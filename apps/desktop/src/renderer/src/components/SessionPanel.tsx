import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { engineLabel } from '@shared/engine'
import type {
  ContextUsage,
  McpEngineState,
  McpServerInfo,
  McpState,
  PiStatus,
  SubagentView
} from '@shared/types'
import { isSubagentRunning } from '../lib/subagents'
import { composerKey } from '../lib/session-composer'
import type { ChatItem } from '../lib/messages'
import { sessionOutputs } from '../lib/session-outputs'
import {
  BranchIcon,
  ChevronIcon,
  CloseIcon,
  CodeIcon,
  FolderIcon,
  PlugIcon,
  RefreshIcon,
  StopIcon,
  ToolIcon
} from './Icons'

/**
 * Session panel: the right-hand inspector, laid out like Claude Code's.
 *
 * Every card is a single row with the value that matters when it is folded (`Environment › sup2api`,
 * `Context › 28%`, `Connectors › 1 to reconnect`, …), so the whole panel reads at a glance and only
 * the card being looked at is expanded. Which cards are open is remembered in localStorage; the
 * panel's own open state belongs to the window (`pi-session-panel`).
 *
 * Data comes from what the app already owns: environment from `PiStatus`, context from the engine's
 * measured usage (with a per-section breakdown when the engine builds the request itself), connectors
 * from `get_mcp_state`, outputs from the transcript's write/edit calls, tasks from `PiStatus`.
 */

const EXPANDED_KEY = 'pi-session-panel-cards'

function loadExpanded(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function formatTokens(value?: number | null): string {
  if (!value || value < 0) return '0'
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`
  if (value >= 1000) {
    const thousands = value / 1000
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}K`
  }
  return String(Math.round(value))
}

/** `23.3%` for the small sections, `28%` once a whole percent is enough. */
function percentOf(tokens: number, total: number): string {
  if (!total) return '—'
  const percent = (tokens / total) * 100
  if (percent >= 10 || percent === 0) return `${Math.round(percent)}%`
  return `${percent.toFixed(1)}%`
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function PanelCard({
  title,
  summary,
  expanded,
  onToggle,
  children
}: {
  title: string
  summary?: ReactNode
  expanded: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className={`panel-card ${expanded ? 'expanded' : 'collapsed'}`}>
      <header className="panel-card-head">
        <button className="panel-card-toggle" onClick={onToggle} title={expanded ? '收起' : '展开'}>
          <span className="panel-card-title">{title}</span>
          {summary !== undefined && summary !== null && (
            <span className="panel-card-summary">{summary}</span>
          )}
          <ChevronIcon size={12} />
        </button>
      </header>
      {expanded && <div className="panel-card-body">{children}</div>}
    </section>
  )
}

interface MeterSegment {
  key: string
  label: string
  tokens: number
  tone: string
  /** Keep the row visible at 0 tokens; the bar itself never draws an empty segment. */
  always?: boolean
}

/**
 * The request, drawn as Claude Code draws it: one stacked bar over the whole window, with the
 * autocompaction reserve and the unused space as segments of their own.
 */
function ContextMeter({ segments, total }: { segments: MeterSegment[]; total: number }) {
  const width = total > 0 ? total : Math.max(1, segments.reduce((sum, s) => sum + s.tokens, 0))
  return (
    <div
      className="panel-meter"
      title={segments.map((s) => `${s.label} ${formatTokens(s.tokens)}`).join(' · ')}
    >
      {segments
        .filter((segment) => segment.tokens > 0)
        .map((segment) => (
          <span
            key={segment.key}
            className={`panel-meter-seg ${segment.tone}`}
            style={{ width: `${Math.min(100, (segment.tokens / width) * 100)}%` }}
          />
        ))}
    </div>
  )
}

export function SessionPanel({
  status,
  contextUsage,
  additional = [],
  mcp,
  items,
  subagents,
  onOpenSubagent,
  onClose,
  onOpenSettings,
  onNotice
}: {
  status: PiStatus
  contextUsage?: ContextUsage
  additional?: string[]
  mcp?: McpState
  items: ChatItem[]
  subagents: SubagentView[]
  onOpenSubagent: (id: string) => void
  onClose: () => void
  onOpenSettings: (tab: 'providers' | 'mcp' | 'general') => void
  onNotice: (text: string | null) => void
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(loadExpanded)
  const [showAllOutputs, setShowAllOutputs] = useState(false)
  const [showMcpTools, setShowMcpTools] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [selectedTask, setSelectedTask] = useState<string>()
  const [taskOutput, setTaskOutput] = useState('')
  const [showFinished, setShowFinished] = useState(false)
  const owner = composerKey(status.sessionKey ?? status.sessionFile)
  useEffect(() => {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded))
  }, [expanded])
  useEffect(() => {
    if (!selectedTask) return
    let cancelled = false
    const read = async (): Promise<void> => {
      const result = await window.pi.readBackgroundTask(selectedTask, owner).catch(error => ({ ok: false, error: String(error), text: undefined }))
      if (!cancelled) setTaskOutput(result.ok ? result.text ?? '' : result.error ?? '读取失败')
    }
    setTaskOutput('正在读取…')
    void read()
    const timer = setInterval(() => void read(), 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [selectedTask, owner])
  /** Ticks while a background command runs so its elapsed time stays honest. */
  const [, setTick] = useState(0)

  const backgroundTasks = status.backgroundTasks ?? []
  useEffect(() => {
    if (backgroundTasks.length === 0) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [backgroundTasks.length])

  const isOpen = (key: string): boolean => expanded[key] === true
  const toggle = (key: string): void =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))

  const outputs = useMemo(() => sessionOutputs(items, status.cwd), [items, status.cwd])
  const visibleOutputs = showAllOutputs ? outputs : outputs.slice(0, 5)

  const windowTokens = contextUsage?.contextWindow ?? status.model?.contextWindow ?? 0
  const used = Math.max(0, Math.round(contextUsage?.tokens ?? 0))
  // Auto-compaction turns the window into a ceiling; the gap is reserved, not free.
  const ceiling =
    status.autoCompactPercent !== undefined && windowTokens > 0
      ? Math.round((windowTokens * status.autoCompactPercent) / 100)
      : windowTokens
  const buffer = Math.max(0, windowTokens - ceiling)
  const free = Math.max(0, ceiling - Math.max(used, breakdownTotal(contextUsage)))
  const usedPercent =
    typeof contextUsage?.percent === 'number'
      ? Math.round(contextUsage.percent)
      : windowTokens > 0
        ? Math.round((used / windowTokens) * 100)
        : 0
  const messageCount = items.filter((item) => item.role === 'user' || item.role === 'assistant').length
  const mcpToolCount =
    (mcp?.engines ?? []).reduce(
      (total, engine) => total + engine.tools.filter((tool) => tool.enabled).length,
      0
    ) + (mcp?.desktopTools ?? []).filter((tool) => tool.enabled).length

  const breakdown = contextUsage?.breakdown
  // With a breakdown the bar is made of the request's real sections; without one (pi, Claude Code,
  // Codex — engines that do not build the request themselves) it stays the aggregate it always was.
  const segments: MeterSegment[] = breakdown
    ? [
        { key: 'messages', label: '消息', tokens: breakdown.messages, tone: 'messages', always: true },
        {
          key: 'systemTools',
          label: '系统工具',
          tokens: breakdown.systemTools.tokens,
          tone: 'system-tools',
          always: breakdown.systemTools.count > 0
        },
        {
          key: 'mcpTools',
          label: 'MCP 工具',
          tokens: breakdown.mcpTools.tokens,
          tone: 'mcp-tools',
          always: breakdown.mcpTools.count > 0
        },
        { key: 'systemPrompt', label: '系统提示词', tokens: breakdown.systemPrompt, tone: 'system-prompt', always: true },
        { key: 'buffer', label: '自动压缩缓冲', tokens: buffer, tone: 'buffer' },
        { key: 'free', label: '剩余空间', tokens: free, tone: 'free', always: true }
      ]
    : [
        { key: 'used', label: '会话与工具', tokens: used, tone: 'used', always: true },
        { key: 'buffer', label: '自动压缩缓冲', tokens: buffer, tone: 'buffer' },
        { key: 'free', label: '剩余空间', tokens: free, tone: 'free', always: true }
      ]
  const legend = segments.filter((segment) => segment.tokens > 0 || segment.always)

  const engines = mcp?.engines ?? []
  const servers = (mcp?.servers ?? []).filter((server) => !server.builtin)
  const attention = engines.filter((engine) => engine.enabled && !engine.available).length
  const connected = engines.filter((engine) => engine.enabled && engine.available).length
  const runningSubagents = subagents.filter(isSubagentRunning).length
  const finishedSubagents = subagents.filter((record) => !isSubagentRunning(record)).length
  const finishedTasks = (status.backgroundFinished ?? 0) + finishedSubagents

  const reconnect = async (): Promise<void> => {
    setBusy('engines')
    try {
      await window.pi.refreshMcpEngines()
      onNotice('连接器已重新检测')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(undefined)
    }
  }

  const toggleServer = async (server: McpServerInfo): Promise<void> => {
    setBusy(server.name)
    try {
      const result = await window.pi.setMcpServerEnabled(server.name, !server.enabled)
      if (!result.ok) onNotice(result.error ?? '切换连接器失败')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(undefined)
    }
  }

  const stopTask = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const result = await window.pi.stopBackgroundTask(id, owner)
      if (!result.ok) onNotice(result.error ?? '停止失败')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(undefined)
    }
  }

  const reveal = async (path: string): Promise<void> => {
    const result = await window.pi.revealPath(path)
    if (!result.ok) onNotice(result.error ?? '无法打开文件')
  }

  const dot = (tone: 'ok' | 'off' | 'bad'): ReactNode => (
    <span className={`panel-dot ${tone}`} aria-hidden="true" />
  )

  const engineTone = (engine: McpEngineState): 'ok' | 'off' | 'bad' =>
    !engine.enabled ? 'off' : engine.available ? 'ok' : 'bad'

  const engineState = (engine: McpEngineState): string => {
    if (!engine.enabled) return '已关闭'
    if (!engine.available) return engine.error ? '不可用' : '未安装'
    if (engine.index === 'missing') return '待建索引'
    if (engine.index === 'failed') return '索引失败'
    if (engine.index === 'indexing' || engine.index === 'syncing') return '建索引中'
    return '已连接'
  }

  const workspaceName = status.repo?.name ?? status.cwd.split(/[\\/]/).filter(Boolean).pop()

  return (
    <aside className="session-panel" aria-label="会话概览">
      <header className="session-panel-head">
        <span>概览</span>
        <button className="icon-btn" title="关闭概览" onClick={onClose}>
          <CloseIcon size={13} />
        </button>
      </header>

      <div className="session-panel-scroll">
        <PanelCard
          title="环境"
          expanded={isOpen('env')}
          onToggle={() => toggle('env')}
          summary={<span className="panel-card-value">{workspaceName}</span>}
        >
          <div className="panel-row" title={status.cwd}>
            <FolderIcon size={12} />
            <span className="panel-row-main">{workspaceName}</span>
            {status.repo?.branch && (
              <span className="panel-badge" title={`${status.repo.branch}${status.repo.dirty ? ` · ${status.repo.dirty} 个未提交` : ''}`}>
                <BranchIcon size={10} />
                {status.repo.branch}
              </span>
            )}
          </div>
          <div className="panel-row muted" title={status.cwd}>
            <span className="panel-row-main panel-row-path">{status.cwd}</span>
          </div>
          {additional.map((dir) => (
            <div className="panel-row" key={dir} title={dir}>
              <FolderIcon size={12} />
              <span className="panel-row-main">{dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}</span>
            </div>
          ))}
          <div className="panel-row muted">
            <CodeIcon size={12} />
            <span className="panel-row-main">
              {engineLabel(status.engine)}
              {status.model ? ` · ${status.model.name ?? status.model.id}` : ''}
            </span>
          </div>
        </PanelCard>

        <PanelCard
          title="上下文"
          expanded={isOpen('context')}
          onToggle={() => toggle('context')}
          summary={
            <>
              <span className="panel-card-value">{windowTokens > 0 ? `${usedPercent}%` : '—'}</span>
              <span className="panel-mini-meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, usedPercent)}%` }} />
              </span>
            </>
          }
        >
          <div className="panel-context-head">
            <strong>{usedPercent}% 已用</strong>
            <span>
              {formatTokens(used)} / {windowTokens > 0 ? formatTokens(windowTokens) : '—'}
            </span>
          </div>
          <ContextMeter segments={segments} total={windowTokens} />
          <div className="panel-legend">
            {legend.map((segment) => (
              <div className="panel-legend-row" key={segment.key}>
                <span className={`panel-swatch ${segment.tone}`} />
                <span className="panel-legend-label">{segment.label}</span>
                <span className="panel-legend-value">{formatTokens(segment.tokens)}</span>
                <span className="panel-legend-percent">{percentOf(segment.tokens, windowTokens)}</span>
              </div>
            ))}
          </div>
          {breakdown && breakdown.mcpTools.count > 0 && (
            <>
              <button className="panel-link" onClick={() => setShowMcpTools((value) => !value)}>
                <ChevronIcon size={10} /> MCP 工具 {breakdown.mcpTools.count} 个
              </button>
              {showMcpTools &&
                breakdown.mcpTools.servers.map((server) => (
                  <div className="panel-row panel-row-sub" key={server.name} title={`${server.name} · ${server.count} 个工具`}>
                    <span className="panel-row-main">{server.name}</span>
                    <span className="panel-row-state">
                      {server.count} 个 · {formatTokens(server.tokens)}
                    </span>
                  </div>
                ))}
            </>
          )}
          <div className="panel-context-foot">
            消息 {messageCount} · MCP 工具 {mcpToolCount}
            {status.autoCompactPercent !== undefined
              ? ` · ${status.autoCompactPercent}% 自动压缩`
              : ' · 自动压缩已关闭'}
          </div>
        </PanelCard>

        <PanelCard
          title="连接器"
          expanded={isOpen('connectors')}
          onToggle={() => toggle('connectors')}
          summary={
            <span className="panel-card-value">
              {attention > 0 ? `${attention} 需重连` : connected > 0 ? `${connected} 已连接` : '无'}
            </span>
          }
        >
          {engines.map((engine) => (
            <div className="panel-row" key={engine.id} title={engine.error ?? engine.indexMessage}>
              {dot(engineTone(engine))}
              <span className="panel-row-main">{engine.name}</span>
              <span className="panel-row-state">{engineState(engine)}</span>
            </div>
          ))}
          {servers.map((server) => (
            <div className="panel-row" key={server.name} title={server.summary || server.transport}>
              {dot(server.enabled ? 'ok' : 'off')}
              <span className="panel-row-main">{server.name}</span>
              <button
                className="panel-link"
                disabled={busy === server.name}
                onClick={() => void toggleServer(server)}
                title={server.enabled ? '暂时停用这个 MCP 服务' : '重新启用这个 MCP 服务'}
              >
                {server.enabled ? '停用' : '启用'}
              </button>
            </div>
          ))}
          {engines.length === 0 && servers.length === 0 && (
            <div className="panel-empty">没有可用的连接器</div>
          )}
          <div className="panel-card-actions">
            <button
              className="panel-link"
              disabled={busy === 'engines'}
              onClick={() => void reconnect()}
            >
              <RefreshIcon size={11} /> 重新检测
            </button>
            <button className="panel-link" onClick={() => onOpenSettings('mcp')}>
              <PlugIcon size={11} /> 管理
            </button>
          </div>
        </PanelCard>

        <PanelCard
          title="产出"
          expanded={isOpen('outputs')}
          onToggle={() => toggle('outputs')}
          summary={<span className="panel-card-value">{outputs.length || '无'}</span>}
        >
          {visibleOutputs.map((output) => (
            <button
              className="panel-row panel-row-button"
              key={output.path}
              title={`${output.path}（在文件管理器中显示）`}
              onClick={() => void reveal(output.path)}
            >
              <ToolIcon size={12} />
              <span className="panel-row-main">{output.name}</span>
              <span className="panel-row-state">
                {output.kind === 'edit' ? '改' : output.kind === 'patch' ? '补' : '写'}
              </span>
            </button>
          ))}
          {outputs.length === 0 && <div className="panel-empty">本会话还没有写文件</div>}
          {outputs.length > 5 && (
            <button className="panel-link" onClick={() => setShowAllOutputs((value) => !value)}>
              {showAllOutputs ? '收起' : `显示其余 ${outputs.length - 5} 个`}
            </button>
          )}
        </PanelCard>

        <PanelCard
          title="后台任务"
          expanded={isOpen('tasks')}
          onToggle={() => toggle('tasks')}
          summary={
            <span className="panel-card-value">
              {backgroundTasks.length + runningSubagents > 0
                ? `${backgroundTasks.length + runningSubagents} 运行中`
                : finishedTasks > 0
                  ? `${finishedTasks} 已完成`
                  : '空闲'}
            </span>
          }
        >
          {backgroundTasks.map((task) => (
            <div className="panel-row" key={task.id} title={task.command}>
              <span className="panel-dot running" aria-hidden="true" />
              <button className="panel-link panel-row-main panel-row-ellipsis" title="查看命令输出" onClick={() => setSelectedTask(task.id)}>{task.command}</button>
              <span className="panel-row-state">{formatElapsed(Date.now() - task.startedAt)}</span>
              <button
                className="panel-icon-btn"
                title="停止这个后台命令"
                disabled={busy === task.id}
                onClick={() => void stopTask(task.id)}
              >
                <StopIcon size={11} />
              </button>
            </div>
          ))}
          {subagents.filter(isSubagentRunning).map(record => (
            <button className="panel-row panel-row-button" key={record.id} onClick={() => onOpenSubagent(record.id)} title="查看子代理详情">
              <span className="panel-dot running" />
              <span className="panel-row-main">{record.label || record.agent || record.id}</span>
              <span className="panel-row-state">子代理</span>
            </button>
          ))}
          {backgroundTasks.length === 0 && !subagents.some(isSubagentRunning) && <div className="panel-empty">没有正在运行的后台任务</div>}
          {finishedTasks > 0 && (
            <button className="panel-link" onClick={() => setShowFinished(value => !value)}>
              {finishedTasks} 个已完成
            </button>
          )}
          {showFinished && (status.backgroundHistory ?? []).map(task => (
            <button key={task.id} className="panel-row panel-row-button" onClick={() => setSelectedTask(task.id)}>
              <span className="panel-row-main panel-row-ellipsis">{task.command}</span><span className="panel-row-state">{task.state === 'completed' ? '完成' : task.state === 'failed' ? '失败' : '停止'}</span>
            </button>
          ))}
          {showFinished && subagents.filter(record => !isSubagentRunning(record)).map(record => (
            <button key={record.id} className="panel-row panel-row-button" onClick={() => onOpenSubagent(record.id)}>
              <span className="panel-row-main">{record.label || record.agent || record.id}</span><span className="panel-row-state">子代理</span>
            </button>
          ))}
          {selectedTask && <div className="panel-task-detail">
            <div className="panel-card-actions"><span>命令输出 · 最近 12KB</span><button className="panel-link" onClick={() => setSelectedTask(undefined)}>关闭</button></div>
            <pre>{taskOutput}</pre>
          </div>}
        </PanelCard>
      </div>
    </aside>
  )
}

/** What the breakdown already attributes; the rest of the window is still free. */
function breakdownTotal(usage?: ContextUsage): number {
  const breakdown = usage?.breakdown
  if (!breakdown) return 0
  return (
    breakdown.messages +
    breakdown.systemPrompt +
    breakdown.systemTools.tokens +
    breakdown.mcpTools.tokens
  )
}
