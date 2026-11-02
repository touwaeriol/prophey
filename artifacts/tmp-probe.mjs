import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json'), 'utf8'))
const key = auth?.deepseek?.key
if (!key) throw new Error('no deepseek key in auth.json')

const bodies = ['https://api.deepseek.com/anthropic', 'https://api.deepseek.com/v1']
for (const base of bodies) {
  const url = `${base}/chat/completions`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
    })
    const text = await response.text()
    console.log(`${url} -> ${response.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
  } catch (error) {
    console.log(`${url} -> network error ${error.message}`)
  }
}
