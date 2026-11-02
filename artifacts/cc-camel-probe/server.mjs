#!/usr/bin/env node
/**
 * Throwaway MCP probe: does the client keep camelCase tool names and camelCase argument keys?
 *
 * Every request is appended to calls.jsonl next to this file, so the evidence is what the server
 * actually received - not what the client claims it sent.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const logFile = path.join(here, 'calls.jsonl')

function log(entry) {
  fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

const tools = [
  {
    name: 'echoCamelCase',
    description:
      'Echo camelCase arguments back verbatim. Call this whenever the user asks to verify camelCase argument passing.',
    inputSchema: {
      type: 'object',
      properties: {
        userName: { type: 'string', description: 'name of the user' },
        taskId: { type: 'string', description: 'task identifier' },
        dryRun: { type: 'boolean', description: 'do not apply anything' },
        maxResults: { type: 'number', description: 'how many results to return' },
        targetDir: { type: 'string', description: 'directory to work in' },
        filters: {
          type: 'object',
          description: 'search filters',
          properties: {
            caseSensitive: { type: 'boolean' },
            includeGlobs: { type: 'array', items: { type: 'string' } }
          },
          required: ['caseSensitive']
        }
      },
      required: ['userName', 'taskId', 'dryRun', 'maxResults', 'targetDir', 'filters']
    }
  },
  {
    name: 'echo_snake',
    description:
      'Echo snake_case arguments back verbatim. Call this whenever the user asks to verify snake_case argument passing.',
    inputSchema: {
      type: 'object',
      properties: {
        user_name: { type: 'string' },
        task_id: { type: 'string' },
        dry_run: { type: 'boolean' },
        max_results: { type: 'number' }
      },
      required: ['user_name', 'task_id', 'dry_run', 'max_results']
    }
  }
]

function handleCall(id, params) {
  const name = params?.name
  const args = params?.arguments ?? {}
  log({ kind: 'call', name, arguments: args, keys: Object.keys(args) })
  send({
    jsonrpc: '2.0',
    id,
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ tool: name, received: args, keys: Object.keys(args) }, null, 2)
        }
      ]
    }
  })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      log({ kind: 'unparsable', line: line.slice(0, 400) })
      continue
    }
    log({ kind: 'request', method: message.method, id: message.id })
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'camel-probe', version: '0.0.1' }
        }
      })
    } else if (message.method === 'tools/list') {
      log({ kind: 'tools/list', names: tools.map((tool) => tool.name) })
      send({ jsonrpc: '2.0', id: message.id, result: { tools } })
    } else if (message.method === 'tools/call') {
      handleCall(message.id, message.params)
    } else if (message.method === 'ping') {
      send({ jsonrpc: '2.0', id: message.id, result: {} })
    } else if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + message.method } })
    }
  }
})
