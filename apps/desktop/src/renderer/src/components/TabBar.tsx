import { engineLabel } from '@shared/engine'
import type { PiStatus } from '@shared/types'
import { BranchIcon, CloseIcon, PanelIcon, PlusIcon, SparkIcon } from './Icons'

export function TabBar({
  title,
  status,
  streaming,
  panelOpen,
  subagentsRunning,
  subagentsFinished,
  onNew,
  onTogglePanel,
  onOpenSubagents
}: {
  title: string
  status: PiStatus
  streaming: boolean
  panelOpen: boolean
  subagentsRunning: number
  subagentsFinished: number
  onNew: () => void
  onTogglePanel: () => void
  onOpenSubagents: () => void
}) {
  return (
    <header className="tabbar">
      <div className="tabs">
        <div className="tab active">
          <BranchIcon size={13} />
          <span className="tab-title">{title}</span>
          {streaming && <span className="tab-running" />}
          <button className="tab-close" title="关闭并新建会话" onClick={onNew}>
            <CloseIcon size={12} />
          </button>
        </div>
        <button className="tab-new" title="新建会话" onClick={onNew}>
          <PlusIcon size={14} />
        </button>
      </div>
      <div className="tabbar-right">
        {status.phase !== 'ready' && (
          <span className={`connection ${status.phase}`}>
            {status.phase === 'starting'
              ? '连接 ' + engineLabel(status.engine) + '…'
              : status.phase === 'error'
                ? engineLabel(status.engine) + ' 未连接'
                : '已停止'}
          </span>
        )}
        <button
          className={`subagent-btn ${subagentsRunning > 0 ? 'running' : ''}`}
          title={
            subagentsRunning > 0
              ? `${subagentsRunning} 个子代理运行中`
              : subagentsFinished > 0
                ? `${subagentsFinished} 个子代理已完成`
                : '子代理'
          }
          onClick={onOpenSubagents}
        >
          <SparkIcon size={13} />
          <span>{subagentsRunning > 0 ? subagentsRunning : subagentsFinished || ''}</span>
        </button>
        <button
          className={`icon-btn panel-toggle ${panelOpen ? 'on' : ''}`}
          title={
            panelOpen
              ? '隐藏会话概览（环境、上下文、连接器、产出、后台任务）'
              : '显示会话概览（环境、上下文、连接器、产出、后台任务）'
          }
          aria-pressed={panelOpen}
          onClick={onTogglePanel}
        >
          <PanelIcon size={15} />
        </button>
      </div>
    </header>
  )
}
