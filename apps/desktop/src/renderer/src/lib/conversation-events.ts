import {
  imagesFromBlocks,
  NOTICE_TYPE,
  noticeText,
  textFromBlocks,
  thinkingFromBlocks,
  toolCallsFromBlocks,
  type ChatItem,
  type ToolCallView
} from './messages'

interface ToolCallPayload {
  id?: string
  toolCallId?: string
  name?: string
  toolName?: string
  arguments?: unknown
  args?: unknown
}

function partialToolCall(payload: ToolCallPayload, patch: Partial<ToolCallView>): ToolCallView {
  const args = payload.arguments ?? payload.args
  return {
    id: String(payload.id ?? payload.toolCallId ?? 'tool'),
    name: String(payload.name ?? payload.toolName ?? 'tool'),
    args: typeof args === 'string' ? args : args ? JSON.stringify(args, null, 2) : '',
    status: 'running',
    ...patch
  }
}

function mergeCall(current: ToolCallView, next: ToolCallView): ToolCallView {
  return {
    id: current.id,
    name: next.name && next.name !== 'tool' ? next.name : current.name,
    args: next.args || current.args,
    status: next.status || current.status,
    result: next.result ?? current.result,
    durationMs: next.durationMs ?? current.durationMs
  }
}

function resultText(result: unknown): string | undefined {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && 'content' in result) {
    return textFromBlocks((result as { content?: unknown }).content)
  }
  return undefined
}

function patchLastAssistant(items: ChatItem[], patch: (item: ChatItem) => ChatItem): ChatItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].role === 'assistant') {
      const next = items.slice()
      next[index] = patch(next[index])
      return next
    }
  }
  return items
}

function upsertTool(items: ChatItem[], call: ToolCallView): ChatItem[] {
  let found = false
  const next = items.map((item) => {
    if (item.role !== 'assistant') return item
    const index = item.toolCalls.findIndex((existing) => existing.id === call.id)
    if (index === -1) return item
    found = true
    const toolCalls = item.toolCalls.slice()
    toolCalls[index] = mergeCall(toolCalls[index], call)
    return { ...item, toolCalls }
  })
  if (found) return next
  return patchLastAssistant(next, (item) => ({
    ...item,
    toolCalls: [...item.toolCalls, call]
  }))
}

function appendDelta(items: ChatItem[], field: 'text' | 'thinking', delta: string): ChatItem[] {
  if (!delta) return items
  return patchLastAssistant(items, (item) => ({ ...item, [field]: (item[field] ?? '') + delta }))
}


/**
 * A user turn reaching the window.
 *
 * Two shapes arrive here. `deliver()` paints an optimistic bubble before it sends, and the engine's
 * event then fills in what was actually stored (that is the `pending` branch). A steered message has
 * no optimistic bubble at all: it waits at the engine's next boundary, the window shows it as a
 * pending send, and this event is the moment it really entered the transcript. It is appended as
 * pending so the matching `message_end` completes it instead of adding a second copy.
 */
function patchPendingUser(items: ChatItem[], content?: unknown, now = 0): ChatItem[] {
  const index = items.findLastIndex((item) => item.role === 'user' && item.pending)
  const images = imagesFromBlocks(content)
  if (index < 0) {
    return [
      ...items,
      {
        id: 'user-' + now + '-' + items.length,
        role: 'user',
        text: textFromBlocks(content),
        images,
        toolCalls: [],
        pending: true
      }
    ]
  }
  const next = items.slice()
  next[index] = {
    ...next[index],
    text: textFromBlocks(content) || next[index].text,
    images: images.length > 0 ? images : next[index].images,
    pending: false
  }
  return next
}

function finishMessage(items: ChatItem[], message: MessagePayload, now: number): ChatItem[] {
  if (message.role === 'custom' || message.customType === NOTICE_TYPE) {
    if (message.customType !== NOTICE_TYPE) return items
    const text = noticeText(textFromBlocks(message.content))
    return text ? [...items, { id: 'notice-' + now + '-' + items.length, role: 'system', text, toolCalls: [] }] : items
  }
  if (message.role === 'user') return patchPendingUser(items, message.content, now)
  if (message.role !== 'assistant') return items
  return patchLastAssistant(items, (item) => {
    const calls = toolCallsFromBlocks(message.content)
    return {
      ...item,
      text: textFromBlocks(message.content) || item.text,
      thinking: thinkingFromBlocks(message.content) || item.thinking,
      toolCalls: calls.length > 0 ? calls.map((call) => {
        const existing = item.toolCalls.find((entry) => entry.id === call.id)
        return existing ? mergeCall(call, existing) : call
      }) : item.toolCalls,
      streaming: false
    }
  })
}

interface MessagePayload {
  role?: string
  content?: unknown
  customType?: string
  timestamp?: number
}

/**
 * Compaction rewrites the transcript into one summary message.
 *
 * Engines that compact in place (Claude / Codex) hand us nothing to project and keep their own
 * transcript, so their event is ignored; Prophey sends the summary it just stored, and the window
 * replaces everything before it — painting turns the model can no longer see is a lie either way.
 */
function compactionReplaced(items: ChatItem[], message: MessagePayload | undefined, now: number): ChatItem[] {
  if (message?.role !== 'user') return items
  const text = textFromBlocks(message.content)
  if (!text.trim()) return items
  return [{
    id: 'summary-' + now + '-' + items.length,
    role: 'user',
    text,
    images: imagesFromBlocks(message.content),
    toolCalls: [],
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : now
  }]
}

/** Pure event projection: IPC and run timing stay in App; chat transformations stay here. */
export function applyConversationEvent(items: ChatItem[], record: Record<string, unknown>, now: number): ChatItem[] {
  switch (record.type) {
    case 'message_start': {
      const message = record.message as MessagePayload | undefined
      if (message?.role === 'user') return patchPendingUser(items, message.content, now)
      if (message?.role !== 'assistant') return items
      return [...items, { id: 'assistant-' + now + '-' + items.length, role: 'assistant', text: '', thinking: '', toolCalls: [], streaming: true }]
    }
    case 'message_update': {
      const event = record.assistantMessageEvent as { type?: string; delta?: string; toolCall?: ToolCallPayload } | undefined
      if (event?.type === 'text_delta') return appendDelta(items, 'text', event.delta ?? '')
      if (event?.type === 'thinking_delta') return appendDelta(items, 'thinking', event.delta ?? '')
      if (event?.type === 'toolcall_end' && event.toolCall) return upsertTool(items, partialToolCall(event.toolCall, { status: 'running' }))
      return items
    }
    case 'message_end':
      return finishMessage(items, (record.message as MessagePayload | undefined) ?? {}, now)
    case 'tool_execution_start':
      return upsertTool(items, partialToolCall(record, { status: 'running' }))
    case 'tool_execution_update':
      return upsertTool(items, partialToolCall(record, { status: 'running', result: resultText(record.partialResult) }))
    case 'tool_execution_end':
      return upsertTool(items, partialToolCall(record, {
        status: record.isError ? 'error' : 'done',
        result: resultText(record.result),
        durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined
      }))
    case 'compaction_end':
      return compactionReplaced(items, record.message as MessagePayload | undefined, now)
    case 'agent_settled':
      // A bubble without its `message_end` is still a real message (the engine persisted it), so a
      // settle clears the dim rather than leaving it pending forever.
      return items.map((item) =>
        item.streaming || item.pending ? { ...item, streaming: false, pending: false } : item
      )
    default:
      return items
  }
}
