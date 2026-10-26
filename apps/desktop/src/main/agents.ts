import { updateJsonFile } from './storage'
/**
 * Subagent presets: built-in defaults plus the user's `agents.json`.
 *
 * A preset is a bundle of start parameters (tools, model, mode, system prompt), never a restriction:
 * `start_subagent` lets the caller override every field. Presets also feed the `<agents>` system
 * prompt section when `agents.exposure` is `prompt`.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export type AgentMode = 'sync' | 'background'

export interface AgentModel {
  provider: string
  id: string
  thinking?: string
}

export interface AgentPreset {
  id: string
  name: string
  description: string
  tags?: string[]
  tools?: string[]
  mode?: AgentMode
  model?: AgentModel | 'inherit'
  appendSystemPrompt?: string
  visible?: boolean
  timeoutMs?: number
  source: 'builtin' | 'user'
}

export type AgentExposure = 'prompt' | 'lazy' | 'hidden'

const SHARED_PROMPT =
  'You are a subagent started by another agent. Do not ask the user questions and do not wait ' +
  'for confirmation. Keep the answer short: state the conclusion, the file:line locations that ' +
  'matter, and anything the caller must decide. Never dump large code blocks.'

export const BUILTIN_AGENTS: AgentPreset[] = [
  {
    id: 'explorer',
    name: '代码探查',
    description: '只读定位实现、梳理调用链，返回 file:line，不贴大段源码',
    tags: ['search', 'read', 'locate', '探查', '定位'],
    tools: ['read', 'grep', 'find', 'ls'],
    mode: 'background',
    model: 'inherit',
    visible: true,
    source: 'builtin',
    appendSystemPrompt:
      `${SHARED_PROMPT}\n\nYou are read-only: search and read, never edit. ` +
      'Answer with the files and line ranges that matter, and a one-line summary per finding.'
  },
  {
    id: 'reviewer',
    name: '代码审查',
    description: '审查当前改动，按严重度报问题与位置，不改代码',
    tags: ['review', 'audit', '审查', '检查'],
    tools: ['read', 'grep', 'find', 'ls'],
    mode: 'sync',
    model: 'inherit',
    visible: true,
    source: 'builtin',
    appendSystemPrompt:
      `${SHARED_PROMPT}\n\nYou are a reviewer: do not modify files. Report each issue as ` +
      '`file:line · severity · problem · suggested fix`, most severe first.'
  },
  {
    id: 'tester',
    name: '测试与修复',
    description: '先复现问题，再修，最后附命令与测试输出摘要',
    tags: ['test', 'fix', 'debug', '测试', '修复', '复现'],
    tools: ['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls'],
    mode: 'sync',
    model: 'inherit',
    visible: true,
    source: 'builtin',
    appendSystemPrompt:
      `${SHARED_PROMPT}\n\nReproduce before fixing. Finish with the commands you ran and whether ` +
      'they passed.'
  },
  {
    id: 'worker',
    name: '功能实现',
    description: '完整工具集，实现功能并列出改动文件与验证方式',
    tags: ['implement', 'build', 'feature', '实现', '开发'],
    mode: 'background',
    model: 'inherit',
    visible: true,
    source: 'builtin',
    appendSystemPrompt:
      `${SHARED_PROMPT}\n\nImplement the task end to end. Finish with the changed files and how you ` +
      'verified the change.'
  }
]

interface AgentsFile {
  agents?: {
    exposure?: AgentExposure
    promptLimit?: number
    presets?: Record<string, Partial<AgentPreset>>
  }
}

export interface AgentSettings {
  exposure: AgentExposure
  promptLimit: number
  presets: AgentPreset[]
}

export function agentsFilePath(userData: string): string {
  return path.join(userData, 'agents.json')
}

export async function loadAgents(userData: string): Promise<AgentSettings> {
  let file: AgentsFile = {}
  try {
    file = JSON.parse(await fs.readFile(agentsFilePath(userData), 'utf8')) as AgentsFile
  } catch {
    file = {}
  }
  const exposure: AgentExposure =
    file.agents?.exposure === 'lazy' || file.agents?.exposure === 'hidden'
      ? file.agents.exposure
      : 'prompt'
  const promptLimit =
    typeof file.agents?.promptLimit === 'number' && file.agents.promptLimit > 0
      ? Math.floor(file.agents.promptLimit)
      : 8
  const merged = new Map(BUILTIN_AGENTS.map((preset) => [preset.id, preset]))
  for (const [id, raw] of Object.entries(file.agents?.presets ?? {})) {
    if (!raw || typeof raw !== 'object') continue
    const base = merged.get(id)
    merged.set(id, {
      ...(base ?? {
        id,
        name: id,
        description: '',
        source: 'user' as const
      }),
      ...raw,
      id,
      name: raw.name ?? base?.name ?? id,
      description: raw.description ?? base?.description ?? '',
      source: 'user'
    })
  }
  return { exposure, promptLimit, presets: [...merged.values()] }
}

/** Create `agents.json` with a documented skeleton the first time it is opened. */
export async function ensureAgentsFile(userData: string): Promise<void> {
  const file = agentsFilePath(userData)
  try {
    await fs.access(file)
    return
  } catch {
    // create below
  }
  const skeleton = {
    agents: {
      exposure: 'prompt',
      promptLimit: 8,
      presets: {
        'fast-fix': {
          name: '快速修复',
          description: '用小模型做小范围修复',
          tools: ['read', 'edit', 'bash'],
          mode: 'sync',
          model: { provider: 'deepseek', id: 'deepseek-flash' }
        }
      }
    }
  }
  await updateJsonFile<AgentsFile>(file, skeleton as AgentsFile, (current) => current)
}

/** Tools a preset can whitelist; anything else is left to pi's defaults. */
export const TOOL_OPTIONS = [
  'read',
  'write',
  'edit',
  'bash',
  'powershell',
  'grep',
  'find',
  'ls'
]

export interface PresetDraft {
  id: string
  name?: string
  description?: string
  mode?: AgentMode
  tools?: string[] | null
  model?: AgentModel | 'inherit' | null
  appendSystemPrompt?: string
  visible?: boolean
  timeoutMs?: number
}

/** Create or update one preset. `tools: null` means "no allowlist" (full tool set). */
export async function savePreset(userData: string, draft: PresetDraft): Promise<void> {
  const id = draft.id.trim()
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error('预设 id 只能包含字母、数字、_ 和 -')
  }
  await updateJsonFile<AgentsFile>(agentsFilePath(userData), {}, (parsed) => {
    const presets = { ...(parsed.agents?.presets ?? {}) }
    const entry: Partial<AgentPreset> = {
      ...(presets[id] ?? {}),
      name: draft.name?.trim() || id,
      description: draft.description?.trim() ?? '',
      mode: draft.mode ?? 'background',
      appendSystemPrompt: draft.appendSystemPrompt?.trim() || undefined,
      visible: draft.visible !== false,
      timeoutMs: draft.timeoutMs
    }
    if (draft.tools === null) delete entry.tools
    else if (Array.isArray(draft.tools)) entry.tools = draft.tools
    if (draft.model === null || draft.model === 'inherit' || !draft.model) entry.model = 'inherit'
    else entry.model = draft.model
    presets[id] = entry
    return { ...parsed, agents: { ...(parsed.agents ?? {}), presets } }
  })
}

/** Drop a user preset; built-in presets reappear with their defaults. */
export async function deletePreset(userData: string, id: string): Promise<void> {
  await updateJsonFile<AgentsFile>(agentsFilePath(userData), {}, (parsed) => {
    const presets = { ...(parsed.agents?.presets ?? {}) }
    delete presets[id]
    return { ...parsed, agents: { ...(parsed.agents ?? {}), presets } }
  })
}

/** Persist only the exposure setting, keeping the presets the user wrote. */
export async function saveExposure(userData: string, exposure: AgentExposure): Promise<void> {
  await updateJsonFile<AgentsFile>(agentsFilePath(userData), {}, (parsed) => ({
    ...parsed, agents: { ...(parsed.agents ?? {}), exposure }
  }))
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((term) => term.length > 0)
}

/** Rank presets for a query: BM25-ish over id/name/description/tags/tools, id hits weighted up. */
export function rankAgents(
  presets: AgentPreset[],
  query: string | undefined,
  limit = 5
): Array<AgentPreset & { score: number }> {
  const needle = query?.trim().toLowerCase()
  if (!needle) return presets.slice(0, Math.max(limit, 20)).map((preset) => ({ ...preset, score: 0 }))
  const terms = tokenize(needle)
  const scored = presets.map((preset) => {
    const id = preset.id.toLowerCase()
    const name = preset.name.toLowerCase()
    const description = preset.description.toLowerCase()
    const tags = (preset.tags ?? []).map((tag) => tag.toLowerCase())
    const tools = (preset.tools ?? []).map((tool) => tool.toLowerCase())
    let score = 0
    if (id === needle) score += 40
    else if (id.includes(needle)) score += 12
    if (name.includes(needle)) score += 10
    if (description.includes(needle)) score += 6
    if (tags.some((tag) => tag.includes(needle))) score += 8
    for (const term of terms) {
      if (id.includes(term)) score += 4
      if (name.includes(term)) score += 3
      if (tags.some((tag) => tag.includes(term))) score += 2
      if (description.includes(term)) score += 1
      if (tools.some((tool) => tool.includes(term))) score += 1
    }
    return { ...preset, score }
  })
  const hits = scored.filter((preset) => preset.score > 0).sort((a, b) => b.score - a.score)
  const fallback = scored.slice(0, 3)
  return (hits.length > 0 ? hits : fallback).slice(0, Math.max(1, limit))
}

/**
 * When to delegate, shared by both exposures. A bare catalog tells the model what exists but not
 * why it would pay off, and models default to doing everything in the main context.
 */
const SUBAGENT_USAGE = [
  'Subagents run in their own process with their own context. They cannot see this conversation,',
  'cannot ask the user, and cannot start more subagents. You get back a short final answer.',
  '',
  'Delegate when the work is self-contained and would otherwise flood this context:',
  '- broad exploration ("where is X handled", reading many files) — keep file contents out of here;',
  '- long verification loops (run the suite, fix, rerun) where only the verdict matters;',
  '- a review of the diff before you commit to an approach;',
  '- several independent slices that can run at once — one subagent each, mode "background".',
  '',
  'Do it yourself when it is a few tool calls, when it needs this conversation\'s context, when a',
  'decision only the user can make is involved (use `ask_user_question`), or when the next step is',
  'irreversible and needs your own control.',
  '',
  'A subagent starts blind: give it the goal, the paths, the constraints and what "done" means.',
  'Never write "as we discussed" or refer to earlier turns.'
].join('\n')

/** The `<agents>` system prompt section, or undefined when nothing should be listed. */
export function renderAgentsSection(settings: AgentSettings): string | undefined {
  if (settings.exposure === 'hidden') return undefined
  if (settings.exposure === 'lazy') {
    return [
      SUBAGENT_USAGE,
      '',
      'Call `search_agents` to find a preset, then `start_subagent` with `agent: "<id>"`. Any',
      'parameter (model, tools, mode, cwd) overrides the preset.'
    ].join('\n')
  }
  const all = settings.presets
  const listed =
    all.length <= settings.promptLimit
      ? all
      : all.filter((preset) => preset.visible === true).slice(0, settings.promptLimit)
  if (listed.length === 0) return undefined
  const lines = listed.map((preset) => {
    const ability =
      preset.tools && preset.tools.length > 0
        ? preset.tools.includes('edit') || preset.tools.includes('write') || preset.tools.includes('bash')
          ? 'edits allowed'
          : 'read-only'
        : 'full tools'
    const mode = preset.mode ?? 'background'
    return `- ${preset.id} (${mode}, ${ability}): ${preset.description}`
  })
  return [
    SUBAGENT_USAGE,
    '',
    'Presets you can start with `start_subagent`:',
    ...lines,
    '',
    'Pass `agent: "<id>"`; any parameter (model, tools, mode, cwd) overrides the preset.',
    'Use `search_agents` for presets the user added. Use `get_subagent` / `wait_subagent` for the',
    'final answer and `get_subagent_changes` for what it touched.'
  ].join('\n')
}
