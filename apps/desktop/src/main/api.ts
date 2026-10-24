/**
 * Internal JSON API for the desktop MCP tools: agents, models and subagents.
 *
 * Everything here answers JSON because it is consumed by `packages/mcp-core`, which formats the
 * model-facing Markdown. Keeping the transport structured avoids re-parsing text in the tools.
 */
import type { ApiRequest, ApiResponse } from './bridge'
import { rankAgents, type AgentSettings } from './agents'
import type { SubagentManager } from './subagents'
import type { EngineId } from '../shared/engine'
import type { AgentWorkspace } from './agent/engine'

export interface ApiDeps {
  agentSettings: () => AgentSettings
  subagents: () => SubagentManager
  listModels: (options: { configuredOnly: boolean }) => Promise<
    Array<{
      provider: string
      providerName: string
      id: string
      name?: string
      contextWindow?: number
      configured: boolean
    }>
  >
  defaultMode: () => 'sync' | 'background'
  desktopTools: () => boolean
  /** Session file of the main conversation, so a subagent can be traced back to it. */
  parentSession?: () => string | undefined
  engine?: () => EngineId
  parentWorkspace?: () => AgentWorkspace
  parentModel?: () => { provider: string; id: string } | undefined
  /** Check a requested provider/model against the catalog before starting a run. */
  resolveModel?: (
    provider: string | undefined,
    id: string | undefined
  ) => Promise<{ model?: { provider: string; id: string }; error?: { code: string; message: string } }>
}

const SUBAGENT_ID = /^\/subagents\/([^/]+)(?:\/([a-z]+))?$/

function ok(body: Record<string, unknown>): ApiResponse {
  return { status: 200, body: { ok: true, ...body } }
}

function fail(status: number, code: string, message: string): ApiResponse {
  return { status, body: { ok: false, code, message } }
}

function agentView(preset: AgentSettings['presets'][number]): Record<string, unknown> {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    tools: preset.tools,
    mode: preset.mode,
    model: preset.model,
    source: preset.source
  }
}

export function createApiHandler(deps: ApiDeps): (request: ApiRequest) => Promise<ApiResponse> {
  return async (request) => {
    const { method, path, query, body } = request
    // Snapshot the caller before any await; the visible conversation can change meanwhile.
    const caller = request.context ?? {
      sessionKey: deps.parentSession?.(), engine: deps.engine?.() ?? 'pi',
      workspace: deps.parentWorkspace?.(), model: deps.parentModel?.()
    }

    if (path === '/agents') {
      const settings = deps.agentSettings()
      const limit = Number(query.get('limit') ?? 5)
      const query_text = query.get('q') ?? undefined
      const ranked = rankAgents(settings.presets, query_text, Number.isFinite(limit) ? limit : 5)
      return ok({
        exposure: settings.exposure,
        total: settings.presets.length,
        agents: ranked.map((preset) => ({ ...agentView(preset), score: preset.score }))
      })
    }

    if (path === '/models') {
      const configuredOnly = query.get('configuredOnly') !== '0'
      const provider = query.get('provider') ?? undefined
      const choices = await deps.listModels({ configuredOnly })
      const filtered = provider ? choices.filter((choice) => choice.provider === provider) : choices
      const grouped = new Map<string, { provider: string; providerName: string; models: unknown[] }>()
      for (const choice of filtered) {
        const entry = grouped.get(choice.provider) ?? {
          provider: choice.provider,
          providerName: choice.providerName,
          models: []
        }
        entry.models.push({
          id: choice.id,
          name: choice.name,
          contextWindow: choice.contextWindow
        })
        grouped.set(choice.provider, entry)
      }
      return ok({ providers: [...grouped.values()] })
    }

    if (path === '/subagents' && method === 'POST') {
      const engine = caller.engine
      if (engine === 'claude' || engine === 'codex') {
        return fail(400, 'NATIVE_SUBAGENTS', '当前引擎使用自带子代理，不适用桌面子代理 MCP')
      }
      const manager = deps.subagents()
      const settings = deps.agentSettings()
      const agentId = typeof body.agent === 'string' ? body.agent : undefined
      const preset = agentId
        ? settings.presets.find((candidate) => candidate.id === agentId)
        : undefined
      if (agentId && !preset) {
        return fail(400, 'UNKNOWN_AGENT', `未知预设：${agentId}。可用：${settings.presets.map((p) => p.id).join(', ')}`)
      }
      const task = typeof body.task === 'string' ? body.task.trim() : ''
      if (!task) return fail(400, 'BAD_TASK', 'task 不能为空')
      const requestedProvider = typeof body.provider === 'string' ? body.provider : undefined
      const requestedModel = typeof body.model === 'string' ? body.model : undefined
      let resolvedModel: { provider: string; id: string } | undefined
      if (requestedProvider || requestedModel) {
        const resolution = (await deps.resolveModel?.(requestedProvider, requestedModel)) ?? {}
        if (resolution.error) return fail(400, resolution.error.code, resolution.error.message)
        resolvedModel = resolution.model
      }
      try {
        const parent = caller.workspace
        const inherited = !preset?.model || preset.model === 'inherit' ? caller.model : undefined
        const selected = resolvedModel ?? inherited
        const result = await manager.start({
          engine,
          task,
          preset,
          mode: (body.mode as 'sync' | 'background' | undefined) ?? undefined,
          provider: selected?.provider,
          model: selected?.id,
          thinking: typeof body.thinking === 'string' ? body.thinking : undefined,
          tools: Array.isArray(body.tools) ? body.tools.map(String) : undefined,
          cwd: typeof body.cwd === 'string' ? body.cwd : parent?.primary,
          additional: !body.cwd || body.cwd === parent?.primary ? parent?.additional : [],
          label: typeof body.label === 'string' ? body.label : undefined,
          timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
          waitMs: typeof body.waitMs === 'number' ? body.waitMs : undefined,
          notify:
            body.notify === 'queue' || body.notify === 'wake' || body.notify === 'none'
              ? body.notify
              : undefined,
          desktopTools: deps.desktopTools(),
          parentSession: caller.sessionKey
        })
        return ok({
          subagent: result.record,
          resolved: result.resolved,
          timedOut: result.timedOut
        })
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'START_FAILED'
        return fail(code === 'SUBAGENT_LIMIT' ? 429 : 400, code, error instanceof Error ? error.message : String(error))
      }
    }

    if (path === '/subagents' && method === 'GET') {
      const q = (query.get('q') ?? '').trim().toLowerCase()
      const status = query.get('status') ?? undefined
      const agent = query.get('agent') ?? undefined
      const limit = Number(query.get('limit') ?? 0)
      const all = deps.subagents().list().filter(record => !request.context || record.parentSession === caller.sessionKey)
      let list = all
      if (status) list = list.filter((record) => record.status === status)
      if (agent) list = list.filter((record) => record.agent === agent)
      if (q) {
        list = list.filter((record) =>
          `${record.id} ${record.label ?? ''} ${record.agent ?? ''} ${record.finalText ?? ''} ${record.cwd}`
            .toLowerCase()
            .includes(q)
        )
      }
      list = list.slice().sort((a, b) => b.createdAt - a.createdAt)
      if (Number.isFinite(limit) && limit > 0) list = list.slice(0, limit)
      return ok({ total: all.length, subagents: list })
    }

    const match = SUBAGENT_ID.exec(path)
    if (match) {
      const id = decodeURIComponent(match[1])
      const action = match[2]
      const manager = deps.subagents()
      const record = manager.get(id)
      if (!record) return fail(404, 'UNKNOWN_SUBAGENT', `未知子代理：${id}`)
      if (request.context && record.parentSession !== caller.sessionKey) return fail(404, 'UNKNOWN_SUBAGENT', `当前会话没有子代理：${id}`)

      if (!action && method === 'GET') {
        const include = (query.get('include') ?? 'status')
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
        return ok({ subagent: record, include })
      }

      if (action === 'prompt' && method === 'POST') {
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) return fail(400, 'BAD_TEXT', 'text 不能为空')
        const mode = body.mode === 'interrupt' || body.mode === 'follow-up' ? body.mode : 'steer'
        try {
          const next = await manager.prompt(id, text, mode)
          return ok({ subagent: next, mode })
        } catch (error) {
          return fail(400, (error as { code?: string }).code ?? 'PROMPT_FAILED', error instanceof Error ? error.message : String(error))
        }
      }

      if (action === 'stop' && method === 'POST') {
        const next = await manager.stop(id, body.keepMessages !== false)
        return ok({ subagent: next })
      }

      if (action === 'wait' && method === 'POST') {
        const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 60_000
        const result = await manager.wait(id, timeoutMs)
        return ok({ subagent: result.record, timedOut: result.timedOut })
      }

      if (action === 'changes' && method === 'GET') {
        const detail = query.get('detail') === 'calls' ? 'calls' : 'summary'
        return ok({ subagent: record, detail })
      }

      return fail(404, 'UNKNOWN_ROUTE', `${method} ${path} 不支持`)
    }

    return fail(404, 'UNKNOWN_ROUTE', `${method} ${path} 不支持`)
  }
}
