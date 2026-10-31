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
  /**
   * `steer` waits at the engine's next boundary and can still be retracted; `direct` was already
   * accepted by the engine and is only waiting to appear in the transcript.
   */
  mode: 'steer' | 'direct'
}

/**
 * Messages on their way in, pinned to the lower right of the chat area.
 *
 * Deliberately outside the transcript: a message that scrolls away with the conversation reads as
 * already sent, and the whole point here is that it is not. It keeps the shape of a just-sent bubble,
 * stays in place while the transcript scrolls, and disappears the moment the engine really puts it
 * into the transcript. A `steer` gets `立即发送` (the only hard interrupt in the app) and `撤回` (the
 * engine still holds it); a `direct` message is already accepted, so it says so and offers neither.
 */
export function PendingSends({
  items,
  onSendNow,
  onCancel,
  inline = false
}: {
  items: PendingSend[]
  onSendNow: (item: PendingSend) => void
  onCancel: (item: PendingSend) => void
  /**
   * Sit in the transcript at the user's place instead of floating over it.
   *
   * A waiting message is a message the user wrote: it belongs where it will land, right after the
   * last turn, so it can be read in context. It still says it has not been delivered.
   */
  inline?: boolean
}) {
  if (items.length === 0) return null
  return (
    <div className={`pending-sends ${inline ? 'inline' : ''}`} aria-live="polite">
      {items.map((item) => (
        <div className="pending-send" key={item.id}>
          <div className="pending-send-state">
            <span className="pulse-dot" />
            {item.mode === 'steer' ? '待发送 · 等当前步骤结束' : '正在发送 · 等引擎写入对话'}
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
            {item.mode === 'steer' && (
              <button
                className="pending-send-now"
                title="停掉当前回合，立刻把这条发出去"
                onClick={() => onSendNow(item)}
              >
                <SendIcon size={10} />
                立即发送
              </button>
            )}
            {item.mode === 'steer' && (
              <button
                className="pending-send-cancel"
                title="撤回这条（还没进对话）"
                onClick={() => onCancel(item)}
              >
                <CloseIcon size={10} />
                撤回
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
