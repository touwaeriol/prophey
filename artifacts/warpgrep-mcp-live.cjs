/**
 * Live check of packages/warpgrep-mcp against the real DeepSeek API (key from ~/.pi/agent/auth.json).
 * Run: node artifacts/warpgrep-mcp-live.cjs [question]
 */
const { spawn } = require('node:child_process')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const question = process.argv[2] ?? '侧栏折叠/展开的状态存在哪里，读写它的函数叫什么？'

const child = spawn(process.execPath, [path.join(repo, 'packages/warpgrep-mcp/server.mjs'), '--path', repo], {
  stdio: ['pipe', 'pipe', 'pipe']
})
let buffer = ''
const waiting = new Map()
let nextId = 1
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const message = JSON.parse(line)
    const resolve = waiting.get(message.id)
    if (resolve) {
      waiting.delete(message.id)
      resolve(message)
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write(chunk))
const send = (method, params) => {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve) => waiting.set(id, resolve))
}

;(async () => {
  try {
    await send('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    const started = Date.now()
    const message = await send('tools/call', {
      name: 'codebase_search',
      arguments: { search_string: question }
    })
    const elapsed = Date.now() - started
    const structured = message.result?.structuredContent
    console.log('\n--- answer ---')
    console.log(message.result?.content?.map((part) => part.text).join('\n'))
    console.log('\n--- stats ---')
    console.log({ ms: elapsed, ...(structured ?? {}) })
    if (message.result?.isError) process.exitCode = 1
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    child.kill()
  }
})()
