import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SubagentView } from '@shared/types'
import type { ChatItem, MessageImage, ToolCallView } from '../lib/messages'
import { Markdown } from './Markdown'
import { DraftImageStrip, ImageLightbox, MessageImages } from './ImageLightbox'
import { ChevronIcon, PaperclipIcon, PencilIcon, SparkIcon, ToolIcon } from './Icons'
import { SUBAGENT_STATUS_LABELS, isSubagentRunning } from '../lib/subagents'
import { usageMeter } from '../lib/context-usage'
import { imageSrc, type DraftImage } from '../lib/images'
import { useDraftImages } from '../hooks/useDraftImages'
import { PendingSends, type PendingSend } from './PendingSends'

/**
 * How much of a transcript is mounted on opening, and how much more each scroll to the top adds.
 *
 * A session with 140 heavy turns took ~450ms from switch to first pixel, because every message was
 * parsed in a single commit and the pane stayed blank until the slowest one was done. Mounting the
 * tail first puts the screen the reader asked for on glass in a fraction of that, and the earlier
 * part fills in when they scroll back to it.
 */
const FIRST_WINDOW = 20
const WINDOW_STEP = 20
/** Distance from the top of the transcript (px) that asks for the previous window. */
const GROW_DISTANCE = 320

/** The desktop tool that starts a run: these get a card of their own instead of a generic row. */
function isSubagentStart(name: string): boolean {
  return name.endsWith('start_subagent')
}

function subagentIdFrom(text: string | undefined): string | undefined {
  return /sa_[0-9a-f]{6,}/.exec(text ?? '')?.[0]
}

function subagentHint(call: ToolCallView): { label?: string; agent?: string } {
  try {
    const args = JSON.parse(call.args) as { label?: string; agent?: string; task?: string }
    return { label: args.label, agent: args.agent }
  } catch {
    return {}
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Tool calls render as plain cards, one per call.
 *
 * There used to be an aggregate header above them (“调用 N 个工具” / “读取 N 个文件 ›”）: it cost a
 * row plus margins per assistant message, and its text repeated what the cards already show. The
 * running indicator lives in the run-status bar, so nothing is lost by dropping it.
 */
function ToolList({ calls }: { calls: ToolCallView[] }) {
  return (
    <div className="tool-list">
      {calls.map((call) => (
        <ToolCard key={call.id} call={call} />
      ))}
    </div>
  )
}

function ToolCard({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false)
  const expanded = open
  return (
    <div className={`tool-card ${call.status}`}>
      <button className="tool-head" aria-expanded={expanded} onClick={() => setOpen((value) => !value)}>
        <span className={`tool-chevron ${expanded ? 'open' : ''}`}>
          <ChevronIcon size={12} />
        </span>
        <ToolIcon size={13} />
        <span className="tool-name">{call.name}</span>
        <span className="tool-summary">{call.args.replace(/\s+/g, ' ').slice(0, 110)}</span>
        <span className="tool-status">
          {call.status === 'running' ? '运行中' : call.status === 'error' ? '失败' : '完成'}
          {call.durationMs !== undefined ? ` · ${formatDuration(call.durationMs)}` : ''}
        </span>
      </button>
      {expanded && (
        <div className="tool-body">
          {call.args && (
            <pre className="tool-args">
              <code>{call.args}</code>
            </pre>
          )}
          {call.result && <pre className="tool-result">{call.result}</pre>}
          {call.status === 'running' && !call.result && (
            <div className="tool-running">
              <span className="pulse-dot" /> 执行中…
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A subagent run as it appears in the transcript: its own icon, live status, and — when expanded —
 * the child's latest output plus a way into the full panel.
 */
function SubagentCard({
  call,
  record,
  onOpen
}: {
  call: ToolCallView
  record?: SubagentView
  onOpen: (id?: string) => void
}) {
  const hint = subagentHint(call)
  const id = record?.id ?? subagentIdFrom(call.result)
  const status = record?.status ?? (call.status === 'running' ? 'streaming' : 'idle')
  const [open, setOpen] = useState(false)
  const label = record?.label ?? hint.label ?? record?.agent ?? hint.agent ?? '子代理'
  const lastMessage = record?.messages?.[record.messages.length - 1]?.text
  const running = isSubagentRunning({ status })
  const activeCall = record?.activeCalls?.[record.activeCalls.length - 1]
  const liveText = record?.draft?.text || lastMessage

  return (
    <div className={`subagent-card ${status}`}>
      <button className="subagent-card-head" onClick={() => setOpen((value) => !value)}>
        <span className={`subagent-card-icon ${status}`}>
          <SparkIcon size={12} />
        </span>
        <span className="subagent-card-title">{label}</span>
        {record?.agent && record.agent !== label && (
          <span className="subagent-card-agent">{record.agent}</span>
        )}
        <span className={`subagent-card-state ${status}`}>{SUBAGENT_STATUS_LABELS[status]}</span>
        {id && <span className="subagent-card-id">{id}</span>}
        <span className="subagent-card-spacer" />
        {record?.contextUsage && (
          <span className="subagent-card-meta" title="子代理自己的上下文">
            {usageMeter(record.contextUsage)}
          </span>
        )}
        {record?.runtimeMs !== undefined && (
          <span className="subagent-card-meta">{formatDuration(record.runtimeMs)}</span>
        )}
        <ChevronIcon size={11} className={`card-chevron ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="subagent-card-body">
          {record?.error && <div className="message-error">{record.error}</div>}
          {running && !record?.finalText && (
            <div className="subagent-card-live">
              <span className="pulse-dot" />
              <span>
                {activeCall
                  ? `正在执行 ${activeCall.tool}${activeCall.target ? ' · ' + activeCall.target : ''}`
                  : liveText
                    ? liveText.replace(/\s+/g, ' ').slice(0, 240)
                    : record?.draft?.thinking
                      ? '正在思考…'
                      : '正在处理…'}
              </span>
            </div>
          )}
          {record?.finalText && (
            <div className="subagent-card-final">
              <Markdown>{record.finalText}</Markdown>
            </div>
          )}
          {!record && !running && call.result && <pre className="tool-result">{call.result}</pre>}
          <div className="subagent-card-actions">
            <button className="ghost" onClick={() => onOpen(id)}>
              查看详细进程
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking">
      <button className="thinking-head" onClick={() => setOpen((value) => !value)}>
        <SparkIcon size={13} />
        <span>思考过程</span>
        <ChevronIcon size={12} className={open ? 'rotated' : ''} />
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}

const Message = memo(function Message({
  item,
  userIndex,
  onEditTurn,
  subagents,
  onOpenSubagent
}: {
  item: ChatItem
  /** Position among user turns, or -1 for a bubble that is not a settled user message. */
  userIndex: number
  onEditTurn: (index: number, text: string, images: DraftImage[]) => void
  subagents: SubagentView[]
  onOpenSubagent: (id?: string) => void
}) {  if (item.role === 'system') {
    return (
      <article className="message system" data-message-id={item.id}>
        <div className="system-notice">
          <span className="system-notice-tag">子代理</span>
          <span className="system-notice-text">{item.text}</span>
        </div>
      </article>
    )
  }
  if (item.role === 'user') {
    return <UserMessage item={item} index={userIndex} onEditTurn={onEditTurn} />
  }
  const starts = item.toolCalls.filter((call) => isSubagentStart(call.name))
  const others = item.toolCalls.filter((call) => !isSubagentStart(call.name))
  return (
    <article className="message assistant" data-message-id={item.id}>
      <div className="assistant-body">
        {item.thinking && <Thinking text={item.thinking} />}
        {item.text && <Markdown>{item.text}</Markdown>}
        {starts.map((call) => {
          const id = subagentIdFrom(call.result)
          const record = id
            ? subagents.find((entry) => entry.id === id)
            : (() => {
                const hint = subagentHint(call)
                if (!hint.label) return undefined
                return subagents.find((entry) => entry.label === hint.label)
              })()
          return <SubagentCard key={call.id} call={call} record={record} onOpen={onOpenSubagent} />
        })}
        {others.length > 0 && <ToolList calls={others} />}
        {item.error && <div className="message-error">{item.error}</div>}
        {item.streaming && !item.text && item.toolCalls.length === 0 && (
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </article>
  )
})

const SUGGESTIONS = [
  '梳理这个仓库的目录结构，并说明核心模块',
  '找出最近一次失败的测试并修复它',
  '为当前改动写一份提交信息',
  '解释 src 里最关键的一条调用链'
]

/**
 * The user's own message: pasted logs and specs are legitimately long, and a hundred-line bubble
 * pushes the answer it was asking for off screen. The bubble keeps the beginning and offers the rest.
 *
 * Whether it overflows is measured, not guessed from a character count: the same text wraps
 * differently at every window width, and a clamp on short text would hide the tail of a one-liner.
 * The measurement always happens in the clamped state (`overflowing` is left alone while expanded),
 * so the toggle cannot disappear from under the cursor that just clicked it.
 */
function UserBubble({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  const measure = (): void => {
    const node = ref.current
    if (!node || expanded) return
    const next = node.scrollHeight > node.clientHeight + 2
    setOverflowing((previous) => (previous === next ? previous : next))
  }

  useLayoutEffect(() => {
    measure()
  }, [text, expanded])

  // A wider window can make the same message fit; a narrower one can start clipping it.
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(node)
    return () => observer.disconnect()
  }, [text, expanded])

  return (
    <div
      className={[
        'user-bubble',
        expanded ? 'expanded' : '',
        overflowing ? 'overflowing' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="user-bubble-text" ref={ref}>
        {text}
      </div>
      {overflowing && (
        <button className="user-bubble-toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  )
}

/**
 * One of the user's own messages, with the edit affordance.
 *
 * Editing rewrites history: the engine drops everything from this turn on and the edited text is
 * sent in its place, so the editor says so out loud. Attachments work exactly like the composer's
 * (same hook: paste, drop, pick, remove, video frames) — an edit may rewrite what was attached too,
 * and a user who can add a picture in one box but not the other would rightly call that a bug.
 */
function UserMessage({
  item,
  index,
  onEditTurn
}: {
  item: ChatItem
  index: number
  onEditTurn: (index: number, text: string, images: DraftImage[]) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<DraftImage[]>([])
  const [preview, setPreview] = useState<DraftImage>()
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const { convertingVideos, dragging, handleFiles, removeImage, dropProps } = useDraftImages({
    images: attachments,
    onImagesChange: setAttachments,
    input: inputRef
  })
  const editing = draft !== null
  // A bubble that has not settled (still being delivered) is not in the engine's history yet.
  const editable = index >= 0 && !item.pending
  const canSend = draft !== null && (draft.trim().length > 0 || attachments.length > 0)

  const open = (): void => {
    setDraft(item.text)
    // The message's own pictures start in the editor, as attachments that can be removed or added to.
    setAttachments(
      (item.images ?? []).map((image, at) => ({ id: `edit-${at}`, data: image.data, mimeType: image.mimeType }))
    )
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const close = (): void => {
    setDraft(null)
    setAttachments([])
  }

  const submit = (): void => {
    if (!canSend) return
    const text = draft.trim()
    const images = attachments
    close()
    onEditTurn(index, text, images)
  }

  return (
    <article className={`message user ${item.pending ? 'pending' : ''}`} data-message-id={item.id}>
      {!editing && item.images && item.images.length > 0 && (
        <MessageImages images={item.images} align="end" />
      )}
      {editing ? (
        <div className={`user-edit ${dragging ? 'dragging' : ''}`} {...dropProps}>
          <DraftImageStrip images={attachments} onRemove={removeImage} onPreview={setPreview} />
          {convertingVideos > 0 && (
            <div className="video-converting" role="status">
              正在本地抽取关键帧…视频不会原样上传，暂不支持音轨识别
            </div>
          )}
          <textarea
            className="user-edit-input"
            ref={inputRef}
            value={draft}
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
                return
              }
              // Enter sends, Shift+Enter breaks the line — the composer's own contract.
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (convertingVideos > 0) return
              submit()
            }}
          />
          <div className="user-edit-actions">
            <input
              ref={fileRef}
              className="attachment-input"
              type="file"
              accept="image/*,video/mp4,video/webm,video/quicktime,video/ogg,.mkv"
              multiple
              tabIndex={-1}
              aria-hidden
              onChange={(event) => {
                handleFiles(Array.from(event.target.files ?? []))
                event.target.value = ''
              }}
            />
            <button
              className="user-edit-attach"
              disabled={convertingVideos > 0}
              title="添加图片或视频（视频本地抽帧，不含音轨；也可以直接粘贴或拖入）"
              aria-label="添加图片或视频"
              onClick={() => fileRef.current?.click()}
            >
              <PaperclipIcon size={13} />
            </button>
            <span className="user-edit-hint">发送后，这条之后的对话会被丢弃</span>
            <button className="user-edit-btn ghost" onClick={close}>
              取消
            </button>
            <button
              className="user-edit-btn primary"
              disabled={!canSend || convertingVideos > 0}
              onClick={submit}
            >
              重新发送
            </button>
          </div>
        </div>
      ) : (
        item.text && <UserBubble text={item.text} />
      )}
      {editable && !editing && (
        <button
          className="user-edit-open"
          title="编辑这条并从它重新发送（后面的对话会被丢弃）"
          onClick={open}
        >
          <PencilIcon size={11} />
          编辑
        </button>
      )}
      {preview && (
        <ImageLightbox src={imageSrc(preview)} alt={preview.name} onClose={() => setPreview(undefined)} />
      )}
    </article>
  )
}

export function Conversation({
  items,
  workspace,
  connected,
  loggedIn,
  subagents,
  onOpenSubagent,
  onSuggestion,
  onEditTurn,
  sessionKey,
  anchorId,
  scrollRef,
  loading,
  pending = [],
  onSendNow,
  onCancel
}: {
  items: ChatItem[]
  workspace: string
  connected: boolean
  loggedIn: boolean
  subagents: SubagentView[]
  onOpenSubagent: (id?: string) => void
  onSuggestion: (text: string) => void
  /** Rewrite history from the `index`-th user message and send it again. */
  onEditTurn: (index: number, text: string, images: DraftImage[]) => void
  /** Identity of this conversation: the window resets per session, never per streamed event. */
  sessionKey?: string
  /** Message the reader was last on; the window opens around it instead of the tail. */
  anchorId?: string
  /** The transcript's scroll box, needed to notice a scroll back to the top. */
  scrollRef?: React.RefObject<HTMLDivElement | null>
  /** History is on its way: say so instead of claiming the conversation is empty. */
  loading?: boolean
  /**
   * Messages the engine is still holding for this session.
   *
   * Rendered at the user's place at the end of the transcript, not in a floating panel: they are
   * messages the user wrote, they just have not been delivered yet. The pane deliberately does not
   * scroll to them — the reader stays where they were while the run in flight finishes.
   */
  pending?: PendingSend[]
  onSendNow?: (item: PendingSend) => void
  onCancel?: (item: PendingSend) => void
}) {
  const windowRef = useRef<{ key?: string; start: number }>({ start: 0 })
  const heightRef = useRef(0)
  const [, bump] = useState(0)
  const anchorIndex = anchorId ? items.findIndex((item) => item.id === anchorId) : -1
  // Decide once per session, when the transcript has actually arrived: for the first frames of a
  // switch `items` is empty, and the tail is the part the reader is looking at.
  if (items.length > 0 && windowRef.current.key !== sessionKey) {
    windowRef.current = {
      key: sessionKey,
      start: anchorIndex >= 0
        ? Math.max(0, anchorIndex - Math.floor(FIRST_WINDOW / 2))
        : Math.max(0, items.length - FIRST_WINDOW)
    }
  }
  const start = Math.min(
    Math.max(0, windowRef.current.start),
    Math.max(0, items.length - FIRST_WINDOW)
  )

  // Scrolling back asks for more of the transcript. The window grows instead of the list jumping:
  // the effect below keeps the line under the viewport still while rows are inserted above it.
  useEffect(() => {
    const container = scrollRef?.current
    if (!container) return
    const onScroll = (): void => {
      if (container.scrollTop > GROW_DISTANCE) return
      if (windowRef.current.start <= 0) return
      windowRef.current = {
        ...windowRef.current,
        start: Math.max(0, windowRef.current.start - WINDOW_STEP)
      }
      bump((value) => value + 1)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [scrollRef, sessionKey])

  // Rows above the viewport grow the scroll height; without this the text slides down as they load.
  // It also keeps a reader who is following the tail at the tail, because the bottom moved by the
  // same amount the content grew.
  useLayoutEffect(() => {
    const container = scrollRef?.current
    const previousHeight = heightRef.current
    if (!container || !previousHeight) return
    const delta = container.scrollHeight - previousHeight
    if (delta > 0) container.scrollTop += delta
  }, [start, scrollRef])
  useLayoutEffect(() => {
    const container = scrollRef?.current
    if (container) heightRef.current = container.scrollHeight
  })

  // A message on its way in already makes this a conversation, even before the engine echoes it
  // back: the first turn of a session is exactly when the bubble has to be visible somewhere.
  if (items.length === 0 && pending.length === 0) {
    // A conversation being loaded is not an empty one. Without this the window offered 「开始一段
    // 对话」 over a session whose engine was still starting, which reads as "my history is gone".
    if (loading) {
      return (
        <div className="empty">
          <div className="empty-mark">π</div>
          <p className="empty-sub">正在载入会话…</p>
        </div>
      )
    }
    return (
      <div className="empty">
        <div className="empty-mark">π</div>
        <h1>开始一段对话</h1>
        <p className="empty-sub">
          当前工作目录 <code>{workspace}</code>
        </p>
        {!connected && <p className="empty-warn">引擎尚未就绪，请查看顶部状态提示。</p>}
        {connected && !loggedIn && (
          <p className="empty-warn">尚未配置模型服务：打开设置 → 服务商完成配置。</p>
        )}
        <div className="suggestions">
          {SUGGESTIONS.map((text) => (
            <button key={text} className="suggestion" onClick={() => onSuggestion(text)}>
              {text}
            </button>
          ))}
        </div>
      </div>
    )
  }

  // The engine counts user turns, so each bubble has to know its own position among them. Rows
  // hidden above the window still count — otherwise editing a message would rewrite the wrong turn.
  let userTurns = items
    .slice(0, start)
    .filter((item) => item.role === 'user' && !item.pending).length - 1
  return (
    <div className="conversation" data-window-start={start}>
      {start > 0 && (
        <div className="conversation-earlier">向上滚动加载更早的消息（还有 {start} 条）</div>
      )}
      {items.slice(start).map((item) => {
        if (item.role === 'user' && !item.pending) userTurns += 1
        return (
          <Message
            key={item.id}
            item={item}
            userIndex={item.role === 'user' && !item.pending ? userTurns : -1}
            onEditTurn={onEditTurn}
            subagents={subagents}
            onOpenSubagent={onOpenSubagent}
          />
        )
      })}
      {onSendNow && onCancel && (
        <PendingSends items={pending} onSendNow={onSendNow} onCancel={onCancel} inline />
      )}
    </div>
  )
}
