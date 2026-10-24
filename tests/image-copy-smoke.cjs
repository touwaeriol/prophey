/** Real OS clipboard regression. No model calls or mocked preload. Do not use
 * the clipboard during this test; all advertised payloads are eagerly saved. */
const assert = require('node:assert/strict')
const { clipboard, ClipboardItem, nativeImage } = require('electron')

module.exports = async function imageCopySmoke(evaluate, until, window, setSessionFixture) {
  const saved = []
  for (const item of await clipboard.read()) {
    const payloads = {}
    for (const type of item.types) {
      const value = await item.getType(type)
      payloads[type] = type === 'electron application/bookmark'
        ? { ...value } : new Blob([await value.arrayBuffer()], { type: value.type })
    }
    saved.push(payloads)
  }
  const contents = window.webContents
  const idle = await evaluate('window.pi.getStatus()')
  let attachedHere = false
  let sessionInjected = false
  const width = 19, height = 13
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    pixels[i] = (x * 11 + y * 3) % 256
    pixels[i + 1] = (y * 17 + x * 2) % 256
    pixels[i + 2] = (x * 7 + y * 13) % 256
    pixels[i + 3] = 255
  }
  const fixture = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 })
  const expected = fixture.toBitmap()
  async function seed() {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([fixture.toPNG()], { type: 'image/png' }) })])
  }
  async function assertClipboard(label, bitmap = expected) {
    const item = (await clipboard.read()).find(item => item.types.includes('image/png'))
    assert.ok(item, label + ': image/png advertised')
    const image = nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png')).arrayBuffer()))
    assert.equal(image.isEmpty(), false, label)
    assert.deepEqual(image.getSize(), { width, height }, label + ': intrinsic dimensions')
    assert.deepEqual(image.toBitmap(), bitmap, label + ': every pixel')
  }
  async function shortcut(letter, command) {
    const event = { modifiers: process.platform === 'darwin' ? 4 : 2,
      key: letter.toLowerCase(), code: 'Key' + letter, windowsVirtualKeyCode: letter.charCodeAt(0) }
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
      ...event, type: 'rawKeyDown', ...(command ? { commands: [command] } : {})
    })
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' })
  }
  async function closePreview() {
    await evaluate('document.querySelector(".image-lightbox-close")?.click()')
    await until(() => evaluate('!document.querySelector(".image-lightbox")'), 'preview closed')
  }
  async function openPreview(selector = '.draft-image-thumb') {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await until(() => evaluate(`(() => {
      const image = document.querySelector('.image-lightbox img')
      return image?.complete && image.naturalWidth === ${width} && image.naturalHeight === ${height}
    })()`), 'preview decoded')
    assert.equal(await evaluate('document.querySelector(".image-lightbox-copy").textContent.trim()'), '复制图片')
  }
  async function copied() {
    await until(() => evaluate('document.querySelector(".image-lightbox-copy")?.textContent.trim() === "已复制"'), 'copy success feedback')
  }
  try {
    assert.equal(await evaluate('typeof window.pi.copyImage'), 'function')
    await until(() => evaluate('!!document.querySelector(".composer textarea:not(:disabled)")'), 'enabled composer')
    assert.equal(await evaluate('document.querySelectorAll(".draft-image").length'), 0)
    if (!contents.debugger.isAttached()) { contents.debugger.attach('1.3'); attachedHere = true }
    await seed()
    await assertClipboard('seed')
    await evaluate('document.querySelector(".composer textarea").focus()')
    await shortcut('V', 'paste')
    await until(() => evaluate('document.querySelectorAll(".draft-image").length === 1'), 'native image paste')
    await openPreview()
    clipboard.clear()
    assert.equal(await clipboard.has('image/png'), false)
    await evaluate('document.querySelector(".image-lightbox-copy").click()')
    await copied()
    await assertClipboard('button')
    await closePreview()
    await openPreview()
    clipboard.clear()
    // Right-click opens an in-app menu with the same copy action.
    await evaluate(`(() => {
      const image = document.querySelector('.image-lightbox img')
      const rect = image.getBoundingClientRect()
      image.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2)
      }))
    })()`)
    await until(() => evaluate('!!document.querySelector(".image-context-menu")'), 'context menu')
    assert.equal(
      await evaluate('document.querySelector(".image-context-menu button").textContent.includes("复制图片")'),
      true
    )
    await evaluate('document.querySelector(".image-context-menu button").click()')
    await copied()
    await assertClipboard('context menu')
    assert.equal(await evaluate('document.querySelectorAll(".image-context-menu").length'), 0)
    // Escape closes the menu first and leaves the preview open.
    await evaluate(`document.querySelector('.image-lightbox img').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))`)
    await until(() => evaluate('!!document.querySelector(".image-context-menu")'), 'context menu again')
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await until(() => evaluate('!document.querySelector(".image-context-menu")'), 'escape closes the menu')
    assert.equal(await evaluate('!!document.querySelector(".image-lightbox")'), true)
    await closePreview()
    await openPreview()
    clipboard.clear()
    // keydown preventDefault may suppress copy: do not require a copy event here.
    await shortcut('C')
    await copied()
    await assertClipboard('Ctrl/Cmd+C')
    await closePreview()
    await openPreview()
    clipboard.clear()
    await evaluate(`(() => {
      window.__imageCopySmokeNative = 0
      window.__imageCopySmokeListener = event => { if (event.isTrusted) window.__imageCopySmokeNative++ }
      window.addEventListener('copy', window.__imageCopySmokeListener, true)
    })()`)
    contents.copy()
    await copied()
    assert.equal(await evaluate('window.__imageCopySmokeNative'), 1, 'native copy listener')
    await assertClipboard('contents.copy')
    await closePreview()

    // The smoke entry supplies only session history, through the real preload.
    // Like queue-smoke, inject status to refresh the renderer without sending a prompt.
    setSessionFixture({
      sessionKey: 'image-copy-smoke-fixture',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'image-copy-smoke session fixture' },
        { type: 'image', mimeType: 'image/jpeg', data: fixture.toJPEG(90).toString('base64') }
      ], timestamp: Date.now() }]
    })
    sessionInjected = true
    contents.send('pi:status', { ...idle, sessionKey: 'image-copy-smoke-fixture' })
    await until(() => evaluate('!!document.querySelector(".message-image")'), 'session image')
    await openPreview('.message-image')
    // JPEG is lossy; compare to the renderer-decoded pixels, not the PNG original.
    const png = await evaluate(`(() => {
      const image = document.querySelector('.image-lightbox img')
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      canvas.getContext('2d').drawImage(image, 0, 0)
      return canvas.toDataURL('image/png').split(',')[1]
    })()`)
    const jpegPixels = nativeImage.createFromBuffer(Buffer.from(png, 'base64')).toBitmap()
    clipboard.clear()
    await evaluate('document.querySelector(".image-lightbox-copy").click()')
    await copied()
    await assertClipboard('session JPEG converted to PNG', jpegPixels)
    await closePreview()
    await openPreview('.message-image')
    await evaluate(`document.querySelector('.image-lightbox img').src = 'data:image/png;base64,bm90IGEgcG5n'`)
    await until(() => evaluate(`(() => { const img = document.querySelector('.image-lightbox img'); return img.complete && img.naturalWidth === 0 })()`), 'broken img src')
    await evaluate('document.querySelector(".image-lightbox-copy").click()')
    await until(() => evaluate(`!!document.querySelector('.image-lightbox-feedback')?.textContent.trim() && !document.querySelector('.image-lightbox-copy').disabled`), 'broken image failure feedback')
    assert.notEqual(await evaluate('document.querySelector(".image-lightbox-copy").textContent.trim()'), '已复制')
    await assertClipboard('broken source preserves clipboard', jpegPixels)
    await closePreview()
    await seed()
    for (const input of [null, '', 'not an image', 'https://example.invalid/image.png',
      'data:image/jpeg;base64,' + fixture.toJPEG(90).toString('base64'), 'data:image/png;base64,bm90IGEgcG5n']) {
      const result = await evaluate(`window.pi.copyImage(${JSON.stringify(input)}).then(
        result => ({ rejected: result?.ok === false, error: result?.error }),
        error => ({ rejected: true, error: String(error) }))`)
      assert.equal(result.rejected, true, 'invalid IPC rejected')
      assert.ok(result.error)
      await assertClipboard('invalid IPC preserves clipboard')
    }
    console.log('Image copy passed: draft paste, button, context menu, shortcut, native copy, session JPEG, broken source, invalid IPC')
  } finally {
    try {
      await closePreview()
      await evaluate(`(() => {
        if (window.__imageCopySmokeListener) window.removeEventListener('copy', window.__imageCopySmokeListener, true)
        delete window.__imageCopySmokeListener
        delete window.__imageCopySmokeNative
        document.querySelectorAll('.draft-image-remove').forEach(button => button.click())
      })()`)
      await until(() => evaluate('document.querySelectorAll(".draft-image").length === 0'), 'draft cleanup')
      setSessionFixture(undefined)
      if (sessionInjected) {
        contents.send('pi:status', idle)
        await until(() => evaluate('!document.body.textContent.includes("image-copy-smoke session fixture")'), 'session cleanup')
      }
    } finally {
      try {
        setSessionFixture(undefined)
        if (sessionInjected) contents.send('pi:status', idle)
        if (attachedHere) contents.debugger.detach()
      } catch (error) {
        // The window may already be gone; cleanup must not mask the real result.
        console.warn('image copy cleanup skipped:', error instanceof Error ? error.message : error)
      } finally {
        try {
          if (saved.length) await clipboard.write(saved.map(payloads => new ClipboardItem(payloads)))
          else clipboard.clear()
        } catch (error) {
          // CI runners can lock the OS clipboard; restoring it is best effort.
          console.warn('image clipboard restore skipped:', error instanceof Error ? error.message : error)
        }
      }
    }
  }
}
