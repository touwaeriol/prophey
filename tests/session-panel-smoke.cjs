/**
 * Session panel (the right-hand inspector): five cards, config from real IPC state, and the
 * transcript-derived outputs / background-task rows driven by events.
 */
const assert = require('node:assert/strict')
const path = require('node:path')

module.exports = async function sessionPanelSmoke(evaluate, until, window) {
  const card = (title) =>
    `Array.from(document.querySelectorAll('.panel-card')).find(c => c.querySelector('.panel-card-toggle span')?.textContent === ${JSON.stringify(title)})`

  // The panel's open state persists in localStorage; make sure this run starts with it open.
  await evaluate(`(() => {
    if (!document.querySelector('.session-panel')) {
      document.querySelector('.tabbar .icon-btn[title^="显示/隐藏会话概览"]').click();
    }
  })()`)
  await until(() => evaluate('!!document.querySelector(".session-panel")'), 'session panel')

  const titles = await evaluate(
    'Array.from(document.querySelectorAll(".panel-card-toggle span"), e => e.textContent)'
  )
  assert.deepEqual(titles, ['环境', '上下文', '连接器', '产出', '后台任务'])

  // Environment: the session's directory plus the engine · model row.
  const environment = await evaluate(`${card('环境')}.textContent`)
  const cwd = await evaluate('window.pi.getStatus().then(s => s.cwd)')
  const folder = cwd.split(/[\\/]/).filter(Boolean).pop()
  assert.equal(environment.includes(folder), true, 'environment shows the workspace folder: ' + environment)
  assert.match(environment, / · /, 'environment shows engine · model')

  // Context: the meter and the two honest blocks (used aggregate, reserved buffer / free space).
  const context = await evaluate(`${card('上下文')}.textContent`)
  assert.match(context, /\d+% 已用/)
  assert.match(context, /会话与工具/)
  assert.match(context, /剩余空间/)
  assert.equal(await evaluate(`!!${card('上下文')}.querySelector('.panel-meter')`), true)

  // Connectors: built-in engines come from get_mcp_state; 管理 opens the MCP settings tab.
  assert.equal(
    await evaluate(`${card('连接器')}.querySelectorAll('.panel-row').length > 0`),
    true,
    'connector rows'
  )
  await evaluate(
    `Array.from(${card('连接器')}.querySelectorAll('.panel-link')).find(b => b.textContent.includes('管理')).click()`
  )
  await until(() => evaluate('!!document.querySelector(".settings")'), 'settings from panel')
  assert.equal(
    await evaluate(
      'Array.from(document.querySelectorAll(".settings-nav button")).find(b => b.classList.contains("active"))?.textContent.includes("MCP")'
    ),
    true,
    'panel management opens the MCP tab'
  )
  await evaluate('document.querySelector(".modal-backdrop").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))')
  await until(() => evaluate('!document.querySelector(".settings")'), 'settings dismissed')

  // Outputs: a write_file tool call in the transcript becomes a row (the extractor is unit-tested).
  const base = Date.now()
  const owner = await evaluate('window.pi.getStatus().then(s => s.sessionKey ?? s.sessionFile)')
  const emit = record => window.webContents.send('pi:event', { ...record, sessionKey: owner })
  emit({ type: 'message_start', message: { role: 'assistant' } })
  emit({
    type: 'tool_execution_start',
    toolCallId: 'proof-write',
    toolName: 'write_file',
    arguments: { path: 'src/proof.ts', content: 'export const proof = true' }
  })
  emit({
    type: 'tool_execution_end',
    toolCallId: 'proof-write',
    toolName: 'write_file',
    arguments: { path: 'src/proof.ts', content: 'export const proof = true' },
    result: 'ok'
  })
  emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
  })
  await until(() => evaluate(`${card('产出')}.textContent.includes('proof.ts')`), 'output row')
  const outputTitle = await evaluate(`${card('产出')}.querySelector('.panel-row-button').title`)
  assert.match(outputTitle.replace(/\\/g, '/'), /src\/proof\.ts（在文件管理器中显示）$/)

  // Revealing is limited to the session workspace: an outside path and a missing file are refused.
  const outside = await evaluate('window.pi.revealPath("/etc/passwd")')
  assert.equal(outside.ok, false)
  const workspace = await evaluate('window.pi.getStatus().then(s => s.cwd)')
  const missing = await evaluate(`window.pi.revealPath(${JSON.stringify(path.join(workspace, 'src/missing.ts'))})`)
  assert.equal(missing.ok, false)
  assert.match(missing.error, /不存在|已被删除/)

  // Background tasks: a status broadcast is enough to render the row, elapsed time and stop button.
  const idle = await evaluate('window.pi.getStatus()')
  window.webContents.send('pi:status', {
    ...idle,
    isStreaming: false,
    backgroundTasks: [{ id: 'bash_proof', command: 'proof background command', startedAt: base - 65_000 }],
    backgroundFinished: 3
  })
  await until(() => evaluate(`${card('后台任务')}.textContent.includes('proof background command')`), 'task row')
  const tasks = await evaluate(`${card('后台任务')}.textContent`)
  assert.match(tasks, /1m 5s/)
  assert.match(tasks, /3 个已完成/)
  assert.equal(await evaluate(`!!${card('后台任务')}.querySelector('.panel-icon-btn')`), true)
  // The stop IPC is wired even though this fixture task never existed in the engine.
  const stopped = await evaluate(`window.pi.stopBackgroundTask("bash_proof", ${JSON.stringify(owner)})`)
  assert.equal(stopped.ok, false)
  assert.match(stopped.error, /未知命令任务|没有后台命令/)

  // Cards collapse independently, and the panel closes from its own header.
  await evaluate(`${card('上下文')}.querySelector('.panel-card-toggle').click()`)
  await until(() => evaluate(`!${card('上下文')}.querySelector('.panel-card-body')`), 'context collapsed')
  await evaluate(`${card('上下文')}.querySelector('.panel-card-toggle').click()`)
  await until(() => evaluate(`!!${card('上下文')}.querySelector('.panel-card-body')`), 'context expanded')
  await evaluate('document.querySelector(".session-panel-head .icon-btn").click()')
  await until(() => evaluate('!document.querySelector(".session-panel")'), 'panel closed')
  assert.equal(
    await evaluate('localStorage.getItem("pi-session-panel")'),
    '0',
    'closed state persists'
  )

  window.webContents.send('pi:status', idle)
  console.log('Session panel passed: five cards, context meter, connectors, outputs, tasks, collapse and persistence')
}
