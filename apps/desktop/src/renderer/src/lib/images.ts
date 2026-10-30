import { MAX_CLIPBOARD_IMAGE_PIXELS, MAX_CLIPBOARD_PNG_BYTES } from '../../../shared/image-clipboard'
import type { VideoFrameInfo } from './video'

/** Rasterize the displayed image, not its URL, so JPEG/WebP/etc. copy as a real PNG. */
export async function copyPreviewImage(image: HTMLImageElement): Promise<void> {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
    throw new Error('图片尚未加载或加载失败，请稍后重试')
  }
  if (image.naturalWidth * image.naturalHeight > MAX_CLIPBOARD_IMAGE_PIXELS) {
    throw new Error('图片尺寸过大，无法复制')
  }
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  try {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法读取图片')
    context.drawImage(image, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片转换失败')), 'image/png')
    })
    if (blob.size > MAX_CLIPBOARD_PNG_BYTES) throw new Error('图片过大，无法复制')
    const result = await window.pi.copyImage(await readAsDataUrl(blob))
    if (!result.ok) throw new Error(result.error || '复制图片失败')
  } finally {
    canvas.width = canvas.height = 0
  }
}

export interface DraftImage {
  id: string
  data: string
  mimeType: string
  name?: string
  /** Set only on extracted video frames; used to label their thumbnails. */
  video?: VideoFrameInfo
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export function imageSrc(image: { data: string; mimeType: string }): string {
  return `data:${image.mimeType || 'image/png'};base64,${image.data}`
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })
}

export async function blobToDraftImage(blob: Blob, name?: string): Promise<DraftImage | null> {
  if (blob.size > MAX_IMAGE_BYTES) return null
  const dataUrl = await readAsDataUrl(blob)
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return null
  const mimeType = /^data:([^;]+)/.exec(dataUrl)?.[1] ?? blob.type ?? 'image/png'
  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    data: dataUrl.slice(comma + 1),
    mimeType,
    ...(name ? { name } : {})
  }
}

export function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  // Windows / Snipping Tool pastes sometimes come through as plain files with no item entry.
  if (files.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      if (file.type.startsWith('image/')) files.push(file)
    }
  }
  return files
}
