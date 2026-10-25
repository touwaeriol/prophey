/**
 * Where each conversation was left on screen.
 *
 * Opening another session used to reset the transcript to the bottom, so coming back to a long
 * conversation meant scrolling again from the end. The scroll offset belongs to the session, like
 * its draft and queue, so switching back lands on the line the user was reading.
 *
 * The anchor is the message that was at the top of the viewport, not only a pixel offset: the same
 * transcript can lay out a little differently between visits (a tool card折叠, an image settling),
 * and the reader wants the same *line*, not the same number.
 *
 * Only an in-memory map: a pixel offset describes the current layout, not the session, and a
 * restart re-renders transcripts at different heights anyway.
 */
export type SessionScroll = {
  /** scrollTop of the transcript when the session was left (fallback when the anchor is gone). */
  top: number
  /** The reader was following the tail, so reopening should follow the tail again. */
  stuck: boolean
  /** Message that sat at the top of the viewport, and how far into it the viewport started. */
  anchorId?: string
  anchorOffset?: number
}

export type SessionScrollMap = Map<string, SessionScroll>

/** Distance from the bottom (px) that still counts as "following the tail". */
export const STICK_DISTANCE = 80

type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number }

/** Record where a transcript sits right before leaving it. */
export function rememberScroll(
  map: SessionScrollMap,
  key: string | undefined,
  element: ScrollBox | null,
  anchor?: { id: string; offset: number }
): void {
  if (!key || !element) return
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight
  map.set(key, {
    top: element.scrollTop,
    stuck: distance < STICK_DISTANCE,
    ...(anchor ? { anchorId: anchor.id, anchorOffset: anchor.offset } : {})
  })
}

/** What to restore for a session, if it was open before. */
export function recallScroll(map: SessionScrollMap, key: string | undefined): SessionScroll | undefined {
  return key ? map.get(key) : undefined
}

/**
 * Put a transcript back where it was left; a session last seen at the bottom returns to the bottom.
 *
 * `locate` returns a message's offset from the top of the scroll box, or `null` when that message is
 * no longer rendered — then the remembered pixel offset is the best that can be done.
 */
export function restoreScroll(
  element: {
    scrollTop: number
    scrollHeight: number
    scrollTo?: (options: { top: number; behavior: 'instant' }) => void
  },
  scroll: SessionScroll,
  locate?: (id: string) => number | null
): void {
  const anchored =
    !scroll.stuck && scroll.anchorId && locate ? locate(scroll.anchorId) : null
  const top =
    anchored != null
      ? Math.max(0, anchored - (scroll.anchorOffset ?? 0))
      : scroll.stuck
        ? element.scrollHeight
        : scroll.top
  // `.scroll` is `scroll-behavior: smooth`, which would glide the transcript into place after every
  // switch. An anchor is not an animation: land on it in one frame.
  if (element.scrollTo) element.scrollTo({ top, behavior: 'instant' })
  else element.scrollTop = top
}
