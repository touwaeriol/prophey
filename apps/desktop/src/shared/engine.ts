/** Shared by engines, IPC and renderer. Native ownership is not an unsupported feature. */
export type EngineId = 'prophey' | 'pi' | 'claude' | 'codex'
export interface EngineCapabilities {
  compact: boolean
  compactInstructions: boolean
  autoCompaction: 'configurable' | 'native' | 'none'
  fork: boolean
  thinking: boolean
  models: boolean
  images: boolean
  /**
   * Who decides whether an image can go out: `model` = the model entry's declared modalities
   * (pi and Prophey share pi's catalog), `native` = the CLI owns it (Claude Code, Codex).
   */
  imageInput: 'model' | 'native'
  steer: boolean
  mcp: 'managed' | 'native'
  providerSettings: boolean
  speed: boolean
  sessionStorage: 'managed' | 'native'
  toolPolicy: 'native' | 'sandbox' | 'managed'
}
export interface EngineCommand {
  name: string
  args: string
  hint: string
  action:
    | 'clear'
    | 'compact'
    | 'autocompact'
    | 'mcp'
    | 'btw'
    | 'model'
    | 'thinking'
    | 'status'
    | 'native'
  source: 'desktop' | 'engine'
}
export function engineCapabilities(id: EngineId): EngineCapabilities {
  const cli = id === 'claude' || id === 'codex'
  return {
    compact: true,
    compactInstructions: id !== 'codex',
    autoCompaction: cli ? 'native' : 'configurable',
    fork: true,
    thinking: true,
    models: true,
    images: true,
    imageInput: cli ? 'native' : 'model',
    // Steering is what Enter does mid-run; Claude Code's SDK has no mid-turn injection, so it queues.
    steer: id !== 'claude',
    mcp: cli ? 'native' : 'managed',
    providerSettings: !cli,
    speed: !cli,
    sessionStorage: cli ? 'native' : 'managed',
    toolPolicy: id === 'claude' ? 'native' : id === 'codex' ? 'sandbox' : 'managed'
  }
}
export function engineCommands(
  c: EngineCapabilities,
  native: EngineCommand[] = []
): EngineCommand[] {
  const commands: EngineCommand[] = []
  const add = (name: string, args: string, hint: string, action: EngineCommand['action']): void => {
    commands.push({ name, args, hint, action, source: 'desktop' })
  }
  add('/clear', '', '新建会话，保留历史记录', 'clear')
  if (c.compact)
    add('/compact', c.compactInstructions ? '[提示词]' : '', '使用当前引擎压缩上下文', 'compact')
  if (c.autoCompaction === 'configurable')
    add('/autocompact', '[token 数 | off | on]', '设置自动压缩', 'autocompact')
  if (c.mcp === 'managed') add('/mcp', '', '查看桌面管理的 MCP 服务器与工具', 'mcp')
  if (c.fork) add('/btw', '<问题>', '在当前会话的独立分支中提问', 'btw')
  if (c.models) add('/model', '[模型 ID]', '查看或切换当前引擎模型', 'model')
  if (c.thinking) add('/thinking', '[等级]', '查看或设置思考等级', 'thinking')
  add('/status', '', '查看当前引擎与上下文状态', 'status')
  for (const command of native) {
    if (!commands.some((entry) => entry.name === command.name)) commands.push(command)
  }
  return commands
}

export function isNativeSessionReference(ref: string): boolean {
  return /^(claude|codex):[a-zA-Z0-9-]+$/.test(ref)
}

export function engineLabel(id?: EngineId): string {
  return ({ prophey: '内建', pi: 'pi', claude: 'Claude Code', codex: 'Codex' } as const)[
    id ?? 'prophey'
  ]
}
