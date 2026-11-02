import { baseName, type Attachment } from '../lib/attachments'

/**
 * Files waiting in the composer (and in the message editor).
 *
 * One row per file, above the textarea, next to the image thumbnails: a pasted file has no preview
 * worth rendering, so the name is the content. Clicking reveals it in the file manager, which is
 * also the only way to check *which* of five identically named exports was pasted.
 */
export function AttachmentStrip({
  attachments,
  onRemove
}: {
  attachments: Attachment[]
  onRemove: (path: string) => void
}): React.JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <div className="draft-files">
      {attachments.map((attachment) => (
        <div key={attachment.path} className="draft-file" title={attachment.path}>
          <span className="draft-file-icon" aria-hidden="true">
            📄
          </span>
          <button
            type="button"
            className="draft-file-name"
            onClick={() => void window.pi.revealPath(attachment.path)}
          >
            {baseName(attachment.path)}
          </button>
          {attachment.size && <span className="draft-file-size">{attachment.size}</span>}
          <button
            type="button"
            className="draft-file-remove"
            aria-label={`移除 ${baseName(attachment.path)}`}
            title="移除"
            onClick={() => onRemove(attachment.path)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
