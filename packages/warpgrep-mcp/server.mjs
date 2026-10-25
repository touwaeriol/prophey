#!/usr/bin/env node
/**
 * WarpGrep MCP server (stdio JSON-RPC, zero dependencies).
 *
 * One tool — `codebase_search` — that runs a bounded grep/read/finish loop over `--path` and asks a
 * chat model (DeepSeek by default) which files answer the question. Same tool contract as the
 * desktop app's built-in WarpGrep endpoint, but the backend is a model you already pay for and can
 * point anywhere OpenAI-compatible.
 *
 * stdout is the JSON-RPC channel; every diagnostic goes to stderr.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ConfigError, resolveConfig } from './config.mjs'
import { tools } from './tools/index.mjs'

const SERVER_NAME = 'warpgrep-mcp'
const FALLBACK_PROTOCOL = '2025-06-18'
const KNOWN_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

function log(message) {
  process.stderr.write(`[warpgrep] ${message}\n`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

function version() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    return JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

let config
try {
  const resolved = resolveConfig()
  if (resolved.help) {
    process.stdout.write(resolved.usage)
    process.exit(0)
  }
  if (resolved.version) {
    process.stdout.write(`${version()}\n`)
    process.exit(0)
  }
  config = resolved
} catch (error) {
  if (error instanceof ConfigError) {
    log(error.message)
    process.exit(2)
  }
  throw error
}

const toolByName = new Map(tools.map((tool) => [tool.name, tool]))
const inflight = new Map()

async function handleRequest(message) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion
      reply(id, {
        protocolVersion: KNOWN_PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: version() },
        instructions:
          'Natural-language code search over ' +
          config.cwd +
          ' via ' +
          config.model +
          '. Ask a targeted question; the search subagent greps, reads and returns file:line ' +
          'ranges. File excerpts read during a search are sent to ' +
          config.baseUrl +
          '.'
      })
      return
    }
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, {
        tools: tools.map(({ name, title, description, inputSchema }) => ({
          name,
          title,
          description,
          inputSchema
        }))
      })
      return
    case 'tools/call': {
      const tool = toolByName.get(params?.name)
      if (!tool) {
        replyError(id, -32602, `unknown tool: ${String(params?.name)}`)
        return
      }
      const controller = new AbortController()
      if (id !== undefined) inflight.set(id, controller)
      try {
        reply(id, await tool.call(params?.arguments ?? {}, { config, log }))
      } finally {
        if (id !== undefined) inflight.delete(id)
      }
      return
    }
    case 'resources/list':
      reply(id, { resources: [] })
      return
    case 'resources/templates/list':
      reply(id, { resourceTemplates: [] })
      return
    case 'prompts/list':
      reply(id, { prompts: [] })
      return
    default:
      replyError(id, -32601, `method not supported: ${String(method)}`)
  }
}

function handleNotification(message) {
  if (message.method === 'notifications/cancelled') {
    const requestId = message.params?.requestId
    const controller = inflight.get(requestId)
    if (controller) {
      controller.abort()
      inflight.delete(requestId)
    }
  }
}

function dispatch(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    log(`invalid JSON: ${line.slice(0, 200)}`)
    return
  }
  if (!message || typeof message !== 'object') return
  if (message.id === undefined || message.id === null) {
    handleNotification(message)
    return
  }
  void handleRequest(message).catch((error) => {
    log(`request failed: ${error instanceof Error ? error.stack : String(error)}`)
    replyError(message.id, -32603, error instanceof Error ? error.message : String(error))
  })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, '')
    buffer = buffer.slice(index + 1)
    if (line.trim()) dispatch(line)
    index = buffer.indexOf('\n')
  }
})

process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
log(
  `ready tools=${tools.map((tool) => tool.name).join(',')} path=${config.cwd} model=${config.model} ` +
    `key=${config.key ? config.keySource : 'unset'}`
)
