import { pathKey } from './session-groups'

/**
 * Which session a `get_messages` answer belongs to.
 *
 * Switching sessions is not instantaneous: the window learns the new session from a status
 * broadcast, while the engine may still be holding the previous transcript for a few ms. Applying
 * that answer put session B's conversation under session A's title (the "sessions cross
 * directories" bug), so every answer carries the key of the session it came from and the window
 * only accepts it when that key is the session on screen.
 */
export interface SessionMessagesPayload {
  sessionKey?: string
  messages: unknown[]
}

export function messagesBelong(
  payloadKey: string | undefined,
  expected: { sessionKey?: string; sessionFile?: string }
): boolean {
  // Engines that cannot name their session keep the old behaviour: nothing to compare against.
  if (!payloadKey) return true
  const wanted = [expected.sessionKey, expected.sessionFile]
    .filter((key): key is string => typeof key === 'string' && key !== '')
    .map(pathKey)
  if (wanted.length === 0) return true
  return wanted.includes(pathKey(payloadKey))
}
