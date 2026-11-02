import { clipboard } from 'electron'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Paths of the files on the clipboard, when a paste carries them.
 *
 * Copying a file in Explorer, the Desktop or a WeChat chat puts a list of absolute paths on the
 * clipboard — the bytes never touch it, the path is the whole payload. Chromium models that as a
 * `DataTransfer` most of the time, but an empty paste is common enough (and silently does nothing)
 * that the renderer asks here first.
 *
 * Three sources, in the order that survives non-ASCII names: `text/uri-list` is UTF-8 `file://`
 * URLs; `FileNameW` is CF_HDROP as UTF-16LE; `FileName` is the ANSI one and needs GBK on a Chinese
 * Windows (decoding it as latin1 mangles every non-ASCII name into a path that no longer exists).
 * A single-line `text/plain` that resolves to a real absolute path counts too — copying a path as
 * text is common, and `existsSync` is what tells it apart from prose.
 *
 * This Electron has no `clipboard.readBuffer`, so a raw format is read through the `osclipboard`
 * MIME type of the async API and rebuilt from the blob bytes.
 *
 * Only paths that still exist are returned: the clipboard outlives the file, and a stale entry would
 * become an attachment the model cannot open.
 */
export async function clipboardFilePaths(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const candidates: string[] = []
  const items = await clipboard.read().catch(() => [])
  for (const item of items) {
    for (const type of item.types) {
      if (type !== 'text/uri-list' && type !== 'text/plain' &&
        !type.includes('format="FileNameW"') && !type.includes('format="FileName"')) continue
      const blob = (await item.getType(type as never).catch(() => undefined)) as Blob | undefined
      if (!blob) continue
      const bytes = Buffer.from(await blob.arrayBuffer())
      if (type === 'text/uri-list') {
        for (const line of bytes.toString('utf8').split(/\r?\n/)) {
          const url = line.trim()
          if (!url.startsWith('file:')) continue
          try {
            candidates.push(fileURLToPath(url))
          } catch {
            // A malformed entry must not cost the other lines.
          }
        }
      } else if (type === 'text/plain') {
        const text = bytes.toString('utf8').trim()
        if (text.includes('\n')) continue
        if (text && path.isAbsolute(text)) candidates.push(text)
      } else {
        const wide = type.includes('format="FileNameW"')
        let text = ''
        try {
          text = wide ? bytes.toString('utf16le') : new TextDecoder('gbk').decode(bytes)
        } catch {
          text = bytes.toString('latin1')
        }
        candidates.push(...text.split('\u0000'))
      }
    }
  }
  const paths: string[] = []
  for (const candidate of candidates) {
    const entry = candidate.trim()
    if (!entry || paths.includes(entry)) continue
    if (!existsSync(entry)) continue
    paths.push(entry)
  }
  return paths
}
