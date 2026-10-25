/**
 * Turning a conversation into "what would this user send next?" — the text side only.
 *
 * Kept apart from `suggest.ts` (which needs the provider runtime) so the rules are testable in a
 * plain Node process: which messages are worth sending, how much of each, what counts as a usable
 * answer and what is noise.
 */
/** The model answers with this when it has no confident guess. Never shown. */
export const NO_SUGGESTION = 'NO_SUGGESTION'
/** A suggestion is one short message; anything longer is an answer, not a next prompt. */
export const MAX_SUGGESTION_CHARS = 60
/** Whole context budget: a suggestion must stay cheap, so only the tail of the session is sent. */
const MAX_CONTEXT_CHARS = 4000
/** Per message, so one long tool-heavy reply cannot eat the budget. */
const MAX_MESSAGE_CHARS = 600

export interface SuggestTurn {
  role: 'user' | 'assistant'
  text: string
  /** Tools the assistant called in this turn: "run the tests again" only makes sense knowing them. */
  tools?: string[]
}

function blocks(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = message.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object')
}

/**
 * The last few turns as text: user prompts and assistant replies, with the names of the tools each
 * reply called. Tool results are skipped — they are long, and the tool name is the part that tells a
 * reader what just happened.
 */
export function suggestionContext(
  messages: Array<Record<string, unknown>>,
  limit = 8
): SuggestTurn[] {
  const turns: SuggestTurn[] = []
  for (const message of messages) {
    const role = message?.role
    if (role !== 'user' && role !== 'assistant') continue
    // A failed reply says nothing about what the user wants next; it only confuses the guess.
    if (role === 'assistant' && message.stopReason === 'error') continue
    if (message.customType) continue
    let text = ''
    const tools: string[] = []
    for (const block of blocks(message)) {
      if (block.type === 'text' && typeof block.text === 'string') text += block.text
      if ((block.type === 'toolCall' || block.type === 'tool_use') && typeof block.name === 'string') {
        tools.push(block.name)
      }
    }
    text = text.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS)
    if (!text && tools.length === 0) continue
    const last = turns[turns.length - 1]
    // pi can emit user turns back to back (a steer); keep them in one entry so the transcript reads
    // the way the model saw it instead of as stuttering fragments.
    if (last && last.role === 'user' && role === 'user' && !tools.length) {
      last.text = `${last.text} ${text}`.trim().slice(0, MAX_MESSAGE_CHARS)
      continue
    }
    turns.push({ role, text, ...(tools.length ? { tools: [...new Set(tools)].slice(0, 6) } : {}) })
  }
  const tail = turns.slice(-Math.max(2, limit))
  let size = 0
  const kept: SuggestTurn[] = []
  for (const turn of [...tail].reverse()) {
    size += turn.text.length + (turn.tools?.join(' ').length ?? 0)
    if (kept.length > 0 && size > MAX_CONTEXT_CHARS) break
    kept.unshift(turn)
  }
  return kept
}

/** The context as plain text for one user message. */
export function renderSuggestionContext(turns: SuggestTurn[]): string {
  return turns
    .map((turn) => {
      const who = turn.role === 'user' ? '用户' : '助手'
      const tools = turn.tools?.length ? `（调用了 ${turn.tools.join('、')}）` : ''
      return `${who}：${turn.text || '（无文字）'}${tools}`
    })
    .join('\n')
}

/** The most recent user prompt, used to drop a suggestion that merely echoes it. */
export function lastUserText(turns: SuggestTurn[]): string | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role === 'user') return turns[index].text
  }
  return undefined
}

/**
 * Accept or reject the model's answer.
 *
 * Rejected: the `NO_SUGGESTION` marker, empty text, anything long enough to be a reply rather than
 * a message, a suggestion that just repeats the last prompt, and multi-sentence rambling.
 */
export function cleanSuggestion(raw: string | undefined, lastUser?: string): string | undefined {
  if (!raw) return undefined
  // Counted on the raw text: the trailing full stop is stripped below, so counting afterwards would
  // let a two-sentence reply through.
  const sentences = (raw.match(/[。！？!?]/g) ?? []).length
  let text = raw
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/```$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  // Models like to wrap the answer in labels and quotes even when told not to; peel them off one
  // layer at a time so `- next: x` and `"建议：x"` both end up as `x`.
  for (let pass = 0; pass < 3; pass += 1) {
    const before = text
    text = text
      .replace(/^[-*•]\s+/, '')
      .replace(/^(?:建议|下一条(?:消息)?|next(?: message)?|suggestion)\s*[:：\-]\s*/i, '')
      .replace(/^["'“”「『]+|["'“”」』]+$/g, '')
      .replace(/[。.、\s]+$/, '')
      .trim()
    if (text === before) break
  }
  if (!text) return undefined
  if (new RegExp(NO_SUGGESTION, 'i').test(text)) return undefined
  if (Array.from(text).length > MAX_SUGGESTION_CHARS) return undefined
  // A next message is one line; two sentences in a row is the model talking to the user.
  if (sentences > 1) return undefined
  if (lastUser && text === lastUser.trim()) return undefined
  return text
}
