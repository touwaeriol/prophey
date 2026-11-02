/**
 * DeepSeek's tool-call markup arriving as ordinary reply text.
 *
 * Some gateways (ccgateway in front of a DeepSeek model, for instance) do not translate the model's
 * `<｜｜DSML｜｜tool_calls>` block into `tool_calls` in the API response. The markup then lands in the
 * message's text: no tool runs, and the window paints `<｜｜DSML｜｜ invoke name="run_bash">…` as if it
 * were prose (`s_99a5d7e6` in a real session did exactly that). Repairing it here keeps the model's
 * intent — the calls run — and keeps the markup out of the transcript.
 *
 * The parser is deliberately forgiving: the marker has been seen with full-width bars
 * (`｜｜DSML｜｜`), with spaces around them, and with the block name mangled to ` calls` by a sanitizer
 * upstream, so tag names are matched case-insensitively and only `invoke` / `parameter` carry meaning.
 */

/** The marker as it appears on the wire, in every shape seen so far (bars split by spaces too). */
const MARKER = /[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]/i

/** `</｜｜DSML｜｜ parameter>` and friends; `attributes` keeps the raw attribute text. */
const TAG = /<\s*(\/?)\s*[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]\s*([A-Za-z_]+)\b([^>]*)>/g

/** A marker whose tag never closed (a stream cut mid-block) still must not reach the window. */
const UNTERMINATED = /<\s*\/?\s*[|｜]\s*[|｜]\s*DSML[\s\S]*$/i

const INVOKE = new Set(['invoke', 'invoke_tool', 'tool', 'tool_call', 'function'])
const PARAMETER = new Set(['parameter', 'param', 'argument', 'arg'])

export interface RepairedCall {
  name: string
  arguments: Record<string, unknown>
}

export interface RepairedText {
  /** The reply with the markup removed; empty when the message carried nothing but a tool block. */
  text: string
  /** Calls the model asked for in the text, in the order it wrote them. */
  calls: RepairedCall[]
}

/** True when a reply carries tool-call markup at all (the cheap check before parsing). */
export function hasToolCallMarkup(text: string): boolean {
  return MARKER.test(text)
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attributes)
  return match ? match[1] : undefined
}

/** `string="true"` means the value is literal; anything else is JSON the model wrote. */
function parameterValue(raw: string, attributes: string): unknown {
  const value = raw.replace(/^[ \t]*\r?\n/, '').trim()
  if (/\bstring\s*=\s*"true"/i.test(attributes)) return value
  if (!value) return ''
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * Split a reply into prose and the tool calls it described.
 *
 * Text outside the markup is kept (a model often says "先摸清结构" and then writes the calls); text
 * *inside* it is kept only when it is a parameter value. When the marker is present but no `invoke`
 * parses — a truncated stream, a future format — the markup is still dropped and `calls` is empty,
 * so the window shows plain prose instead of raw tags.
 */
export function repairToolCallText(text: string): RepairedText {
  if (!hasToolCallMarkup(text)) return { text, calls: [] }
  const calls: RepairedCall[] = []
  let prose = ''
  let current: RepairedCall | undefined
  let parameterName: string | undefined
  let parameterAttributes = ''
  let parameterRaw = ''
  let cursor = 0

  const closeParameter = (): void => {
    if (current && parameterName) current.arguments[parameterName] = parameterValue(parameterRaw, parameterAttributes)
    parameterName = undefined
    parameterRaw = ''
    parameterAttributes = ''
  }
  const closeInvoke = (): void => {
    closeParameter()
    if (current) {
      if (current.name.trim()) calls.push(current)
      current = undefined
    }
  }

  TAG.lastIndex = 0
  for (let match = TAG.exec(text); match; match = TAG.exec(text)) {
    const [tag, closing, rawName, attributes] = match
    const between = text.slice(cursor, match.index)
    cursor = match.index + tag.length
    if (parameterName !== undefined) parameterRaw += between
    else if (!current) prose += between

    const name = rawName.toLowerCase()
    if (INVOKE.has(name)) {
      if (closing) closeInvoke()
      else {
        closeInvoke()
        current = { name: attribute(attributes, 'name') ?? '', arguments: {} }
      }
      continue
    }
    if (PARAMETER.has(name)) {
      closeParameter()
      if (!closing) {
        parameterName = attribute(attributes, 'name')
        parameterAttributes = attributes
      }
    }
    // Anything else (`calls`, `tool_calls`, …) is a wrapper and carries nothing.
  }
  closeInvoke()
  if (parameterName !== undefined) closeParameter()

  const tail = text.slice(cursor)
  if (!current) prose += tail
  return { text: prose.replace(UNTERMINATED, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), calls }
}
