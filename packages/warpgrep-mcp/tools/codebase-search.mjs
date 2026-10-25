/**
 * `codebase_search` — the one tool this server exposes, kept API-compatible with the desktop app's
 * built-in WarpGrep tool so a client can switch between them without re-learning anything.
 */
import { SearchError, searchCodebase } from '../search.mjs'
import { sources } from '../workspace.mjs'

export const codebaseSearch = {
  name: 'codebase_search',
  title: 'WarpGrep codebase search',
  description:
    'Natural-language code search subagent for this repository. It runs several rounds of grep, ' +
    'file listing and reads, then returns the relevant files and line ranges; set ' +
    'includeSource=true to also get their code. Use a targeted question such as "Where are HTTP ' +
    'routes authenticated?", not bare keywords or a symbol name. Results may be partial. File ' +
    'excerpts read during the search are sent to the configured model endpoint.',
  inputSchema: {
    type: 'object',
    properties: {
      search_string: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: 'What to find or understand, as a specific natural-language question.'
      },
      includeSource: {
        type: 'boolean',
        default: false,
        description:
          'Also return the code of each listed range. By default only file paths and line ranges ' +
          'are returned; read them with your file tools.'
      },
      maxChars: {
        type: 'integer',
        minimum: 1000,
        maximum: 48000,
        default: 12000,
        description: 'Response budget in Unicode characters.'
      }
    },
    required: ['search_string'],
    additionalProperties: false
  },

  async call(args, context) {
    const budget = Math.min(Math.max(Number(args?.maxChars ?? 12000) || 12000, 1000), 48000)
    try {
      const result = await searchCodebase(String(args?.search_string ?? ''), context.config, {
        onEvent: (event) => {
          if (event.type === 'tool') context.log(`tool ${event.name} ${JSON.stringify(event.args).slice(0, 120)}`)
        }
      })
      const sections = []
      if (result.answer) sections.push(result.answer)
      if (result.files) sections.push(`files:\n${result.files}`)
      if (args?.includeSource === true && result.files) {
        const code = sources(context.config.cwd, result.files, budget)
        if (code) sections.push(code)
      }
      const text = sections.join('\n\n') || 'No results.'
      if (result.dropped.length > 0) {
        context.log(
          `dropped ${result.dropped.length} unverifiable path(s): ${result.dropped.slice(0, 5).join(', ')}`
        )
      }
      return {
        content: [{ type: 'text', text: text.slice(0, budget) }],
        structuredContent: {
          files: result.files,
          answer: result.answer,
          dropped: result.dropped,
          turns: result.turns,
          usage: result.usage,
          model: context.config.model
        }
      }
    } catch (error) {
      const code = error instanceof SearchError ? error.code : 'FAILED'
      const message = error instanceof Error ? error.message : String(error)
      // Tool-level failure: keep the conversation alive and let the model or the user react.
      return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true }
    }
  }
}
