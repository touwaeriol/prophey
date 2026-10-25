/**
 * What a WarpGrep custom endpoint must look like.
 *
 * The search loop POSTs to `${baseUrl}/chat/completions` with `tools` (see
 * `packages/warpgrep-mcp/search.mjs`), so the setting is an **OpenAI-compatible chat base URL**:
 *
 * - `https://api.deepseek.com/v1` or `https://api.deepseek.com` — correct;
 * - `https://api.deepseek.com/chat/completions` — the search would append the path twice, so the
 *   suffix is trimmed on save instead of failing a search later;
 * - `https://api.deepseek.com/anthropic` (or `…/v1/messages`) — an Anthropic-protocol address.
 *   DeepSeek's provider settings use exactly this for web search, which is why it is the mistake
 *   people actually make; it cannot serve a chat completion with tool calls and is refused here.
 *
 * Validating at the point of entry matters because a wrong base URL only shows up as a 404/401 in
 * the middle of a search, several steps away from the field that caused it.
 */
export interface WarpGrepEndpointCheck {
  /** Normalized base URL to store; absent when the field is empty (hosted Morph). */
  baseUrl?: string
  /** Why the value cannot be used. When set, `baseUrl` is undefined. */
  error?: string
  /** The value works but had to be rewritten (trailing slash, a pasted `/chat/completions`). */
  normalized?: boolean
}

/** Hint shown next to the field: the shape a valid endpoint has. */
export const WARP_ENDPOINT_EXAMPLE = 'https://api.deepseek.com/v1'

/** Model a custom endpoint runs when the field is left empty. */
export const WARP_DEFAULT_MODEL = 'deepseek-flash'

/** The hosted model, used whenever no custom endpoint is configured. */
export const WARP_MORPH_MODEL = 'morph-warp-grep-v2.1'

export function checkWarpgrepEndpoint(input: string | null | undefined): WarpGrepEndpointCheck {
  const raw = (input ?? '').trim()
  if (!raw) return {}
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { error: '端点地址不是合法 URL' }
  }
  if (!/^https?:$/.test(parsed.protocol)) return { error: '端点必须是 http(s) 地址' }
  let baseUrl = raw.replace(/\/+$/, '')
  // The search appends `/chat/completions` itself; a pasted full URL would double the path.
  baseUrl = baseUrl.replace(/\/chat\/completions$/i, '')
  if (/\/anthropic$/i.test(baseUrl) || /\/messages$/i.test(baseUrl)) {
    return {
      error: '这是 Anthropic 协议地址：WarpGrep 用 OpenAI 兼容的 chat completions，请填基础地址（如 ' +
        WARP_ENDPOINT_EXAMPLE + '）'
    }
  }
  if (/\/responses$/i.test(baseUrl) || /\/completions$/i.test(baseUrl)) {
    return { error: '这是 Responses 协议的地址：请填 chat completions 的基础地址（…/v1）' }
  }
  if (!baseUrl) return { error: '端点地址不完整' }
  return { baseUrl, normalized: baseUrl !== raw }
}
