import type { PiStatus } from '@shared/types'
import { MoonIcon, PanelIcon, SettingsIcon, SparkIcon, SunIcon } from './Icons'

/**
 * The window rail. Only the list toggle lives up here, and only while the list is hidden; every
 * create / workspace / config action sits in the sidebar itself, so the rail keeps just the
 * logo, that toggle and the app-level controls pinned to the bottom edge.
 */
export function IconRail({
  status,
  theme,
  sidebarOpen,
  onToggleSidebar,
  onOpenSettings,
  onToggleTheme
}: {
  status: PiStatus
  theme: 'dark' | 'light'
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onOpenSettings: () => void
  onToggleTheme: () => void
}) {
  return (
    <nav className="rail">
      <div className="rail-logo" title="pi desktop">
        π
      </div>
      {!sidebarOpen && (
        <button
          className="rail-btn sidebar-toggle"
          title="显示会话列表 (Ctrl+B)"
          aria-pressed={false}
          onClick={onToggleSidebar}
        >
          <PanelIcon size={16} />
        </button>
      )}
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
