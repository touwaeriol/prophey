/**
 * How a context meter reads in the window.
 *
 * The session composer, the session panel, the subagent drawer and the subagent cards all show the
 * same two numbers (how much is used, how big the window is), so the formatting lives here instead
 * of being re-invented per component. Nothing here decides *what* to measure: the engines publish
 * `ContextUsage` and this only turns it into text.
 */

/** A token count as the UI writes it: `120`, `34K`, `1.05M`. Empty for zero or a missing value. */
export function contextLabel(value?: number | null): string {
  if (!value || value <= 0) return ''
  if (value < 1000) return String(Math.round(value))
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number(millions.toFixed(2))}M`
  }
  return `${Math.round(value / 1000)}K`
}

/** `34K / 1M`; whichever half is unknown is dropped rather than printed as `?`. */
export function usagePair(
  tokens?: number | null,
  contextWindow?: number | null
): string {
  const used = contextLabel(tokens)
  const window = contextLabel(contextWindow)
  if (used && window) return `${used} / ${window}`
  return used || (window ? `— / ${window}` : '')
}

/**
 * The compact one-liner a list row or a card can afford: `12% 34K / 1M`.
 *
 * `percent` is the engine's own number against the raw window. A subagent has no threshold of its
 * own on screen, so recomputing it against an auto-compaction ceiling here would describe a limit
 * the run never reaches; the session composer keeps that job because it shows the threshold.
 */
export function usageMeter(
  usage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null
): string {
  if (!usage) return ''
  const percent = typeof usage.percent === 'number' ? `${Math.round(usage.percent)}%` : ''
  const pair = usagePair(usage.tokens, usage.contextWindow)
  return [percent, pair].filter(Boolean).join(' ')
}

/** Colour of a full meter: the same steps the composer uses. */
export function usageTone(usage?: { percent?: number | null } | null): '' | 'warn' | 'danger' {
  const percent = usage?.percent
  if (typeof percent !== 'number') return ''
  if (percent >= 100) return 'danger'
  if (percent >= 85) return 'warn'
  return ''
}
