#!/usr/bin/env node
/**
 * Restore the sessions left behind when the app's userData folder was renamed.
 *
 * The 0.6.x rename (package name `agent-desktop` -> `@prophey/desktop`) moved Electron's userData
 * from `%APPDATA%\agent-desktop` to `%APPDATA%\@prophey\desktop`. `migrateLegacyUserData()` in
 * apps/desktop/src/main/index.ts only knows `%APPDATA%\@pi-mcps\desktop` and only copies
 * config.json / device-id / updates.json, so `sessions.json` and `transcripts/` stayed behind.
 * The new build re-indexed pi's own session files from ~/.pi/agent/sessions, which is why only the
 * pi-mcps group came back.
 *
 * This script (run it with the app closed):
 *   1. backs up the current sessions.json next to this file (./backups/);
 *   2. copies every transcript still missing into the new userData;
 *   3. merges the old session records whose files now live in the new userData, deduped by path;
 *   4. merges the old recentRepos into the new config.json.
 *
 * Usage:  node restore-legacy-sessions.mjs [--dry-run] [--force]
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dryRun = process.argv.includes('--dry-run')
const force = process.argv.includes('--force')
const here = path.dirname(fileURLToPath(import.meta.url))
const appData = process.env.APPDATA
if (!appData) {
  console.error('✗ APPDATA 不存在，这个脚本只适用于 Windows。')
  process.exit(1)
}
const legacyDir = path.join(appData, 'agent-desktop')
const currentDir = path.join(appData, '@prophey', 'desktop')

const log = (...args) => console.log(...args)
const fail = (message) => {
  console.error('\n✗ ' + message)
  process.exit(1)
}

if (!existsSync(legacyDir)) fail(`旧目录不存在：${legacyDir}`)
if (!existsSync(currentDir)) fail(`新目录不存在：${currentDir}`)

function runningImage() {
  for (const image of ['Prophey.exe', 'electron.exe']) {
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /NH`, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
      })
      if (out.toLowerCase().includes(image.toLowerCase())) return image
    } catch {
      // tasklist missing or refused; treat as not running
    }
  }
  return ''
}

if (!dryRun && !force) {
  const image = runningImage()
  if (image) {
    fail(
      `应用正在运行（${image}）。请先完全退出应用再运行本脚本，\n` +
      `  否则应用内存里的会话列表会把 sessions.json 覆盖回去。\n` +
      `  确认要强行写入请加 --force。`
    )
  }
}

const keyOf = (value) => (value ? path.resolve(value).toLowerCase() : '')
/** `%APPDATA%\agent-desktop\transcripts\x.jsonl` -> `%APPDATA%\@prophey\desktop\transcripts\x.jsonl` */
const rewrite = (value) => {
  if (!value) return value
  const from = legacyDir.toLowerCase()
  return value.toLowerCase().startsWith(from) ? currentDir + value.slice(legacyDir.length) : value
}

// 1. transcripts that never made it into the new userData
const legacyTranscripts = path.join(legacyDir, 'transcripts')
const currentTranscripts = path.join(currentDir, 'transcripts')
const toCopy = existsSync(legacyTranscripts)
  ? readdirSync(legacyTranscripts)
    .filter((name) => name.endsWith('.jsonl'))
    .filter((name) => !existsSync(path.join(currentTranscripts, name)))
  : []
log(`旧 transcripts：${existsSync(legacyTranscripts) ? readdirSync(legacyTranscripts).length : 0} 个文件，其中 ${toCopy.length} 个需要复制`)

if (!dryRun && toCopy.length > 0) {
  mkdirSync(currentTranscripts, { recursive: true })
  for (const name of toCopy) {
    copyFileSync(path.join(legacyTranscripts, name), path.join(currentTranscripts, name))
  }
}

// 2. merge the old records, deduped by path
const readSessions = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed?.sessions) ? parsed.sessions : []
  } catch {
    return []
  }
}
const currentFile = path.join(currentDir, 'sessions.json')
const legacyFile = path.join(legacyDir, 'sessions.json')
const currentSessions = readSessions(currentFile)
const legacySessions = readSessions(legacyFile)

const seenPaths = new Set()
const seenIds = new Set()
for (const record of currentSessions) {
  for (const value of [record.path, record.key]) if (value) seenPaths.add(keyOf(value))
  if (record.id) seenIds.add(record.id)
}

const willExist = (value) => Boolean(value) && (existsSync(value) || toCopy.includes(path.basename(value)))
const added = []
const skipped = []
for (const record of legacySessions) {
  const target = rewrite(record.path || record.key)
  if (!willExist(target)) {
    skipped.push({ record, reason: '文件不在新目录' })
    continue
  }
  if (seenPaths.has(keyOf(target))) {
    skipped.push({ record, reason: '索引里已有' })
    continue
  }
  const id = record.id && !seenIds.has(record.id) ? record.id : `s_${Math.random().toString(16).slice(2, 14)}`
  added.push({ ...record, id, key: target, path: target })
  seenPaths.add(keyOf(target))
  seenIds.add(id)
}

log(`旧索引：${legacySessions.length} 条，新索引：${currentSessions.length} 条，可补回 ${added.length} 条`)
for (const { record, reason } of skipped) {
  log(`  · 跳过 [${reason}] ${record.engine ?? 'pi'} ${record.title || record.id}`)
}

// 3. recentRepos, so the other project directories come back in the picker
const currentConfigFile = path.join(currentDir, 'config.json')
const legacyConfigFile = path.join(legacyDir, 'config.json')
let mergedRepos
try {
  const currentConfig = JSON.parse(readFileSync(currentConfigFile, 'utf8'))
  const legacyConfig = JSON.parse(readFileSync(legacyConfigFile, 'utf8'))
  const merged = [...(currentConfig.recentRepos ?? [])]
  for (const repo of legacyConfig.recentRepos ?? []) {
    if (!merged.some((value) => keyOf(value) === keyOf(repo))) merged.push(repo)
  }
  mergedRepos = { currentConfig, merged, changed: merged.length !== (currentConfig.recentRepos ?? []).length }
} catch {
  // missing or unreadable config is not fatal; the session list is what matters
}

if (dryRun) {
  log('\n[dry-run] 没有写入任何文件。')
  log(`  会复制：${toCopy.length} 个 transcript`)
  log(`  会补回：${added.length} 条会话记录（cwd: ${[...new Set(added.map((r) => r.cwd))].join(' | ') || '无'}）`)
  if (mergedRepos?.changed) log(`  会补回 recentRepos：${mergedRepos.merged.filter((r) => !(mergedRepos.currentConfig.recentRepos ?? []).includes(r)).join(', ')}`)
  process.exit(0)
}

// 4. write atomically, after backing up the index that is live right now
const backups = path.join(here, 'backups')
mkdirSync(backups, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
if (existsSync(currentFile)) copyFileSync(currentFile, path.join(backups, `sessions-${stamp}.json`))

const merged = [...currentSessions, ...added]
const tmp = currentFile + '.tmp'
writeFileSync(tmp, JSON.stringify({ sessions: merged }, null, 2) + '\n', 'utf8')
renameSync(tmp, currentFile)

if (mergedRepos?.changed) {
  const next = { ...mergedRepos.currentConfig, recentRepos: mergedRepos.merged }
  const configTmp = currentConfigFile + '.tmp'
  writeFileSync(configTmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(configTmp, currentConfigFile)
}

log('')
log(`✓ 已复制 ${existsSync(currentTranscripts) ? toCopy.length : 0} 个 transcript`)
log(`✓ sessions.json：${currentSessions.length} -> ${merged.length} 条`)
if (mergedRepos?.changed) log(`✓ config.json：recentRepos ${(mergedRepos.currentConfig.recentRepos ?? []).length} -> ${mergedRepos.merged.length} 个`)
log(`  备份在 ${backups}`)
log('\n现在可以重新打开应用，侧栏应该会重新出现多个项目分组。')
