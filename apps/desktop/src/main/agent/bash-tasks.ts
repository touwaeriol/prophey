import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { CoreTool } from './core-tools'
import { killTree } from '../proc'

type Result = Awaited<ReturnType<CoreTool['call']>>
interface Task {
  id: string
  command: string
  startedAt: number
  file: string
  child: ChildProcess
  state: 'running' | 'completed' | 'failed' | 'stopped'
  code?: number | null
  error?: string
  background: boolean
  done: Promise<void>
  timer?: ReturnType<typeof setTimeout>
}
const text = (value: string, isError = false): Result => ({ content: [{ type: 'text', text: value }], isError })
const bounded = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback

/** One engine owns these tasks. Output goes directly to disk, never into a growing memory buffer. */
export class BashTasks {
  private tasks = new Map<string, Task>()
  private disposed = false

  constructor(private readonly options: { directory: string; shell: string; notify: (text: string) => void;
    onChange?: (tasks: Array<{ id: string; command: string; startedAt: number }>) => void }) {}

  active(): Array<{ id: string; command: string; startedAt: number }> {
    return [...this.tasks.values()].filter(task => task.background && task.state === 'running')
      .map(task => ({ id: task.id, command: task.command, startedAt: task.startedAt }))
  }

  /**
   * Background commands that already ended, for the session panel's "N finished" line.
   *
   * Retained tasks are bounded (see `run`), so this is a recent count, not a lifetime total.
   */
  finishedCount(): number {
    return [...this.tasks.values()].filter(task => task.background && task.state !== 'running').length
  }

  private changed(): void { this.options.onChange?.(this.active()) }

  async stopAll(): Promise<void> {
    await Promise.all([...this.tasks.values()].filter(task => task.state === 'running').map(task => this.stop(task.id)))
  }

  async run(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('命令执行器已关闭')
    if ([...this.tasks.values()].filter(task => task.state === 'running').length >= 8) {
      throw new Error('已有 8 条命令运行中，请先停止或等待完成')
    }
    mkdirSync(this.options.directory, { recursive: true })
    const id = 'bash_' + randomUUID().slice(0, 12)
    const file = path.join(this.options.directory, id + '.log')
    const fd = openSync(file, 'wx')
    let child: ChildProcess
    try {
      child = spawn(this.options.shell, ['-lc', String(args.command)], {
        cwd: String(args.cwd), windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', fd, fd]
      })
    } finally { closeSync(fd) }
    let complete!: () => void
    const done = new Promise<void>(resolve => { complete = resolve })
    const task: Task = { id, file, child, command: String(args.command).slice(0, 160), startedAt: Date.now(), state: 'running', background: false, done }
    this.tasks.set(id, task)
    // Retain bounded metadata; the full logs remain available at their returned paths.
    if (this.tasks.size > 128) {
      const oldest = [...this.tasks.values()].find(item => item.state !== 'running')
      if (oldest) this.tasks.delete(oldest.id)
    }
    let finished = false
    const finish = (code: number | null, error?: string) => {
      if (finished) return
      finished = true
      clearTimeout(task.timer)
      task.code = code
      task.error ??= error
      if (task.state === 'running') task.state = code === 0 && !error ? 'completed' : 'failed'
      this.changed()
      complete()
      if (task.background && !this.disposed && task.state !== 'stopped') {
        this.options.notify(`命令 ${id} ${task.state}，退出码 ${code ?? '未知'}${task.error ? '：' + task.error.slice(0, 160) : ''}。用 read_bash_task 按需读取结果；日志：${file}`)
      }
    }
    child.once('error', error => finish(null, error.message))
    child.once('exit', code => finish(code))
    task.timer = setTimeout(() => {
      task.error = '命令超过运行时限'
      task.state = 'failed'
      this.kill(task)
    }, bounded(args.timeout, 120, 1, 1800) * 1000)
    const abort = () => { task.state = 'stopped'; this.kill(task) }
    signal?.addEventListener('abort', abort, { once: true })
    let yieldTimer: ReturnType<typeof setTimeout> | undefined
    try {
      if (args.run_in_background !== true) {
        await Promise.race([done, new Promise<void>(resolve => {
          yieldTimer = setTimeout(resolve, bounded(args.yield_time_ms, 1000, 0, 10000))
        })])
      }
      signal?.throwIfAborted()
      task.background = task.state === 'running'
      this.changed()
      return await this.read({ task_id: id, tail: true, max_bytes: 4000 })
    } finally {
      clearTimeout(yieldTimer)
      signal?.removeEventListener('abort', abort)
    }
  }

  private get(id: unknown): Task {
    const task = this.tasks.get(String(id))
    if (!task) throw new Error(`未知命令任务：${String(id)}。任务仅属于创建它的会话；已回收任务的日志仍保留在返回的路径。`)
    return task
  }

  async read(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const task = this.get(args.task_id)
    signal?.throwIfAborted()
    if (task.state === 'running' && bounded(args.wait_ms, 0, 0, 60000) > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: (() => void) | undefined
      try {
        await Promise.race([task.done, new Promise<void>((resolve, reject) => {
          timer = setTimeout(resolve, bounded(args.wait_ms, 0, 0, 60000))
          abort = () => reject(new Error('已取消等待；后台命令仍在运行'))
          signal?.addEventListener('abort', abort, { once: true })
        })])
      } finally {
        clearTimeout(timer)
        if (abort) signal?.removeEventListener('abort', abort)
      }
    }
    const handle = await fs.open(task.file, 'r')
    try {
      const size = (await handle.stat()).size
      const limit = bounded(args.max_bytes, 4000, 256, 12000)
      const offset = args.tail === true ? Math.max(0, size - limit) : bounded(args.offset, 0, 0, size)
      const buffer = Buffer.alloc(args.status_only === true ? 0 : Math.min(limit, size - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      // Skip a partial UTF-8 codepoint at the beginning; keep a trailing one for the next page.
      let start = 0, end = bytesRead
      while (start < end && (buffer[start] & 0xc0) === 0x80) start++
      if (end > start && offset + end < size) {
        let lead = end - 1
        while (lead > start && (buffer[lead] & 0xc0) === 0x80) lead--
        const needed = buffer[lead] >= 0xf0 ? 4 : buffer[lead] >= 0xe0 ? 3 : buffer[lead] >= 0xc0 ? 2 : 1
        if (end - lead < needed) end = lead
      }
      const next = offset + end
      const header = `${task.id} · ${task.state} · 退出码 ${task.code ?? '待定'}\n日志：${task.file}\n${size} bytes；本次 ${offset + start}–${next}；下一游标 offset=${next}${next < size ? '（还有输出）' : ''}`
      const body = args.status_only === true ? '' : '\n' + (buffer.subarray(start, end).toString('utf8') || '（暂无输出）')
      return text(header + (task.error ? '\n' + task.error : '') + body, task.state === 'failed')
    } finally { await handle.close() }
  }

  private kill(task: Task): void {
    if (!task.child.pid || task.child.exitCode !== null || task.child.signalCode !== null) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(task.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      const failed = () => {
        if (task.child.exitCode !== null || task.child.signalCode !== null) return
        task.error = '无法终止完整进程树，请检查进程权限；正在尝试结束主进程'
        task.state = 'failed'
        task.child.kill()
      }
      killer.on('error', failed)
      killer.on('exit', code => { if (code !== 0) failed() })
    } else {
      try { process.kill(-task.child.pid, 'SIGKILL') } catch { task.child.kill('SIGKILL') }
    }
  }

  async stop(id: unknown): Promise<Result> {
    const task = this.get(id)
    if (task.state === 'running') {
      task.state = 'stopped'
      this.kill(task)
      await task.done
      this.changed()
    }
    return this.read({ task_id: id, status_only: true })
  }

  dispose(): void {
    this.disposed = true
    for (const task of this.tasks.values()) {
      if (task.state !== 'running') continue
      task.state = 'stopped'
      clearTimeout(task.timer)
      // App shutdown must not depend on another event-loop turn to terminate children.
      if (process.platform === 'win32') killTree(task.child, true)
      else this.kill(task)
    }
  }

  tools(): CoreTool[] {
    return [
      {
        name: 'read_bash_task',
        description: 'Read bounded output or status of a command. Reuse the returned byte offset for new output; tail reads the end. Set wait_ms to wait for completion (max 60000) rather than polling. Completion is also notified automatically.',
        parameters: { type: 'object', properties: {
          task_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 },
          max_bytes: { type: 'integer', minimum: 256, maximum: 12000 },
          wait_ms: { type: 'integer', minimum: 0, maximum: 60000 },
          tail: { type: 'boolean' }, status_only: { type: 'boolean' }
        }, required: ['task_id'], additionalProperties: false },
        call: (args, signal) => this.read(args, signal)
      },
      {
        name: 'stop_bash_task', description: 'Stop a running command and its child processes.',
        parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
        call: args => this.stop(args.task_id)
      }
    ]
  }
}
