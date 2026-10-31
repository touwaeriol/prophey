/**
 * Base URLs for OpenAI-compatible providers.
 *
 * Both spellings are common in the wild and mean the same API, so the app accepts either one **without
 * rewriting what the user typed**: the request goes to the address as configured, and a gateway that
 * serves its API under `/v1` answers the bare form with its web page — that answer is detected and the
 * request retried once under `/v1` (`main/provider-fetch.ts`). Nothing here transforms an address;
 * this module only answers "does it carry a path?", which decides whether that fallback applies.
 */
export function hasUrlPath(baseUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).pathname.replace(/\/+$/, '') !== ''
  } catch {
    return false
  }
}

/** True when an `openai-*` Base URL carries no path segment, so the `/v1` fallback applies to it. */
export function needsVersionPath(baseUrl: string, api: string): boolean {
  if (!/^openai-(completions|responses)$/i.test(api.trim())) return false
  const url = baseUrl.trim()
  if (!url) return false
  return !hasUrlPath(url)
}
