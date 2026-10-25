import { engineLabel, type EngineId } from '@shared/engine'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CHATGPT_USAGE_URL,
  usageTooltip,
  usageWindowsSummary,
  type ChatGptUsageResult
} from '@shared/chatgpt-usage'
import type {
  AppSettings,
  AppUpdateSnapshot,
  DesktopConfig,
  McpWebState,
  ModelChoice,
  PiStatus,
  ProviderAuthType,
  ProviderInfo,
  ProviderModelOption,
  ProxyInfo
} from '@shared/types'
import {
  CheckIcon,
  CloseIcon,
  GlobeIcon,
  SparkIcon,
  FolderIcon,
  KeyIcon,
  ListIcon,
  LogoutIcon,
  MoonIcon,
  PlugIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SunIcon,
  UserIcon
} from './Icons'
import { ProviderEditor } from './ProviderEditor'
import { McpPanel } from './McpPanel'
import { AgentsPanel } from './AgentsPanel'
import { ProviderMark } from './ProviderMark'
import { Toggle } from './Toggle'
import { LoginDialog, type LoginState } from './LoginDialog'
import { updateBusy, updateProgress, updateStatusText } from '../lib/updates'

type Tab = 'providers' | 'mcp' | 'agents' | 'general'

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Trigger points offered in the auto-compaction row; any 10–99 value is accepted by the backend. */
const COMPACT_PERCENT_PRESETS = [50, 60, 70, 75, 80, 85, 90, 95]

/** `349K` / `1M` — the same shape the composer's context meter uses. */
function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number(millions.toFixed(2))}M`
  }
  if (value >= 1000) {
    const thousands = value / 1000
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}K`
  }
  return String(value)
}

interface ModelConfigState {
  provider: ProviderInfo
  models: ProviderModelOption[]
  selected: Set<string>
  query: string
  loading: boolean
  saving: boolean
  error?: string
}

const SOURCE_LABELS: Record<string, string> = {
  stored: '已保存凭据',
  runtime: '本次运行',
  environment: '环境变量',
  fallback: '回退配置',
  models_json_key: 'models.json',
  models_json_command: 'models.json 命令'
}

const PROVIDER_NOTES: Record<string, string> = {
  openai: 'ChatGPT 订阅或 OpenAI API Key，使用标准 OpenAI 模型',
  'openai-codex': '旧版 Codex 渠道，仅支持 ChatGPT Plus/Pro 订阅，模型较少',
  anthropic: 'Claude 订阅（OAuth）或 Anthropic API Key',
  deepseek: '国内海外同一个域名；Anthropic 兼容接口在 /anthropic，联网搜索走的就是它',
  'moonshotai-cn': 'Kimi 国内：api.moonshot.cn',
  moonshotai: 'Kimi 海外：api.moonshot.ai',
  'kimi-coding': 'Kimi 订阅（Coding 套餐）：api.kimi.com/coding',
  'minimax-cn': 'MiniMax 国内：api.minimaxi.com（Anthropic 兼容）',
  minimax: 'MiniMax 海外：api.minimax.io（Anthropic 兼容）',
  zai: 'Z.AI 海外 Coding 套餐：api.z.ai',
  'zai-coding-cn': 'Z.AI 国内 Coding 套餐：open.bigmodel.cn',
  'google-vertex': 'Vertex AI：需要项目与区域，走 GCP 凭据',
  google: 'AI Studio（Gemini API）：generativelanguage.googleapis.com'
}

/**
 * Providers whose OAuth login is a ChatGPT subscription. Only these rows can show plan usage, and
 * only once a credential is stored — an API-key login has no subscription windows behind it.
 */
const CHATGPT_PLAN_PROVIDERS: readonly string[] = ['openai', 'openai-codex']

function isChatGptPlanProvider(provider: ProviderInfo): boolean {
  return CHATGPT_PLAN_PROVIDERS.includes(provider.id) && provider.storedType === 'oauth'
}

/**
 * Remaining ChatGPT plan usage for one provider row.
 *
 * OpenAI does not hand plan balances to "Sign in with ChatGPT" credentials, so when no Codex login
 * backs the number the row says so and offers the link ChatGPT's own UI/UX guidance asks for —
 * never a made-up percentage.
 */
function ProviderUsageLine({
  result,
  loading,
  onManage
}: {
  result?: ChatGptUsageResult
  loading: boolean
  onManage: () => void
}) {
  const usage = result?.usage
  const summary =
    usage && usage.windows.length > 0 ? usageWindowsSummary(usage) : undefined
  const title = usage
    ? usageTooltip(usage)
    : (result?.reason ?? '正在向 OpenAI 查询 ChatGPT 订阅用量…')
  return (
    <div className={`provider-usage ${summary ? '' : 'muted'}`} title={title}>
      <span className="provider-usage-value">
        {loading ? '正在查询剩余用量…' : (summary ?? '需在 ChatGPT 设置中查看')}
      </span>
      <button className="provider-usage-link" onClick={onManage} title={CHATGPT_USAGE_URL}>
        查看用量
      </button>
    </div>
  )
}

export function SettingsModal({
  open,
  initialTab,
  status,
  theme,
  onThemeChange,
  update,
  onCheckUpdate,
  onInstallUpdate,
  onCancelUpdate,
  onSetAutoUpdate,
  onSetAutoDownload,
  onOpenReleases,
  onClose,
  onRestart,
  onChooseWorkspace
}: {
  open: boolean
  initialTab?: Tab
  status: PiStatus
  theme: 'dark' | 'light'
  onThemeChange: (theme: 'dark' | 'light') => void
  update: AppUpdateSnapshot
  onCheckUpdate: () => void
  onInstallUpdate: () => void
  onCancelUpdate: () => void
  onSetAutoUpdate: (enabled: boolean) => void
  onSetAutoDownload: (enabled: boolean) => void
  onOpenReleases: () => void
  onClose: () => void
  onRestart: () => Promise<void> | void
  onChooseWorkspace: () => Promise<void> | void
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'providers')
  const dialogRef = useRef<HTMLDivElement>(null)
  const [dialogSize, setDialogSize] = useState<{ width: number; height: number } | undefined>(
    () => {
      try {
        const raw = localStorage.getItem('pi-settings-size')
        if (!raw) return undefined
        const parsed = JSON.parse(raw) as { width?: number; height?: number }
        if (!parsed.width || !parsed.height) return undefined
        return { width: parsed.width, height: parsed.height }
      } catch {
        return undefined
      }
    }
  )
  const dialogStyle = dialogSize
    ? { width: `${dialogSize.width}px`, height: `${dialogSize.height}px` }
    : undefined

  // Remember the size the user dragged the dialog to; the CSS resize handle does the rest.
  useEffect(() => {
    const element = dialogRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    let timer: number | undefined
    const observer = new ResizeObserver(() => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const width = Math.round(element.getBoundingClientRect().width)
        const height = Math.round(element.getBoundingClientRect().height)
        localStorage.setItem('pi-settings-size', JSON.stringify({ width, height }))
        setDialogSize({ width, height })
      }, 400)
    })
    observer.observe(element)
    return () => {
      if (timer) window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [open])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providersLoading, setProvidersLoading] = useState(false)
  /** ChatGPT plan windows behind the OpenAI rows; `undefined` until the first answer arrives. */
  const [usage, setUsage] = useState<ChatGptUsageResult>()
  const [usageLoading, setUsageLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [loadError, setLoadError] = useState<string>()
  const [login, setLogin] = useState<LoginState>()
  const [modelsJson, setModelsJson] = useState<{ path: string; content: string }>()
  const [providerEditor, setProviderEditor] = useState<{
    file: { path: string; content: string }
    provider?: ProviderInfo
    mode: 'form' | 'json'
  }>()
  const [settings, setSettings] = useState<AppSettings>()
  const [desktopConfig, setDesktopConfig] = useState<DesktopConfig>()
  const activeTab =
    desktopConfig?.capabilities &&
    !desktopConfig.capabilities.providerSettings &&
    ['providers', 'mcp', 'agents'].includes(tab)
      ? 'general'
      : tab
  useEffect(() => {
    if (open) void window.pi.getDesktopConfig().then(setDesktopConfig)
    if (
      status.capabilities &&
      !status.capabilities.providerSettings &&
      (activeTab === 'providers' ||
        activeTab === 'mcp' ||
        activeTab === 'agents')
    )
      setTab('general')
  }, [open, status.engine])
  const [proxyInfo, setProxyInfo] = useState<ProxyInfo>()
  const [models, setModels] = useState<ModelChoice[]>([])
  const [defaultProvider, setDefaultProvider] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [defaultThinking, setDefaultThinking] = useState('')
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const [confirmLogout, setConfirmLogout] = useState<string>()
  const [modelConfig, setModelConfig] = useState<ModelConfigState>()
  const [webSearch, setWebSearch] = useState<McpWebState>()
  const [webBusy, setWebBusy] = useState(false)
  /** Auto-compaction trigger as a percentage of the window; kept in sync with `status`. */
  const [compactPercent, setCompactPercent] = useState('')
  const [compactBusy, setCompactBusy] = useState(false)
  const loginRef = useRef<LoginState | undefined>(undefined)
  loginRef.current = login

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true)
    try {
      const [nextProviders, file] = await Promise.all([
        window.pi.listProviders(),
        window.pi.getModelsJson()
      ])
      setProviders(nextProviders)
      setModelsJson(file)
      setLoadError(undefined)
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProvidersLoading(false)
    }
  }, [])

  const loadUsage = useCallback(async (force = false) => {
    setUsageLoading(true)
    try {
      setUsage(await window.pi.chatGptUsage(force))
    } catch (cause) {
      setUsage({ reason: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setUsageLoading(false)
    }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const [nextSettings, nextModels, nextDesktop, nextProxy] = await Promise.all([
        window.pi.getAppSettings(),
        window.pi.listModelChoices(),
        window.pi.getDesktopConfig(),
        window.pi.getProxyInfo()
      ])
      setSettings(nextSettings)
      setModels(nextModels)
      setDesktopConfig(nextDesktop)
      setProxyInfo(nextProxy)
      setDefaultProvider(nextSettings.defaultProvider ?? '')
      setDefaultModel(nextSettings.defaultModel ?? '')
      setDefaultThinking(nextSettings.defaultThinkingLevel ?? '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  /**
   * Turn auto-compaction on or off. Enabling also makes the main process write the reserve that
   * puts the trigger at `AUTO_COMPACT_RATIO` of the current model's window, then restart pi.
   */
  const toggleAutoCompact = useCallback(
    async (enabled: boolean) => {
      try {
        const result = await window.pi.setAutoCompact(enabled)
        if (!result.ok) {
          setError(result.error ?? '设置失败')
          return
        }
        const percent = result.percent ?? status.autoCompactPercent
        setNotice(
          !enabled
            ? '自动压缩已关闭'
            : result.warning
              ? result.warning
              : percent === undefined
                ? '自动压缩已开启'
                : `自动压缩已开启：到 ${percent}% 时压缩`
        )
        await loadSettings()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [loadSettings, status.autoCompactPercent]
  )

  /**
   * Set the auto-compaction trigger (percentage of the model's window).
   *
   * The main process stores it as a ratio, so switching to a model with a different window keeps
   * the same proportion and recomputes pi's `reserveTokens`. While a run is in flight the restart is
   * deferred, so the value shows up in `/autocompact` and the meter immediately and pi picks it up
   * when the current turn settles.
   */
  const applyCompactPercent = useCallback(
    async (value: number) => {
      setCompactBusy(true)
      try {
        const result = await window.pi.setAutoCompactRatio(value)
        if (!result.ok) {
          setError(result.error ?? '设置失败')
          return
        }
        setNotice(
          result.warning ??
            `自动压缩阈值：${result.percent ?? value}%（当前模型保留 ${formatTokens(
              result.reserveTokens ?? 0
            )} tokens）`
        )
        await loadSettings()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setCompactBusy(false)
      }
    },
    [loadSettings]
  )

  // Broadcasts carry the effective threshold, so the select follows `/autocompact 500000` too.
  useEffect(() => {
    if (typeof status.autoCompactPercent === 'number') {
      setCompactPercent(String(status.autoCompactPercent))
    }
  }, [status.autoCompactPercent])

  useEffect(() => {
    if (!open) return
    setTab(initialTab ?? 'providers')
    setProviderEditor(undefined)
    setNotice(undefined)
    setError(undefined)
    void loadProviders()
    void loadSettings()
    // The per-provider "联网" switch lives on the MCP engine's config, so read it here.
    void window.pi
      .getMcpState()
      .then((state) => setWebSearch(state.web))
      .catch(() => undefined)
  }, [open, initialTab, loadProviders, loadSettings])

  useEffect(() => {
    if (!open) return
    return window.pi.onMcpState((state) => setWebSearch(state.web))
  }, [open])

  // Only a stored ChatGPT-subscription credential has plan windows, so otherwise skip the request.
  const chatGptProviderKey = useMemo(
    () =>
      providers
        .filter(isChatGptPlanProvider)
        .map((provider) => provider.id)
        .sort()
        .join(','),
    [providers]
  )
  useEffect(() => {
    if (!open || !chatGptProviderKey) return
    void loadUsage()
  }, [open, chatGptProviderKey, loadUsage])

  const toggleProviderWebSearch = useCallback(async (provider: ProviderInfo, enabled: boolean) => {
    setWebBusy(true)
    try {
      const next = await window.pi.setProviderWebSearch(provider.id, enabled)
      setWebSearch(next.web)
      setNotice(
        enabled
          ? `${provider.name} 的原生搜索已开启（web_search 会优先用它）`
          : `${provider.name} 的原生搜索已关闭（web_search 回退 Brave）`
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWebBusy(false)
    }
  }, [])

  useEffect(
    () =>
      window.pi.onLoginMessage((message) => {
        setLogin((current) => {
          if (!current || current.loginId !== message.loginId) return current
          if (message.kind === 'prompt') {
            return { ...current, prompt: { promptId: message.promptId, prompt: message.prompt } }
          }
          if (message.kind === 'event') {
            return { ...current, events: [...current.events, message.event] }
          }
          return {
            ...current,
            prompt: undefined,
            submitting: false,
            result: { ok: message.ok, error: message.error }
          }
        })
        if (message.kind === 'done') {
          void loadProviders()
          void loadSettings()
        }
      }),
    [loadProviders, loadSettings]
  )

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (loginRef.current) {
        if (!loginRef.current.result) {
          window.pi.cancelLogin(loginRef.current.loginId)
        }
        setLogin(undefined)
      } else {
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  useEffect(() => {
    if (!notice && !error) return
    const timer = setTimeout(() => {
      setNotice(undefined)
      setError(undefined)
    }, 6000)
    return () => clearTimeout(timer)
  }, [notice, error])

  // Include saved definitions even if the runtime cannot yet offer a login method.
  const allProviders = useMemo(() => {
    const merged = new Map(providers.map((provider) => [provider.id, provider]))
    try {
      const saved = JSON.parse(modelsJson?.content ?? '{}').providers ?? {}
      for (const [id, value] of Object.entries(saved)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const config = value as Record<string, unknown>
        const current = merged.get(id)
        merged.set(id, {
          id,
          name: id,
          configured: false,
          builtin: false,
          options: [],
          modelCount: Array.isArray(config.models) ? config.models.length : 0,
          ...current,
          ...(typeof config.name === 'string' && config.name ? { name: config.name } : {}),
          ...(typeof config.baseUrl === 'string' ? { baseUrl: config.baseUrl } : {})
        })
      }
    } catch {
      // The JSON editor remains available to repair malformed configuration.
    }
    return [...merged.values()].sort((a, b) =>
      Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name)
    )
  }, [providers, modelsJson])

  const filteredProviders = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return allProviders
    return allProviders.filter(
      (provider) =>
        provider.name.toLowerCase().includes(needle) || provider.id.toLowerCase().includes(needle)
    )
  }, [allProviders, query])

  const configuredCount = providers.filter((provider) => provider.configured).length

  const providerChoices = useMemo(() => {
    const map = new Map<string, string>()
    for (const model of models) map.set(model.provider, model.providerName)
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [models])

  /** Common trigger points, plus whatever `/autocompact <tokens>` happened to produce. */
  const compactOptions = useMemo(() => {
    const values = [...COMPACT_PERCENT_PRESETS]
    const current = Number(compactPercent)
    if (Number.isFinite(current) && current > 0 && !values.includes(current)) {
      values.push(current)
      values.sort((a, b) => a - b)
    }
    return values
  }, [compactPercent])

  const filteredModels = useMemo(
    () => models.filter((model) => !defaultProvider || model.provider === defaultProvider),
    [models, defaultProvider]
  )

  const builtinIds = useMemo(
    () => new Set(providers.filter((provider) => provider.builtin).map((provider) => provider.id)),
    [providers]
  )

  const filteredProviderModels = useMemo(() => {
    if (!modelConfig) return []
    const needle = modelConfig.query.trim().toLowerCase()
    return modelConfig.models.filter((model) => {
      if (!needle) return true
      return `${model.name ?? ''} ${model.modelId}`.toLowerCase().includes(needle)
    })
  }, [modelConfig])

  const startLogin = useCallback(async (provider: ProviderInfo, type: ProviderAuthType) => {
    const loginId = crypto.randomUUID()
    setLogin({
      loginId,
      providerName: provider.name,
      method: type,
      events: []
    })
    const result = await window.pi
      .startLogin(provider.id, type, loginId)
      .catch((cause: unknown) => ({
        error: cause instanceof Error ? cause.message : String(cause)
      }))
    if (result.error) {
      setLogin((current) =>
        current ? { ...current, result: { ok: false, error: result.error } } : current
      )
    }
  }, [])

  const answerLogin = useCallback(async (value: string) => {
    const current = loginRef.current
    if (!current?.prompt) return
    setLogin((state) => (state ? { ...state, submitting: true, prompt: undefined } : state))
    await window.pi.answerLogin(current.loginId, current.prompt.promptId, value)
  }, [])

  const cancelLogin = useCallback(() => {
    const current = loginRef.current
    if (current) window.pi.cancelLogin(current.loginId)
    setLogin(undefined)
  }, [])

  const logout = useCallback(
    async (provider: ProviderInfo) => {
      if (confirmLogout !== provider.id) {
        setConfirmLogout(provider.id)
        setTimeout(
          () => setConfirmLogout((value) => (value === provider.id ? undefined : value)),
          4000
        )
        return
      }
      setConfirmLogout(undefined)
      const result = await window.pi.logoutProvider(provider.id)
      if (result.ok) {
        setNotice(`已退出 ${provider.name}`)
        void loadProviders()
      } else {
        setError(result.error ?? '退出失败')
      }
    },
    [confirmLogout, loadProviders]
  )

  const openModelConfig = useCallback(async (provider: ProviderInfo) => {
    setModelConfig({
      provider,
      models: [],
      selected: new Set(),
      query: '',
      loading: true,
      saving: false
    })
    try {
      const models = await window.pi.listProviderModels(provider.id)
      setModelConfig((prev) =>
        prev && prev.provider.id === provider.id
          ? {
              ...prev,
              models,
              selected: new Set(models.filter((model) => model.enabled).map((model) => model.id)),
              loading: false
            }
          : prev
      )
    } catch (cause) {
      setModelConfig((prev) =>
        prev
          ? {
              ...prev,
              loading: false,
              error: cause instanceof Error ? cause.message : String(cause)
            }
          : prev
      )
    }
  }, [])

  const toggleModel = useCallback((id: string) => {
    setModelConfig((prev) => {
      if (!prev) return prev
      const selected = new Set(prev.selected)
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
      return { ...prev, selected }
    })
  }, [])

  const setAllModels = useCallback((enabled: boolean) => {
    setModelConfig((prev) =>
      prev
        ? {
            ...prev,
            selected: enabled ? new Set(prev.models.map((model) => model.id)) : new Set()
          }
        : prev
    )
  }, [])

  const saveModelConfig = useCallback(async () => {
    const current = modelConfig
    if (!current) return
    setModelConfig({ ...current, saving: true, error: undefined })
    const result = await window.pi.setProviderModels(current.provider.id, [...current.selected])
    if (!result.ok) {
      setModelConfig((prev) =>
        prev ? { ...prev, saving: false, error: result.error ?? '保存失败' } : prev
      )
      return
    }
    setModelConfig(undefined)
    setNotice(`${current.provider.name} 的模型列表已保存`)
    void loadProviders()
    void loadSettings()
  }, [modelConfig, loadProviders, loadSettings])

  const openProviderEditor = async (mode: 'form' | 'json', provider?: ProviderInfo): Promise<void> => {
    try {
      const file = await window.pi.getModelsJson()
      setModelsJson(file)
      setProviderEditor({ file, provider, mode })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const saveModels = useCallback(
    async (content: string) => {
      const result = await window.pi.saveModelsJson(content)
      if (!result.ok) throw new Error(result.error ?? '保存失败')
      setNotice('服务商配置已保存')
      await loadProviders()
      await loadSettings()
    },
    [loadProviders, loadSettings]
  )

  const saveGeneral = useCallback(async () => {
    const result = await window.pi.saveAppSettings({
      defaultProvider: defaultProvider || '',
      defaultModel: defaultModel || '',
      defaultThinkingLevel: defaultThinking || ''
    })
    if (result.ok) {
      setNotice('默认模型已保存，pi 正在重启')
      void loadSettings()
    } else {
      setError(result.error ?? '保存失败')
    }
  }, [defaultProvider, defaultModel, defaultThinking, loadSettings])

  if (!open) return null

  const progress = updateProgress(update)

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="settings" ref={dialogRef} style={dialogStyle}>
        <aside className="settings-nav">
          <div className="settings-title">
            <span className="wordmark-mark">π</span>
            <span>设置</span>
          </div>
          {desktopConfig?.capabilities?.providerSettings && (
            <button
              className={activeTab === 'providers' ? 'active' : ''}
              onClick={() => setTab('providers')}
            >
              <UserIcon size={15} /> 服务商
              <span className="nav-count">{configuredCount}</span>
            </button>
          )}
          {desktopConfig?.capabilities?.mcp === 'managed' && (
            <>
              <button className={activeTab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>
                <PlugIcon size={15} /> MCP
              </button>
              <button
                className={activeTab === 'agents' ? 'active' : ''}
                onClick={() => setTab('agents')}
              >
                <SparkIcon size={15} /> 代理
              </button>
            </>
          )}
          <button
            className={activeTab === 'general' ? 'active' : ''}
            onClick={() => setTab('general')}
          >
            <FolderIcon size={15} /> 通用
          </button>
          <div className="settings-nav-foot">
            <span className={`status-dot ${status.phase}`} />
            <span>
              {engineLabel(status.engine)}{' '}
              {status.phase === 'ready'
                ? '已连接'
                : status.phase === 'starting'
                  ? '启动中'
                  : '未连接'}
            </span>
          </div>
        </aside>

        <section className="settings-body">
          <header className="settings-head">
            <div>
              <h2>
                {activeTab === 'providers'
                  ? '服务商'
                  : activeTab === 'mcp'
                    ? 'MCP'
                    : activeTab === 'agents'
                      ? '代理'
                      : '通用'}
              </h2>
              <p>
                {activeTab === 'providers'
                  ? '统一管理服务商的登录、接口地址与模型'
                  : activeTab === 'mcp'
                    ? '连接工具服务，扩展当前引擎的能力'
                    : activeTab === 'agents'
                      ? '子代理预设：注入哪些工具、追加什么提示词，以及如何暴露给模型'
                      : '当前会话目录、默认模型与思考等级'}
              </p>
            </div>
            <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
              <CloseIcon size={15} />
            </button>
          </header>

          {(notice || error) && (
            <div className={`settings-message ${error ? 'error' : 'ok'}`}>{error ?? notice}</div>
          )}

          {activeTab === 'providers' && (
            <div className="settings-content providers">
              <div className="providers-toolbar">
                <div className="search-box">
                  <SearchIcon size={13} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索服务商"
                    spellCheck={false}
                  />
                </div>
                <button className="primary" onClick={() => void openProviderEditor('form')}>
                  <PlusIcon size={12} /> 添加服务商
                </button>
                <button className="ghost" onClick={() => void openProviderEditor('json')}>
                  高级 JSON
                </button>
                <button
                  className="icon-btn"
                  title="刷新"
                  onClick={() => {
                    void loadProviders()
                    if (chatGptProviderKey) void loadUsage(true)
                  }}
                >
                  <RefreshIcon size={14} />
                </button>
                <span className="providers-count">
                  {providersLoading ? '加载中…' : `${configuredCount} / ${allProviders.length} 已配置`}
                </span>
              </div>

              {loadError && <div className="settings-message error">{loadError}</div>}

              <div className="provider-list">
                {filteredProviders.map((provider) => (
                  <div key={provider.id} className={`provider-row ${provider.configured ? 'configured' : ''}`}>
                    <ProviderMark id={provider.id} name={provider.name} />
                    <div className="provider-main">
                      <div className="provider-name">
                        {provider.name}
                        {provider.configured && (
                          <span className="badge ok">
                            {provider.storedType
                              ? provider.storedType === 'oauth'
                                ? 'OAuth'
                                : 'API Key'
                              : (SOURCE_LABELS[provider.source ?? ''] ?? '已配置')}
                          </span>
                        )}
                      </div>
                      <div className="provider-sub">
                        <code>{provider.id}</code>
                        <span>{provider.modelCount} 个模型</span>
                        {provider.sourceLabel && <span>{provider.sourceLabel}</span>}
                        {provider.baseUrl && (
                          <span className="provider-base-url-tag" title={provider.baseUrl}>
                            <PlugIcon size={10} />
                            {provider.baseUrl}
                          </span>
                        )}
                      </div>
                      {PROVIDER_NOTES[provider.id] && (
                        <div className="provider-note">{PROVIDER_NOTES[provider.id]}</div>
                      )}
                      {isChatGptPlanProvider(provider) && (
                        <ProviderUsageLine
                          result={usage}
                          loading={usageLoading}
                          onManage={() => void window.pi.openExternal(CHATGPT_USAGE_URL)}
                        />
                      )}
                    </div>
                    <div className="provider-actions">
                      {webSearch !== undefined &&
                        webSearch.nativeSupported.includes(provider.id) && (
                          <button
                            className={`prov-btn ghost web ${
                              webSearch.nativeProviders.includes(provider.id) ? 'on' : ''
                            }`}
                            disabled={webBusy}
                            onClick={() =>
                              void toggleProviderWebSearch(
                                provider,
                                !webSearch.nativeProviders.includes(provider.id)
                              )
                            }
                            title={
                              webSearch.nativeProviders.includes(provider.id)
                                ? 'web_search 优先用该服务商的原生搜索；点击改为回退 Brave'
                                : '让 web_search 用该服务商自己的原生搜索（需要已登录 / 有 Key）'
                            }
                          >
                            <GlobeIcon size={12} />
                            {webSearch.nativeProviders.includes(provider.id) ? '联网 开' : '联网'}
                          </button>
                        )}
                      {provider.options.map((option) => (
                        <button
                          key={option.type}
                          className={`prov-btn ${option.type}`}
                          onClick={() => void startLogin(provider, option.type)}
                        >
                          {option.type === 'oauth' ? (
                            <UserIcon size={12} />
                          ) : (
                            <KeyIcon size={12} />
                          )}
                          {option.label}
                        </button>
                      ))}
                        <button
                          className="prov-btn ghost"
                          onClick={() => void openModelConfig(provider)}
                          title="配置模型列表，隐藏不想用的模型"
                        >
                          <ListIcon size={12} /> 模型
                        </button>
                        <button className="prov-btn ghost" onClick={() => void openProviderEditor('form', provider)}
                          title="编辑接口地址、凭据与模型定义">
                          <PencilIcon size={12} /> 编辑
                        </button>
                        {provider.storedType && (
                          <button
                            className={`prov-btn ghost ${confirmLogout === provider.id ? 'danger' : ''}`}
                            onClick={() => void logout(provider)}
                            title="删除已保存的凭据"
                          >
                            <LogoutIcon size={12} />
                            {confirmLogout === provider.id ? '确认退出' : '退出'}
                          </button>
                        )}
                      </div>
                    </div>
                ))}
                {filteredProviders.length === 0 && (
                  <div className="provider-empty">
                    {providersLoading
                      ? '正在加载服务商…'
                      : allProviders.length === 0
                        ? '没有可用的服务商'
                        : '没有匹配的服务商'}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'agents' && <AgentsPanel onNotice={setNotice} onError={setError} />}

          {activeTab === 'mcp' && <McpPanel onNotice={setNotice} onError={setError} />}

          {activeTab === 'general' && (
            <div className="settings-content general">
              <div className="field">
                <label>当前会话目录</label>
                <div className="field-row">
                  <code className="path">{status.cwd}</code>
                  <button
                    className="ghost"
                    disabled={status.sessionLocked}
                    onClick={() => void onChooseWorkspace()}
                    title="选择目录并在该目录新建会话"
                  >
                    <FolderIcon size={12} /> 在新目录新建
                  </button>
                </div>
                <p className="field-hint">
                  {status.sessionLocked ? '会话已开始，目录和 agent 已锁定；需要其他工作区时请从侧栏新建会话。' : '发送第一条消息后，此会话的目录和 agent 将锁定。'}
                </p>
              </div>

              <div className="field">
                <label>新会话默认引擎</label>
                <select
                  aria-label="新会话默认引擎"
                  value={desktopConfig?.defaultEngine ?? 'prophey'}
                  onChange={(event) => {
                    const next = event.target.value as EngineId
                    void window.pi.setDefaultEngine(next).then(async (result) => {
                      if (!result.ok) throw new Error('保存默认引擎失败')
                      setDesktopConfig(await window.pi.getDesktopConfig())
                      setNotice('新会话将默认使用 ' + engineLabel(next) + '，已有会话不变')
                    }).catch((error) => setError(String(error)))
                  }}
                >
                  {(['prophey', 'pi', 'claude', 'codex'] as EngineId[]).map((id) => (
                    <option key={id} value={id}>{engineLabel(id)}</option>
                  ))}
                </select>
                <p className="field-hint">
                  每个会话独立保存自己的引擎。在对话输入框中选择引擎，只影响当前会话。
                  打开已有会话时会自动恢复它的引擎。
                </p>
                {desktopConfig?.capabilities?.mcp === 'native' && (
                  <p className="field-hint">
                    当前引擎的命令、子代理和 MCP 由其原生能力管理；不接入 Prophey 的桌面子代理及同类 MCP 工具。
                  </p>
                )}
              </div>

              <div className="field">
                <label>自动压缩</label>
                {desktopConfig?.capabilities?.autoCompaction === 'configurable' ? (
                  <>
                    <div className="field-row compaction-controls">
                      <Toggle
                        checked={settings?.compaction?.enabled !== false}
                        disabled={compactBusy || !settings}
                        onChange={(enabled) => void toggleAutoCompact(enabled)}
                      />
                      <select
                        aria-label="自动压缩触发阈值"
                        value={compactPercent}
                        disabled={compactBusy || !settings || settings.compaction?.enabled === false}
                        onChange={(event) => {
                          const next = Number(event.target.value)
                          setCompactPercent(String(next))
                          void applyCompactPercent(next)
                        }}
                      >
                        {!compactPercent && <option value="" disabled>等待模型信息</option>}
                        {compactOptions.map((percent) => (
                          <option key={percent} value={percent}>上下文达到 {percent}% 时</option>
                        ))}
                      </select>
                      {settings?.compaction?.enabled === false && <span className="field-inline">已关闭</span>}
                    </div>
                    <p className="field-hint">
                      {settings?.compaction?.enabled !== false && status.model?.contextWindow && compactPercent
                        ? '当前窗口 ' + formatTokens(status.model.contextWindow) + '，约 ' +
                          formatTokens(Math.round(Number(compactPercent) / 100 * status.model.contextWindow)) +
                          ' tokens 时压缩。'
                        : ''}
                      适用于支持此设置的会话，换模型时按窗口比例计算。
                    </p>
                  </>
                ) : (
                  <p className="field-hint">由当前引擎管理；可使用 /compact 手动压缩。</p>
                )}
              </div>
              {desktopConfig?.capabilities?.toolPolicy === 'sandbox' && (
                <div className="field">
                  <label>文件访问范围</label>
                  <select
                    value={desktopConfig.codexSandbox ?? 'default'}
                    onChange={(event) => {
                      const mode = event.target.value as 'default' | 'read-only' | 'workspace-write'
                      void window.pi.setEngineSandbox(mode).then(async (result) => {
                        if (!result.ok) setError(result.error ?? '设置失败')
                        setDesktopConfig(await window.pi.getDesktopConfig())
                      })
                    }}
                  >
                    <option value="default">使用 Codex 自己的配置</option>
                    <option value="read-only">只读</option>
                    <option value="workspace-write">允许写入工作区</option>
                  </select>
                </div>
              )}
              {desktopConfig?.capabilities?.toolPolicy === 'sandbox' && (
                <div className="field">
                  <label>原生提问</label>
                  <div className="field-row">
                    <Toggle
                      checked={desktopConfig.codexRequestUserInput !== false}
                      onChange={(enabled) =>
                        void window.pi.setEngineCodexQuestions(enabled).then(async (result) => {
                          if (!result.ok) setError(result.error ?? '设置失败')
                          setDesktopConfig(await window.pi.getDesktopConfig())
                        })
                      }
                    />
                    <span className="field-inline">允许 Codex 在动手前向你提问</span>
                  </div>
                  <p className="field-hint">
                    使用 Codex 实验性的 request_user_input 工具，问题显示在输入框上方的问答面板里。
                    只在本次启动传入配置覆盖，不修改你的 config.toml；关闭后模型只能自行假设。
                  </p>
                </div>
              )}
              <div className="field">
                <label>网络代理</label>
                <div className="field-row">
                  <code className="path">{proxyInfo?.proxy ?? '未检测到系统代理（直连）'}</code>
                </div>
                <p className="field-hint">
                  自动读取 Windows 系统代理（Clash 等）；OAuth、更新检查和引擎子进程都会继承该代理。
                </p>
              </div>

              <div className="field">
                <label>软件更新</label>
                <div className="update-card">
                  <div className="update-row">
                    <div className="update-info">
                      <div className="update-version">当前版本 {update.currentVersion}</div>
                      <div className={`update-status ${update.status}`}>
                        {updateStatusText(update)}
                        {update.latestVersion ? ` · 最新 ${update.latestVersion}` : ''}
                      </div>
                      {update.checkedAt && (
                        <div className="update-checked">
                          上次检查：
                          {new Date(update.checkedAt).toLocaleString('zh-CN')}
                        </div>
                      )}
                    </div>
                    <div className="update-actions">
                      <button
                        className="ghost"
                        onClick={onCheckUpdate}
                        disabled={updateBusy(update)}
                      >
                        <RefreshIcon size={12} /> 检查更新
                      </button>
                      {update.canInstall &&
                        update.latestVersion &&
                        (update.status === 'available' || update.status === 'preparing') && (
                          <button className="primary" onClick={onInstallUpdate}>
                            {update.status === 'preparing' ? '立即重启安装' : '下载并安装'}
                          </button>
                        )}
                      {update.status === 'downloading' && (
                        <button className="ghost" onClick={onCancelUpdate}>
                          取消下载
                        </button>
                      )}
                    </div>
                  </div>

                  {update.status === 'downloading' && (
                    <div className="update-progress">
                      <div className="update-progress-bar">
                        <span style={{ width: `${progress ?? 0}%` }} />
                      </div>
                      <span>
                        {(update.downloaded / 1024 / 1024).toFixed(1)} MB
                        {update.total ? ` / ${(update.total / 1024 / 1024).toFixed(1)} MB` : ''}
                        {progress !== null ? ` · ${progress}%` : ''}
                      </span>
                    </div>
                  )}

                  {update.notes && (
                    <details className="update-notes">
                      <summary>更新说明</summary>
                      <pre>{update.notes}</pre>
                    </details>
                  )}

                  {!update.canInstall && (
                    <p className="field-hint">
                      当前是开发 / 未打包模式，只能检测版本，无法应用安装包。
                    </p>
                  )}
                  {update.error && (
                    <div className="settings-message error">{update.error.message}</div>
                  )}

                  <div className="update-footer">
                    <label className="update-auto">
                      <input
                        type="checkbox"
                        checked={update.autoCheck}
                        disabled={updateBusy(update)}
                        onChange={(event) => onSetAutoUpdate(event.target.checked)}
                      />
                      自动检查更新（启动后及每 6 小时）
                    </label>
                    <label className="update-auto">
                      <input
                        type="checkbox"
                        checked={update.autoDownload}
                        onChange={(event) => onSetAutoDownload(event.target.checked)}
                      />
                      自动下载更新（退出应用时静默安装，不弹安装向导）
                    </label>
                    <button className="update-link" onClick={onOpenReleases}>
                      打开 GitHub 发布页
                    </button>
                  </div>
                </div>
              </div>

              {desktopConfig?.capabilities?.providerSettings && (
                <>
                  <div className="field-grid">
                    <div className="field">
                      <label>默认服务商</label>
                      <select
                        value={defaultProvider}
                        onChange={(event) => {
                          setDefaultProvider(event.target.value)
                          setDefaultModel('')
                        }}
                      >
                        <option value="">自动</option>
                        {providerChoices.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label>默认模型</label>
                      <select
                        value={defaultModel}
                        onChange={(event) => setDefaultModel(event.target.value)}
                      >
                        <option value="">自动</option>
                        {filteredModels.map((model) => (
                          <option key={`${model.provider}/${model.id}`} value={model.id}>
                            {model.name ?? model.id}
                            {model.configured ? '' : '（未配置凭据）'}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label>思考等级</label>
                      <select
                        value={defaultThinking}
                        onChange={(event) => setDefaultThinking(event.target.value)}
                      >
                        <option value="">自动</option>
                        {THINKING_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </>
              )}
              <div className="field">
                <label>外观</label>
                <div className="theme-switch">
                  <button
                    className={theme === 'dark' ? 'active' : ''}
                    onClick={() => onThemeChange('dark')}
                  >
                    <MoonIcon size={13} /> 深色
                  </button>
                  <button
                    className={theme === 'light' ? 'active' : ''}
                    onClick={() => onThemeChange('light')}
                  >
                    <SunIcon size={13} /> 亮色
                  </button>
                </div>
              </div>

              <div className="general-actions">
                {desktopConfig?.capabilities?.providerSettings && (
                  <button className="primary" onClick={() => void saveGeneral()}>
                    保存并重启引擎
                  </button>
                )}
                <button className="ghost" onClick={() => void onRestart()}>
                  <RefreshIcon size={12} /> 仅重启引擎
                </button>
                {desktopConfig?.capabilities?.providerSettings && (
                  <button className="ghost" onClick={() => void window.pi.openAgentDir()}>
                    <FolderIcon size={12} /> 打开配置目录
                  </button>
                )}
              </div>

              {desktopConfig?.capabilities?.providerSettings && (
                <div className="paths">
                  <div>
                    <span>settings.json</span>
                    <code>{settings?.settingsPath ?? '~/.pi/agent/settings.json'}</code>
                  </div>
                  <div>
                    <span>auth.json</span>
                    <code>{settings?.authPath ?? '~/.pi/agent/auth.json'}</code>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {providerEditor && (
        <ProviderEditor
          filePath={providerEditor.file.path}
          content={providerEditor.file.content}
          provider={providerEditor.provider}
          initialMode={providerEditor.mode}
          builtinIds={builtinIds}
          knownIds={new Set(allProviders.map((provider) => provider.id))}
          onSave={saveModels}
          onClose={() => setProviderEditor(undefined)}
          onOpenFile={() => void window.pi.openModelsJson()}
        />
      )}

      {modelConfig && (
        <div className="login-backdrop">
          <div className="model-config-dialog">
            <header>
              <div>
                <h3>{modelConfig.provider.name} 模型</h3>
                <p>勾选要保留在模型列表中的模型，未勾选的会隐藏</p>
              </div>
              <button className="icon-btn" onClick={() => setModelConfig(undefined)} title="关闭">
                <CloseIcon size={14} />
              </button>
            </header>

            <div className="model-config-search">
              <SearchIcon size={13} />
              <input
                autoFocus
                value={modelConfig.query}
                onChange={(event) =>
                  setModelConfig((prev) => (prev ? { ...prev, query: event.target.value } : prev))
                }
                placeholder="搜索模型"
                spellCheck={false}
              />
            </div>

            <div className="model-config-list">
              {modelConfig.loading && <div className="model-config-empty">加载模型列表…</div>}
              {!modelConfig.loading && filteredProviderModels.length === 0 && (
                <div className="model-config-empty">没有匹配的模型</div>
              )}
              {filteredProviderModels.map((model) => (
                <label key={model.id} className="model-config-row">
                  <input
                    type="checkbox"
                    checked={modelConfig.selected.has(model.id)}
                    onChange={() => toggleModel(model.id)}
                  />
                  <span className="model-config-name">{model.name ?? model.modelId}</span>
                  <span className="model-config-meta">
                    {model.modelId}
                    {model.contextWindow ? ` · ${formatTokens(model.contextWindow)}` : ''}
                  </span>
                </label>
              ))}
            </div>

            {modelConfig.error && <div className="model-picker-error">{modelConfig.error}</div>}

            <footer>
              <span className="model-config-count">
                已启用 {modelConfig.selected.size} / {modelConfig.models.length}
              </span>
              <div className="model-config-actions">
                <button className="ghost" onClick={() => setAllModels(true)}>
                  全选
                </button>
                <button className="ghost" onClick={() => setAllModels(false)}>
                  全不选
                </button>
                <button className="ghost" onClick={() => setModelConfig(undefined)}>
                  取消
                </button>
                <button
                  className="primary"
                  onClick={() => void saveModelConfig()}
                  disabled={modelConfig.saving || modelConfig.loading}
                >
                  保存
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}

      {login && (
        <LoginDialog
          login={login}
          onAnswer={(value) => void answerLogin(value)}
          onCancel={cancelLogin}
          onClose={() => setLogin(undefined)}
          onOpenExternal={(url) => void window.pi.openExternal(url)}
        />
      )}
    </div>
  )
}
