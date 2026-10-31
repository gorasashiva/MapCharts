// Trade Buddy ⇄ Claude Code bridge (dev server only).
//
// Adds POST /__buddy/ask to the Vite dev server. Each request runs the local
// Claude Code CLI headless (`claude -p`) with the user's existing Claude Code
// login — no API key — and streams the answer back as NDJSON lines:
//   {"type":"text","text":"<full text so far>"}
//   {"type":"done","text":"…","sessionId":"…","costUsd":0.01}
//   {"type":"error","message":"…"}
// GET /__buddy/health reports whether the CLI is available.
//
// The CLI runs with no tools (answers only), no user/project settings, hooks
// or MCP servers, from an empty temp directory. Only requests from this
// machine, sent by the app page itself, are accepted: the demo server runs
// with --host, and without these checks anything on the LAN (or any website,
// via a cross-site POST) could spend the user's Claude plan.
import { spawn, execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = process.env.CLAUDE_BIN || 'claude'
const WORKDIR = join(tmpdir(), 'candl-buddy-bridge')
const MODELS = new Set(['opus', 'sonnet', 'haiku'])
const EFFORTS = new Set(['low', 'medium', 'high'])
const MAX_CONCURRENT = 2
const MAX_BODY = 512 * 1024
const TIMEOUT_MS = 5 * 60 * 1000

let running = 0

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** Same-machine, same-app requests only. */
function allowed(req) {
  if (!isLoopback(req.socket.remoteAddress)) return false
  if (req.headers['x-buddy-bridge'] !== '1') return false // forces a CORS preflight for cross-site callers
  const origin = req.headers.origin
  if (origin) {
    try {
      const host = new URL(origin).hostname
      if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return false
    } catch {
      return false
    }
  }
  return true
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('request too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function send(res, obj) {
  res.write(JSON.stringify(obj) + '\n')
}

function health(res) {
  execFile(CLI, ['--version'], { timeout: 10_000 }, (err, stdout) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(err ? { ok: false, message: `Claude Code CLI not found (${CLI}). Install it or set CLAUDE_BIN.` } : { ok: true, version: stdout.trim() }))
  })
}

async function ask(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch (e) {
    res.statusCode = 400
    res.end(String(e.message))
    return
  }
  const { prompt, system, sessionId, model, effort, persist } = body ?? {}
  if (typeof prompt !== 'string' || !prompt.trim() || typeof system !== 'string') {
    res.statusCode = 400
    res.end('prompt and system are required')
    return
  }
  if (running >= MAX_CONCURRENT) {
    res.statusCode = 429
    res.end('Claude Code is busy with another Buddy request; try again shortly.')
    return
  }

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--system-prompt', system]
  if (MODELS.has(model)) args.push('--model', model)
  if (EFFORTS.has(effort)) args.push('--effort', effort)
  if (typeof sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(sessionId)) args.push('--resume', sessionId)
  if (!persist) args.push('--no-session-persistence')

  mkdirSync(WORKDIR, { recursive: true })
  running++
  res.statusCode = 200
  res.setHeader('content-type', 'application/x-ndjson')
  res.setHeader('cache-control', 'no-store')

  const child = spawn(CLI, args, { cwd: WORKDIR, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let text = ''
  let buf = ''
  let stderr = ''
  let finished = false
  const finish = (obj) => {
    if (finished) return
    finished = true
    running--
    clearTimeout(timer)
    send(res, obj)
    res.end()
  }
  const timer = setTimeout(() => {
    child.kill('SIGTERM')
    finish({ type: 'error', message: 'Claude Code took longer than 5 minutes; cancelled.' })
  }, TIMEOUT_MS)

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') {
        text += e.event.delta.text
        send(res, { type: 'text', text })
      } else if (e.type === 'result') {
        if (e.is_error) finish({ type: 'error', message: e.result || e.subtype || 'Claude Code returned an error' })
        else finish({ type: 'done', text: typeof e.result === 'string' && e.result ? e.result : text, sessionId: e.session_id, costUsd: e.total_cost_usd ?? 0 })
      }
    }
  })
  child.stderr.on('data', (c) => {
    stderr = (stderr + c.toString('utf8')).slice(-2000)
  })
  child.on('error', (err) => finish({ type: 'error', message: `Could not start Claude Code (${CLI}): ${err.message}` }))
  child.on('close', (code) => finish({ type: 'error', message: `Claude Code exited (code ${code}) without a result. ${stderr.trim().split('\n').pop() ?? ''}` }))
  // Browser went away (panel closed, reload): stop spending on an unread answer.
  res.on('close', () => {
    if (!finished) {
      child.kill('SIGTERM')
      finished = true
      running--
      clearTimeout(timer)
    }
  })

  child.stdin.end(prompt)
}

/** Vite plugin: registers the bridge on the dev server only (never in builds). */
export function buddyBridge() {
  return {
    name: 'candl-buddy-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        if (url !== '/__buddy/ask' && url !== '/__buddy/health') return next()
        if (!allowed(req)) {
          res.statusCode = 403
          res.end('Buddy bridge accepts requests from this machine only.')
          return
        }
        if (url === '/__buddy/health' && req.method === 'GET') return health(res)
        if (url === '/__buddy/ask' && req.method === 'POST') return void ask(req, res)
        res.statusCode = 405
        res.end()
      })
    },
  }
}
