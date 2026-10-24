import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { engineLabel } from '@shared/engine'
import type { McpEngineState, McpServerInfo, McpState, PiStatus } from '@shared/types'
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
 * Session panel: the right-hand inspector modelled on Claude Desktop's.
 *
 * Five cards, each backed by data the app already owns — environment from `PiStatus`, context from
 * `get_session_stats` (aggregate tokens only: pi does not expose Claude's per-section split, so the
 * card shows what is real and does not invent categories), connectors from `get_mcp_state`, outputs
 * derived from the transcript's write/edit calls, and background tasks from `PiStatus`.
 */

function formatTokens(value?: number | null): string {
  if (!value || value < 0) return '0'
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`
  if (value >= 1000) {
    const thousands = value / 1000
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}K`
  }
  return String(Math.round(value))
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
  collapsed,
  onToggle,
  children
}: {
  title: string
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className={`panel-card ${collapsed ? 'collapsed' : ''}`}>
      <header className="panel-card-head">
        <button className="panel-card-toggle" onClick={onToggle} title={collapsed ? '展开' : '收起'}>
          <span>{title}</span>
          <ChevronIcon size={12} />
        </button>
      </header>
      {!collapsed && <div className="panel-card-body">{children}</div>}
    </section>
  )
}

function ContextMeter({
  used,
  buffer,
  window
}: {
  used: number
  buffer: number
  window: number
}) {
  const width = window > 0 ? window : Math.max(1, used + buffer)
  const usedPercent = Math.min(100, (used / width) * 100)
  const bufferPercent = Math.min(100 - usedPercent, (buffer / width) * 100)
  return (
    <div className="panel-meter" title={`已用 ${formatTokens(used)} · 缓冲 ${formatTokens(buffer)} · 窗口 ${formatTokens(width)}`}>
      <span className="panel-meter-used" style={{ width: `${usedPercent}%` }} />
      <span className="panel-meter-buffer" style={{ width: `${bufferPercent}%` }} />
    </div>
  )
}

export function SessionPanel({
  status,
  contextUsage,
  additional = [],
  mcp,
  items,
  onClose,
  onOpenSettings,
  onNotice
}: {
  status: PiStatus
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null }
  additional?: string[]
  mcp?: McpState
  items: ChatItem[]
  onClose: () => void
  onOpenSettings: (tab: 'providers' | 'mcp' | 'general') => void
  onNotice: (text: string | null) => void
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [showAllOutputs, setShowAllOutputs] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  /** Ticks while a background command runs so its elapsed time stays honest. */
  const [, setTick] = useState(0)

  const backgroundTasks = status.backgroundTasks ?? []
  useEffect(() => {
    if (backgroundTasks.length === 0) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [backgroundTasks.length])

  const toggle = (key: string): void =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))

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
  const free = Math.max(0, ceiling - used)
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

  const engines = mcp?.engines ?? []
  const servers = (mcp?.servers ?? []).filter((server) => !server.builtin)

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
      const result = await window.pi.stopBackgroundTask(id)
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

  return (
    <aside className="session-panel" aria-label="会话概览">
      <header className="session-panel-head">
        <span>概览</span>
        <button className="icon-btn" title="关闭概览" onClick={onClose}>
          <CloseIcon size={13} />
        </button>
      </header>

      <div className="session-panel-scroll">
        <PanelCard title="环境" collapsed={collapsed.env === true} onToggle={() => toggle('env')}>
          <div className="panel-row" title={status.cwd}>
            <FolderIcon size={12} />
            <span className="panel-row-main">{status.repo?.name ?? status.cwd}</span>
            {status.repo?.branch && (
              <span className="panel-badge" title={`${status.repo.branch}${status.repo.dirty ? ` · ${status.repo.dirty} 个未提交` : ''}`}>
                <BranchIcon size={10} />
                {status.repo.branch}
              </span>
            )}
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
          collapsed={collapsed.context === true}
          onToggle={() => toggle('context')}
        >
          <div className="panel-context-head">
            <strong>{usedPercent}% 已用</strong>
            <span>
              {formatTokens(used)} / {windowTokens > 0 ? formatTokens(windowTokens) : '—'}
            </span>
          </div>
          <ContextMeter used={used} buffer={buffer} window={windowTokens} />
          <div className="panel-legend">
            <div className="panel-legend-row">
              <span className="panel-swatch used" />
              <span className="panel-legend-label">会话与工具</span>
              <span className="panel-legend-value">{formatTokens(used)}</span>
              <span className="panel-legend-percent">{usedPercent}%</span>
            </div>
            {buffer > 0 && (
              <div className="panel-legend-row">
                <span className="panel-swatch buffer" />
                <span className="panel-legend-label">自动压缩缓冲</span>
                <span className="panel-legend-value">{formatTokens(buffer)}</span>
                <span className="panel-legend-percent">
                  {windowTokens > 0 ? Math.round((buffer / windowTokens) * 100) : 0}%
                </span>
              </div>
            )}
            <div className="panel-legend-row">
              <span className="panel-swatch free" />
              <span className="panel-legend-label">剩余空间</span>
              <span className="panel-legend-value">{formatTokens(free)}</span>
              <span className="panel-legend-percent">
                {windowTokens > 0 ? Math.round((free / windowTokens) * 100) : 0}%
              </span>
            </div>
          </div>
          <div className="panel-context-foot">
            消息 {messageCount} · MCP 工具 {mcpToolCount}
            {status.autoCompactPercent !== undefined
              ? ` · ${status.autoCompactPercent}% 自动压缩`
              : ' · 自动压缩已关闭'}
          </div>
        </PanelCard>

        <PanelCard
          title="连接器"
          collapsed={collapsed.connectors === true}
          onToggle={() => toggle('connectors')}
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

        <PanelCard title="产出" collapsed={collapsed.outputs === true} onToggle={() => toggle('outputs')}>
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
          collapsed={collapsed.tasks === true}
          onToggle={() => toggle('tasks')}
        >
          {backgroundTasks.map((task) => (
            <div className="panel-row" key={task.id} title={task.command}>
              <span className="panel-dot running" aria-hidden="true" />
              <span className="panel-row-main panel-row-ellipsis">{task.command}</span>
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
          {backgroundTasks.length === 0 && <div className="panel-empty">没有正在运行的后台命令</div>}
          {(status.backgroundFinished ?? 0) > 0 && (
            <div className="panel-context-foot">{status.backgroundFinished} 个已完成</div>
          )}
        </PanelCard>
      </div>
    </aside>
  )
}
