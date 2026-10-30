import type { DraftImage } from './images'

export const MAX_VIDEO_BYTES = 200 * 1024 * 1024
export const MAX_VIDEO_SECONDS = 120
export const VIDEO_FRAME_COUNT = 6

export interface VideoFrameInfo {
  name: string
  duration: number
  index: number
  count: number
  time: number
}

export interface VideoSource {
  name: string
  duration: number
  width: number
  height: number
}

export function isVideo(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(file.name)
}

export function videoTimes(duration: number, count = VIDEO_FRAME_COUNT): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0]
  const length = Math.max(1, Math.floor(count))
  // A frame at the exact duration is outside the media timeline. Keep samples just inside it.
  const end = Math.max(0, duration - Math.min(0.05, duration / 100))
  // Two decimals: these are seek targets and the prompt prints `toFixed(1)`, but the raw product 11.95 × 3 / 5 lands on 7.169999999999999.
  return Array.from({ length }, (_, index) =>
    length === 1 ? 0 : Number(((index / (length - 1)) * end).toFixed(2))
  )
}

export function videoFramePrompt(frames: DraftImage[]): string {
  const videos = new Map<string, DraftImage[]>()
  for (const image of frames) {
    if (!image.video) continue
    const group = videos.get(image.video.name) ?? []
    group.push(image)
    videos.set(image.video.name, group)
  }
  if (videos.size === 0) return ''
  return [...videos.values()].map(frames => {
    const info = frames[0].video!
    return [
      `[视频抽帧附件：${info.name}；时长 ${info.duration.toFixed(1)} 秒；共 ${frames.length} 帧]`,
      '用户上传的是视频，不是独立照片。请结合以下按时间均匀抽取的画面识别视频内容；不要把单帧当成完整视频，不要声称看过未展示的细节。',
      '当前转换不包含音轨，不能据此判断语音、音乐或音效。若问题需要更密的动作或音轨，请说明限制。',
      ...frames.map(frame => `第 ${frame.video!.index + 1} 帧：${frame.video!.time.toFixed(1)} 秒。`)
    ].join('\n')
  }).join('\n\n')
}

/**
 * Video is only a renderer-side input format. Providers receive the same image blocks as ordinary
 * attachments; no video bytes or object URLs enter the transcript or the engine protocol.
 */
export async function extractVideoFrames(file: File): Promise<DraftImage[]> {
  if (file.size > MAX_VIDEO_BYTES) throw new Error('视频超过 200MB，请先裁剪或压缩')
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  const canvas = document.createElement('canvas')
  let disposed = false
  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    video.onloadedmetadata = null
    video.onseeked = null
    video.onerror = null
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
    canvas.width = canvas.height = 0
  }
  const fail = (message: string): Error => {
    cleanup()
    return new Error(message)
  }
  try {
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(fail('读取视频超时，请换用 MP4 或 WebM')), 15_000)
      video.onloadedmetadata = () => {
        window.clearTimeout(timer)
        resolve()
      }
      video.onerror = () => {
        window.clearTimeout(timer)
        reject(fail('无法解码视频，请换用浏览器支持的 MP4 或 WebM'))
      }
      video.src = url
      video.load()
    })
    if (disposed) throw new Error('无法解码视频，请换用浏览器支持的 MP4 或 WebM')
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw fail('无法读取视频时长')
    if (video.duration > MAX_VIDEO_SECONDS) throw fail('视频超过 2 分钟，请先裁剪后重试')
    if (!video.videoWidth || !video.videoHeight) throw fail('视频没有可识别的画面')

    const scale = Math.min(1, 768 / Math.max(video.videoWidth, video.videoHeight))
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw fail('无法创建视频抽帧画布')
    const source: VideoSource = {
      name: file.name || '视频', duration: video.duration,
      width: video.videoWidth, height: video.videoHeight
    }
    const times = videoTimes(source.duration)
    const frames: DraftImage[] = []
    for (const [index, time] of times.entries()) {
      await seek(video, time, fail)
      if (disposed) throw new Error('视频抽帧已取消')
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(value => value ? resolve(value) : reject(fail('视频帧编码失败')), 'image/jpeg', 0.82)
      })
      const dataUrl = await readBlob(blob)
      frames.push({
        id: `video-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        data: dataUrl.slice(dataUrl.indexOf(',') + 1),
        mimeType: 'image/jpeg',
        name: `${source.name} · 第 ${index + 1} 帧`,
        video: { ...source, index, count: times.length, time }
      })
    }
    return frames
  } finally {
    cleanup()
  }
}

async function seek(video: HTMLVideoElement, time: number, fail: (message: string) => Error): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(fail('视频抽帧超时，请重试')), 10_000)
    const finish = (): void => {
      window.clearTimeout(timer)
      video.onseeked = null
      video.onerror = null
      resolve()
    }
    video.onseeked = finish
    video.onerror = () => {
      window.clearTimeout(timer)
      reject(fail('视频抽帧失败，请换用 MP4 或 WebM'))
    }
    // Chromium does not consistently emit seeked when the requested time is already current.
    if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish()
    else video.currentTime = time
  })
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取视频帧失败'))
    reader.readAsDataURL(blob)
  })
}
