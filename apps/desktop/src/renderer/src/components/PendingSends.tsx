import type { DraftImage } from '../lib/images'
import { CloseIcon, SendIcon } from './Icons'

/** One message the engine is holding until the step in flight finishes. */
export interface PendingSend {
  id: string
  /** Session it belongs to; only the active session's entries are rendered. */
  key: string
  text: string
  images: DraftImage[]
  /** Exactly what went to `prompt()` — video-frame preamble included. */
  promptText: string
  /** Engine ticket, for retracting it or replacing it with a hard interrupt. */
  steerId?: string
}

/**
 * Messages waiting at the engine's next boundary, pinned to the lower right of the chat area.
 *
 * Deliberately outside the transcript: a message that scrolls away with the conversation reads as
 * already sent, and the whole point here is that it is not. It keeps the shape of a just-sent bubble,
 * stays in place while the transcript scrolls, and disappears the moment the engine really puts it
 * into the transcript. `立即发送` is the only hard interrupt in the app; `撤回` takes the message back
 * while the engine is still holding it.
 */
export function PendingSends({
  items,
  onSendNow,
  onCancel
}: {
  items: PendingSend[]
  onSendNow: (item: PendingSend) => void
  onCancel: (item: PendingSend) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="pending-sends" aria-live="polite">
      {items.map((item) => (
        <div className="pending-send" key={item.id}>
          <div className="pending-send-state">
            <span className="pulse-dot" />
            待发送 · 等当前步骤结束
          </div>
          {item.images.length > 0 && (
            <div className="pending-send-images">
              {item.images.map((image) => (
                <img
                  key={image.id}
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt=""
                  title={image.name}
                />
              ))}
            </div>
          )}
          {item.text && <div className="pending-send-text">{item.text}</div>}
          <div className="pending-send-actions">
            <button
              className="pending-send-now"
              title="停掉当前回合，立刻把这条发出去"
              onClick={() => onSendNow(item)}
            >
              <SendIcon size={10} />
              立即发送
            </button>
            <button
              className="pending-send-cancel"
              title="撤回这条（还没进对话）"
              onClick={() => onCancel(item)}
            >
              <CloseIcon size={10} />
              撤回
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
