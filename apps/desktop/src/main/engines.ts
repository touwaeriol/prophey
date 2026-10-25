/**
 * Built-in MCP engines: CodeGraph (local code index) and WarpGrep (Morph code search).
 *
 * CodeGraph is an external CLI: the app resolves its entry point, spawns it as a stdio MCP server
 * behind the gateway, and keeps its index in sync with the session directory. WarpGrep is a hosted
 * API, so it needs an API key instead of a binary and runs inside the gateway itself.
 *
 * Nothing here writes to `~/.pi/agent/mcp.json`: engines are registered by the extension the app
 * passes with `--extension`, so terminal pi sessions stay untouched.
 */
import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpEngineId, McpEngineState, McpToolInfo } from '../shared/types'
import type { WarpGrepBackend } from './warpgrep'

/** Tools declared to the model directly; every other tool of the server is loaded via tool_search. */
export const DIRECT_TOOLS: Record<McpEngineId, string[]> = {
  codegraph: ['codegraph_explore', 'codegraph_search', 'codegraph_callers', 'codegraph_impact'],
  warpgrep: ['codebase_search'],
  web: ['web_search', 'web_fetch']
}

/**
 * Tools the gateway exposes at all. Everything else the engine offers is dropped before pi sees it,
 * which is how the tool count stays bounded.
 */
export const ALLOWED_TOOLS: Record<McpEngineId, string[]> = {
  codegraph: [
    'codegraph_explore',
    'codegraph_search',
    'codegraph_callers',
    'codegraph_callees',
    'codegraph_impact',
    'codegraph_node',
    'codegraph_status',
    'codegraph_files'
  ],
  warpgrep: ['codebase_search'],
  web: ['web_search', 'web_fetch']
}

/** CodeGraph only exposes the tools named here (its own default is `explore` alone). */
const CODEGRAPH_TOOLS = 'explore,search,callers,callees,impact,node,status,files'

const TIMEOUT_MS: Record<McpEngineId, number> = {
  codegraph: 120_000,
  warpgrep: 120_000,
  web: 120_000
}

const DETECT_TIMEOUT_MS = 20_000
const CACHE_MS = 60_000

interface EngineEntry {
  /** Absolute path to an executable, or to the JS entry that must run under node. */
  path: string
  kind: 'node' | 'binary'
}

interface CachedDetection {
  entry?: EngineEntry
  version?: string
  error?: string
  /** Explicit entry the detection was made for, so the cache key matches the config value. */
  explicit?: string
  at: number
}

const detectionCache = new Map<McpEngineId, CachedDetection>()

export function invalidateDetection(id?: McpEngineId): void {
  if (id) detectionCache.delete(id)
  else detectionCache.clear()
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeout ?? DETECT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error
            ? 1
            : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

/** First `*.js` path mentioned by an npm shim script, so `.cmd` shims never need a shell. */
async function jsEntryFromShim(file: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(file, 'utf8')
    const matches = text.match(/[^\s"'`)]+\.(?:js|cjs|mjs)/g)
    if (!matches) return undefined
    const relative = matches.find((match) => match.includes('node_modules'))
    if (!relative) return undefined
    const resolved = path.resolve(path.dirname(file), relative.replace(/[\\/]+/g, path.sep))
    return existsSync(resolved) ? resolved : undefined
  } catch {
    return undefined
  }
}

function npmGlobalRoots(): string[] {
  const roots: string[] = []
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'))
  roots.push(
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules')
  )
  return roots
}

function pathCandidates(binary: string): string[] {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const names =
    process.platform === 'win32'
      ? [`${binary}.exe`, `${binary}.cmd`, binary]
      : [binary]
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)))
}

async function resolveCodegraph(explicit?: string): Promise<EngineEntry | undefined> {
  if (explicit) {
    if (explicit.endsWith('.js') || explicit.endsWith('.cjs') || explicit.endsWith('.mjs')) {
      return { path: explicit, kind: 'node' }
    }
    const shim = await jsEntryFromShim(explicit)
    if (shim) return { path: shim, kind: 'node' }
    if (explicit.endsWith('.exe')) return { path: explicit, kind: 'binary' }
    return undefined
  }
  const packagePath = path.join('@colbymchenry', 'codegraph', 'npm-shim.js')
  for (const root of npmGlobalRoots()) {
    const candidate = path.join(root, packagePath)
    if (existsSync(candidate)) return { path: candidate, kind: 'node' }
  }
  for (const candidate of pathCandidates('codegraph')) {
    if (!existsSync(candidate)) continue
    const shim = await jsEntryFromShim(candidate)
    if (shim) return { path: shim, kind: 'node' }
    if (candidate.endsWith('.exe')) return { path: candidate, kind: 'binary' }
  }
  return undefined
}

async function detect(id: McpEngineId, explicit?: string): Promise<CachedDetection> {
  const cached = detectionCache.get(id)
  if (cached && Date.now() - cached.at < CACHE_MS && cached.explicit === explicit) return cached
  if (id !== 'codegraph') {
    // WarpGrep is a hosted API and the web engine runs in-process: neither has an entry to detect.
    const result: CachedDetection = { explicit, at: Date.now() }
    detectionCache.set(id, result)
    return result
  }
  const entry = await resolveCodegraph(explicit)
  if (!entry) {
    const result: CachedDetection = {
      explicit,
      at: Date.now(),
      error: explicit
        ? `指定的入口不可用：${explicit}`
        : '未找到 CodeGraph（npm 全局安装 codegraph，或手动指定入口）'
    }
    detectionCache.set(id, result)
    return result
  }
  const probe =
    entry.kind === 'node'
      ? await run(process.execPath, [entry.path, '--version'], { env: { ELECTRON_RUN_AS_NODE: '1' } })
      : await run(entry.path, ['--version'])
  const output = `${probe.stdout}\n${probe.stderr}`.trim()
  const version = output.split('\n').map((line) => line.trim()).find(Boolean)
  const valid = probe.code === 0 && /\d+\.\d+\.\d+/.test(output)
  const result: CachedDetection = valid
    ? { explicit, at: Date.now(), entry, version }
    : {
        explicit,
        at: Date.now(),
        entry,
        error: output
          ? `入口无法运行：${output.slice(0, 200)}`
          : '入口无法运行（--version 失败）'
      }
  detectionCache.set(id, result)
  return result
}

/** Resolved entry path of an engine, or undefined when it cannot be found. */
export async function engineEntry(id: McpEngineId, explicit?: string): Promise<string | undefined> {
  return (await detect(id, explicit)).entry?.path
}

/** What the gateway needs to serve one engine. */
export interface EngineTargetSpec {
  id: McpEngineId
  /**
   * Unique endpoint key: the engine id for the primary repository, `<id>__<repo>` for the others.
   *
   * A project can span several repositories and code search has to be per repository (the upstream
   * indexes one tree), so each root gets its own endpoint and its own tool set instead of pretending
   * one index covers everything.
   */
  key: string
  /** Repository display name, when the target is scoped to one root of a project. */
  label?: string
  kind: 'upstream' | 'warpgrep' | 'web'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd: string
  /** Upstream tool names to expose; everything else is dropped. */
  allowlist: string[]
  timeoutMs: number
  /** WarpGrep only: key, plus an optional custom OpenAI-compatible endpoint. */
  warpgrep?: WarpGrepBackend
}

/** What the extension registers with pi: one HTTP endpoint per engine. */
export interface EngineRegistration {
  name: string
  url: string
  headers: Record<string, string>
  exposure: 'deferred'
  toolExposure: Record<string, string>
  timeout: number
  description: string
  /** Repository this endpoint is scoped to, when a project spans several. */
  label?: string
}

function exposureFor(id: McpEngineId, toggles: Record<string, boolean> | undefined): Record<string, string> {
  const toolExposure: Record<string, string> = {}
  for (const tool of DIRECT_TOOLS[id]) toolExposure[tool] = 'direct'
  for (const [tool, enabled] of Object.entries(toggles ?? {})) {
    if (!enabled) toolExposure[tool] = 'hidden'
  }
  return toolExposure
}

/** A repository the engines should cover: the project's roots, primary first. */
export interface EngineRoot {
  path: string
  name: string
  primary?: boolean
}

/**
 * Cap on how many repositories get their own engine endpoints.
 *
 * Each root is another upstream process (CodeGraph or Serena) plus its own tools in the model's
 * list, so a project with eight repositories would cost eight processes and a wall of tools. Beyond
 * this, the remaining roots stay reachable through pi's own grep/read tools.
 */
export const ENGINE_ROOT_LIMIT = 3

/** `codegraph` for the primary root, `codegraph__server` for the others. */
function rootKey(id: McpEngineId, root: EngineRoot): string {
  if (root.primary) return id
  // Lower case: the bridge's endpoint pattern and pi's tool names both stay simpler that way.
  const slug = root.name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'root'
  return `${id}__${slug}`
}

/** Engines that are enabled and usable, in the shape the gateway consumes. */
export async function buildEngineTargets(options: {
  roots: EngineRoot[]
  config: Record<string, { enabled?: boolean; entry?: string } | undefined>
  /** Legacy field: the Morph key alone, still honoured when `warpgrep.apiKey` is absent. */
  morphApiKey?: string
  /** WarpGrep: Morph key, or a custom OpenAI-compatible endpoint. */
  warpgrep?: WarpGrepBackend
  /** Web engine: whether any backend (Brave key or native provider) is configured. */
  webAvailable?: boolean
}): Promise<EngineTargetSpec[]> {
  const targets: EngineTargetSpec[] = []
  const roots = options.roots.length > 0 ? options.roots : [{ path: process.cwd(), name: 'root', primary: true }]
  const primary = roots.find((root) => root.primary) ?? roots[0]
  const ordered = [primary, ...roots.filter((root) => root !== primary)].slice(0, ENGINE_ROOT_LIMIT)
  for (const id of ['codegraph', 'warpgrep', 'web'] as McpEngineId[]) {
    const engine = options.config[id]
    if (!engine?.enabled) continue
    if (id === 'web') {
      // The gateway resolves Brave / provider native per call, so nothing else is needed here.
      if (options.webAvailable === false) continue
      targets.push({
        id,
        key: id,
        kind: 'web',
        cwd: primary.path,
        allowlist: ALLOWED_TOOLS[id],
        timeoutMs: TIMEOUT_MS[id]
      })
      continue
    }
    if (id === 'warpgrep') {
      for (const root of ordered) {
        targets.push({
          id,
          key: rootKey(id, root),
          label: ordered.length > 1 ? root.name : undefined,
          kind: 'warpgrep',
          cwd: root.path,
          allowlist: ALLOWED_TOOLS[id],
          timeoutMs: TIMEOUT_MS[id],
          warpgrep: {
            apiKey: options.warpgrep?.apiKey?.trim() || options.morphApiKey?.trim() || undefined,
            baseUrl: options.warpgrep?.baseUrl?.trim() || undefined,
            model: options.warpgrep?.model?.trim() || undefined
          }
        })
      }
      continue
    }
    const detection = await detect(id, engine.entry?.trim() || undefined)
    if (!detection.entry) continue
    for (const root of ordered) {
      targets.push({
        id,
        key: rootKey(id, root),
        label: ordered.length > 1 ? root.name : undefined,
        kind: 'upstream',
        command: process.execPath,
        args: [detection.entry.path, 'serve', '--mcp', '--path', root.path],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          // No CODEGRAPH_NO_DAEMON: that makes the server take CodeGraph's single writer lock, and a
          // second client (the user's IDE or terminal) then either refuses to start or serves a
          // reduced tool set. Letting it proxy to the shared daemon keeps them coexisting.
          CODEGRAPH_MCP_TOOLS: CODEGRAPH_TOOLS
        },
        cwd: root.path,
        allowlist: ALLOWED_TOOLS[id],
        timeoutMs: TIMEOUT_MS[id]
      })
    }
  }
  return targets
}

/** Endpoint registrations for the extension; each URL is a gateway on the loopback bridge. */
export function buildEngineRegistrations(options: {
  baseUrl: string
  token: string
  targets: EngineTargetSpec[]
  toggles: Record<string, Record<string, boolean> | undefined>
}): EngineRegistration[] {
  return options.targets.map((target) => {
    // pi exposes these as `mcp__<name>__<tool>`, so the name has to survive as an identifier.
    const name = target.key.replace(/[^a-zA-Z0-9_-]+/g, '_')
    const repo = target.label ? `（仓库 ${target.label}）` : ''
    const base =
      target.id === 'codegraph'
        ? `CodeGraph 网关：符号搜索、调用关系、影响面分析（${ALLOWED_TOOLS.codegraph.length} 个工具，默认只返回位置不返回源码）`
        : target.id === 'web'
          ? '网络网关：web_search（服务商原生搜索或 Brave）与 web_fetch（本地抓取并转 Markdown）'
          : 'WarpGrep 网关：Morph 的自然语言代码搜索（codebase_search，默认只返回文件与行号）'
    return {
      name,
      url: `${options.baseUrl}/mcp/${target.key}`,
      headers: { authorization: `Bearer ${options.token}` },
      exposure: 'deferred',
      // Tool switches are per engine, so a per-root endpoint follows its engine's settings.
      toolExposure: exposureFor(target.id, options.toggles[target.key] ?? options.toggles[target.id]),
      timeout: Math.round(target.timeoutMs / 1000),
      description: repo ? `${base}${repo}` : base,
      ...(target.label ? { label: target.label } : {})
    }
  })
}

export async function engineStates(options: {
  config: Record<string, { enabled?: boolean; entry?: string } | undefined>
  morphApiKey?: string
  warpgrep?: WarpGrepBackend
  toggles: Record<string, Record<string, boolean> | undefined>
  tools: Record<string, McpToolInfo[] | undefined>
  indexStatus: Record<string, { state: McpEngineState['index']; message?: string } | undefined>
  gatewayErrors?: Record<string, string | undefined>
  web?: { braveKey?: string; nativeProviders?: string[] }
}): Promise<McpEngineState[]> {
  const states: McpEngineState[] = []
  const customEndpoint = Boolean(options.warpgrep?.baseUrl?.trim())
  const hasKey = Boolean(options.warpgrep?.apiKey?.trim() || options.morphApiKey?.trim() || customEndpoint)
  const webNatives = options.web?.nativeProviders ?? []
  const webHasBrave = Boolean(options.web?.braveKey?.trim())
  const webAvailable = webHasBrave || webNatives.length > 0
  const webEntry =
    [webHasBrave ? 'Brave Search API' : '', ...webNatives].filter(Boolean).join(' · ') ||
    '未配置后端'
  for (const id of ['codegraph', 'warpgrep', 'web'] as McpEngineId[]) {
    const engine = options.config[id] ?? {}
    const detection = await detect(id, engine.entry?.trim() || undefined)
    const known = options.tools[id] ?? []
    const available =
      id === 'web'
        ? webAvailable
        : id === 'warpgrep'
          ? hasKey
          : Boolean(detection.entry) && !detection.error
    const error =
      options.gatewayErrors?.[id] ??
      detection.error ??
      (id === 'warpgrep' && !hasKey ? '未配置 Morph API Key 或自定义端点' : undefined) ??
      (id === 'web' && !webAvailable
        ? '未配置 Brave Search Key，也没有启用任何服务商的原生搜索'
        : undefined)
    states.push({
      id,
      name:
        id === 'codegraph' ? 'CodeGraph' : id === 'warpgrep' ? 'WarpGrep' : '网络搜索',
      enabled: Boolean(engine.enabled),
      available,
      entry:
        id === 'warpgrep'
          ? customEndpoint
            ? `${options.warpgrep?.baseUrl?.trim()} · ${options.warpgrep?.model?.trim() || 'deepseek-flash'}`
            : 'api.morphllm.com/v1'
          : id === 'web'
            ? webEntry
            : engine.entry?.trim() || detection.entry?.path,
      version: detection.version,
      error,
      index: id === 'codegraph' ? (options.indexStatus[id]?.state ?? 'unknown') : undefined,
      indexMessage: id === 'codegraph' ? options.indexStatus[id]?.message : undefined,
      tools: known.map((tool) => ({
        ...tool,
        enabled: options.toggles[id]?.[tool.name] !== false,
        direct: DIRECT_TOOLS[id].includes(tool.name)
      }))
    })
  }
  return states
}

/** `.codegraph` at or above `cwd`, which is where CodeGraph looks for its index. */
export function findCodegraphIndex(cwd: string): string | undefined {
  let dir = path.resolve(cwd)
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, '.codegraph')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

const indexRuns = new Map<string, Promise<{ ok: boolean; message: string }>>()

/**
 * Build the index when the project has none. Runs in the background: the MCP server connects right
 * away and reports missing-index results until the run finishes.
 *
 * An existing index is left alone on purpose. The running MCP server holds CodeGraph's file lock, so
 * an automatic `sync` would fail with "database is locked"; re-indexing stays a manual action
 * (Settings → 立即索引), which is also when the user expects it to take a while.
 */
export function ensureCodegraphIndex(
  cwd: string,
  entry: string | undefined,
  onStatus: (status: { state: McpEngineState['index']; message?: string }) => void
): void {
  if (!entry) return
  if (indexRuns.get(cwd)) return
  if (findCodegraphIndex(cwd)) {
    onStatus({ state: 'indexed', message: '使用现有索引' })
    return
  }
  onStatus({ state: 'indexing', message: `codegraph init ${cwd}` })
  const task = run(process.execPath, [entry, 'init', cwd], {
    cwd,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    timeout: 0
  }).then((result) => {
    const output = `${result.stdout}\n${result.stderr}`.trim()
    if (result.code !== 0) {
      const message = output.split('\n').filter(Boolean).slice(-3).join(' ') || 'codegraph init 失败'
      onStatus({ state: 'failed', message })
      return { ok: false, message }
    }
    onStatus({ state: 'indexed', message: 'codegraph init 完成' })
    return { ok: true, message: output.split('\n').filter(Boolean).slice(-1)[0] ?? '' }
  })
  indexRuns.set(cwd, task)
  void task.finally(() => indexRuns.delete(cwd))
}

export async function runCodegraphIndex(
  cwd: string,
  config: { enabled?: boolean; entry?: string } | undefined
): Promise<{ ok: boolean; message: string }> {
  const detection = await detect('codegraph', config?.entry?.trim() || undefined)
  if (!detection.entry) return { ok: false, message: detection.error ?? '未找到 CodeGraph' }
  const action = findCodegraphIndex(cwd) ? 'sync' : 'init'
  const result = await run(process.execPath, [detection.entry.path, action, cwd], {
    cwd,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    timeout: 0
  })
  const output = `${result.stdout}\n${result.stderr}`.trim()
  if (result.code !== 0) {
    if (/locked/i.test(output)) {
      return {
        ok: false,
        message:
          '索引被运行中的 CodeGraph 服务器锁定：先关闭 CodeGraph 引擎（或重启 pi）再索引，' +
          '或在项目里运行 codegraph unlock'
      }
    }
    return { ok: false, message: output.split('\n').filter(Boolean).slice(-3).join(' ') || '索引失败' }
  }
  invalidateDetection('codegraph')
  return { ok: true, message: `codegraph ${action} 完成` }
}
