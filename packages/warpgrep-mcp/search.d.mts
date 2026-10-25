/**
 * Types for the shared search loop (`search.mjs`), which the desktop gateway and the standalone
 * MCP server both run. Kept hand-written and minimal: the implementation is plain JS on purpose so
 * it can be spawned by any MCP client without a build step.
 */
export type SearchUsage = { prompt: number; completion: number; cached: number }

export type SearchResult = {
  /** Verified, workspace-relative `path:start-end` lines — invented paths never appear here. */
  files: string
  /** Entries the model reported that do not exist (or do not parse), for logging only. */
  dropped: string[]
  answer?: string
  turns: number
  usage: SearchUsage
}

export type SearchConfig = {
  /** Repository root; every tool call is confined to it. */
  cwd: string
  /** OpenAI-compatible endpoint, without a trailing slash. */
  baseUrl: string
  model: string
  key: string
  maxTurns?: number
  /** Whole-search deadline in ms (default 100000). */
  totalTimeoutMs?: number
  /** Per-model-call timeout in ms (default 45000). */
  turnTimeoutMs?: number
  /** `null` sends no system message at all — the fine-tuned Morph model needs none. */
  systemPrompt?: string | null
  /** Ask the model to call `finish` when it answers in prose (default true). */
  nudge?: boolean
}

export declare class SearchError extends Error {
  readonly code: string
  constructor(code: string, message: string)
}

export declare function searchCodebase(
  question: string,
  config: SearchConfig,
  options?: { onEvent?: (event: Record<string, unknown>) => void }
): Promise<SearchResult>

export declare const TOOL_SPECS: ReadonlyArray<Record<string, unknown>>

export declare function filesFromProse(text: string): string
