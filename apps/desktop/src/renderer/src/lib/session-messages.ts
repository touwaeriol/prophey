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
  /** The engine is not ready to answer yet; an empty `messages` here means "ask again", not "empty". */
  pending?: boolean
}

export function messagesBelong(
  payloadKey: string | undefined,
  expected: { sessionKey?: string; sessionFile?: string }
): boolean {
  if (!payloadKey) return !expected.sessionKey && !expected.sessionFile
  const wanted = [expected.sessionKey, expected.sessionFile]
    .filter((key): key is string => typeof key === 'string' && key !== '')
    .map(pathKey)
  if (wanted.length === 0) return false
  return wanted.includes(pathKey(payloadKey))
}
