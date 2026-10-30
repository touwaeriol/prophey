import { useCallback, useEffect, useRef, useState } from 'react'
import { blobToDraftImage, clipboardImages, type DraftImage } from '../lib/images'
import { extractVideoFrames, isVideo } from '../lib/video'

/**
 * Attachments for one text input: paste, drop, pick, remove, and the video-frame conversion.
 *
 * The composer and the history editor share this on purpose — the same paste, the same 8MB rule, the
 * same "视频本地抽帧" behaviour. Two implementations drift, and then one of them quietly accepts a
 * format the other drops.
 *
 * `input` is the textarea the paste belongs to: a paste into some other field (settings, the @-picker)
 * is left to that field instead of becoming an attachment.
 */
export function useDraftImages({
  images,
  onImagesChange,
  onNotice,
  disabled,
  input
}: {
  images: DraftImage[]
  onImagesChange: (images: DraftImage[]) => void
  onNotice?: (message: string) => void
  /** True while nothing may be attached (engine not ready, another input owns the paste). */
  disabled?: boolean
  input: React.RefObject<HTMLTextAreaElement | null>
}) {
  const [convertingVideos, setConvertingVideos] = useState(0)
  const [dragging, setDragging] = useState(false)
  /**
   * Latest attachments, so two pastes that are still decoding do not both append to a stale array
   * (props would be captured by the first `addImages` call).
   */
  const imagesRef = useRef(images)
  useEffect(() => {
    imagesRef.current = images
  }, [images])

  const addImages = useCallback(
    async (files: File[]): Promise<void> => {
      for (const file of files) {
        let added: DraftImage[] = []
        if (isVideo(file)) {
          setConvertingVideos(count => count + 1)
          try {
            added = await extractVideoFrames(file)
          } catch (error) {
            onNotice?.(error instanceof Error ? error.message : String(error))
          } finally {
            setConvertingVideos(count => Math.max(0, count - 1))
          }
        } else {
          const image = await blobToDraftImage(file, file.name || undefined)
          if (!image) onNotice?.('图片超过 8MB，已跳过')
          else added = [image]
        }
        if (added.length === 0) continue
        // Read the ref after every await: concurrent decoding and session changes must not make one
        // async result overwrite the other attachments or restore images already sent.
        const next = [...imagesRef.current, ...added]
        imagesRef.current = next
        onImagesChange(next)
      }
    },
    [onImagesChange, onNotice]
  )

  /** Same reason as `addImages`: two removals in one tick must not both start from stale props. */
  const removeImage = useCallback(
    (id: string): void => {
      const next = imagesRef.current.filter((image) => image.id !== id)
      imagesRef.current = next
      onImagesChange(next)
    },
    [onImagesChange]
  )

  const handleFiles = useCallback(
    (files: File[]): void => {
      // Nothing may be attached while the engine is not accepting prompts. Say so instead of
      // dropping the paste: the image is gone from the clipboard by then.
      if (disabled) {
        onNotice?.('现在不能添加图片或视频：pi 未就绪，或侧边提问窗口还开着')
        return
      }
      void addImages(files)
    },
    [addImages, disabled, onNotice]
  )

  /**
   * Clipboard images are pure attachments: an image in the clipboard is attached instead of being
   * inserted as text. Listening on the window (not just the textarea) keeps Ctrl+V working when focus
   * sits on a chip or the scroll area; pastes into other inputs are left alone.
   */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const target = event.target as HTMLElement | null
      const editable =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (editable && target !== input.current) return
      const files = clipboardImages(event.clipboardData)
      if (files.length === 0) return
      event.preventDefault()
      handleFiles(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [handleFiles, input])

  /** Drop zone props: images and videos only, and only while they may be attached. */
  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      if (disabled || !event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      setDragging(true)
    },
    onDragLeave: (event: React.DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      setDragging(false)
    },
    onDrop: (event: React.DragEvent) => {
      const files = Array.from(event.dataTransfer.files).filter(
        (file) => file.type.startsWith('image/') || isVideo(file)
      )
      if (files.length === 0) return
      event.preventDefault()
      setDragging(false)
      handleFiles(files)
    }
  }

  return { convertingVideos, dragging, addImages, handleFiles, removeImage, dropProps }
}
