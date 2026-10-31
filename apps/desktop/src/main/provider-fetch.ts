/**
 * Make an OpenAI-compatible Base URL work whether or not it carries `/v1` — **without rewriting it**.
 *
 * The address is the user's: `https://gateway.example` stays that string in `models.json`. The adapter
 * appends `/chat/completions` to it, and a gateway that serves its API under `/v1` answers the bare
 * form with its web page (200 + HTML, which the adapter reports as “stream ended without
 * finish_reason”) or with 404. So the request is sent as typed first; when the answer is clearly not
 * the API, it is retried once with `/v1` inserted and that answer is what the adapter sees.
 *
 * Two rules keep this honest:
 * 1. Only requests that are *not* recognisably API answers are retried — an HTML page or a 404/405.
 *    A 401/400/429 means the gateway understood the request, so its answer stands.
 * 2. Nothing is rewritten on disk, and a Base URL that already carries a path (`/v1`, `/openai`) is
 *    left completely alone: it was explicit, and guessing on top of an explicit path is how you break
 *    a working configuration.
 */

/** What the fetch wrapper needs to know about one provider. */
export interface BaseUrlCompat {
  /** The Base URL exactly as configured, when it is an OpenAI-compatible host with no path. */
  bareBase?: string
}

/** True when a response is the gateway's web page (or its router saying “no such route”). */
export function looksLikeWrongBase(response: { status: number; headers: { get(name: string): string | null } }): boolean {
  if (response.status === 404 || response.status === 405) return true
  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  // HTML where JSON or an event stream was expected: the request landed on a web page.
  return type.includes('text/html')
}

/**
 * Insert the missing version segment: `https://host/chat/completions` → `https://host/v1/chat/completions`.
 * Returns undefined when the URL does not belong to this base (nothing to do).
 */
export function withVersionSegment(base: string, url: string): string | undefined {
  const trimmed = base.replace(/\/+$/, '')
  // A Base URL that already carries a path was explicit: guessing on top of it is how a working
  // `/openai` or `/v1` configuration breaks.
  if (!isBareBase(trimmed)) return undefined
  if (!url.startsWith(`${trimmed}/`)) return undefined
  const rest = url.slice(trimmed.length)
  if (/^\/v\d+(\/|$)/.test(rest)) return undefined
  return `${trimmed}/v1${rest}`
}

/** True when the URL has no path segment beyond `/` — the case the fallback exists for. */
export function isBareBase(base: string): boolean {
  try {
    return new URL(base).pathname.replace(/\/+$/, '') === ''
  } catch {
    return false
  }
}

/** Bodies we can replay for the retry. A consumed stream cannot be, so those get one attempt. */
function replayable(init?: RequestInit): boolean {
  const body = init?.body
  return body == null || typeof body === 'string' || body instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
}

/**
 * A `fetch` for one provider's requests.
 *
 * `onFallback` fires when the retry is what produced the answer, so the UI can explain the address
 * rather than silently pretending nothing happened.
 */
export function createCompatFetch(
  compat: BaseUrlCompat,
  options: {
    base?: typeof globalThis.fetch
    onFallback?: (from: string, to: string) => void
    /** Resolves the URL a request is going to, for both `string` and `Request` inputs. */
  } = {}
): typeof globalThis.fetch {
  const base = options.base ?? globalThis.fetch
  const bare = compat.bareBase?.trim().replace(/\/+$/, '')
  if (!bare) return base
  return async function compatFetch(input: Parameters<typeof globalThis.fetch>[0] | URL, init?: RequestInit): Promise<Response> {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const retryUrl = withVersionSegment(bare, target)
    // Nothing to fall back to, or a body we cannot send twice: behave like plain fetch.
    if (!retryUrl || !replayable(init)) return base(input, init)
    const first = await base(input, init)
    if (!looksLikeWrongBase(first)) return first
    // The page the gateway served instead of an API answer: drop it and ask the versioned path.
    await first.body?.cancel().catch(() => undefined)
    options.onFallback?.(target, retryUrl)
    return base(retryUrl, init)
  } as typeof globalThis.fetch
}

/** Per-provider "the /v1 retry is what answered" flags, read once by the settings row. */
const fallbacks = new Map<string, { from: string; to: string }>()

export function noteFallback(providerId: string, from: string, to: string): void {
  fallbacks.set(providerId, { from, to })
}

/** Take (and clear) the last fallback for a provider. */
export function takeFallback(providerId: string): { from: string; to: string } | undefined {
  const found = fallbacks.get(providerId)
  if (found) fallbacks.delete(providerId)
  return found
}

