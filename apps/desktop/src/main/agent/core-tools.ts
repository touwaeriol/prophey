import http from 'node:http'
import { pathToFileURL } from 'node:url'
import type { Tool } from '@earendil-works/pi-ai'

/**
 * The root-aware tools, as the own engine sees them.
 *
 * The implementations already exist for pi's side: `packages/mcp-core/tools/workspace.mjs` is plain
 * JS with node builtins only, served over MCP. Loading the same file here means one implementation
 * for both engines instead of a second copy that drifts.
 */
export interface CoreTool {
  name: string
  /**
   * Where the tool comes from when it is not ours (`codegraph`, `warpgrep`, …).
   *
   * Only the context meter uses it: a request's token cost is split between the app's own tools and
   * each MCP server, and the model must not see the field in the declaration.
   */
  source?: string
  description: string
  /** JSON schema for the arguments; providers pass it through as-is. */
  parameters: Record<string, unknown>
  call(
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }>
}

/** Tools in the shape a provider expects. */
export function toolDeclarations(tools: CoreTool[]): Tool[] {
  return tools.map(
    (tool) =>
      ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as never
      }) as Tool
  )
}

/**
 * The bridge the desktop tools talk to.
 *
 * pi reaches it through the MCP server (`AGENT_DESKTOP_MCP_URL`); the Prophey engine has no MCP
 * server in between, so it speaks the same JSON API directly. Same endpoints, same token, one
 * implementation of the tools.
 */
export interface BridgeOptions {
  url: string
  token: string
}

export function bridgeContext(options: BridgeOptions): Record<string, unknown> {
  // `node:http` rather than `fetch`: the main process installs a global undici dispatcher for the
  // system proxy, and loopback requests through it fail (`fetch failed`) — the same reason the
  // MCP server uses raw http. It also avoids undici's 300s headers timeout, which a question
  // waiting for the user would otherwise hit.
  const request = (method: string, target: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let url: URL
      try {
        url = new URL(target, options.url)
      } catch (error) {
        reject(new Error(`桥接地址无效：${String(error)}`))
        return
      }
      const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), 'utf8')
      const call = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method,
          signal,
          headers: {
            ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
            'x-agent-desktop-token': options.token
          }
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            try {
              resolve(JSON.parse(text))
            } catch {
              reject(new Error(`桥接返回了无法解析的内容：${text.slice(0, 200)}`))
            }
          })
        }
      )
      // A question can stay unanswered for a long time; never cut it.
      call.setTimeout(0)
      call.on('error', reject)
      if (body) call.end(body)
      else call.end()
    })
  return {
    request,
    post: (target: string, payload?: unknown, signal?: AbortSignal) => request('POST', target, payload, signal),
    signal: undefined,
    log: () => {}
  }
}

interface ModuleTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  call(args?: Record<string, unknown>, context?: unknown): ReturnType<CoreTool['call']>
}

/** Preserve tool context and cancellation consistently for every shared desktop tool module. */
function adaptModuleTool(tool: ModuleTool, context: Record<string, unknown> = {}): CoreTool {
  return {
    name: tool.name,
    description: tool.description ?? tool.name,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    call: (args, signal) => tool.call(args ?? {}, { ...context, signal })
  }
}

/** Import the subagent tools; they drive the app's subagent manager through the bridge. */
export async function loadSubagentTools(
  modulePath: string,
  context: Record<string, unknown>
): Promise<CoreTool[]> {
  const module = (await import(pathToFileURL(modulePath).href)) as { subagentTools?: ModuleTool[] }
  return (module.subagentTools ?? []).map((tool) => adaptModuleTool(tool, context))
}

/** Import the desktop question tool: it shows a dialog in the window and waits for the answer. */
export async function loadAskTool(
  modulePath: string,
  context: Record<string, unknown>
): Promise<CoreTool[]> {
  const module = (await import(pathToFileURL(modulePath).href)) as { askUserQuestion?: ModuleTool }
  return module.askUserQuestion ? [adaptModuleTool(module.askUserQuestion, context)] : []
}

/** Import the workspace tool module by absolute path (dev checkout or packaged resources). */
export async function loadWorkspaceTools(modulePath: string, context: Record<string, unknown> = {}): Promise<CoreTool[]> {
  const module = (await import(pathToFileURL(modulePath).href)) as { workspaceTools?: ModuleTool[] }
  return (module.workspaceTools ?? []).map((tool) => adaptModuleTool(tool, context))
}
