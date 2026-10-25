import { useEffect, useState } from 'react'
import { RefreshIcon, StopIcon } from './Icons'

/** `m`/`s`/`h` is enough for a command that has been running for minutes. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** What the panel knows about a background command when it hands it to the drawer. */
export interface TaskTarget {
  id: string
  command: string
  /** Absent (or `running`) while the command is still going. */
  state?: string
  startedAt: number
  endedAt?: number
  /** Session that owns the command, captured when the row was clicked: switching sessions must not
   *  point the drawer at another session's log. */
  sessionKey?: string
}

const STATE_LABELS: Record<string, string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  stopped: '已停止'
}

/**
 * Second level of a background task, as a drawer.
 *
 * The card in the panel keeps one line per command; opening it here means the output gets the whole
 * column height — an inline block pushed the rest of the list off screen once a turn had run a dozen
 * commands.
 */
export function TaskDrawer({
  task,
  onClose
}: {
  task: TaskTarget
  onClose: () => void
}) {
  const sessionKey = task.sessionKey ?? ''
  const [output, setOutput] = useState('正在读取…')
  const [busy, setBusy] = useState(false)
  const running = task.state === undefined || task.state === 'running'

  useEffect(() => {
    let cancelled = false
    const read = async (): Promise<void> => {
      const result = await window.pi
        .readBackgroundTask(task.id, sessionKey)
        .catch((error) => ({ ok: false, error: String(error), text: undefined }))
      if (cancelled) return
      setOutput(result.ok ? result.text ?? '（还没有输出）' : result.error ?? '读取失败')
    }
    setOutput('正在读取…')
    void read()
    // Keep following the log while the command runs; a finished one is read once.
    const timer = running ? setInterval(() => void read(), 2000) : undefined
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [task.id, sessionKey, running])

  const stop = async (): Promise<void> => {
    setBusy(true)
    await window.pi.stopBackgroundTask(task.id, sessionKey)
    setBusy(false)
  }

  const state = task.state ?? 'running'
  const elapsed = task.endedAt ? task.endedAt - task.startedAt : Date.now() - task.startedAt

  return (
    <aside className="subagent-drawer task-drawer">
      <header className="drawer-head">
        <span className="drawer-title">后台任务</span>
        <span className={`task-state ${state}`}>{STATE_LABELS[state] ?? state}</span>
        <span className="drawer-spacer" />
        {running && (
          <button
            className="icon-btn"
            title="停止这个后台命令"
            disabled={busy}
            onClick={() => void stop()}
          >
            <StopIcon size={12} />
          </button>
        )}
        <button
          className="icon-btn"
          title="重新读取输出"
          onClick={() => {
            setOutput('正在读取…')
            void window.pi
              .readBackgroundTask(task.id, sessionKey)
              .then((result) => setOutput(result.ok ? result.text ?? '（还没有输出）' : result.error ?? '读取失败'))
              .catch((error) => setOutput(String(error)))
          }}
        >
          <RefreshIcon size={12} />
        </button>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="task-meta">
        <code className="task-command" title={task.command}>
          {task.command}
        </code>
        <div className="task-figures">
          <span>{running ? formatElapsed(elapsed) : `耗时 ${formatElapsed(elapsed)}`}</span>
          <span title={new Date(task.startedAt).toLocaleString()}>
            开始 {new Date(task.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <span className="task-id">{task.id}</span>
        </div>
      </div>

      <div className="task-output">
        <pre>{output}</pre>
      </div>

      <footer className="drawer-foot">
        命令在独立的后台 shell 中运行，输出写入日志文件；这里只读最近 12KB。
      </footer>
    </aside>
  )
}
