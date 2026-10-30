/** Real Chromium video decoding and canvas frame extraction; no model request or user media. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

module.exports = async function videoSmoke(evaluate, until, window) {
  try {
    await until(() => evaluate('!!document.querySelector(".composer textarea:not(:disabled)")'), 'composer')
    assert.equal(await evaluate('!!document.querySelector(".media-attach")'), true)
    assert.equal(await evaluate('document.querySelector(".attachment-input").accept.includes("video/mp4")'), true)
    // A previous smoke module can leave a draft behind (composer state is persisted per session),
    // so start from an empty strip instead of expecting the count to be exactly the frames we add.
    await evaluate('document.querySelectorAll(".draft-image-remove").forEach(button => button.click())')
    await until(() => evaluate('document.querySelectorAll(".draft-image").length === 0'), 'empty draft strip')
    await evaluate(`(async () => {
      // A short moving pattern makes every sample different, without relying on an installed ffmpeg.
      const canvas = document.createElement('canvas')
      canvas.width = 320; canvas.height = 180
      const context = canvas.getContext('2d')
      const stream = canvas.captureStream(15)
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
      const chunks = []
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      const stopped = new Promise(resolve => recorder.onstop = resolve)
      recorder.start()
      for (let index = 0; index < 18; index++) {
        context.fillStyle = 'hsl(' + index * 18 + ', 75%, 55%)'
        context.fillRect(0, 0, 320, 180)
        context.fillStyle = 'white'; context.font = '30px sans-serif'
        context.fillText('Frame ' + index, 80 + index * 4, 100)
        await new Promise(resolve => setTimeout(resolve, 65))
      }
      recorder.stop()
      await stopped
      stream.getTracks().forEach(track => track.stop())
      const file = new File(chunks, 'video-smoke.webm', { type: 'video/webm' })
      const transfer = new DataTransfer(); transfer.items.add(file)
      const input = document.querySelector('.attachment-input')
      Object.defineProperty(input, 'files', { value: transfer.files, configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await until(() => evaluate('document.querySelectorAll(".draft-image").length === 6'), 'six decoded frames')
    const frames = await evaluate(`(async () => Promise.all([...document.querySelectorAll('.draft-image img')].map(image => {
      if (!image.complete) return null
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      canvas.getContext('2d').drawImage(image, 0, 0)
      return { width: image.naturalWidth, height: image.naturalHeight, src: image.src, sample: canvas.toDataURL('image/jpeg', .2) }
    })))()`)
    assert.equal(frames.length, 6)
    for (const frame of frames) {
      assert.equal(frame.width, 320)
      assert.equal(frame.height, 180)
      assert.match(frame.src, /^data:image\/jpeg;base64,/)
    }
    assert.equal(new Set(frames.map(frame => frame.sample)).size > 1, true, 'frames come from different times')
    assert.match(await evaluate('document.querySelector(".draft-image-thumb").title'), /video-smoke\.webm.*秒/)
    assert.equal(await evaluate('document.querySelector(".send-btn").disabled'), false)
    const dir = path.join(process.env.PROPHEY_SMOKE_ROOT, 'artifacts/video-recognition')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'frames.png'), (await window.webContents.capturePage()).toPNG())
    await evaluate(`document.querySelectorAll('.draft-image-remove').forEach(button => button.click())`)
    await until(() => evaluate('document.querySelectorAll(".draft-image").length === 0'), 'frame removal')
    await evaluate(`(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['not a video'], 'broken.mp4', { type: 'video/mp4' }))
      const input = document.querySelector('.attachment-input')
      Object.defineProperty(input, 'files', { value: transfer.files, configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await until(() => evaluate('document.body.textContent.includes("无法解码视频")'), 'decode error feedback')
    assert.equal(await evaluate('document.querySelectorAll(".draft-image").length'), 0)
    console.log('Video recognition input passed: real WebM decode, six timeline frames, JPEG attachments, removal and decode errors')
  } finally {
    await evaluate(`document.querySelectorAll('.draft-image-remove').forEach(button => button.click())`)
  }
}
