/**
 * Base URLs for OpenAI-compatible providers.
 *
 * The adapter appends `/chat/completions` to whatever Base URL it is given, so `https://host` asks a
 * gateway's web page for a completion — the request "works" (200, HTML) and the reply is empty. Both
 * spellings are common in the wild (`https://api.deepseek.com` and `https://api.deepseek.com/v1` are
 * the same API), so the missing version segment is filled in rather than reported as a broken
 * protocol. A URL that already carries a path is left exactly as typed.
 */
export function withVersionPath(baseUrl: string): string {
  try {
    const url = new URL(baseUrl.trim())
    const path = url.pathname.replace(/\/+$/, '')
    if (path !== '') return baseUrl.trim()
    return `${url.origin}/v1`
  } catch {
    // Not a URL we can parse: leave it to the editor's validation rather than guessing.
    return baseUrl
  }
}

/** True when an `openai-*` Base URL carries no path segment, so it must be filled in on save. */
export function needsVersionPath(baseUrl: string, api: string): boolean {
  if (!/^openai-(completions|responses)$/i.test(api.trim())) return false
  const url = baseUrl.trim()
  if (!url) return false
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === ''
  } catch {
    return false
  }
}
