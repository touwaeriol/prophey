import { useMemo, useState } from 'react'
import type { ProviderInfo } from '@shared/types'
import { declaresImageInput } from '@shared/model-input'
import { needsVersionPath as bareOpenAiUrl, withVersionPath } from '@shared/provider-url'
import { buildProviderModels, emptyModel, type ModelDraft } from '../lib/provider-models'
import { CheckIcon, CloseIcon, ExternalIcon, PlusIcon, TrashIcon } from './Icons'

const API_TYPES = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'mistral-conversations',
  'azure-openai-responses',
  'openai-codex-responses',
  'bedrock-converse-stream',
  'google-vertex',
  'pi-messages'
]

interface RawProvider {
  [key: string]: unknown
}

interface ProviderRow {
  id: string
  name: string
  baseUrl: string
  api: string
  apiKey: string
  models: Record<string, unknown>[]
  raw: RawProvider
}

interface ProviderDraft {
  originalId?: string
  id: string
  name: string
  baseUrl: string
  api: string
  apiKey: string
  models: ModelDraft[]
}

function toDraft(provider: ProviderRow): ProviderDraft {
  return {
    originalId: provider.id,
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: provider.apiKey,
    models:
      provider.models.length > 0
        ? provider.models.map((model) => ({
            id: typeof model.id === 'string' ? model.id : '',
            name: typeof model.name === 'string' ? model.name : '',
            contextWindow:
              typeof model.contextWindow === 'number' ? String(model.contextWindow) : '',
            maxTokens: typeof model.maxTokens === 'number' ? String(model.maxTokens) : '',
            reasoning: Boolean(model.reasoning),
            images: declaresImageInput(model.input),
            raw: model
          }))
        : [emptyModel()]
  }
}

export function ProviderEditor({
  filePath,
  content,
  provider,
  builtinIds,
  knownIds,
  initialMode,
  onSave,
  onClose,
  onOpenFile
}: {
  filePath: string
  content: string
  provider?: ProviderInfo
  builtinIds: Set<string>
  knownIds: Set<string>
  initialMode: 'form' | 'json'
  onSave: (content: string) => Promise<void>
  onClose: () => void
  onOpenFile: () => void
}) {
  const [mode, setMode] = useState(initialMode)
  const [jsonContent, setJsonContent] = useState(content)
  const [editorError, setEditorError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [saving, setSaving] = useState(false)
  const parsed = useMemo(() => {
    try {
      const data = JSON.parse(content) as Record<string, unknown>
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('顶层必须是 JSON 对象')
      }
      if (data.providers !== undefined &&
          (!data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers))) {
        throw new Error('providers 必须是 JSON 对象')
      }
      const providersRaw =
        data.providers && typeof data.providers === 'object'
          ? (data.providers as Record<string, unknown>)
          : {}
      const list: ProviderRow[] = Object.entries(providersRaw).map(([id, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`服务商 ${id} 必须是 JSON 对象`)
        }
        const raw = value as RawProvider
        if (raw.models !== undefined &&
            (!Array.isArray(raw.models) || raw.models.some((model) =>
              !model || typeof model !== 'object' || Array.isArray(model)))) {
          throw new Error(`服务商 ${id} 的 models 必须是模型对象数组`)
        }
        return {
          id,
          name: typeof raw.name === 'string' ? raw.name : '',
          baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
          api: typeof raw.api === 'string' ? raw.api : '',
          apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
          models: Array.isArray(raw.models) ? (raw.models as Record<string, unknown>[]) : [],
          raw
        }
      })
      return { data, list, error: undefined }
    } catch (cause) {
      return {
        data: null,
        list: [] as ProviderRow[],
        error: cause instanceof Error ? cause.message : String(cause)
      }
    }
  }, [content])

  const [draft, setDraft] = useState<ProviderDraft>(() => {
    const saved = parsed.list.find((item) => item.id === provider?.id)
    if (saved) return toDraft(saved)
    return {
      originalId: provider?.id,
      id: provider?.id ?? '',
      name: '',
      baseUrl: '',
      api: provider ? '' : 'openai-completions',
      apiKey: '',
      models: [emptyModel()]
    }
  })
  const savedProvider = parsed.list.find((item) => item.id === provider?.id)

  /**
   * An OpenAI-compatible adapter appends `/chat/completions` to whatever Base URL it is given, so a
   * bare host would point the request at the gateway's web page (200 with HTML, and the failure then
   * looks like "this protocol is not supported"). Saving fills the version segment in; this flag only
   * says so before the user commits.
   */
  const needsVersionPath = bareOpenAiUrl(draft.baseUrl, draft.api)

  const applyContent = async (nextContent: string): Promise<void> => {
    setSaving(true)
    setEditorError(undefined)
    try {
      await onSave(nextContent)
      onClose()
    } catch (cause) {
      setEditorError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const saveDraft = async (): Promise<void> => {
    if (parsed.error) {
      setEditorError(`JSON 解析失败：${parsed.error}`)
      return
    }
    const id = draft.id.trim()
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      setEditorError('服务商 ID 只能包含字母、数字、下划线和短横线')
      return
    }
    if (!draft.originalId && (knownIds.has(id) || parsed.list.some((item) => item.id === id))) {
      setEditorError('该服务商 ID 已存在，请从列表中编辑')
      return
    }
    const isBuiltin = builtinIds.has(id)
    if (!isBuiltin && !draft.baseUrl.trim()) {
      setEditorError('服务商需要填写 Base URL')
      return
    }
    if (!isBuiltin && !draft.api.trim()) {
      setEditorError('服务商需要选择 API 类型')
      return
    }
    if (draft.baseUrl.trim() && !/^https?:\/\//i.test(draft.baseUrl.trim())) {
      setEditorError('接口地址必须以 http:// 或 https:// 开头')
      return
    }
    // pi needs the window to decide when to compact and how much it can send; a model without one
    // silently loses auto-compaction (the reserve falls back to a flat 16K tokens).
    const missingWindow = draft.models.find(
      (model) => model.id.trim() &&
        (!Number.isFinite(Number(model.contextWindow)) || !(Number(model.contextWindow) > 0))
    )
    if (missingWindow) {
      setEditorError(
        `模型 ${missingWindow.id.trim()} 必须填写上下文窗口大小（contextWindow），否则自动压缩与用量显示都会失准`
      )
      return
    }
    const models = buildProviderModels(draft.models)
    const existingProvider = draft.originalId
      ? parsed.list.find((provider) => provider.id === draft.originalId)?.raw ?? {}
      : {}
    const provider: Record<string, unknown> = {
      ...existingProvider,
      name: draft.name.trim() || undefined,
      baseUrl: draft.baseUrl.trim() || undefined,
      api: draft.api.trim() || undefined,
      apiKey: draft.apiKey.trim() ||
        (typeof existingProvider.apiKey === 'string' ? undefined : existingProvider.apiKey),
      models: models.length || !isBuiltin ? models : undefined
    }
    const nextData = {
      ...(parsed.data ?? {}),
      providers: {
        ...((parsed.data?.providers as Record<string, unknown> | undefined) ?? {})
      }
    }
    if (draft.originalId) delete nextData.providers[draft.originalId]
    nextData.providers[id] = provider
    const nextContent = JSON.stringify(nextData, null, 2)
    await applyContent(nextContent)
  }

  const deleteProvider = async (provider: ProviderRow): Promise<void> => {
    if (confirmDelete !== provider.id) {
      setConfirmDelete(provider.id)
      setTimeout(
        () => setConfirmDelete((value) => (value === provider.id ? undefined : value)),
        4000
      )
      return
    }
    setConfirmDelete(undefined)
    const nextData = {
      ...(parsed.data ?? {}),
      providers: {
        ...((parsed.data?.providers as Record<string, unknown> | undefined) ?? {})
      }
    }
    delete nextData.providers[provider.id]
    await applyContent(JSON.stringify(nextData, null, 2))
  }

  const updateDraft = (patch: Partial<ProviderDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
  }

  const updateModel = (index: number, patch: Partial<ModelDraft>): void => {
    setDraft((current) => {
      const models = current.models.slice()
      models[index] = { ...models[index], ...patch }
      return { ...current, models }
    })
  }

  return (
    <div
      className="login-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          if (!saving) onClose()
        }
      }}
    >
      <div className="provider-editor" role="dialog" aria-modal="true" aria-label="服务商配置">
        <header>
          <div>
            <h3>{mode === 'json' ? '高级 JSON' : provider ? '编辑服务商' : '添加服务商'}</h3>
            <p>{mode === 'json' ? '编辑全部服务商配置' : provider?.name ?? '配置接口、凭据与模型'}</p>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={saving} title="关闭">
            <CloseIcon size={14} />
          </button>
        </header>
        {mode === 'json' ? (
          <div className="provider-editor-body">
            <div className="provider-config-bar">
              <code className="path">{filePath}</code>
              <button className="ghost" onClick={onOpenFile}>
                <ExternalIcon size={12} /> 打开文件
              </button>
            </div>
            <textarea
              className="models-editor"
              autoFocus
              value={jsonContent}
              spellCheck={false}
              aria-label="服务商 JSON 配置"
              onChange={(event) => setJsonContent(event.target.value)}
            />
            <p className="field-hint">支持 headers、compat、modelOverrides 等高级字段。保存前会校验 JSON。</p>
          </div>
        ) : parsed.error ? (
          <div className="provider-editor-body">
            <p>服务商配置不是合法 JSON：{parsed.error}</p>
            <button className="ghost" onClick={() => setMode('json')}>
              切到 JSON 修复
            </button>
          </div>
        ) : (
          <div className="provider-editor-body">
            <div className="field-grid two">
              <div className="field">
                <label>服务商 ID</label>
                <input
                  autoFocus={!provider}
                  value={draft.id}
                  disabled={Boolean(draft.originalId)}
                  placeholder="my-gateway"
                  spellCheck={false}
                  onChange={(event) => updateDraft({ id: event.target.value })}
                />
                <p className="field-hint">字母、数字、下划线或短横线；保存后不可修改。</p>
              </div>
              <div className="field">
                <label>显示名称</label>
                <input
                  autoFocus={Boolean(provider)}
                  value={draft.name}
                  placeholder="My Gateway"
                  onChange={(event) => updateDraft({ name: event.target.value })}
                />
              </div>
            </div>

            <div className="field">
              <label>Base URL</label>
              <input
                value={draft.baseUrl}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                onChange={(event) => updateDraft({ baseUrl: event.target.value })}
              />
              {needsVersionPath && (
                <p className="field-hint warn">
                  OpenAI 兼容接口会请求 <code>Base URL + /chat/completions</code>：保存时会自动补成{' '}
                  <code>{withVersionPath(draft.baseUrl)}</code>（带路径的地址不会被动）。
                </p>
              )}
            </div>

            <div className="field-grid two">
              <div className="field">
                <label>API 类型</label>
                <input
                  list="pi-api-types"
                  value={draft.api}
                  placeholder="openai-completions"
                  spellCheck={false}
                  onChange={(event) => updateDraft({ api: event.target.value })}
                />
                <datalist id="pi-api-types">
                  {API_TYPES.map((type) => (
                    <option key={type} value={type} />
                  ))}
                </datalist>
              </div>
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={draft.apiKey}
                  placeholder="$MY_API_KEY 或 sk-..."
                  spellCheck={false}
                  onChange={(event) => updateDraft({ apiKey: event.target.value })}
                />
                <p className="field-hint">支持 $ENV 变量、字面量或 !命令；留空沿用已有登录凭据。</p>
              </div>
            </div>

            {builtinIds.has(draft.id) && (
              <p className="field-hint">接口地址和 API 类型留空时沿用预置值。下方模型用于补充或修改预置模型；模型显示开关在列表的“模型”中设置。</p>
            )}
            <div className="provider-models">
              <div className="provider-models-head">
                <div>
                  <strong>模型</strong>
                  <span>{draft.models.filter((model) => model.id.trim()).length} 个</span>
                </div>
                <button
                  className="ghost"
                  onClick={() =>
                    setDraft((current) =>
                      current ? { ...current, models: [...current.models, emptyModel()] } : current
                    )
                  }
                >
                  <PlusIcon size={12} /> 添加模型
                </button>
              </div>

              <div className="provider-model-rows">
                {draft.models.map((model, index) => (
                  <div className="provider-model-row" key={index}>
                    <input
                      value={model.id}
                      placeholder="模型 ID"
                      spellCheck={false}
                      onChange={(event) => updateModel(index, { id: event.target.value })}
                    />
                    <input
                      value={model.name}
                      placeholder="显示名称"
                      onChange={(event) => updateModel(index, { name: event.target.value })}
                    />
                    <input
                      type="number"
                      value={model.contextWindow}
                      placeholder="上下文（必填）"
                      title="上下文窗口大小，例如 200000；自动压缩按它的 90% 触发"
                      onChange={(event) =>
                        updateModel(index, { contextWindow: event.target.value })
                      }
                    />
                    <input
                      type="number"
                      value={model.maxTokens}
                      placeholder="最大输出"
                      onChange={(event) => updateModel(index, { maxTokens: event.target.value })}
                    />
                    <label className="model-reasoning">
                      <input
                        type="checkbox"
                        checked={model.reasoning}
                        onChange={(event) =>
                          updateModel(index, { reasoning: event.target.checked })
                        }
                      />
                      推理
                    </label>
                    <label
                      className="model-reasoning"
                      title="勾选后把图片按 base64 发给模型；不勾选时 pi 会把截图替换成“image omitted”，模型看不到"
                    >
                      <input
                        type="checkbox"
                        checked={model.images}
                        onChange={(event) => updateModel(index, { images: event.target.checked })}
                      />
                      支持图片
                    </label>
                    <button
                      className="icon-btn"
                      title="删除模型"
                      onClick={() =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                models: current.models.filter((_, item) => item !== index)
                              }
                            : current
                        )
                      }
                    >
                      <TrashIcon size={13} />
                    </button>
                  </div>
                ))}
                {draft.models.length === 0 && (
                  <div className="provider-model-empty">还没有模型，点右上角添加</div>
                )}
              </div>
            </div>

          </div>
        )}
        {editorError && <div className="settings-message error">{editorError}</div>}
        <footer>
          {mode === 'form' && savedProvider ? (
            <button className="ghost danger" disabled={saving} onClick={() => void deleteProvider(savedProvider)}>
              <TrashIcon size={12} />
              {confirmDelete === savedProvider.id ? '确认' : ''}{builtinIds.has(savedProvider.id) ? '恢复预置配置' : '删除服务商'}
            </button>
          ) : <span className="provider-editor-hint">保存后应用到当前引擎</span>}
          <div className="provider-editor-actions">
            <button className="ghost" onClick={onClose} disabled={saving}>取消</button>
            <button className="primary" disabled={saving || (mode === 'form' && Boolean(parsed.error))}
              onClick={() => void (mode === 'json' ? applyContent(jsonContent) : saveDraft())}>
              <CheckIcon size={12} /> {saving ? '保存中…' : '保存并应用'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
