/**
 * Session panel (the right-hand inspector), laid out like Claude Code's: five folded cards that each
 * carry their own summary, the context meter, and the transcript-derived outputs / background-task
 * rows driven by events.
 */
const assert = require('node:assert/strict')
const path = require('node:path')

module.exports = async function sessionPanelSmoke(evaluate, until, window) {
  const card = (title) =>
    `Array.from(document.querySelectorAll('.panel-card')).find(c => c.querySelector('.panel-card-toggle span')?.textContent === ${JSON.stringify(title)})`
  const summary = (title) => `(${card(title)}.querySelector('.panel-card-summary')?.textContent ?? '')`
  /** Cards start folded; every body assertion below opens its card first. */
  const expand = async (title) => {
    if (await evaluate(`!!${card(title)}?.querySelector('.panel-card-body')`)) return
    await evaluate(`${card(title)}.querySelector('.panel-card-toggle').click()`)
    await until(() => evaluate(`!!${card(title)}?.querySelector('.panel-card-body')`), title + ' expanded')
  }

  // The panel's open state persists in localStorage; make sure this run starts with it open.
  await evaluate(`(() => {
    if (!document.querySelector('.session-panel')) {
      document.querySelector('.tabbar .icon-btn[title^="显示/隐藏会话概览"]').click();
    }
  })()`)
  await until(() => evaluate('!!document.querySelector(".session-panel")'), 'session panel')

  const titles = await evaluate(
    'Array.from(document.querySelectorAll(".panel-card-toggle span.panel-card-title"), e => e.textContent)'
  )
  assert.deepEqual(titles, ['环境', '上下文', '连接器', '产出', '后台任务'])

  // Folded, every card still says what it holds: the directory, the percentage, connector state.
  assert.equal(await evaluate('document.querySelectorAll(".panel-card .panel-card-body").length'), 0, 'cards start folded')
  const cwd = await evaluate('window.pi.getStatus().then(s => s.cwd)')
  const folder = cwd.split(/[\\/]/).filter(Boolean).pop()
  assert.equal(await evaluate(summary('环境')), folder, 'environment summary names the directory')
  assert.match(await evaluate(summary('上下文')), /^\d+%|—$/, 'context summary is a percentage')
  assert.equal(await evaluate(`!!${card('上下文')}.querySelector('.panel-mini-meter')`), true, 'folded meter')
  assert.match(await evaluate(summary('连接器')), /已连接|需重连|无/)
  assert.match(await evaluate(summary('产出')), /^\d+$|^无$/, 'outputs summary is a count')
  assert.match(await evaluate(summary('后台任务')), /运行中|已完成|空闲/)

  // Environment: the session's directory plus the engine · model row.
  await expand('环境')
  const environment = await evaluate(`${card('环境')}.textContent`)
  assert.equal(environment.includes(folder), true, 'environment shows the workspace folder: ' + environment)
  assert.match(environment, / · /, 'environment shows engine · model')
  assert.equal(await evaluate(`${card('环境')}.textContent.includes(${JSON.stringify(cwd)})`), true, 'environment shows the path')

  // Context: the meter and the honest blocks (used aggregate, reserved buffer / free space).
  await expand('上下文')
  const context = await evaluate(`${card('上下文')}.textContent`)
  assert.match(context, /\d+% 已用/)
  assert.match(context, /会话与工具/)
  assert.match(context, /剩余空间/)
  assert.equal(await evaluate(`!!${card('上下文')}.querySelector('.panel-meter')`), true)

  // Connectors: built-in engines come from get_mcp_state; 管理 opens the MCP settings tab.
  await expand('连接器')
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
  await until(() => evaluate(`${summary('产出')} !== '无'`), 'output count in the folded summary')
  const outputsBefore = Number(await evaluate(summary('产出')))
  assert.equal(outputsBefore >= 1, true, 'the folded outputs card counts files: ' + outputsBefore)
  await expand('产出')
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

  // A Prophey status carries the per-section breakdown, so the card switches from one aggregate bar
  // to the Claude-style sections and names the MCP servers behind their share of the prompt.
  const idle = await evaluate('window.pi.getStatus()')
  window.webContents.send('pi:status', {
    ...idle,
    contextUsage: {
      tokens: 279200,
      contextWindow: 1000000,
      percent: 27.92,
      breakdown: {
        messages: 233500,
        systemPrompt: 4900,
        systemTools: { tokens: 25300, count: 7 },
        mcpTools: {
          tokens: 7900,
          count: 5,
          servers: [
            { name: 'codegraph', tokens: 5900, count: 3 },
            { name: 'warpgrep', tokens: 2000, count: 2 }
          ]
        }
      }
    }
  })
  await until(() => evaluate(`!!${card('上下文')}.querySelector('.panel-meter-seg.mcp-tools')`), 'sectioned meter')
  const sections = await evaluate(`${card('上下文')}.textContent`)
  for (const label of ['消息', '系统工具', 'MCP 工具', '系统提示词', '剩余空间']) {
    assert.equal(sections.includes(label), true, 'context sections include ' + label + ': ' + sections)
  }
  assert.equal(await evaluate(`${summary('上下文')}.includes('28%')`), true, 'the folded card shows the percentage')
  await evaluate(`Array.from(${card('上下文')}.querySelectorAll('.panel-link')).find(b => b.textContent.includes('MCP 工具')).click()`)
  await until(() => evaluate(`${card('上下文')}.textContent.includes('codegraph')`), 'mcp server shares')

  // Background tasks: a status broadcast is enough to render the row, elapsed time and stop button.
  window.webContents.send('pi:status', {
    ...idle,
    isStreaming: false,
    backgroundTasks: [{ id: 'bash_proof', command: 'proof background command', startedAt: base - 65_000 }],
    backgroundFinished: 3
  })
  await until(() => evaluate(`${summary('后台任务')} === '1 运行中'`), 'running count in the folded summary')
  await expand('后台任务')
  await until(() => evaluate(`${card('后台任务')}.textContent.includes('proof background command')`), 'task row')
  const tasks = await evaluate(`${card('后台任务')}.textContent`)
  assert.match(tasks, /1m 5s/)
  assert.match(tasks, /3 个已完成/)
  assert.equal(await evaluate(`!!${card('后台任务')}.querySelector('.panel-icon-btn')`), true)
  // The stop IPC is wired even though this fixture task never existed in the engine.
  const stopped = await evaluate(`window.pi.stopBackgroundTask("bash_proof", ${JSON.stringify(owner)})`)
  assert.equal(stopped.ok, false)
  assert.match(stopped.error, /未知命令任务|没有后台命令/)

  // Cards fold back to one row and remember it; the panel closes from its own header.
  await evaluate(`${card('上下文')}.querySelector('.panel-card-toggle').click()`)
  await until(() => evaluate(`!${card('上下文')}.querySelector('.panel-card-body')`), 'context folded')
  assert.match(await evaluate(summary('上下文')), /^\d+%|—$/, 'the folded card keeps its number')
  assert.match(
    await evaluate('localStorage.getItem("pi-session-panel-cards") ?? ""'),
    /"context":false/,
    'folded state persists'
  )
  await evaluate('document.querySelector(".session-panel-head .icon-btn").click()')
  await until(() => evaluate('!document.querySelector(".session-panel")'), 'panel closed')
  assert.equal(
    await evaluate('localStorage.getItem("pi-session-panel")'),
    '0',
    'closed state persists'
  )

  window.webContents.send('pi:status', idle)
  console.log('Session panel passed: folded summaries, context meter, connectors, outputs, tasks, folding')
}
