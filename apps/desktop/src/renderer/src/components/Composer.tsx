import { EnginePicker } from './EnginePicker'
import type { EngineCapabilities, EngineCommand } from '@shared/engine'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ModelOption, PiStatus, SpeedMode } from '@shared/types'
import {
  BranchIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  FolderIcon,
  PaperclipIcon,
  PencilIcon,
  SearchIcon,
  SendIcon,
  StopIcon
} from './Icons'
import { DraftImageStrip, ImageLightbox } from './ImageLightbox'
import { insertFileMention } from '../lib/composer'
import { contextLabel } from '../lib/context-usage'
import { useDismissable } from '../hooks/useDismissable'
import { useDraftImages } from '../hooks/useDraftImages'
import type { QueuedMessage } from '../lib/chat-types'
import { imageSrc, type DraftImage } from '../lib/images'

const THINKING_LABELS: Record<string, string> = {
  off: '关闭',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大'
}

/** Request-level processing tiers; the labels match what each vendor sells them as. */
const SPEED_LABELS: Record<SpeedMode, string> = {
  standard: '标准',
  fast: '快速',
  ultrafast: '极速'
}

const SPEED_OPTIONS: Array<{ mode: SpeedMode; label: string; hint: string }> = [
  { mode: 'standard', label: '标准', hint: '服务商默认档位，计价与平时一致' },
  {
    mode: 'fast',
    label: '快速',
    hint: 'OpenAI service_tier=fast / Claude speed=fast，按快速档计价；需要 API 计费或支持该档位的套餐，账号不支持时会回退标准'
  },
  {
    mode: 'ultrafast',
    label: '极速',
    hint: 'OpenAI service_tier=ultrafast，仅 gpt-6-astra / gpt-6.1-sol，且需要 API 计费或支持该档位的套餐'
  }
]

export function Composer({
  value,
  onChange,
  images,
  onImagesChange,
  queued,
  onQueueRemove,
  onQueueEdit,
  onQueueSendNow,
  onNotice,
  onSend,
  onRunCommand,
  onStop,
  streaming,
  disabled,
  status,
  contextUsage,
  autoCompactPercent,
  onChooseWorkspace,
  statusBar,
  capabilities,
  commands,
  suggestion,
  onSuggestionUsed
}: {
  value: string
  onChange: (value: string) => void
  images: DraftImage[]
  onImagesChange: (images: DraftImage[]) => void
  queued: QueuedMessage[]
  onQueueRemove: (id: string) => void
  onQueueEdit: (id: string) => void
  /** Stop the run and send this queued item now — the only hard interrupt in the app. */
  onQueueSendNow: (id: string) => void
  onNotice?: (message: string) => void
  onSend: (mode: 'send' | 'steer') => void
  /**
   * Run a picked slash command on the spot. Only commands that take no arguments come here: the
   * composer decides *when* a command runs, `runCommand` decides what it does.
   */
  onRunCommand?: (text: string) => void
  onStop: () => void
  streaming: boolean
  disabled: boolean
  status: PiStatus
  /** Current context-window usage from `get_session_stats`. */
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null }
  /** Where auto-compaction starts, as a percentage; shown in the meter's tooltip. */
  autoCompactPercent?: number
  onChooseWorkspace: () => void
  /** Run summary rendered directly above the input, so it reads as part of the composer. */
  statusBar?: ReactNode
  /**
   * What the active engine supports. A CLI engine owns its own loop, so compaction and the side chat
   * are its own commands — offering ours would only produce "not supported" after the click.
   */
  capabilities?: EngineCapabilities
  commands: EngineCommand[]
  /**
   * Predicted next message for this conversation. Rendered as ghost text while the draft is empty
   * (or a prefix of it, so Tab completes what was started) and as a chip above the box.
   */
  suggestion?: string
  /** The suggestion was accepted or dismissed; the window forgets it until the next turn. */
  onSuggestionUsed?: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const contextRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  /**
   * Attachments come from the shared hook so the composer and the history editor behave the same way
   * (same paste, same drop, same video frames). Only the text input itself is composer-specific.
   */
  const { convertingVideos, dragging, handleFiles, removeImage, dropProps } = useDraftImages({
    images,
    onImagesChange,
    onNotice,
    disabled,
    input: ref
  })
  const [modelOpen, setModelOpen] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelQuery, setModelQuery] = useState('')
  const [modelLoading, setModelLoading] = useState(false)
  const [modelError, setModelError] = useState<string>()
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [levels, setLevels] = useState<string[]>([])
  const [thinkingLoading, setThinkingLoading] = useState(false)
  const [thinkingError, setThinkingError] = useState<string>()
  const [speedOpen, setSpeedOpen] = useState(false)
  const [speedBusy, setSpeedBusy] = useState(false)
  const [speedError, setSpeedError] = useState<string>()
  const [preview, setPreview] = useState<DraftImage>()
  /**
   * A prediction is only shown while it could be what the user is already typing: an empty draft, or
   * a strict prefix of the suggestion. Once the draft diverges it is wrong, so it disappears —
   * silently replacing or appending somebody's half-written message would be worse than nothing.
   */
  const suggestionFits = Boolean(
    suggestion &&
      !disabled &&
      !streaming &&
      !status.compacting &&
      !status.switchingEngine &&
      (value === '' || (value.length < suggestion.length && suggestion.startsWith(value)))
  )
  /** The untyped part, drawn as ghost text after what is already in the box. */
  const ghostText = suggestionFits ? suggestion!.slice(value.length) : undefined
  const [slashIndex, setSlashIndex] = useState(0)
  // Set when a command was inserted from the menu, so Enter sends instead of re-applying it.
  const [slashPicked, setSlashPicked] = useState<string | undefined>(undefined)
  const [contextOpen, setContextOpen] = useState(false)
  const [contextQuery, setContextQuery] = useState('')
  const [contextFiles, setContextFiles] = useState<string[]>([])
  const [contextLoading, setContextLoading] = useState(false)
  const [contextError, setContextError] = useState<string>()

  // Images are plain attachments: no filename captions, no [图片N] markers in the text.
  const slashQuery =
    value !== slashPicked && value.startsWith('/') && !value.includes(' ') && !value.includes('\n')
      ? value.slice(1).toLowerCase()
      : undefined
  // Only offer what the engine can answer.
  const availableCommands = commands
  const slashMatches =
    slashQuery === undefined
      ? []
      : availableCommands.filter((command) => command.name.slice(1).startsWith(slashQuery))

  const applyCommand = (name: string, args: string): void => {
    const next = args ? `${name} ` : name
    onChange(next)
    setSlashPicked(next)
    setSlashIndex(0)
    requestAnimationFrame(() => {
      const element = ref.current
      if (!element) return
      element.focus()
      element.setSelectionRange(next.length, next.length)
    })
  }

  const openContextPicker = async (): Promise<void> => {
    if (contextOpen) {
      setContextOpen(false)
      return
    }
    setContextOpen(true)
    setContextQuery('')
    setContextError(undefined)
    setContextLoading(true)
    try {
      setContextFiles(await window.pi.listWorkspaceFiles())
    } catch (error) {
      setContextError(error instanceof Error ? error.message : String(error))
    } finally {
      setContextLoading(false)
    }
  }

  const insertContext = (file: string): void => {
    const node = ref.current
    const caret = node?.selectionStart ?? value.length
    const { text: next, caret: position } = insertFileMention(value, caret, file)
    onChange(next)
    setContextOpen(false)
    requestAnimationFrame(() => {
      const element = ref.current
      if (!element) return
      element.focus()
      element.setSelectionRange(position, position)
    })
  }

  const filteredFiles = useMemo(() => {
    const needle = contextQuery.trim().toLowerCase()
    const list = needle
      ? contextFiles.filter((file) => file.toLowerCase().includes(needle))
      : contextFiles
    return list.slice(0, 80)
  }, [contextFiles, contextQuery])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`
  }, [value])

  useEffect(() => {
    ref.current?.focus()
  }, [])

  useDismissable(modelOpen || thinkingOpen || speedOpen, pickerRef, () => {
    setModelOpen(false)
    setThinkingOpen(false)
    setSpeedOpen(false)
  })
  useDismissable(contextOpen, contextRef, () => setContextOpen(false))

  useEffect(() => {
    let stale = false
    setLevels([])
    setThinkingOpen(false)
    setModelOpen(false)
    setModels([])
    if (status.phase === 'ready' && status.model) {
      void window.pi.listThinkingLevels().then(next => { if (!stale) setLevels(next) }).catch(() => {})
    }
    return () => { stale = true }
  }, [status.engine, status.model?.provider, status.model?.id, status.phase])

  const openModelPicker = async (): Promise<void> => {
    if (modelOpen) {
      setModelOpen(false)
      return
    }
    setModelOpen(true)
    setModelQuery('')
    setModelLoading(true)
    setModelError(undefined)
    setTimeout(() => searchRef.current?.focus(), 0)
    try {
      setModels(await window.pi.listModels())
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error))
    } finally {
      setModelLoading(false)
    }
  }

  const chooseModel = async (model: ModelOption): Promise<void> => {
    if (model.provider === status.model?.provider && model.id === status.model.id) {
      setModelOpen(false)
      return
    }
    setModelLoading(true)
    setModelError(undefined)
    const result = await window.pi.setModel(model.provider, model.id).catch(error => ({ ok: false, error: String(error) }))
    setModelLoading(false)
    if (!result.ok) {
      setModelError(result.error ?? '切换模型失败')
      return
    }
    setModelOpen(false)
  }

  const groups = useMemo(() => {
    const needle = modelQuery.trim().toLowerCase()
    const map = new Map<string, ModelOption[]>()
    for (const model of models) {
      const providerName = model.providerName ?? model.provider
      const haystack = `${model.name ?? ''} ${model.id} ${providerName}`.toLowerCase()
      if (needle && !haystack.includes(needle)) continue
      const list = map.get(providerName) ?? []
      list.push(model)
      map.set(providerName, list)
    }
    return [...map.entries()]
  }, [models, modelQuery])

  const openThinkingPicker = async (): Promise<void> => {
    if (thinkingOpen) {
      setThinkingOpen(false)
      return
    }
    setThinkingOpen(true)
    setSpeedOpen(false)
    setThinkingLoading(true)
    setThinkingError(undefined)
    try {
      setLevels(await window.pi.listThinkingLevels())
    } catch (error) {
      setThinkingError(error instanceof Error ? error.message : String(error))
    } finally {
      setThinkingLoading(false)
    }
  }

  const chooseThinking = async (level: string): Promise<void> => {
    if (level === status.thinkingLevel) {
      setThinkingOpen(false)
      return
    }
    setThinkingLoading(true)
    setThinkingError(undefined)
    const result = await window.pi.setThinkingLevel(level).catch(error => ({ ok: false, error: String(error) }))
    setThinkingLoading(false)
    if (!result.ok) {
      setThinkingError(result.error ?? '切换思考等级失败')
      return
    }
    setThinkingOpen(false)
  }

  /**
   * Speed tier. The main process restarts pi so the extension picks the new value up; while a run is
   * in flight that restart is deferred, so the switch reports the saved mode immediately.
   */
  const chooseSpeed = async (mode: SpeedMode): Promise<void> => {
    if (mode === speed?.mode) {
      setSpeedOpen(false)
      return
    }
    setSpeedBusy(true)
    setSpeedError(undefined)
    const result = await window.pi.setSpeedMode(mode)
    setSpeedBusy(false)
    if (!result.ok) {
      setSpeedError(result.error ?? '切换速度档位失败')
      return
    }
    setSpeedOpen(false)
  }

  const workspace = status.cwd.split(/[\\/]/).filter(Boolean).pop() ?? status.cwd
  const speed = status.speed
  const speedOptions = SPEED_OPTIONS
  const activeLabel = status.model
    ? (models.find(
        (model) => model.provider === status.model?.provider && model.id === status.model?.id
      )?.name ??
      status.model.name ??
      status.model.id)
    : '未登录 / 无可用模型'

  /**
   * Usage against the *effective* ceiling rather than the raw window.
   *
   * Auto-compaction rewrites the context at `autoCompactPercent`, so that point — 500K of a 1M
   * window at 50% — is the budget a run can really use; showing 1M described a limit the session
   * never reaches. With compaction off the ceiling is the window itself.
   */
  const contextMeter = (() => {
    const window = contextUsage?.contextWindow
    if (!window) return undefined
    const ceiling =
      typeof autoCompactPercent === 'number' && autoCompactPercent > 0 && autoCompactPercent < 100
        ? Math.max(1, Math.round((autoCompactPercent / 100) * window))
        : window
    const used = typeof contextUsage?.tokens === 'number' ? contextUsage.tokens : undefined
    if (used === undefined) return undefined
    const percent = used ? Math.round((used / ceiling) * 100) : 0
    const tone = percent >= 100 ? 'danger' : percent >= 85 ? 'warn' : ''
    return {
      percent,
      tone,
      usedLabel: used ? contextLabel(used) : '—',
      ceilingLabel: contextLabel(ceiling),
      windowLabel: contextLabel(window),
      compacting: ceiling !== window
    }
  })()

  return (
    <div className="composer-wrap">
      {statusBar}
      {queued.length > 0 && (
        <div className="queue-panel">
          <div className="queue-head">
            <span className="queue-count">{queued.length} 条排队消息</span>
            <span className="queue-hint">
              {queued.some((item) => item.command)
                ? '回合结束后自动发送 / 执行；点「立即发送」会打断当前回合'
                : '回合结束后自动发送；点「立即发送」会打断当前回合'}
            </span>
          </div>
          {queued.map((item) => (
            <div className="queue-item" key={item.id}>
              {item.command && <span className="queue-tag">命令</span>}
              <span className="queue-text" title={item.text}>
                {item.text || `${item.images.length} 张图片`}
              </span>
              {!item.command && (
                <button
                  className="queue-now"
                  title="停掉当前回合，立刻把这条发出去"
                  onClick={() => onQueueSendNow(item.id)}
                >
                  <SendIcon size={10} />
                  立即发送
                </button>
              )}
              <button className="queue-btn" title="编辑" onClick={() => onQueueEdit(item.id)}>
                <PencilIcon size={11} />
              </button>
              <button className="queue-btn" title="删除" onClick={() => onQueueRemove(item.id)}>
                <CloseIcon size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`composer ${disabled ? 'disabled' : ''} ${dragging ? 'dragging' : ''}`}
        {...dropProps}
      >
        {slashMatches.length > 0 && (
          <div className="slash-menu">
            {slashMatches.map((command, index) => (
              <button
                key={command.name}
                className={`slash-item ${index === Math.min(slashIndex, slashMatches.length - 1) ? 'active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  // Same rule as Enter: picking a command that takes nothing runs it.
                  if (!command.args && onRunCommand) onRunCommand(command.name)
                  else applyCommand(command.name, command.args)
                }}
              >
                <span className="slash-name">
                  {command.name}
                  {command.args && <span className="slash-args"> {command.args}</span>}
                </span>
                <span className="slash-hint">{command.hint}</span>
              </button>
            ))}
          </div>
        )}
        <DraftImageStrip images={images} onRemove={removeImage} onPreview={setPreview} />
        {convertingVideos > 0 && (
          <div className="video-converting" role="status">
            正在本地抽取关键帧…视频不会原样上传，暂不支持音轨识别
          </div>
        )}
        {suggestionFits && (
          <button
            type="button"
            className="composer-suggestion"
            // Keep the caret in the textarea: accepting is a keystroke, not a focus change.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange(suggestion!)
              ref.current?.focus()
            }}
            title="按 Tab 填入"
          >
            <span className="suggestion-label">下一句</span>
            <span className="suggestion-text">{suggestion}</span>
            <kbd>Tab</kbd>
          </button>
        )}
        <div className="composer-input">
          <textarea
            ref={ref}
            value={value}
            rows={1}
            spellCheck={false}
            placeholder={
              ghostText !== undefined
                ? ''
                : status.compacting
                  ? '正在压缩上下文，结束后会自动继续…'
                  : streaming
                    ? capabilities?.steer
                      ? '继续输入，Enter 引导（等当前步骤结束）'
                      : '继续输入，Enter 排队'
                    : '发送消息…（可粘贴图片，或添加图片 / 视频）'
            }
            onChange={(event) => {
              const next = event.target.value
              if (next !== slashPicked) setSlashPicked(undefined)
              onChange(next)
              if (next.endsWith('@') && (next.length === 1 || /\s/.test(next[next.length - 2]))) {
                void openContextPicker()
              }
            }}
            onKeyDown={(event) => {
              if (slashMatches.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setSlashIndex((index) => (index + 1) % slashMatches.length)
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setSlashIndex((index) => (index - 1 + slashMatches.length) % slashMatches.length)
                  return
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault()
                  const command = slashMatches[Math.min(slashIndex, slashMatches.length - 1)]
                  // Enter runs a command that takes nothing. Filling the box and waiting for a second
                  // Enter made `/clear` and `/status` look broken. A command with arguments still
                  // fills the box (Tab completes any of them), so `[提示词]` can be typed first.
                  if (event.key === 'Enter' && !command.args && !event.nativeEvent.isComposing) {
                    onRunCommand?.(command.name)
                    return
                  }
                  applyCommand(command.name, command.args)
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  onChange('')
                  return
                }
              }
              // An IME owns Tab/Esc/Enter until the candidate is committed.
              if (!event.nativeEvent.isComposing) {
                if (event.key === 'Tab' && ghostText !== undefined && !event.shiftKey) {
                  // Accept the prediction: fill the box, do not send. The remainder is exactly what
                  // the ghost is showing, so the text never jumps.
                  event.preventDefault()
                  onChange(value + ghostText)
                  onSuggestionUsed?.()
                  return
                }
                if (event.key === 'Escape' && suggestionFits) {
                  event.preventDefault()
                  onSuggestionUsed?.()
                  return
                }
              }
              if (event.key !== 'Enter') return
              if (event.nativeEvent.isComposing) return
              if (event.shiftKey) return
              event.preventDefault()
              if (convertingVideos > 0) {
                onNotice?.('视频正在抽帧，请稍候再发送')
                return
              }
              // Running turn: Enter steers (the message joins the current run), Ctrl+Enter queues it
              // for after the run. Idle, both just send.
              if (event.ctrlKey || event.metaKey) onSend('send')
              else if (streaming && !status.compacting && capabilities?.steer) onSend('steer')
              else onSend('send')
            }}
          />
          {ghostText !== undefined && (
            <div className="composer-ghost" aria-hidden>
              {/* The typed part is invisible but occupies its width, so the ghost starts at the caret. */}
              <span className="composer-ghost-typed">{value}</span>
              <span className="composer-ghost-rest">{ghostText}</span>
            </div>
          )}
        </div>
        <div className="composer-foot">
          <div className="composer-left" ref={contextRef}>
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
              className="attach-btn media-attach"
              disabled={disabled || convertingVideos > 0}
              title="添加图片或视频（视频本地抽帧，不含音轨）"
              aria-label="添加图片或视频"
              onClick={() => fileRef.current?.click()}
            >
              <PaperclipIcon size={16} />
            </button>
            <button
              className={`attach-btn context-btn ${contextOpen ? 'open' : ''}`}
              title="引用上下文（@ 文件或目录）"
              onClick={() => void openContextPicker()}
            >
              <span className="at-mark">@</span>
            </button>
            {contextOpen && (
              <div className="context-picker">
                <div className="context-picker-search">
                  <SearchIcon size={13} />
                  <input
                    autoFocus
                    value={contextQuery}
                    onChange={(event) => setContextQuery(event.target.value)}
                    placeholder="搜索文件或目录"
                    spellCheck={false}
                  />
                </div>
                <div className="context-picker-list">
                  {contextLoading && <div className="context-picker-empty">读取工作目录…</div>}
                  {!contextLoading && contextError && (
                    <div className="context-picker-empty">{contextError}</div>
                  )}
                  {!contextLoading && !contextError && filteredFiles.length === 0 && (
                    <div className="context-picker-empty">没有匹配的文件</div>
                  )}
                  {filteredFiles.map((file) => (
                    <button
                      key={file}
                      className="context-picker-item"
                      onClick={() => insertContext(file)}
                      title={file}
                    >
                      {file}
                    </button>
                  ))}
                </div>
                <div className="context-picker-foot">
                  选中后插入 <code>@路径</code>，pi 会自己读取
                </div>
              </div>
            )}
            <button
              className="chip"
              disabled={status.sessionLocked || streaming}
              onClick={onChooseWorkspace}
              title={`${status.cwd}${status.sessionLocked ? '（会话已开始，目录已锁定）' : '（选择工作目录）'}`}
            >
              <FolderIcon size={12} />
              <span>{workspace}</span>
              {status.repo?.isRepo && status.repo.branch && (
                <span className="chip-branch">
                  <BranchIcon size={10} />
                  {status.repo.branch}
                </span>
              )}
            </button>
          </div>
          <div className="composer-right">
            {contextMeter && (
              <div
                className={`context-meter ${contextMeter.tone}`}
                title={
                  contextMeter.compacting
                    ? `上下文 ${contextMeter.usedLabel} / ${contextMeter.ceilingLabel}` +
                      `（窗口 ${contextMeter.windowLabel}，到 ${autoCompactPercent}% 自动压缩）`
                    : `上下文 ${contextMeter.usedLabel} / ${contextMeter.windowLabel}（${capabilities?.autoCompaction === 'native' ? '自动压缩由引擎管理' : '自动压缩已关闭'}）`
                }
              >
                <span
                  className="context-ring"
                  style={{ ['--p' as string]: `${contextMeter.percent}%` }}
                />
                <span className="context-meter-value">{contextMeter.percent}%</span>
                <span className="context-meter-sub">
                  {contextMeter.usedLabel} / {contextMeter.ceilingLabel}
                </span>
              </div>
            )}
            <EnginePicker compact status={status} disabled={disabled && status.phase === 'ready'} onNotice={onNotice} />
            {capabilities?.models && (
              <div className="model-pill" ref={pickerRef}>
                <button
                  className={`pill-seg model ${status.model ? '' : 'warn'} ${modelOpen ? 'open' : ''}`}
                  onClick={() => void openModelPicker()}
                  disabled={streaming || disabled}
                  title="选择模型"
                >
                  <span>{activeLabel}</span>
                </button>
                {capabilities?.thinking && levels.length > 0 && (
                  <>
                    <span className="pill-sep" />
                    <button
                      className={`pill-seg thinking ${thinkingOpen ? 'open' : ''}`}
                      onClick={() => void openThinkingPicker()}
                      disabled={streaming || disabled || levels.every(level => level === 'off')}
                      title="选择思考等级"
                    >
                      <span>
                        {THINKING_LABELS[status.thinkingLevel ?? ''] ??
                          status.thinkingLevel ??
                          '默认'}
                      </span>
                      <ChevronIcon size={11} />
                    </button>
                  </>
                )}

                {speed && speed.available.length > 1 && (
                  <>
                    <span className="pill-sep" />
                    <button
                      className={`pill-seg speed ${speed.mode !== 'standard' ? 'on' : ''} ${
                        speedOpen ? 'open' : ''
                      }`}
                      onClick={() => {
                        setSpeedOpen((open) => !open)
                        setThinkingOpen(false)
                        setSpeedError(undefined)
                      }}
                      title={
                        speed.mode === 'standard'
                          ? '请求按服务商默认档位处理'
                          : `请求走 ${SPEED_LABELS[speed.mode]} 档位（按服务商计价）`
                      }
                    >
                      <span>{SPEED_LABELS[speed.mode]}</span>
                      <ChevronIcon size={11} />
                    </button>
                  </>
                )}

                {modelOpen && (
                  <div className="model-picker">
                    <div className="model-picker-search">
                      <SearchIcon size={13} />
                      <input
                        ref={searchRef}
                        value={modelQuery}
                        onChange={(event) => setModelQuery(event.target.value)}
                        placeholder="搜索模型或服务商"
                        spellCheck={false}
                      />
                    </div>

                    <div className="model-picker-list">
                      {modelLoading && <div className="model-picker-empty">加载模型列表…</div>}
                      {!modelLoading && groups.length === 0 && (
                        <div className="model-picker-empty">
                          {models.length === 0
                            ? '没有可用模型，请先在设置中登录服务商'
                            : '没有匹配的模型'}
                        </div>
                      )}
                      {groups.map(([providerName, list]) => (
                        <section key={providerName}>
                          <div className="model-group-label">{providerName}</div>
                          {list.map((model) => {
                            const active =
                              status.model?.provider === model.provider &&
                              status.model.id === model.id
                            return (
                              <button
                                key={`${model.provider}/${model.id}`}
                                className={`model-option ${active ? 'active' : ''}`}
                                onClick={() => void chooseModel(model)}
                              >
                                <span className="model-option-name">
                                  {model.name ?? model.id}
                                  {active && <CheckIcon size={12} />}
                                </span>
                                <span className="model-option-meta">
                                  {model.id}
                                  {model.contextWindow
                                    ? ` · ${contextLabel(model.contextWindow)}`
                                    : ''}
                                </span>
                              </button>
                            )
                          })}
                        </section>
                      ))}
                    </div>

                    {modelError && <div className="model-picker-error">{modelError}</div>}
                    <div className="model-picker-foot">
                      {models.length} 个可用模型 · 在设置中登录更多服务商
                    </div>
                  </div>
                )}

                {thinkingOpen && (
                  <div className="thinking-picker">
                    <div className="thinking-picker-head">思考等级</div>
                    {thinkingLoading && <div className="thinking-picker-empty">加载中…</div>}
                    {!thinkingLoading &&
                      levels.map((level) => {
                        const active = level === status.thinkingLevel
                        return (
                          <button
                            key={level}
                            className={`thinking-option ${active ? 'active' : ''}`}
                            onClick={() => void chooseThinking(level)}
                          >
                            <span className="thinking-option-label">
                              {THINKING_LABELS[level] ?? level}
                              <code>{level}</code>
                            </span>
                            {active && <CheckIcon size={12} />}
                          </button>
                        )
                      })}
                    {!thinkingLoading && levels.length === 0 && (
                      <div className="thinking-picker-empty">当前模型没有可用的思考等级</div>
                    )}
                    {thinkingError && <div className="thinking-picker-error">{thinkingError}</div>}
                  </div>
                )}

                {speedOpen && speed && (
                  <div className="thinking-picker speed-picker">
                    <div className="thinking-picker-head">速度档位</div>
                    {speedOptions.map((option) => {
                      const active = option.mode === speed.mode
                      return (
                        <button
                          key={option.mode}
                          className={`thinking-option ${active ? 'active' : ''}`}
                          disabled={speedBusy || !speed.available.includes(option.mode)}
                          onClick={() => void chooseSpeed(option.mode)}
                          title={option.hint}
                        >
                          <span className="thinking-option-label">
                            {option.label}
                            <code>{option.mode}</code>
                          </span>
                          {active && <CheckIcon size={12} />}
                        </button>
                      )
                    })}
                    {speed.note && <div className="thinking-picker-empty">{speed.note}</div>}
                    {speedError && <div className="thinking-picker-error">{speedError}</div>}
                  </div>
                )}
              </div>
            )}
            {streaming ? (
              <button className="send-btn stop" onClick={onStop} title="中止当前运行">
                <StopIcon size={14} />
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={() => onSend('send')}
                disabled={disabled || convertingVideos > 0 || (!value.trim() && images.length === 0)}
                title={convertingVideos > 0 ? '视频正在抽帧' : '发送 (Enter)'}
              >
                <SendIcon size={15} />
              </button>
            )}
          </div>
        </div>
      </div>

      {preview && (
        <ImageLightbox
          src={imageSrc(preview)}
          alt={preview.name}
          onClose={() => setPreview(undefined)}
        />
      )}
    </div>
  )
}
