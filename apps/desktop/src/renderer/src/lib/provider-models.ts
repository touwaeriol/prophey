/**
 * Turning the provider editor's model rows back into `models.json` entries.
 *
 * Kept out of the component so a test can prove what is written: `contextWindow` decides
 * compaction, `input` decides whether a screenshot reaches the model at all (see
 * `shared/model-input.ts`), and every field the form does not show (`compat`, `headers`,
 * `thinkingLevelMap`, `inputLimits`, …) has to survive an edit untouched.
 */
import { modelInputModalities } from '@shared/model-input'

export interface ModelDraft {
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  reasoning: boolean
  /** Accepts image input; without it pi sends `(image omitted)` instead of the picture. */
  images: boolean
  /** The entry as it came out of `models.json`, kept so unknown fields round-trip. */
  raw?: Record<string, unknown>
}

export function emptyModel(): ModelDraft {
  return { id: '', name: '', contextWindow: '', maxTokens: '', reasoning: false, images: false }
}

/** Rows → `models.json` entries. Rows without an id are dropped. */
export function buildProviderModels(models: ModelDraft[]): Record<string, unknown>[] {
  return models
    .filter((model) => model.id.trim())
    .map((model) => {
      const existing = model.raw ?? {}
      return {
        ...existing,
        id: model.id.trim(),
        name: model.name.trim() || undefined,
        contextWindow: model.contextWindow ? Number(model.contextWindow) : undefined,
        maxTokens: model.maxTokens ? Number(model.maxTokens) : undefined,
        reasoning: model.reasoning,
        input: modelInputModalities(model.images),
        cost: existing.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    })
}
