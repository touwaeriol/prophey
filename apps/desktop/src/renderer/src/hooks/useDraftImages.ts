import { useCallback, useEffect, useRef, useState } from 'react'
import { blobToDraftImage, clipboardImages, type DraftImage } from '../lib/images'
import { extractVideoFrames, isVideo } from '../lib/video'
import {
  attachmentsOf,
  formatBytes,
  insertAttachments,
  MAX_ATTACHMENTS,
  removeAttachment as removeFromText,
  type Attachment
} from '../lib/attachments'

/**
 * Attachments for one text input: paste, drop, pick, remove, and the video-frame conversion.
 *
 * The composer and the history editor share this on purpose — the same paste, the same 8MB rule, the
 * same "视频本地抽帧" behaviour. Two implementations drift, and then one of them quietly accepts a
 * format the other drops.
 *
 * Images and video frames are payloads (`DraftImage`, sent to the provider as parts). Every other
 * file is a **path** and lives in the text as an attachment block — see `lib/attachments.ts` for why
 * that is the store and not a parallel array.
 *
 * `input` is the textarea the paste belongs to: a paste into some other field (settings, the @-picker)
 * is left to that field instead of becoming an attachment.
 */
export function useDraftImages({
  images,
  onImagesChange,
  text,
  onTextChange,
  onNotice,
  disabled,
  input
}: {
  images: DraftImage[]
  onImagesChange: (images: DraftImage[]) => void
  /** The text the attachment block belongs to. */
  text: string
  onTextChange: (next: string) => void
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
  /** Same reason for the text: a path paste may land while a video is still being decoded. */
  const textRef = useRef(text)
  useEffect(() => {
    textRef.current = text
  }, [text])

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

  /** Put paths in the text as one attachment block; the chips are a view of those lines. */
  const addPaths = useCallback(
    (entries: Attachment[]): void => {
      if (entries.length === 0) return
      const result = insertAttachments(textRef.current, entries)
      if (result.skipped > 0) onNotice?.(`一条消息最多 ${MAX_ATTACHMENTS} 个附件，已跳过 ${result.skipped} 个`)
      if (result.added === 0) return
      textRef.current = result.text
      onTextChange(result.text)
    },
    [onNotice, onTextChange]
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

  const removeAttachment = useCallback(
    (path: string): void => {
      const next = removeFromText(textRef.current, path)
      textRef.current = next
      onTextChange(next)
    },
    [onTextChange]
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

  /** Files that are neither an image nor a video: these become path attachments. */
  const addDroppedFiles = useCallback(
    (files: File[]): void => {
      const entries: Attachment[] = []
      for (const file of files) {
        const path = window.pi.pathForFile(file)
        if (!path) {
          onNotice?.(`读不到「${file.name}」的本机路径，已跳过`)
          continue
        }
        entries.push({ path, size: formatBytes(file.size) })
      }
      addPaths(entries)
    },
    [addPaths, onNotice]
  )

  /**
   * Clipboard content: images first, then any other file as a path, then the Windows-only fallback.
   *
   * Listening on the window (not just the textarea) keeps Ctrl+V working when focus sits on a chip
   * or the scroll area; pastes into other inputs are left alone.
   */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const target = event.target as HTMLElement | null
      const editable =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (editable && target !== input.current) return
      const data = event.clipboardData
      const images = clipboardImages(data)
      if (images.length > 0) {
        event.preventDefault()
        handleFiles(images)
        return
      }
      const others = Array.from(data?.files ?? []).filter((file) => !file.type.startsWith('image/'))
      if (others.length > 0) {
        event.preventDefault()
        addDroppedFiles(others)
        return
      }
      // A copied file can arrive as an empty DataTransfer (the path only lives in a clipboard format
      // Chromium does not model). Nothing is inserted by the browser then, so a late answer may
      // append without preventDefault — but when the paste *was* the path as text, that text is now
      // in the box and the block would say the same thing twice.
      const before = textRef.current
      void window.pi.clipboardFilePaths().then((paths) => {
        if (paths.length === 0) return
        const current = textRef.current
        const pasted = current.startsWith(before) ? current.slice(before.length) : current
        const lines = pasted.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        const echoed = lines.length > 0 && lines.every((line) => paths.includes(line))
        if (echoed && pasted) {
          const without = current.replace(pasted, '')
          textRef.current = without
          onTextChange(without)
        }
        addPaths(paths.map((path) => ({ path, size: '' })))
      })
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addDroppedFiles, addPaths, disabled, handleFiles, input, onTextChange])

  /** One entry point for drop and the file picker: media become payloads, the rest become paths. */
  const pickFiles = useCallback(
    (files: File[]): void => {
      const media = files.filter((file) => file.type.startsWith('image/') || isVideo(file))
      const others = files.filter((file) => !media.includes(file))
      if (media.length > 0) handleFiles(media)
      addDroppedFiles(others)
    },
    [addDroppedFiles, handleFiles]
  )

  /** Drop zone props: images and videos become payloads, everything else a path. */
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
      const dropped = Array.from(event.dataTransfer.files)
      if (dropped.length === 0) return
      event.preventDefault()
      setDragging(false)
      pickFiles(dropped)
    }
  }

  return {
    convertingVideos,
    dragging,
    addImages,
    handleFiles,
    pickFiles,
    removeImage,
    /** Attachments currently in the text; a view over the block, not a separate store. */
    attachments: attachmentsOf(text),
    removeAttachment,
    dropProps
  }
}
