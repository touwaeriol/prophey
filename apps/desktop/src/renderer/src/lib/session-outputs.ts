import type { ChatItem } from './messages'

/**
 * Files the assistant wrote in this session, for the session panel's "产出" card.
 *
 * Derived from the transcript's tool calls instead of a file watcher: the transcript is what the
 * conversation actually asked for, and it works after restoring a session without re-scanning the
 * repository. Tool names differ per engine (`write_file` in Prophey, `write`/`edit` in pi,
 * `Write`/`Edit` in Claude Code, `apply_patch` in Codex), so the mapping below is the single place
 * that knows about them.
 */
export interface SessionOutput {
  /** Absolute path, resolved against the session workspace when the tool used a relative one. */
  path: string
  name: string
  /** `write` (new/overwritten), `edit` (modified in place) or `patch` (Codex apply_patch). */
  kind: 'write' | 'edit' | 'patch'
  /** Index of the tool call, so the panel can keep the most recent file first. */
  order: number
}

const WRITE_TOOLS = [
  'write_file',
  'write',
  'create_file',
  'createfile',
  'notebook_write',
  'notebook_edit'
]
const EDIT_TOOLS = [
  'edit_file',
  'edit',
  'multiedit',
  'multi_edit',
  'str_replace',
  'str_replace_editor',
  'apply_edit',
  'patch_file'
]
const PATCH_TOOLS = ['apply_patch', 'applypatch']

/** Argument keys that carry the target path across the four engines' tool schemas. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'target', 'filename', 'file']

function parseArgs(raw: string): Record<string, unknown> | undefined {
  const text = raw.trim()
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function pathFromArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** Codex sends one patch text with `*** Update File: …` / `*** Add File: …` blocks. */
function pathsFromPatch(args: Record<string, unknown> | undefined): string[] {
  if (!args) return []
  const text = [args.patch, args.input, args.diff].find(
    (value): value is string => typeof value === 'string' && value.trim() !== ''
  )
  if (!text) return pathFromArgs(args) ? [pathFromArgs(args) as string] : []
  const found: string[] = []
  for (const line of text.split('\n')) {
    const match = /^\*\*\*\s+(?:Update|Add|Delete|Move to)\s+File:\s*(.+?)\s*$/.exec(line)
    if (match?.[1]) found.push(match[1])
  }
  return found
}

function isAbsolute(target: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(target) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)
}

/** Resolve a tool-provided path against the session workspace; "" when there is no workspace. */
export function resolveOutputPath(target: string, workspace?: string): string | undefined {
  const trimmed = target.trim()
  if (!trimmed) return undefined
  if (isAbsolute(trimmed)) return trimmed
  if (!workspace) return undefined
  const base = workspace.replace(/[\\/]+$/, '')
  return `${base}/${trimmed.replace(/^[.][\\/]/, '').replace(/\\/g, '/')}`
}

function nameOf(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? target
}

function kindOf(tool: string): SessionOutput['kind'] {
  if (PATCH_TOOLS.includes(tool)) return 'patch'
  if (EDIT_TOOLS.includes(tool)) return 'edit'
  return 'write'
}

/**
 * Collect the session's outputs, most recent first.
 *
 * Failed tool calls are ignored: a write that errored did not produce a file. System/tool-result
 * items carry no tool calls, so only assistant turns are scanned.
 */
export function sessionOutputs(items: ChatItem[], workspace?: string): SessionOutput[] {
  const seen = new Map<string, SessionOutput>()
  let counter = 0
  for (const item of items) {
    for (const call of item.toolCalls ?? []) {
      if (call.status === 'error') continue
      const tool = call.name.toLowerCase()
      const args = parseArgs(call.args)
      const kind = kindOf(tool)
      const raw =
        kind === 'patch'
          ? pathsFromPatch(args)
          : WRITE_TOOLS.includes(tool) || EDIT_TOOLS.includes(tool)
            ? [pathFromArgs(args)].filter((value): value is string => Boolean(value))
            : []
      for (const target of raw) {
        const resolved = resolveOutputPath(target, workspace)
        if (!resolved) continue
        // A later call wins: move the file to the end (newest first after the reverse) and keep the
        // first kind we saw, so "edited after written" still reads as a produced file.
        const previous = seen.get(resolved)
        seen.delete(resolved)
        seen.set(resolved, {
          path: resolved,
          name: nameOf(resolved),
          kind: previous?.kind ?? kind,
          order: counter++
        })
      }
    }
  }
  return [...seen.values()].reverse()
}
