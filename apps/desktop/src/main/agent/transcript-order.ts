/**
 * Keep every tool result next to the assistant message that asked for it.
 *
 * OpenAI-compatible endpoints (`deepseek`, `openai`, everything behind `/v1/chat/completions`)
 * reject a whole request when a `role: "tool"` message does not immediately answer a preceding
 * `tool_calls`: `400 Messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'`. Anthropic is stricter still — it wants one user turn carrying all results.
 *
 * A transcript can violate that without anyone doing anything wrong by the provider's rules:
 *
 * - A steer (or a background-task notice) lands while a tool batch is still running, so the user
 *   message is appended between the tool calls and their results.
 * - A run is aborted after the model asked for three tools but only one result was recorded, or a
 *   session is resumed from a file that lost a result.
 *
 * Both leave the conversation permanently unsendable, because the bad order is persisted and then
 * replayed on every request. This repairs the order in memory (never in place) so the next request
 * is valid again:
 *
 * - results belonging to a call batch are pulled up to sit directly after it, in call order;
 * - messages that were sandwiched in the middle are kept, moved just after the batch;
 * - a call with no result gets a placeholder result, which the provider requires anyway;
 * - a result whose call is gone (truncated history) becomes a plain user message, so no content is
 *   lost and the request stays legal.
 *
 * A transcript that already satisfies the contract comes back with the same messages in the same
 * order.
 */
type Message = Record<string, unknown>

interface Call {
  id: string
  name: string
}

const MISSING_RESULT = '(this tool call has no result: it was interrupted before it finished)'

/** Tool calls an assistant message asked for, in the order it asked for them. */
function callsOf(message: Message): Call[] {
  const content = Array.isArray(message.content) ? message.content : []
  const calls: Call[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const entry = block as { type?: unknown; id?: unknown; name?: unknown }
    if (entry.type !== 'toolCall') continue
    calls.push({
      // The engine's own reader falls back to the same synthetic id, so both agree.
      id: typeof entry.id === 'string' && entry.id ? entry.id : `call_${calls.length}`,
      name: typeof entry.name === 'string' ? entry.name : 'tool'
    })
  }
  return calls
}

function toolCallIdOf(message: Message): string | undefined {
  const id = message.toolCallId
  return typeof id === 'string' && id ? id : undefined
}

/** Placeholder content for a call that never produced a result. */
function placeholderResult(call: Call): Message {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: MISSING_RESULT }],
    isError: true,
    timestamp: Date.now()
  }
}

/** A stranded result, kept as a user turn so its text still reaches the model. */
function resultAsUser(message: Message): Message {
  const blocks = Array.isArray(message.content) ? message.content : []
  const content: Message[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const entry = block as { type?: unknown; text?: unknown }
    if (entry.type === 'text' && typeof entry.text === 'string') {
      content.push({ type: 'text', text: entry.text })
    } else if (entry.type === 'image') {
      content.push(block as Message)
    }
  }
  const name = typeof message.toolName === 'string' ? message.toolName : 'tool'
  const id = toolCallIdOf(message)
  if (content.length === 0) content.push({ type: 'text', text: '(empty tool output)' })
  return {
    role: 'user',
    content: [
      { type: 'text', text: `[tool result${id ? ` ${id}` : ''} (${name}) from an earlier turn]` },
      ...content
    ],
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now()
  }
}

/** Repair the call/result grouping; returns a new array, leaving the input untouched. */
export function orderToolResults(messages: Message[]): Message[] {
  const ordered: Message[] = []
  let index = 0

  // Pass 1: pull every batch's results up so nothing sits between a call and its answer.
  while (index < messages.length) {
    const message = messages[index]
    index += 1
    ordered.push(message)
    const calls = message?.role === 'assistant' ? callsOf(message) : []
    if (calls.length === 0) continue
    // Everything between this assistant message and its last result belongs to the batch.
    const pending = new Map(calls.map((call) => [call.id, call]))
    const results: Message[] = []
    const interrupted: Message[] = []
    while (index < messages.length && pending.size > 0) {
      const next = messages[index]
      // The batch is over once the model speaks again; unanswered calls get a placeholder.
      if (!next || next.role === 'assistant') break
      index += 1
      const id = next.role === 'toolResult' ? toolCallIdOf(next) : undefined
      if (id && pending.delete(id)) results.push(next)
      else interrupted.push(next)
    }
    ordered.push(...results)
    for (const call of pending.values()) ordered.push(placeholderResult(call))
    ordered.push(...interrupted)
  }

  // Pass 2: enforce the wire contract itself, so a shape pass 1 could not fix (a result whose
  // call was truncated, a duplicated line, results left over from an older batch) still cannot
  // reach a provider.
  const final: Message[] = []
  /** Calls the emitted prefix still owes a result for, keyed by id. */
  const open = new Map<string, number>()
  /** Names to put on the placeholders `open` may need. */
  const names = new Map<string, string>()
  const closeOpenCalls = (): void => {
    for (const [id, count] of open) {
      const name = names.get(id) ?? 'tool'
      for (let left = 0; left < count; left += 1) final.push(placeholderResult({ id, name }))
    }
    open.clear()
    names.clear()
  }
  for (const message of ordered) {
    if (message?.role === 'assistant') {
      closeOpenCalls()
      final.push(message)
      for (const call of callsOf(message)) {
        open.set(call.id, (open.get(call.id) ?? 0) + 1)
        names.set(call.id, call.name)
      }
      continue
    }
    if (message?.role === 'toolResult') {
      const id = toolCallIdOf(message)
      const count = id ? (open.get(id) ?? 0) : 0
      if (!id || count === 0) {
        // Answers no call the request can see: keep the text as a user turn instead.
        final.push(resultAsUser(message))
        continue
      }
      if (count === 1) {
        open.delete(id)
        names.delete(id as string)
      } else {
        open.set(id, count - 1)
      }
      final.push(message)
      continue
    }
    // Any other turn ends the batch here rather than on the wire.
    if (open.size > 0) closeOpenCalls()
    final.push(message)
  }
  closeOpenCalls()
  return final
}
