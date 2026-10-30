import { useEffect, useMemo, useRef, useState } from 'react'
import type { SubagentView } from '@shared/types'
import { engineLabel } from '@shared/engine'
import { ChevronIcon, RefreshIcon, SparkIcon, StopIcon, ToolIcon } from './Icons'
import { Markdown } from './Markdown'
import { SUBAGENT_STATUS_LABELS, isSubagentRunning } from '../lib/subagents'
import { contextLabel, usageMeter, usagePair, usageTone } from '../lib/context-usage'

function span(ms: number | undefined): string {
  if (typeof ms !== 'number') return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** One row's second line: state, mode, engine, runtime and the run's own context meter. */
function rowStats(record: SubagentView): string {
  return [
    SUBAGENT_STATUS_LABELS[record.status],
    record.mode === 'background' ? '后台' : '同步',
    engineLabel(record.engine ?? 'pi'),
    span(record.runtimeMs),
    usageMeter(record.contextUsage) ||
      (contextLabel(record.tokens) ? `${contextLabel(record.tokens)} tokens` : '')
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The run's meter, drawn like the session one so both read as the same number. */
function ContextMeter({ usage }: { usage: SubagentView['contextUsage'] }) {
  if (!usage) return null
  const percent = typeof usage.percent === 'number' ? Math.round(usage.percent) : undefined
  return (
    <div
      className={`context-meter subagent-meter ${usageTone(usage)}`}
      title={`子代理自己的上下文：${usagePair(usage.tokens, usage.contextWindow)}`}
    >
      <span
        className="context-ring"
        style={{ ['--p' as string]: `${percent ?? 0}%` }}
      />
      <span className="context-meter-value">{percent === undefined ? '—' : `${percent}%`}</span>
      <span className="context-meter-sub">{usagePair(usage.tokens, usage.contextWindow)}</span>
    </div>
  )
}

function changedFiles(record: SubagentView): string[] {
  const seen = new Set<string>()
  for (const call of record.calls) {
    if (!['edit', 'write', 'apply_patch', 'edit_file', 'write_file'].includes(call.tool)) continue
    if (call.summary) seen.add(call.summary)
  }
  return [...seen]
}

type TimelineEntry =
  | {
      kind: 'call'
      key: string
      ts: number
      tool: string
      target?: string
      ok: boolean
      durationMs?: number
      running: boolean
    }
  | {
      kind: 'message'
      key: string
      ts: number
      role: 'assistant' | 'user'
      text: string
      toolCalls?: string[]
    }

/** Calls and messages in the order they happened, with in-flight calls at the end. */
function buildTimeline(record: SubagentView): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  record.messages.forEach((message, index) => {
    if (!message.text && !message.toolCalls?.length) return
    entries.push({
      kind: 'message',
      key: `m${index}`,
      ts: message.ts,
      role: message.role,
      text: message.text,
      toolCalls: message.toolCalls
    })
  })
  record.calls.forEach((call, index) => {
    entries.push({
      kind: 'call',
      key: `c${index}`,
      ts: call.ts,
      tool: call.tool,
      target: call.summary,
      ok: call.ok,
      durationMs: call.durationMs,
      running: false
    })
  })
  for (const call of record.activeCalls ?? []) {
    entries.push({
      kind: 'call',
      key: `a${call.id}`,
      ts: call.startedAt,
      tool: call.tool,
      target: call.target,
      ok: true,
      running: true
    })
  }
  return entries.sort((a, b) => a.ts - b.ts)
}

/** One line describing what the subagent is doing right now. */
function liveActivity(record: SubagentView): string {
  const active = record.activeCalls ?? []
  if (active.length > 0) {
    const [first] = active
    const more = active.length > 1 ? ` 等 ${active.length} 个` : ''
    return `正在执行 ${first.tool}${first.target ? ' · ' + first.target : ''}${more}`
  }
  if (record.draft?.text) return '正在生成回复'
  if (record.draft?.thinking) return '正在思考'
  return record.status === 'starting' ? '正在启动' : '正在处理'
}

/**
 * Right-hand drawer for subagent runs: the list is one click away from the chat, and a run opens
 * in place instead of covering the conversation with a modal.
 */
export function SubagentsDrawer({
  records,
  initialId,
  onClose
}: {
  records: SubagentView[]
  initialId?: string
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(initialId ?? null)
  const [detailOpen, setDetailOpen] = useState(Boolean(initialId))
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'steer' | 'follow-up' | 'interrupt'>('steer')
  const [busy, setBusy] = useState(false)
  const [showProgress, setShowProgress] = useState(true)
  const timelineRef = useRef<HTMLDivElement>(null)
  /** Keep the newest line in view unless the user scrolled up to read something. */
  const stickRef = useRef(true)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return records
    return records.filter((record) =>
      `${record.id} ${record.label ?? ''} ${record.agent ?? ''} ${record.finalText ?? ''} ${record.cwd}`
        .toLowerCase()
        .includes(needle)
    )
  }, [records, query])

  const selected = useMemo(
    () => records.find((record) => record.id === selectedId) ?? undefined,
    [records, selectedId]
  )
  const entries = useMemo(() => (selected ? buildTimeline(selected) : []), [selected])
  const running = selected ? isSubagentRunning(selected) : false

  useEffect(() => {
    if (!initialId) return
    setSelectedId(initialId)
    setDetailOpen(true)
  }, [initialId])

  useEffect(() => {
    setDraft('')
    setShowProgress(true)
    stickRef.current = true
  }, [selected?.id])

  // Streaming updates repaint the panel several times a second; follow the tail like a terminal.
  useEffect(() => {
    const element = timelineRef.current
    if (!element || !stickRef.current) return
    element.scrollTop = element.scrollHeight
  })

  const open = (id: string): void => {
    setSelectedId(id)
    setDetailOpen(true)
  }

  const stop = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    await window.pi.stopSubagent(selected.id)
    setBusy(false)
  }

  const send = async (): Promise<void> => {
    if (!selected || !draft.trim()) return
    setBusy(true)
    const ok = await window.pi.promptSubagent(selected.id, draft.trim(), mode)
    setBusy(false)
    if (ok) setDraft('')
  }

  return (
    <aside className="subagent-drawer">
      <header className="drawer-head">
        {detailOpen && (
          <button
            className="drawer-back"
            title="返回列表"
            onClick={() => setDetailOpen(false)}
          >
            <ChevronIcon size={12} />
          </button>
        )}
        <span className="drawer-title">
          {detailOpen ? selected?.label ?? selected?.agent ?? selected?.id ?? '子代理' : '子代理'}
        </span>
        <span className="drawer-count">{records.length}</span>
        <span className="drawer-spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭">
          ×
        </button>
      </header>

      {!detailOpen && (
        <div className="drawer-list-wrap">
          <input
            className="subagents-search"
            value={query}
            placeholder="搜索 id / 名称 / 结论"
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="subagents-list">
            {visible.map((record) => (
              <button
                key={record.id}
                className={`subagent-row ${record.id === selectedId ? 'active' : ''}`}
                onClick={() => open(record.id)}
              >
                <span className={`subagent-avatar ${record.status}`}>
                  <SparkIcon size={11} />
                </span>
                <span className="subagent-row-main">
                  <span className="subagent-row-head">
                    {record.label ?? record.agent ?? record.id}
                    {record.label && <span className="subagent-row-id">{record.id}</span>}
                    {record.restored && <span className="subagent-tag">历史</span>}
                  </span>
                  <span className="subagent-row-sub">{rowStats(record)}</span>
                </span>
              </button>
            ))}
            {visible.length === 0 && (
              <div className="subagent-empty">
                {records.length === 0 ? '还没有子代理记录' : '没有匹配的记录'}
              </div>
            )}
          </div>
        </div>
      )}

      {detailOpen && selected && (
        <div className="subagent-detail">
          <div className="subagent-meta">
            <span className={`subagent-status ${selected.status}`}>
              {SUBAGENT_STATUS_LABELS[selected.status]}
            </span>
            <span>{selected.id}</span>
            {selected.agent && <span>{selected.agent}</span>}
            {selected.model && (
              <span>
                {selected.model.provider}/{selected.model.id}
              </span>
            )}
            {selected.notify !== 'none' && (
              <span>{selected.notify === 'wake' ? '结束唤醒父代理' : '结束通知父代理'}</span>
            )}
          </div>
          <div className="subagent-cwd" title={selected.cwd}>
            {selected.cwd}
          </div>

          <ContextMeter usage={selected.contextUsage} />

          {selected.sessionFile && (
            <div className="subagent-session">
              <span className="subagent-session-label">会话</span>
              <span className="subagent-session-path" title={selected.sessionFile}>
                {selected.sessionFile.split(/[\\/]/).pop()}
              </span>
              <button
                className="ghost"
                onClick={() => void window.pi.revealSubagentSession(selected.sessionFile!)}
              >
                定位
              </button>
            </div>
          )}

          {selected.error && <div className="message-error">{selected.error}</div>}

          {selected.finalText ? (
            <div className="subagent-section">
              <div className="subagent-section-head">结论</div>
              <div className="subagent-final">
                <Markdown>{selected.finalText}</Markdown>
              </div>
            </div>
          ) : (
            !running && <div className="subagent-empty">（没有结论）</div>
          )}

          {(running || entries.length > 0) && (
            <div className="subagent-section">
              <div className="subagent-section-head">
                <span>进度{entries.length > 0 ? `（${entries.length} 条）` : ''}</span>
                <button
                  className="subagent-toggle"
                  onClick={() => setShowProgress((value) => !value)}
                >
                  {showProgress ? '收起' : '展开'}
                </button>
              </div>
              {showProgress && (
                <div
                  className="subagent-timeline"
                  ref={timelineRef}
                  onScroll={(event) => {
                    const element = event.currentTarget
                    stickRef.current =
                      element.scrollHeight - element.scrollTop - element.clientHeight < 24
                  }}
                >
                  {entries.map((entry) =>
                    entry.kind === 'call' ? (
                      <div
                        key={entry.key}
                        className={`subagent-event call ${
                          entry.running ? 'running' : entry.ok ? 'ok' : 'error'
                        }`}
                      >
                        <span className="subagent-event-icon">
                          <ToolIcon size={11} />
                        </span>
                        <span className="subagent-event-tool">{entry.tool}</span>
                        {entry.target && (
                          <span className="subagent-event-target" title={entry.target}>
                            {entry.target}
                          </span>
                        )}
                        <span className="subagent-event-state">
                          {entry.running ? '运行中' : entry.ok ? '完成' : '失败'}
                          {entry.durationMs !== undefined ? ` · ${span(entry.durationMs)}` : ''}
                        </span>
                      </div>
                    ) : (
                      <div key={entry.key} className={`subagent-event message ${entry.role}`}>
                        <span className="subagent-event-role">
                          {entry.role === 'assistant' ? '子代理' : '提示'}
                        </span>
                        <span className="subagent-event-text">
                          {entry.text || `（调用 ${entry.toolCalls?.join(', ')}）`}
                        </span>
                      </div>
                    )
                  )}
                  {running && (
                    <div className="subagent-event live">
                      <div className="subagent-live-head">
                        <span className="pulse-dot" />
                        <span>{liveActivity(selected)}</span>
                      </div>
                      {selected.draft?.thinking && (
                        <div className="subagent-thinking">{selected.draft.thinking}</div>
                      )}
                      {selected.draft?.text && (
                        <div className="subagent-live-text">{selected.draft.text}</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {changedFiles(selected).length > 0 && (
            <div className="subagent-section">
              <div className="subagent-section-head">
                改动 {changedFiles(selected).length} 个文件
              </div>
              <div className="subagent-files">
                {changedFiles(selected).map((file) => (
                  <span key={file} className="subagent-file">
                    {file}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="subagent-actions">
            {selected.restored ? (
              <div className="subagent-empty">
                历史记录：进程已结束，只能查看结果。需要继续就在同一目录重新起一个子代理。
              </div>
            ) : (
              <>
                {draft.trim() && (
                  <div className="subagent-modes">
                    {(
                      [
                        ['steer', '引导（当前回合后注入）'],
                        ['follow-up', '追加（本回合结束后）'],
                        ['interrupt', '打断后重答']
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        className={`ghost ${mode === value ? 'active' : ''}`}
                        onClick={() => setMode(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="subagent-compose">
                  <input
                    value={draft}
                    placeholder="给它发一条消息…"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        void send()
                      }
                    }}
                    disabled={selected.status === 'stopped' || selected.status === 'error'}
                  />
                  <button
                    className="ghost"
                    onClick={() => void send()}
                    disabled={
                      !draft.trim() ||
                      busy ||
                      selected.status === 'stopped' ||
                      selected.status === 'error'
                    }
                  >
                    <RefreshIcon size={13} /> 发送
                  </button>
                  <button
                    className="ghost danger"
                    onClick={() => void stop()}
                    disabled={busy || !isSubagentRunning(selected)}
                    title="停止子代理"
                  >
                    <StopIcon size={13} /> 停止
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {detailOpen && !selected && (
        <div className="subagent-empty">这个子代理记录已经不在了</div>
      )}

      <footer className="drawer-foot">
        子代理是独立的 pi 进程，默认不加载桌面 MCP。预设与并发限制在 设置 → 代理。
      </footer>
    </aside>
  )
}
