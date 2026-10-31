/**
 * Where each session row goes.
 *
 * The sidebar sorted by `updatedAt`, so merely opening a session lifted it to the top of its
 * directory and everything slid down under the cursor. The order is now something the user owns: it
 * changes when they drag a row, and not otherwise. Sessions still have to appear somewhere sensible
 * the first time they are seen, so a new one sorts in by the chosen key — but only once, at the
 * position it would have had; from then on it stays put.
 */

/**
 * Merge the present sessions into the saved order.
 *
 * `previous` is the order the user arranged; `sorted` is every session as the sort key sees it.
 * Rows that disappeared are dropped, rows already placed keep their place, and a row seen for the
 * first time is inserted where the sort key puts it *relative to the rows already placed*.
 */
export function reconcileOrder(previous: readonly string[], sorted: readonly string[]): string[] {
  const present = new Set(sorted)
  const kept = previous.filter((path) => present.has(path))
  const placed = new Set(kept)
  const next = [...kept]
  for (const path of sorted) {
    if (placed.has(path)) continue
    const at = sorted.slice(0, sorted.indexOf(path)).filter((before) => placed.has(before)).length
    next.splice(at, 0, path)
    placed.add(path)
  }
  return next
}

/** Rank per session path, the shape `buildSessionGroups` sorts by. */
export function rankOrder(order: readonly string[]): Map<string, number> {
  const rank = new Map<string, number>()
  order.forEach((path, index) => rank.set(path, index))
  return rank
}

/**
 * Move one row next to another, the way a drop reads: "put `from` before/after `to`".
 *
 * Returns a new array; an unknown path or a no-op move returns the order unchanged (same contents).
 */
export function moveSession(
  order: readonly string[],
  from: string,
  to: string,
  place: 'before' | 'after'
): string[] {
  if (from === to) return [...order]
  const without = order.filter((path) => path !== from)
  // The anchor is looked up after the removal, so dropping downwards lands beside the target row.
  const at = without.indexOf(to)
  if (at === -1) return [...order]
  without.splice(place === 'before' ? at : at + 1, 0, from)
  return without
}
