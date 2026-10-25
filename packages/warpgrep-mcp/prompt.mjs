/**
 * Prompt for the search subagent.
 *
 * Morph's WarpGrep is a fine-tuned model that needs no instructions; a general chat model does.
 * The rules below are what keeps a DeepSeek run inside 3-6 rounds: grep first with distinctive
 * strings, read only explicit ranges, finish with `path:start-end` lines. Keep it short — every
 * search pays for it, and a stable prefix is what makes DeepSeek's prompt cache hit.
 */
export const PROMPT_VERSION = 1

export function systemPrompt({ maxTurns }) {
  return `You are a code search agent working inside one repository. Answer the question by running
tools, then stop. The caller only needs locations, not prose.

Rules:
- Start with 1-3 grep_search calls that use distinctive identifiers or strings from the question.
  Never guess what a file contains.
- Use glob or list_directory only to resolve a name you already saw, or when grep found nothing.
- Use read with explicit line ranges to confirm a hit. Never read a whole large file.
- Hard limit: ${maxTurns} tool calls. Partial but verified beats exhaustive and slow.
- Finish by calling finish: files = one path:start-end per line (or path alone), most relevant
  first, relative to the repository root; "" when nothing matched. Put the one-sentence answer in
  answer and name the files inside it only if it helps.
- Never report a path you did not see in a tool result.`
}
