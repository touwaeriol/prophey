import type { AppUpdateSnapshot } from '@shared/types'

export function updateStatusText(snapshot: AppUpdateSnapshot): string {
  switch (snapshot.status) {
    case 'checking':
      return '正在检查更新…'
    case 'available':
      return '发现新版本'
    case 'upToDate':
      return '已是最新版本'
    case 'downloading':
      return '正在后台下载更新…'
    case 'preparing':
      return '已下载，退出应用时自动安装'
    case 'installing':
      return '正在静默安装，应用即将重启…'
    case 'error':
      return '更新未完成'
    default:
      return '尚未检查更新'
  }
}

export function updateProgress(snapshot: AppUpdateSnapshot): number | null {
  if (!snapshot.total) return null
  return Math.min(100, Math.round((snapshot.downloaded / snapshot.total) * 100))
}

export function updateBusy(snapshot: AppUpdateSnapshot): boolean {
  // `preparing` is settled work: the installer is on disk and the user may keep working (or quit,
  // which installs it). Only an in-flight operation blocks the buttons.
  return ['checking', 'downloading', 'installing'].includes(snapshot.status)
}
