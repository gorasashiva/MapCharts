#!/usr/bin/env node
// Tape recorder — saves Delta Exchange India's public trade tape to disk and
// serves big-trade history from it.
//
// Why it exists: Big Trades / Deep Trades need individual trades, and Delta's
// public API keeps only the last 50 (≈ a minute on XAUTUSD). Without a
// recording, history before the chart was opened is guesswork. Run this
// somewhere that stays on; every hour it runs is an hour of exact history.
//
//   node recorder/tapeRecorder.mjs          (Node 22.18+: imports a .ts file)
//
// Env: TAPE_SYMBOLS      comma list, default XAUTUSD,BTCUSD,ETHUSD
//      TAPE_DIR          default ./tape-data
//      TAPE_PORT         default 8787
//      TAPE_RETAIN_DAYS  default 30
//
// Storage: TAPE_DIR/<SYMBOL>/<YYYY-MM-DD UTC>.ndjson, one print per line as
// [timeUs, price, qtyBase, side] (side 1 = taker buy, -1 = taker sell), plus
// TAPE_DIR/<SYMBOL>/sessions.json — the spans actually recorded, [[startMs,
// endMs], ...], so a gap (recorder down) isn't mistaken for a quiet market.
//
// HTTP (CORS open, read-only):
//   GET /tape/clusters?symbol&from&to&mode=cumulative|order|separate&(perDay=N|min=Q)
//       Big-trade clusters in [from, to] (epoch ms). perDay = DeepCharts-style
//       auto filter (threshold giving ~N clusters per recorded day); min = a
//       fixed size. Response: {symbol, from, to, recordedFrom, days, threshold, clusters}.
//   GET /tape/trades?symbol&from&to
//       Raw prints in [from, to] (epoch ms, at most 2 days), for exact footprint
//       history. Response: {symbol, from, to, sessions: [[startMs, endMs]...]
//       clipped to the range, prints: [[timeMs, price, qtyBase, side]...]}.
//   GET /tape/status
import { createServer } from 'node:http'
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildClusters, perDayThreshold } from '../src/overlays/takerOrders.ts'

const SYMBOLS = (process.env.TAPE_SYMBOLS ?? 'XAUTUSD,BTCUSD,ETHUSD')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)
const DIR = path.resolve(process.env.TAPE_DIR ?? 'tape-data')
const PORT = Number(process.env.TAPE_PORT ?? 8787)
const RETAIN_DAYS = Number(process.env.TAPE_RETAIN_DAYS ?? 30)
const REST = 'https://api.india.delta.exchange'
const WS_URL = 'wss://socket.india.delta.exchange'
const DAY_MS = 86_400_000
const MAX_RANGE_DAYS = 31
const MAX_CLUSTERS = 20_000
/** A reconnect within this long continues the previous recorded span (the subscribe snapshot backfills it). */
const SESSION_JOIN_MS = 60_000
const STALE_MS = 60_000
const MODES = new Set(['cumulative', 'order', 'separate'])

const log = (...a) => console.log(new Date().toISOString(), '[tape]', ...a)

// ----- per-symbol state -----------------------------------------------------
/** @type {Map<string, {cv: number, cvKnown: boolean, buf: string[], bufMaxUs: number, lastUs: number, flushedMs: number, sessions: number[][], count: number}>} */
const state = new Map()

const symDir = (sym) => path.join(DIR, sym)
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10)

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
  if (!st) return
  await writeFile(path.join(symDir(sym), 'sessions.json'), JSON.stringify(st.sessions))
}

/** Mark `now` as recorded for every symbol (any socket message proves the feed is alive). */
function touchSessions(now) {
  for (const st of state.values()) {
    const last = st.sessions[st.sessions.length - 1]
    if (last) last[1] = Math.max(last[1], now)
  }
}

function openSessions(now) {
  for (const st of state.values()) {
    const last = st.sessions[st.sessions.length - 1]
    if (last && now - last[1] <= SESSION_JOIN_MS) last[1] = now
    else st.sessions.push([now, now])
  }
}

// ----- contract values (prints are in contracts; store base-asset qty) --------
async function loadContractValues() {
  const res = await fetch(`${REST}/v2/tickers`)
  if (!res.ok) throw new Error(`tickers HTTP ${res.status}`)
  const rows = (await res.json()).result ?? []
  for (const r of rows) {
    const st = state.get(r.symbol)
    const cv = Number(r.contract_value)
    if (st && cv > 0) {
      st.cv = cv
      st.cvKnown = true
    }
  }
}

// ----- recording --------------------------------------------------------------
function record(sym, t) {
  const st = state.get(sym)
  if (!st || t?.price == null) return
  const tUs = Number(t.timestamp)
  if (!(tUs > 0)) return
  const qty = Number(((Number(t.size) || 0) * st.cv).toPrecision(12))
  if (!(qty > 0)) return
  const side = t.seller_role === 'taker' ? -1 : 1
  st.buf.push(JSON.stringify([tUs, Number(t.price), qty, side]))
  if (tUs > st.lastUs) st.lastUs = tUs
  if (tUs > st.bufMaxUs) st.bufMaxUs = tUs
  st.count++
}

async function flush() {
  for (const [sym, st] of state) {
    if (st.buf.length === 0) continue
    const lines = st.buf
    const maxUs = st.bufMaxUs
    st.buf = []
    const byDay = new Map()
    for (const line of lines) {
      const tUs = Number(line.slice(1, line.indexOf(',')))
      const key = dayKey(tUs / 1000)
      if (!byDay.has(key)) byDay.set(key, [])
      byDay.get(key).push(line)
    }
    try {
      for (const [key, ls] of byDay) await appendFile(path.join(symDir(sym), `${key}.ndjson`), ls.join('\n') + '\n')
      st.flushedMs = Math.max(st.flushedMs, Math.floor(maxUs / 1000))
    } catch (err) {
      st.buf = lines.concat(st.buf) // keep them for the next attempt
      log(`write failed for ${sym}:`, err.message)
    }
  }
}

function connect() {
  let retry = 0
  let ws = null
  let lastMsg = Date.now()
  let ping = null

  const open = () => {
    ws = new WebSocket(WS_URL)
    ws.onopen = () => {
      retry = 0
      lastMsg = Date.now()
      openSessions(lastMsg)
      ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [{ name: 'all_trades', symbols: SYMBOLS }] } }))
      ping = setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 25_000)
      log(`connected, recording ${SYMBOLS.join(', ')}`)
    }
    ws.onmessage = (ev) => {
      lastMsg = Date.now()
      touchSessions(lastMsg)
      let d
      try {
        d = JSON.parse(ev.data)
      } catch {
        return
      }
      if (d?.type === 'all_trades') record(d.symbol, d)
      else if (d?.type === 'all_trades_snapshot' && Array.isArray(d.trades)) {
        // Newest-first; only what we don't have yet (fills the reconnect gap).
        const since = state.get(d.symbol)?.lastUs ?? 0
        for (let i = d.trades.length - 1; i >= 0; i--) if (Number(d.trades[i].timestamp) > since) record(d.symbol, d.trades[i])
      }
    }
    ws.onclose = () => {
      if (ping) clearInterval(ping)
      ping = null
      const delay = Math.min(30_000, 1_000 * 2 ** retry++)
      log(`disconnected, retrying in ${delay / 1000}s`)
      setTimeout(open, delay)
    }
    ws.onerror = () => ws?.close()
  }

  setInterval(() => {
    if (ws && ws.readyState === 1 && Date.now() - lastMsg > STALE_MS) {
      log('feed stale, reconnecting')
      ws.close()
    }
  }, 10_000)
  open()
}

// ----- retention --------------------------------------------------------------
async function prune() {
  const cutoff = dayKey(Date.now() - RETAIN_DAYS * DAY_MS)
  const keepFrom = Date.now() - RETAIN_DAYS * DAY_MS
  for (const [sym, st] of state) {
    let files = []
    try {
      files = await readdir(symDir(sym))
    } catch {
      continue
    }
    for (const f of files) if (/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f) && f.slice(0, 10) < cutoff) await rm(path.join(symDir(sym), f), { force: true })
    st.sessions = st.sessions.filter((s) => s[1] >= keepFrom)
  }
}

// ----- serving ----------------------------------------------------------------
/** Parsed prints of one day file, filtered to [fromUs, toUs]. */
async function readDay(sym, key, fromUs, toUs) {
  let text
  try {
    text = await readFile(path.join(symDir(sym), `${key}.ndjson`), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue // a line cut short by a crash
    }
    const tUs = r[0]
    if (tUs < fromUs || tUs > toUs) continue
    out.push({ tUs, price: r[1], qty: r[2], side: r[3] > 0 ? 'buy' : 'sell' })
  }
  return out
}

/** Closed days never change: cache their clusters (not 'separate' — one per print is too many to hold). */
const dayCache = new Map()
const DAY_CACHE_MAX = 60

async function clustersForDay(sym, key, mode, fromUs, toUs) {
  const cacheable = key < dayKey(Date.now()) && mode !== 'separate'
  const inRange = (c) => c.time * 1000 >= fromUs && c.time * 1000 <= toUs
  const ck = `${sym}|${key}|${mode}`
  if (cacheable && dayCache.has(ck)) return dayCache.get(ck).filter(inRange)
  const dayStartUs = Date.parse(`${key}T00:00:00Z`) * 1000
  const prints = await readDay(sym, key, cacheable ? dayStartUs : fromUs, cacheable ? dayStartUs + DAY_MS * 1000 : toUs)
  prints.sort((a, b) => a.tUs - b.tUs)
  const clusters = buildClusters(prints, mode)
  if (!cacheable) return clusters
  dayCache.set(ck, clusters)
  if (dayCache.size > DAY_CACHE_MAX) dayCache.delete(dayCache.keys().next().value)
  return clusters.filter(inRange)
}

async function handleClusters(q) {
  const sym = String(q.get('symbol') ?? '').toUpperCase()
  const st = state.get(sym)
  if (!st) return [404, { error: `not recording ${sym || '(no symbol)'}` }]
  const mode = q.get('mode') ?? 'cumulative'
  if (!MODES.has(mode)) return [400, { error: 'mode must be cumulative, order or separate' }]
  let to = Number(q.get('to') ?? Date.now())
  let from = Number(q.get('from') ?? to - DAY_MS)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return [400, { error: 'bad from/to' }]
  from = Math.max(from, to - MAX_RANGE_DAYS * DAY_MS)
  // Only serve what's on disk: callers treat everything up to `to` as covered.
  to = Math.max(from, Math.min(to, st.flushedMs))

  // Recorded coverage inside [from, to].
  let covered = 0
  let recordedFrom = null
  for (const [a, b] of st.sessions) {
    const lo = Math.max(a, from)
    const hi = Math.min(b, to)
    if (hi > lo) {
      covered += hi - lo
      if (recordedFrom === null || lo < recordedFrom) recordedFrom = lo
    }
  }
  const days = covered / DAY_MS

  const all = []
  if (recordedFrom !== null) {
    for (let d = Date.parse(`${dayKey(from)}T00:00:00Z`); d <= to; d += DAY_MS) {
      for (const c of await clustersForDay(sym, dayKey(d), mode, from * 1000, to * 1000)) all.push(c)
    }
  }
  const perDay = Number(q.get('perDay'))
  const threshold = perDay > 0 ? perDayThreshold(all.map((c) => c.qty), days, perDay) : Math.max(0, Number(q.get('min')) || 0)
  let clusters = all.filter((c) => c.qty >= threshold)
  if (clusters.length > MAX_CLUSTERS) {
    clusters = clusters
      .sort((a, b) => b.qty - a.qty)
      .slice(0, MAX_CLUSTERS)
      .sort((a, b) => a.time - b.time)
  }
  return [200, { symbol: sym, from, to, recordedFrom, days, threshold: Number.isFinite(threshold) ? threshold : null, clusters }]
}

const MAX_TRADES_RANGE_MS = 2 * DAY_MS

async function handleTrades(q) {
  const sym = String(q.get('symbol') ?? '').toUpperCase()
  const st = state.get(sym)
  if (!st) return [404, { error: `not recording ${sym || '(no symbol)'}` }]
  let to = Number(q.get('to') ?? Date.now())
  let from = Number(q.get('from') ?? to - DAY_MS)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return [400, { error: 'bad from/to' }]
  from = Math.max(from, to - MAX_TRADES_RANGE_MS)
  // only what is on disk; the recorded spans say which stretches are complete
  to = Math.max(from, Math.min(to, st.flushedMs))
  const sessions = st.sessions.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a)
  const prints = []
  for (let d = Date.parse(`${dayKey(from)}T00:00:00Z`); d <= to; d += DAY_MS) {
    for (const p of await readDay(sym, dayKey(d), from * 1000, to * 1000)) prints.push([p.tUs / 1000, p.price, p.qty, p.side === 'buy' ? 1 : -1])
  }
  prints.sort((a, b) => a[0] - b[0])
  return [200, { symbol: sym, from, to, sessions, prints }]
}

function handleStatus() {
  const out = {}
  for (const [sym, st] of state) {
    out[sym] = {
      contractValue: st.cvKnown ? st.cv : null,
      recordedSince: st.sessions[0]?.[0] ?? null,
      lastTrade: st.lastUs ? Math.floor(st.lastUs / 1000) : null,
      printsThisRun: st.count,
      sessions: st.sessions.length,
    }
  }
  return [200, { symbols: out, dir: DIR, retainDays: RETAIN_DAYS }]
}

function serve() {
  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let status = 404
    let body = { error: 'not found' }
    try {
      if (req.method === 'GET' && url.pathname === '/tape/clusters') [status, body] = await handleClusters(url.searchParams)
      else if (req.method === 'GET' && url.pathname === '/tape/trades') [status, body] = await handleTrades(url.searchParams)
      else if (req.method === 'GET' && url.pathname === '/tape/status') [status, body] = handleStatus()
    } catch (err) {
      status = 500
      body = { error: String(err?.message ?? err) }
    }
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }).listen(PORT, () => log(`serving http://localhost:${PORT}/tape/status`))
}

// ----- main -------------------------------------------------------------------
async function main() {
  for (const sym of SYMBOLS) {
    await mkdir(symDir(sym), { recursive: true })
    const sessions = await loadSessions(sym)
    const lastEnd = sessions.length ? sessions[sessions.length - 1][1] : 0
    state.set(sym, { cv: 1, cvKnown: false, buf: [], bufMaxUs: 0, lastUs: lastEnd * 1000, flushedMs: lastEnd, sessions, count: 0 })
  }
  serve()
  for (;;) {
    try {
      await loadContractValues()
      break
    } catch (err) {
      log('contract values unavailable, retrying in 30s:', err.message)
      await new Promise((r) => setTimeout(r, 30_000))
    }
  }
  for (const [sym, st] of state) if (!st.cvKnown) log(`warning: ${sym} not listed on Delta — storing raw contract counts`)
  setInterval(() => void loadContractValues().catch(() => {}), 6 * 3600_000)

  connect()
  setInterval(() => void flush(), 1_000)
  setInterval(() => void Promise.all(SYMBOLS.map(saveSessions)).catch(() => {}), 10_000)
  setInterval(() => void prune().catch(() => {}), 3600_000)
  void prune().catch(() => {})
  setInterval(() => log(SYMBOLS.map((s) => `${s} ${state.get(s).count}`).join(' · '), 'prints this run'), 300_000)

  const shutdown = async () => {
    await flush()
    await Promise.all(SYMBOLS.map(saveSessions)).catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main()
