#!/usr/bin/env node
// Book recorder — saves Delta Exchange India's order book (l2_updates) and
// trade tape for a few markets, in the order they arrived, so the DOM
// dashboard's level detection and Read card can be replayed and studied
// offline (recorder/replayDom.ts).
//
// Why it exists: exchanges do not publish past order books. Walls, spoofs,
// absorption and the Read card all depend on the book, so a week of them can
// only be studied from our own recording. Every hour it runs is an hour that
// can be replayed exactly; a gap (recorder down, sequence break) is marked.
//
//   node recorder/bookRecorder.mjs          (Node 22.18+: imports a .ts file)
//
// Env: BOOK_SYMBOLS      comma list, default XAUTUSD,BTCUSD,ETHUSD
//      BOOK_DIR          default ./book-data
//      BOOK_PORT         default 8789
//      BOOK_RETAIN_DAYS  default 21
//
// Storage: BOOK_DIR/<SYMBOL>/<YYYY-MM-DD>/<HH>.ndjson (UTC, by receive time),
// gzipped to .ndjson.gz once the hour is over; line format in
// src/overlays/bookTape.ts. BOOK_DIR/<SYMBOL>/sessions.json holds the spans
// actually recorded, [[startMs, endMs], ...].
//
// HTTP (CORS open, read-only):
//   GET /book/status   per market: lines this run, last message, recorded hours, disk use
import { createServer } from 'node:http'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import path from 'node:path'
import { encodeBook, encodeGap, encodeMeta, encodeTrade, hourKey } from '../src/overlays/bookTape.ts'
import { handleBookHeat, rollupRange } from './heatRollup.ts'

const SYMBOLS = (process.env.BOOK_SYMBOLS ?? 'XAUTUSD,BTCUSD,ETHUSD')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)
const DIR = path.resolve(process.env.BOOK_DIR ?? 'book-data')
const PORT = Number(process.env.BOOK_PORT ?? 8789)
const RETAIN_DAYS = Number(process.env.BOOK_RETAIN_DAYS ?? 21)
const REST = 'https://api.india.delta.exchange'
const WS_URL = 'wss://socket.india.delta.exchange'
const DAY_MS = 86_400_000
/** A reconnect within this long continues the previous recorded span. */
const SESSION_JOIN_MS = 60_000
const STALE_MS = 60_000

const log = (...a) => console.log(new Date().toISOString(), '[book]', ...a)

// ----- per-symbol state -----------------------------------------------------
/** @type {Map<string, {cv: number, seq: number, buf: Map<string, string[]>, fileKey: string, sessions: number[][], books: number, trades: number, gaps: number, lastMs: number}>} */
const state = new Map()
const symDir = (sym) => path.join(DIR, sym)

async function loadSessions(sym) {
  try {
    const s = JSON.parse(await readFile(path.join(symDir(sym), 'sessions.json'), 'utf8'))
    return Array.isArray(s) ? s.filter((x) => Array.isArray(x) && x.length === 2) : []
  } catch {
    return []
  }
}

async function saveSessions(sym) {
  const st = state.get(sym)
  if (st) await writeFile(path.join(symDir(sym), 'sessions.json'), JSON.stringify(st.sessions))
}

function openSessions(now) {
  for (const st of state.values()) {
    const last = st.sessions[st.sessions.length - 1]
    if (last && now - last[1] <= SESSION_JOIN_MS) last[1] = now
    else st.sessions.push([now, now])
  }
}

function touch(st, now) {
  st.lastMs = now
  const last = st.sessions[st.sessions.length - 1]
  if (last) last[1] = Math.max(last[1], now)
}

// ----- contract values (sizes are in contracts; store base-asset qty) --------
async function loadContractValues() {
  const res = await fetch(`${REST}/v2/tickers`)
  if (!res.ok) throw new Error(`tickers HTTP ${res.status}`)
  for (const r of (await res.json()).result ?? []) {
    const st = state.get(r.symbol)
    const cv = Number(r.contract_value)
    if (st && cv > 0) st.cv = cv
  }
}

// ----- writing ----------------------------------------------------------------
/** Queue a line into its hour file; each new file starts with a meta line. */
function write(sym, recvMs, line) {
  const st = state.get(sym)
  const { day, hour } = hourKey(recvMs)
  const key = `${day}/${hour}`
  let lines = st.buf.get(key)
  if (!lines) st.buf.set(key, (lines = []))
  if (st.fileKey !== key) {
    st.fileKey = key
    lines.push(encodeMeta(recvMs, sym, st.cv))
  }
  lines.push(line)
}

async function flush() {
  for (const [sym, st] of state) {
    const bufs = st.buf
    if (!bufs.size) continue
    st.buf = new Map()
    for (const [key, lines] of bufs) {
      const [day, hour] = key.split('/')
      try {
        await mkdir(path.join(symDir(sym), day), { recursive: true })
        await appendFile(path.join(symDir(sym), day, `${hour}.ndjson`), lines.join('\n') + '\n')
      } catch (err) {
        st.buf.set(key, lines.concat(st.buf.get(key) ?? [])) // retry on the next flush
        log(`write failed for ${sym} ${key}:`, err.message)
      }
    }
  }
}

/** Gzip every finished hour file, and drop days past retention. */
async function compactAndPrune() {
  const now = Date.now()
  const cur = hourKey(now)
  const oldest = new Date(now - RETAIN_DAYS * DAY_MS).toISOString().slice(0, 10)
  for (const sym of SYMBOLS) {
    let days = []
    try {
      days = (await readdir(symDir(sym), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      continue
    }
    for (const day of days) {
      const dir = path.join(symDir(sym), day)
      if (day < oldest) {
        await rm(dir, { recursive: true, force: true })
        log(`pruned ${sym}/${day}`)
        continue
      }
      for (const f of await readdir(dir)) {
        if (!f.endsWith('.ndjson') || (day === cur.day && f === `${cur.hour}.ndjson`)) continue
        const src = path.join(dir, f)
        try {
          await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(`${src}.gz.tmp`))
          await rename(`${src}.gz.tmp`, `${src}.gz`)
          await rm(src, { force: true })
        } catch (err) {
          log(`compress failed for ${src}:`, err.message)
        }
      }
    }
  }
}

// ----- feed -------------------------------------------------------------------
const levels = (side, cv) => (Array.isArray(side) ? side.map((l) => [Number(l[0]), Number(((Number(l[1]) || 0) * cv).toPrecision(12))]) : [])

function connect() {
  let retry = 0
  let ws = null
  let lastMsg = Date.now()
  let ping = null

  const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg))
  /** Lost book continuity for `sym`: mark it and ask for a fresh snapshot. */
  const resync = (sym, reason) => {
    const st = state.get(sym)
    const now = Date.now()
    st.seq = -1
    st.gaps++
    write(sym, now, encodeGap(now, reason))
    send({ type: 'unsubscribe', payload: { channels: [{ name: 'l2_updates', symbols: [sym] }] } })
    setTimeout(() => send({ type: 'subscribe', payload: { channels: [{ name: 'l2_updates', symbols: [sym] }] } }), 250)
  }

  const open = () => {
    ws = new WebSocket(WS_URL)
    ws.onopen = () => {
      retry = 0
      lastMsg = Date.now()
      openSessions(lastMsg)
      for (const [sym, st] of state) {
        st.seq = -1
        write(sym, lastMsg, encodeGap(lastMsg, 'connect'))
      }
      send({ type: 'subscribe', payload: { channels: [{ name: 'l2_updates', symbols: SYMBOLS }, { name: 'all_trades', symbols: SYMBOLS }] } })
      ping = setInterval(() => send({ type: 'ping' }), 25_000)
      log(`connected, recording book + trades for ${SYMBOLS.join(', ')}`)
    }
    ws.onmessage = (ev) => {
      const now = Date.now()
      lastMsg = now
      let d
      try {
        d = JSON.parse(ev.data)
      } catch {
        return
      }
      const st = state.get(d?.symbol)
      if (!st) return
      if (d.type === 'l2_updates') {
        const action = d.action === 'snapshot' ? 'snapshot' : 'update'
        const s = Number(d.sequence_no)
        if (action === 'update' && (st.seq < 0 || (Number.isFinite(s) && s !== st.seq + 1))) {
          if (st.seq >= 0) resync(d.symbol, 'sequence gap')
          return // updates before a snapshot cannot be applied
        }
        if (Number.isFinite(s)) st.seq = s
        write(d.symbol, now, encodeBook(now, Math.floor(Number(d.timestamp) / 1000) || now, action, levels(d.bids, st.cv), levels(d.asks, st.cv)))
        st.books++
        touch(st, now)
      } else if (d.type === 'all_trades' && d.price != null) {
        const qty = Number(((Number(d.size) || 0) * st.cv).toPrecision(12))
        if (!(qty > 0)) return
        write(d.symbol, now, encodeTrade(now, Number(d.timestamp) || now * 1000, Number(d.price), qty, d.seller_role !== 'taker'))
        st.trades++
        touch(st, now)
      }
      // all_trades_snapshot (the backlog on subscribe) predates the book: not recorded
    }
    ws.onclose = () => {
      clearInterval(ping)
      ping = null
      const wait = Math.min(30_000, 1000 * 2 ** retry++)
      log(`socket closed, reconnecting in ${wait / 1000}s`)
      setTimeout(open, wait)
    }
    ws.onerror = () => ws?.close()
  }
  open()
  // a socket that stops talking without closing
  setInterval(() => {
    if (Date.now() - lastMsg > STALE_MS && ws?.readyState === 1) {
      log('feed stale, reconnecting')
      ws.close()
    }
  }, 15_000)
}

// ----- http -------------------------------------------------------------------
async function dirBytes(dir) {
  let total = 0
  try {
    for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) total += (await stat(path.join(e.parentPath ?? e.path, e.name))).size
    }
  } catch {}
  return total
}

async function status() {
  const out = {}
  for (const [sym, st] of state) {
    out[sym] = {
      contractValue: st.cv,
      bookLinesThisRun: st.books,
      tradesThisRun: st.trades,
      gapsThisRun: st.gaps,
      lastMessage: st.lastMs ? new Date(st.lastMs).toISOString() : null,
      recordedHours: Math.round((st.sessions.reduce((s, [a, b]) => s + (b - a), 0) / 3_600_000) * 10) / 10,
      firstRecorded: st.sessions[0] ? new Date(st.sessions[0][0]).toISOString() : null,
      diskMB: Math.round((await dirBytes(symDir(sym))) / 1e5) / 10,
    }
  }
  return { symbols: out, dir: DIR, retainDays: RETAIN_DAYS }
}

/** Claim the status port first: if another recorder already holds it, this one must not record too (duplicate lines). */
function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/book/heat') {
        // history for the DOM Heatmap indicator: the recorded book binned as time × price (read-only)
        const r = await handleBookHeat(url, DIR).catch((err) => ({ status: 500, body: JSON.stringify({ error: String(err?.message ?? err) }) }))
        res.writeHead(r.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(r.body)
        return
      }
      const ok = url.pathname === '/book/status'
      res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify(ok ? await status() : { error: 'not found' }))
    })
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log(`port ${PORT} is taken: another book recorder is already running, so this one stops`)
        process.exit(0)
      }
      throw err
    })
    server.listen(PORT, () => {
      log(`status on http://localhost:${PORT}/book/status · writing to ${DIR}`)
      resolve()
    })
  })
}

// ----- main -------------------------------------------------------------------
async function main() {
  for (const sym of SYMBOLS) {
    await mkdir(symDir(sym), { recursive: true })
    state.set(sym, { cv: 1, seq: -1, buf: new Map(), fileKey: '', sessions: await loadSessions(sym), books: 0, trades: 0, gaps: 0, lastMs: 0 })
  }
  try {
    await loadContractValues()
  } catch (err) {
    log('contract values unavailable, sizes stay in contracts until restart:', err.message)
  }
  await serve()
  await compactAndPrune()
  connect()
  setInterval(() => void flush(), 2000)
  setInterval(() => void Promise.all(SYMBOLS.map(saveSessions)).catch(() => {}), 10_000)
  setInterval(() => void compactAndPrune(), 60_000)
  // DOM Heatmap history: roll the raw book up into one row per minute. Runs shortly after start and then
  // every 5 minutes; the first run back-fills from the raw files on disk, a day per pass.
  const rollUp = async () => {
    for (const sym of SYMBOLS) {
      try {
        for (let pass = 0; pass < 400; pass++) {
          const r = await rollupRange(DIR, sym, Date.now())
          if (r.minutes) log(`${sym} heat rollup +${r.minutes} min (${new Date(r.from).toISOString().slice(0, 16)}Z)`)
          if (r.complete) break
        }
      } catch (err) {
        log(`${sym} heat rollup failed: ${err?.message ?? err}`)
      }
    }
  }
  setTimeout(() => void rollUp(), 20_000)
  setInterval(() => void rollUp(), 5 * 60_000)
  setInterval(() => log(SYMBOLS.map((s) => `${s} book ${state.get(s).books} · trades ${state.get(s).trades} · gaps ${state.get(s).gaps}`).join(' | ')), 300_000)
  const stop = async () => {
    await flush()
    await Promise.all(SYMBOLS.map(saveSessions)).catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

void main()
