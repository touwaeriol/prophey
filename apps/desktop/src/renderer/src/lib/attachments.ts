/**
 * Pasted files, carried in the message text.
 *
 * A file copied in Explorer or a WeChat chat is a path on this machine — there is no bytes payload
 * the model could receive through the provider. The path itself is the payload: the block below is
 * ordinary text, so it survives steer, the queue, draft persistence, editing and the transcript
 * without a new field anywhere. The composer renders it as a chip row; the chips are a view over
 * the text, never a second store.
 *
 * Format (one block per message, appended):
 *
 *     【附件】本机文件，用 read_file 读绝对路径
 *     - 2.4 MB · D:\WeChat Files\wxid_x\report.pdf
 *
 * The size comes first and ` · ` separates it from the path, because a size never contains the
 * separator while a name or a path can: splitting at the *first* one is always right. The name is
 * the path's last segment, so it is derived rather than stored.
 */

export const ATTACHMENT_HEADER = '【附件】本机文件，用 read_file 读绝对路径'

/** A line of the block: `- size · path` (`-` when the size is unknown). */
const LINE = /^- (.*?) · (.+)$/

/** More than this in one message is noise the model has to read past. */
export const MAX_ATTACHMENTS = 10

export interface Attachment {
  /** Absolute path as pasted; also the identity used by remove. */
  path: string
  /** Human size, e.g. `2.4 MB`; empty when unknown. */
  size: string
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function line(entry: Attachment): string {
  return `- ${entry.size || '-'} · ${entry.path}`
}

/** Every attachment currently in the text, in the order they were pasted. */
export function attachmentsOf(text: string): Attachment[] {
  const found: Attachment[] = []
  for (const raw of text.split('\n')) {
    const match = LINE.exec(raw.trim())
    if (!match) continue
    found.push({ path: match[2], size: match[1] === '-' ? '' : match[1] })
  }
  return found
}

/**
 * Append `entries` to the text, merging into the existing block when there is one.
 *
 * Merging matters: pasting three files one at a time must end as one block, not three headers. The
 * block stays where it was created, so the prose above it keeps its own position.
 */
export function insertAttachments(
  text: string,
  entries: Attachment[],
  cap = MAX_ATTACHMENTS
): { text: string; added: number; skipped: number } {
  const existing = attachmentsOf(text)
  const seen = new Set(existing.map((entry) => entry.path.toLowerCase()))
  const fresh = entries.filter((entry) => entry.path && !seen.has(entry.path.toLowerCase()))
  const room = Math.max(0, cap - existing.length)
  const take = fresh.slice(0, room)
  const skipped = fresh.length - take.length
  if (take.length === 0) return { text, added: 0, skipped }
  if (existing.length === 0) {
    const block = [ATTACHMENT_HEADER, ...take.map(line)].join('\n')
    return { text: `${text.trimEnd()}\n\n${block}`.trimStart(), added: take.length, skipped }
  }
  // Grow the block in place: same position, appended lines.
  const lines = text.split('\n')
  let last = -1
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    if (LINE.test(lines[at].trim())) {
      last = at
      break
    }
  }
  lines.splice(last + 1, 0, ...take.map(line))
  return { text: lines.join('\n'), added: take.length, skipped }
}

/** Drop one attachment (and the block scaffolding once it is the last one). */
export function removeAttachment(text: string, path: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex((raw) => LINE.exec(raw.trim())?.[2] === path)
  if (at < 0) return text
  lines.splice(at, 1)
  if (!lines.some((raw) => LINE.test(raw.trim()))) {
    const header = lines.findIndex((raw) => raw.trim() === ATTACHMENT_HEADER)
    if (header >= 0) {
      lines.splice(header, 1)
      // The blank line that separated the block from the prose goes with it.
      if (header > 0 && lines[header - 1] === '') lines.splice(header - 1, 1)
    }
  }
  return lines.join('\n')
}

/**
 * Split a message into what the user wrote and what was pasted.
 *
 * The bubble shows the files as rows, not as a header and a separator line: the block is a transport
 * format, and reading ` · ` back to the user is noise.
 */
export function stripAttachments(text: string): { prose: string; files: Attachment[] } {
  const files = attachmentsOf(text)
  if (files.length === 0) return { prose: text, files }
  const prose = text
    .split('\n')
    .filter((raw) => raw.trim() !== ATTACHMENT_HEADER && !LINE.test(raw.trim()))
    .join('\n')
    .trim()
  return { prose, files }
}

/**
 * What the model is told about a block, when the user did not write anything themselves.
 *
 * The names alone are useless — the model has to open the files to know what was pasted.
 */
export function attachmentPrompt(text: string): string {
  const { prose } = stripAttachments(text)
  return prose ? text : `看一下我粘贴的附件。\n\n${text.trim()}`
}
