import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckIcon, CloseIcon, CopyIcon } from './Icons'
import { copyPreviewImage, imageSrc, type DraftImage } from '../lib/images'
import type { MessageImage } from '../lib/messages'

export function ImageLightbox({
  src,
  alt,
  onClose
}: {
  src: string
  alt?: string
  onClose: () => void
}): React.JSX.Element {
  const imageRef = useRef<HTMLImageElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const copyingRef = useRef(false)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number } | undefined>(undefined)
  const copy = useCallback(async (): Promise<void> => {
    if (copyingRef.current || !imageRef.current) return
    copyingRef.current = true
    setCopyState('copying')
    setError('')
    try {
      await copyPreviewImage(imageRef.current)
      setCopyState('copied')
    } catch (reason) {
      setCopyState('error')
      setError(reason instanceof Error ? reason.message : '复制图片失败，请重试')
    } finally {
      copyingRef.current = false
    }
  }, [])

  useEffect(() => {
    const previous = document.activeElement
    overlayRef.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])

  useEffect(() => {
    if (copyState !== 'copied') return
    const timer = window.setTimeout(() => setCopyState('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [copyState])

  useEffect(() => {
    if (!menu) return
    // Any click outside dismisses the menu. The menu stops propagation so its own clicks survive.
    const dismiss = (): void => setMenu(undefined)
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [menu])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (menu) setMenu(undefined)
        else onClose()
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        event.stopPropagation()
        setMenu(undefined)
        void copy()
      }
    }
    const copyHandler = (event: ClipboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      void copy()
    }
    window.addEventListener('keydown', handler, true)
    window.addEventListener('copy', copyHandler, true)
    return () => {
      window.removeEventListener('keydown', handler, true)
      window.removeEventListener('copy', copyHandler, true)
    }
  }, [onClose, copy, menu])

  return (
    <div
      className="image-lightbox"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      <div className="image-lightbox-actions">
        <button className="image-lightbox-copy" onClick={() => void copy()} disabled={copyState === 'copying'} title="复制图片 (Ctrl/Cmd+C)">
          {copyState === 'copied' ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
          {copyState === 'copied' ? '已复制' : copyState === 'copying' ? '复制中…' : '复制图片'}
        </button>
        <button className="icon-btn image-lightbox-close" onClick={onClose} title="关闭 (Esc)" aria-label="关闭图片预览">
          <CloseIcon size={15} />
        </button>
      </div>
      <div className="image-lightbox-feedback" role="status" aria-live="polite">
        {error || (copyState === 'copied' ? '图片已复制到剪贴板' : '')}
      </div>
      <img ref={imageRef} src={src} alt={alt ?? '图片'} />
      {menu && (
        <div
          className="image-context-menu"
          role="menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 188)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 96))
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            role="menuitem"
            onClick={() => {
              setMenu(undefined)
              void copy()
            }}
          >
            <span>复制图片</span>
            <kbd>{navigator.platform.toLowerCase().includes('mac') ? '⌘C' : 'Ctrl+C'}</kbd>
          </button>
          <button role="menuitem" onClick={onClose}>
            <span>关闭预览</span>
            <kbd>Esc</kbd>
          </button>
        </div>
      )}
    </div>
  )
}

export function MessageImages({
  images,
  align = 'start'
}: {
  images: MessageImage[]
  align?: 'start' | 'end'
}): React.JSX.Element | null {
  const [preview, setPreview] = useState<MessageImage>()
  if (images.length === 0) return null
  return (
    <>
      <div className={`message-images ${align}`}>
        {images.map((image, index) => (
          <button
            key={`${index}-${image.data.slice(0, 12)}`}
            className="message-image"
            onClick={() => setPreview(image)}
            title="查看大图"
          >
            <img src={imageSrc(image)} alt={`图片${index + 1}`} />
          </button>
        ))}
      </div>
      {preview && (
        <ImageLightbox src={imageSrc(preview)} onClose={() => setPreview(undefined)} />
      )}
    </>
  )
}

export function DraftImageStrip({
  images,
  onRemove,
  onPreview
}: {
  images: DraftImage[]
  onRemove: (id: string) => void
  onPreview: (image: DraftImage) => void
}): React.JSX.Element | null {
  if (images.length === 0) return null
  return (
    <div className="draft-images">
      {images.map((image) => (
        <div key={image.id} className="draft-image">
          <button
            className="draft-image-thumb"
            onClick={() => onPreview(image)}
            title={image.video
              ? `${image.name} · ${image.video.time.toFixed(1)} 秒`
              : image.name ? `查看大图：${image.name}` : '点击查看大图'}
          >
            <img src={imageSrc(image)} alt="" />
          </button>
          <button
            className="draft-image-remove"
            onClick={() => onRemove(image.id)}
            title="移除图片"
          >
            <CloseIcon size={10} />
          </button>
        </div>
      ))}
    </div>
  )
}
