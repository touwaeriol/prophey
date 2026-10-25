import type { PiStatus } from '@shared/types'
import {
  CodeIcon,
  FolderIcon,
  MoonIcon,
  PanelIcon,
  PlusIcon,
  SettingsIcon,
  SparkIcon,
  SunIcon
} from './Icons'

export function IconRail({
  status,
  theme,
  sidebarOpen,
  onNew,
  onToggleSidebar,
  onChooseWorkspace,
  onOpenAgentDir,
  onOpenSettings,
  onToggleTheme
}: {
  status: PiStatus
  theme: 'dark' | 'light'
  sidebarOpen: boolean
  onNew: () => void
  onToggleSidebar: () => void
  onChooseWorkspace: () => void
  onOpenAgentDir: () => void
  onOpenSettings: () => void
  onToggleTheme: () => void
}) {
  return (
    <nav className="rail">
      <div className="rail-logo" title="pi desktop">
        π
      </div>
      <button className="rail-btn" title="新建会话 (Ctrl+N)" onClick={onNew}>
        <PlusIcon size={17} />
      </button>
      {!sidebarOpen && (
        <button
          className="rail-btn sidebar-toggle"
          title="显示会话列表"
          aria-pressed={false}
          onClick={onToggleSidebar}
        >
          <PanelIcon size={16} />
        </button>
      )}
      <button className="rail-btn" title="切换工作目录" onClick={onChooseWorkspace}>
        <FolderIcon size={16} />
      </button>
      <button className="rail-btn" title="打开 pi 配置目录" onClick={onOpenAgentDir}>
        <CodeIcon size={16} />
      </button>
      <div className="rail-spacer" />
      <button
        className="rail-btn"
        title={theme === 'light' ? '切换到深色主题' : '切换到亮色主题'}
        onClick={onToggleTheme}
      >
        {theme === 'light' ? <MoonIcon size={16} /> : <SunIcon size={16} />}
      </button>
      <button
        className={`rail-btn ${status.phase === 'error' ? 'alert' : ''}`}
        title="设置"
        onClick={onOpenSettings}
      >
        <SettingsIcon size={16} />
      </button>
      <div className={`rail-avatar ${status.phase}`} title={`pi ${status.phase}`}>
        {status.phase === 'error' ? '!' : <SparkIcon size={13} />}
      </div>
    </nav>
  )
}
