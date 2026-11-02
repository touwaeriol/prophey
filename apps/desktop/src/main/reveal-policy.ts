import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Whether a path may be revealed in the file manager.
 *
 * Session outputs and repository files stay inside the workspace; **pasted attachments do not** —
 * they come from a WeChat download folder or the Desktop, which is the whole point of pasting them.
 * So a real *file* is accepted wherever it is (revealing never executes anything), while a directory
 * still has to belong to the session: "open the folder" on `C:\` is not useful.
 */
export async function revealTarget(
  target: string,
  roots: string[]
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const raw = String(target ?? '')
  if (!raw) return { ok: false, error: '没有给出路径' }
  const real = async (value: string): Promise<string | undefined> => {
    try {
      return await fs.realpath(value)
    } catch {
      return undefined
    }
  }
  const resolved = await real(path.resolve(raw))
  if (!resolved) return { ok: false, error: '文件不存在或已被删除' }
  const stats = await fs.stat(resolved).catch(() => undefined)
  if (!stats) return { ok: false, error: '文件不存在或已被删除' }
  if (stats.isFile()) return { ok: true, path: resolved }
  const inside = (await Promise.all(roots.map((root) => real(path.resolve(root))))).some(
    (root) => root && (resolved === root || resolved.startsWith(root + path.sep))
  )
  return inside ? { ok: true, path: resolved } : { ok: false, error: '只能打开当前会话目录里的文件夹' }
}
