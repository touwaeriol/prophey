/**
 * The pi extension's side of the project-conventions handover.
 *
 * The desktop reads the files and passes the rendered section through the environment; this pins
 * that the extension actually puts it into `systemPromptOptions.sections` (a section pi renders, as
 * opposed to an MCP `instructions` string that `direct` servers never show the model).
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const extensionUrl = pathToFileURL(
  path.resolve(__dirname, '../apps/desktop/resources/extension/desktop-mcp.js')
).href

/** Load the extension against a stub pi, apply the env it reads, and return the hooks it registered. */
async function load(env) {
  const saved = {}
  for (const key of [
    'AGENT_DESKTOP_MCP_URL',
    'AGENT_DESKTOP_CONVENTIONS',
    'AGENT_DESKTOP_PROJECT',
    'AGENT_DESKTOP_MCP_ENGINES'
  ]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  Object.assign(process.env, env)
  const hooks = {}
  const mod = await import(extensionUrl)
  mod.default({
    on: (event, handler) => {
      hooks[event] = handler
    },
    registerMcpServer: () => {}
  })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return hooks
}

test('conventions become their own system-prompt section', async () => {
  const hooks = await load({ AGENT_DESKTOP_CONVENTIONS: '### GEMINI.md（Gemini CLI）\nBe brief.' })
  const event = { systemPromptOptions: { sections: {} } }
  hooks.before_agent_start(event)
  assert.equal(event.systemPromptOptions.sections.conventions, '### GEMINI.md（Gemini CLI）\nBe brief.')
  // A section name must stay a plain identifier: pi rejects anything else.
  assert.match('conventions', /^[a-z][a-z0-9_-]*$/)
})

test('no conventions means no hook and no empty section', async () => {
  const hooks = await load({})
  // Nothing to inject: the extension must not register a hook that writes an empty section.
  assert.equal(hooks.before_agent_start, undefined)
})

test('the multi-root project section still lands next to it', async () => {
  const hooks = await load({
    AGENT_DESKTOP_CONVENTIONS: 'rules',
    AGENT_DESKTOP_PROJECT: JSON.stringify({
      name: '工作台',
      roots: [
        { name: 'web', path: '/repo/web', primary: true },
        { name: 'api', path: '/repo/api' }
      ]
    })
  })
  const event = { systemPromptOptions: { sections: {} } }
  hooks.before_agent_start(event)
  assert.equal(event.systemPromptOptions.sections.conventions, 'rules')
  assert.match(event.systemPromptOptions.sections.project, /工作台/)
})
