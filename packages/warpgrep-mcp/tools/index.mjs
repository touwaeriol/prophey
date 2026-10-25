/**
 * Tools of the WarpGrep MCP server.
 *
 * Add new tools here: export an object with `name`, `title`, `description`, `inputSchema` and
 * `call(args, context)`. `context` carries the resolved `config` (repository root, model, key) and
 * `log(message)` for stderr — stdout is the JSON-RPC channel and must stay clean.
 */
import { codebaseSearch } from './codebase-search.mjs'

export const tools = [codebaseSearch]
