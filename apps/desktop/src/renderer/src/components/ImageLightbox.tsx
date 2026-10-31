import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckIcon, CloseIcon, CopyIcon } from './Icons'
import { copyPreviewImage, imageSrc, type DraftImage } from '../lib/images'
import type { MessageImage } from '../lib/messages'

const COPY_HINT = navigator.platform.toLowerCase().includes('mac') ? '⌘C' : 'Ctrl+C'

interface MenuEntry {
  label: string
  hint?: string
  onSelect: () => void
  disabled?: boolean
}

/**
 * Chromium's built-in image menu is English-only and writes through a path we cannot check, so
 * every image surface (lightbox and inline thumbnails) shares this one.
 */
export function ImageContextMenu({
  x,
  y,
  entries,
  note
}: {
  x: number
  y: number
  entries: MenuEntry[]
  note?: string
}): React.JSX.Element {
  const height = 12 + entries.length * 30 + (note ? 26 : 0)
  return (
    <div
      className="image-context-menu"
      role="menu"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - 188)),
        top: Math.max(8, Math.min(y, window.innerHeight - height))
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry) => (
        <button key={entry.label} role="menuitem" onClick={entry.onSelect} disabled={entry.disabled}>
          <span>{entry.label}</span>
          {entry.hint && <kbd>{entry.hint}</kbd>}
        </button>
      ))}
      {note && <div className="image-context-menu-note">{note}</div>}
    </div>
  )
}

/** Click outside / window resize / blur dismisses a floating menu. */
function useDismissMenu(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [open, close])
}

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

  // Any click outside dismisses the menu; the menu stops propagation so its own clicks survive.
  useDismissMenu(menu !== undefined, useCallback(() => setMenu(undefined), []))

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
        <ImageContextMenu
          x={menu.x}
          y={menu.y}
          entries={[
            {
              label: '复制图片',
              hint: COPY_HINT,
              onSelect: () => {
                setMenu(undefined)
                void copy()
              }
            },
            { label: '关闭预览', hint: 'Esc', onSelect: onClose }
          ]}
        />
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
  const [menu, setMenu] = useState<{ x: number; y: number; image: MessageImage; target: HTMLImageElement }>()
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const [error, setError] = useState('')
  const copyingRef = useRef(false)
  const closeMenu = useCallback(() => {
    setMenu(undefined)
    setCopyState('idle')
    setError('')
  }, [])

  const copy = useCallback(async (target: HTMLImageElement): Promise<void> => {
    if (copyingRef.current) return
    copyingRef.current = true
    setCopyState('copying')
    setError('')
    try {
      await copyPreviewImage(target)
      setCopyState('copied')
    } catch (reason) {
      setCopyState('error')
      setError(reason instanceof Error ? reason.message : '复制图片失败，请重试')
    } finally {
      copyingRef.current = false
    }
  }, [])

  useDismissMenu(menu !== undefined, closeMenu)

  useEffect(() => {
    if (copyState !== 'copied') return
    const timer = window.setTimeout(closeMenu, 2000)
    return () => window.clearTimeout(timer)
  }, [copyState, closeMenu])

  useEffect(() => {
    if (!menu) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        event.stopPropagation()
        void copy(menu.target)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [menu, copy, closeMenu])

  if (images.length === 0) return null
  return (
    <>
      <div className={`message-images ${align}`}>
        {images.map((image, index) => (
          <button
            key={`${index}-${image.data.slice(0, 12)}`}
            className="message-image"
            onClick={() => setPreview(image)}
            onContextMenu={(event) => {
              // Right-click copies the full-resolution image without opening the preview first.
              event.preventDefault()
              event.stopPropagation()
              const target = event.currentTarget.querySelector('img')
              setCopyState('idle')
              setError('')
              if (target) setMenu({ x: event.clientX, y: event.clientY, image, target })
            }}
            title="查看大图 · 右键可复制图片"
          >
            <img src={imageSrc(image)} alt={`图片${index + 1}`} />
          </button>
        ))}
      </div>
      {preview && (
        <ImageLightbox src={imageSrc(preview)} onClose={() => setPreview(undefined)} />
      )}
      {menu && (
        <ImageContextMenu
          x={menu.x}
          y={menu.y}
          note={error}
          entries={[
            {
              label: copyState === 'copied' ? '已复制' : copyState === 'copying' ? '复制中…' : '复制图片',
              hint: COPY_HINT,
              disabled: copyState === 'copying',
              onSelect: () => void copy(menu.target)
            },
            {
              label: '查看大图',
              onSelect: () => {
                const image = menu.image
                closeMenu()
                setPreview(image)
              }
            }
          ]}
        />
      )}
    </>
  )
}

/**
 * Attachments waiting in the composer (and in the message editor).
 *
 * Right-click copies one without opening it first: an attachment is already the full-resolution
 * image, and 「打开 → 复制 → 关闭」 is three steps for something the user can see right there. Same
 * menu as the transcript's thumbnails, so there is one way to copy an image in the whole app.
 */
export function DraftImageStrip({
  images,
  onRemove,
  onPreview
}: {
  images: DraftImage[]
  onRemove: (id: string) => void
  onPreview: (image: DraftImage) => void
}): React.JSX.Element | null {
  const [menu, setMenu] = useState<{ x: number; y: number; target: HTMLImageElement }>()
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const [error, setError] = useState('')
  const copyingRef = useRef(false)
  const closeMenu = useCallback(() => {
    setMenu(undefined)
    setCopyState('idle')
    setError('')
  }, [])

  const copy = useCallback(async (target: HTMLImageElement): Promise<void> => {
    if (copyingRef.current) return
    copyingRef.current = true
    setCopyState('copying')
    setError('')
    try {
      await copyPreviewImage(target)
      setCopyState('copied')
    } catch (reason) {
      setCopyState('error')
      setError(reason instanceof Error ? reason.message : '复制图片失败，请重试')
    } finally {
      copyingRef.current = false
    }
  }, [])

  useDismissMenu(menu !== undefined, closeMenu)

  useEffect(() => {
    if (copyState !== 'copied') return
    const timer = window.setTimeout(closeMenu, 2000)
    return () => window.clearTimeout(timer)
  }, [copyState, closeMenu])

  useEffect(() => {
    if (!menu) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        event.stopPropagation()
        void copy(menu.target)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [menu, copy, closeMenu])

  if (images.length === 0) return null
  return (
    <>
      <div className="draft-images">
        {images.map((image) => (
          <div key={image.id} className="draft-image">
            <button
              className="draft-image-thumb"
              onClick={() => onPreview(image)}
              onContextMenu={(event) => {
                // Right-click copies the attachment itself, no preview needed.
                event.preventDefault()
                event.stopPropagation()
                const target = event.currentTarget.querySelector('img')
                setCopyState('idle')
                setError('')
                if (target) setMenu({ x: event.clientX, y: event.clientY, target })
              }}
              title={image.video
                ? `${image.name} · ${image.video.time.toFixed(1)} 秒 · 右键可复制图片`
                : `${image.name ? `查看大图：${image.name}` : '点击查看大图'} · 右键可复制图片`}
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
      {menu && (
        <ImageContextMenu
          x={menu.x}
          y={menu.y}
          note={error}
          entries={[
            {
              label: copyState === 'copied' ? '已复制' : copyState === 'copying' ? '复制中…' : '复制图片',
              hint: COPY_HINT,
              disabled: copyState === 'copying',
              onSelect: () => void copy(menu.target)
            }
          ]}
        />
      )}
    </>
  )
}
