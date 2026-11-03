#!/usr/bin/env node
// MAP V3 recorder — saves the GLD option chain twice per US trading day and serves the
// snapshots to the chart (examples/basic/theMapV3.ts computes the locked levels from them).
//
// Why it exists: CBOE's free delayed-quotes feed has no CORS headers (a browser can't read
// it) and keeps no history, so the chart needs a copy saved on a schedule.
//
//   node recorder/mapRecorder.mjs          (Node 22.18+: imports a .ts file)
//
// Schedule — New York wall time, so US daylight saving is followed automatically
// (src/overlays/nyClock.ts), weekdays only:
//   08:15 ET  morning  fresh OCC open interest -> the session's levels (missed: taken late,
//                      until the close)
//   16:20 ET  close    the day's complete volume -> next session's HVL (missed: until midnight)
// First start with nothing recorded takes a morning snapshot at once (flagged late), so
// the chart has levels the same day.
//
// Env: MAP_UNDERLYINGS  comma list, default GLD
//      MAP_DIR          default ./map-data
//      MAP_PORT         default 8788
//      MAP_RETAIN_DAYS  default 400
//
// Storage: MAP_DIR/<UNDERLYING>/<NY date>_<morning|close>.json — {u, kind, nyDate, time,
// late, underlying: {price, prevClose}, delta: {XAUTUSD, PAXGUSD}, rows: [[expiryMs,
// 1 = call | 0 = put, strike, openInterest, iv, volume], ...]} for expiries within 60 days.
//
// HTTP (CORS open, read-only):
//   GET /maplevels/index?u=GLD           [{id, kind, nyDate, time, late}] oldest first
//   GET /maplevels/snapshot?u=GLD&id=…   one snapshot (immutable)
//   GET /maplevels/refs?u=GLD            {id: {XAUTUSD, PAXGUSD}}: Delta's close at the previous
//                                        16:00 ET per morning snapshot — the chart side of the
//                                        GLD ratio, fixed per session (backfilled from Delta's
//                                        candle history, so older snapshots get one too)
//   GET /maplevels/status
import { createServer } from 'node:http'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dueJobs, nyParts, nyTime, optionExpiryMs, prevNyWeekday, sessionDate } from '../src/overlays/nyClock.ts'

const UNDERLYINGS = (process.env.MAP_UNDERLYINGS ?? 'GLD')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)
const DIR = path.resolve(process.env.MAP_DIR ?? 'map-data')
const PORT = Number(process.env.MAP_PORT ?? 8788)
const RETAIN_DAYS = Number(process.env.MAP_RETAIN_DAYS ?? 400)
const CBOE = 'https://cdn.cboe.com/api/global/delayed_quotes/options'
const DELTA = 'https://api.india.delta.exchange'
const DELTA_GOLD = ['XAUTUSD', 'PAXGUSD']
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const DAY_MS = 86_400_000
const KEEP_EXPIRY_MS = 60 * DAY_MS
const TICK_MS = 30_000
const RETRY_MS = 5 * 60_000
const ID_RE = /^\d{4}-\d{2}-\d{2}_(morning|close)$/

const log = (...a) => console.log(new Date().toISOString(), '[map]', ...a)

/** @type {Map<string, {id: string, kind: string, nyDate: string, time: number, late: boolean}[]>} */
const index = new Map()
/** @type {Map<string, number>} next allowed attempt per underlying after a failure */
const retryAt = new Map()
const lastError = new Map()

const uDir = (u) => path.join(DIR, u)

// ----- ratio references ---------------------------------------------------------
// The chart scales GLD strikes by (gold close at the previous 16:00 ET) ÷ (GLD close then).
// Reading that gold close off the chart's own candles made it depend on how much history
// the chart had loaded, so it is recorded here once per session instead.
/** @type {Map<string, Record<string, Record<string, number>>>} u -> id -> symbol -> close */
const refs = new Map()
const refsFile = (u) => path.join(uDir(u), 'refs.json')

async function loadRefs(u) {
  try {
    refs.set(u, JSON.parse(await readFile(refsFile(u), 'utf8')))
  } catch {
    refs.set(u, {})
  }
}

/** Delta's close of the 5m bar that opens at 16:00 ET on the weekday before `nyDate` (as the chart's closeAt reads it). */
async function refCloses(nyDate) {
  const t = nyTime(prevNyWeekday(nyDate), 16, 0)
  const out = {}
  for (const sym of DELTA_GOLD) {
    const rows = (await getJSON(`${DELTA}/v2/history/candles?resolution=5m&symbol=${sym}&start=${Math.floor((t - 3_600_000) / 1000)}&end=${Math.floor((t + 600_000) / 1000)}`)).result ?? []
    let best = null
    for (const r of rows) if (r.time * 1000 <= t && (!best || r.time > best.time)) best = r
    if (best && t - best.time * 1000 <= 6 * 3_600_000 && Number(best.close) > 0) out[sym] = Number(best.close)
  }
  return out
}

/** Fill in missing references, a few per tick (Delta keeps the candles, so late is fine). */
async function backfillRefs(u) {
  const have = refs.get(u) ?? {}
  const missing = (index.get(u) ?? []).filter((e) => e.kind === 'morning' && !have[e.id]).slice(-5)
  let changed = false
  for (const e of missing) {
    try {
      const r = await refCloses(e.nyDate)
      if (Object.keys(r).length) {
        have[e.id] = r
        changed = true
      }
    } catch (err) {
      log(`${u} ref for ${e.id} failed:`, String(err?.message ?? err))
      break
    }
  }
  if (changed) {
    refs.set(u, have)
    await writeFile(refsFile(u), JSON.stringify(have))
  }
}

async function loadIndex(u) {
  await mkdir(uDir(u), { recursive: true })
  const out = []
  for (const f of await readdir(uDir(u))) {
    const id = f.replace(/\.json$/, '')
    if (!ID_RE.test(id)) continue
    try {
      const s = JSON.parse(await readFile(path.join(uDir(u), f), 'utf8'))
      out.push({ id, kind: s.kind, nyDate: s.nyDate, time: s.time, late: !!s.late })
    } catch {
      /* unreadable file: skipped */
    }
  }
  out.sort((a, b) => a.time - b.time)
  index.set(u, out)
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

/** CBOE option symbol GLD261029C00368000 -> [expiryMs, call, strike] (expiry 16:00 ET). */
function parseSymbol(u, sym) {
  const m = new RegExp(`^${u}(\\d{2})(\\d{2})(\\d{2})([CP])(\\d{8})$`).exec(sym)
  if (!m) return null
  return [optionExpiryMs(`20${m[1]}-${m[2]}-${m[3]}`), m[4] === 'C' ? 1 : 0, Number(m[5]) / 1000]
}

async function takeSnapshot(u, kind, nyDate, late) {
  const now = Date.now()
  const d = (await getJSON(`${CBOE}/${u}.json`)).data
  if (!d || !Array.isArray(d.options) || !d.options.length) throw new Error('empty chain')
  const rows = []
  for (const o of d.options) {
    const s = parseSymbol(u, o.option)
    if (!s || s[0] <= now || s[0] - now > KEEP_EXPIRY_MS) continue
    rows.push([s[0], s[1], s[2], Number(o.open_interest) || 0, Number(o.iv) || 0, Number(o.volume) || 0])
  }
  if (!rows.length) throw new Error('no live contracts')
  const delta = {}
  await Promise.all(
    DELTA_GOLD.map(async (sym) => {
      try {
        const t = (await getJSON(`${DELTA}/v2/tickers/${sym}`)).result
        const v = Number(t?.mark_price)
        if (v > 0) delta[sym] = v
      } catch {
        /* optional fallback for the chart scaling */
      }
    }),
  )
  const snap = {
    u,
    kind,
    nyDate,
    time: now,
    late,
    underlying: { price: Number(d.current_price) || 0, prevClose: Number(d.prev_day_close) || 0 },
    delta,
    rows,
  }
  const id = `${nyDate}_${kind}`
  await writeFile(path.join(uDir(u), `${id}.json`), JSON.stringify(snap))
  const list = index.get(u).filter((e) => e.id !== id)
  list.push({ id, kind, nyDate, time: now, late })
  list.sort((a, b) => a.time - b.time)
  index.set(u, list)
  log(`${u} ${id}${late ? ' (late)' : ''}: ${rows.length} contracts, ${u} ${snap.underlying.price}`)
}

function doneFor(u) {
  const done = {}
  for (const e of index.get(u) ?? []) done[e.kind] = !done[e.kind] || e.nyDate > done[e.kind] ? e.nyDate : done[e.kind]
  return done
}

async function tick() {
  const now = Date.now()
  for (const u of UNDERLYINGS) {
    if ((retryAt.get(u) ?? 0) > now) continue
    const jobs = dueJobs(now, doneFor(u))
    // No morning snapshot yet: take the live session's now (before 08:15 ET / weekends: the last weekday's).
    if (!index.get(u).some((e) => e.kind === 'morning') && !jobs.some((j) => j.kind === 'morning')) {
      jobs.unshift({ kind: 'morning', nyDate: sessionDate(now), late: true })
    }
    for (const j of jobs) {
      try {
        await takeSnapshot(u, j.kind, j.nyDate, j.late)
        lastError.delete(u)
      } catch (err) {
        lastError.set(u, String(err?.message ?? err))
        retryAt.set(u, now + RETRY_MS)
        log(`${u} ${j.kind} failed, retry in 5 min:`, lastError.get(u))
        break
      }
    }
    await backfillRefs(u)
  }
}

async function prune() {
  const cutoff = Date.now() - RETAIN_DAYS * DAY_MS
  for (const u of UNDERLYINGS) {
    const keep = []
    for (const e of index.get(u)) {
      if (e.time < cutoff) await rm(path.join(uDir(u), `${e.id}.json`), { force: true })
      else keep.push(e)
    }
    index.set(u, keep)
  }
}

async function handle(url) {
  const u = (url.searchParams.get('u') ?? 'GLD').toUpperCase()
  if (url.pathname === '/maplevels/status') {
    return [200, JSON.stringify({ underlyings: UNDERLYINGS.map((x) => ({ u: x, snapshots: index.get(x)?.length ?? 0, last: index.get(x)?.at(-1) ?? null, error: lastError.get(x) ?? null })), ny: nyParts(Date.now()) }), 'no-store']
  }
  if (!UNDERLYINGS.includes(u)) return [404, JSON.stringify({ error: `not recorded: ${u}` }), 'no-store']
  if (url.pathname === '/maplevels/refs') return [200, JSON.stringify({ u, refs: refs.get(u) ?? {} }), 'no-store']
  if (url.pathname === '/maplevels/index') return [200, JSON.stringify({ u, snapshots: index.get(u), error: lastError.get(u) ?? null }), 'no-store']
  if (url.pathname === '/maplevels/snapshot') {
    const id = url.searchParams.get('id') ?? ''
    if (!ID_RE.test(id)) return [400, JSON.stringify({ error: 'bad id' }), 'no-store']
    try {
      return [200, await readFile(path.join(uDir(u), `${id}.json`), 'utf8'), 'public, max-age=31536000, immutable']
    } catch {
      return [404, JSON.stringify({ error: 'no such snapshot' }), 'no-store']
    }
  }
  return [404, JSON.stringify({ error: 'not found' }), 'no-store']
}

async function main() {
  for (const u of UNDERLYINGS) {
    await loadIndex(u)
    await loadRefs(u)
  }
  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let status = 405
    let body = JSON.stringify({ error: 'GET only' })
    let cache = 'no-store'
    if (req.method === 'GET') {
      try {
        ;[status, body, cache] = await handle(url)
      } catch (err) {
        ;[status, body] = [500, JSON.stringify({ error: String(err?.message ?? err) })]
      }
    }
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': cache })
    res.end(body)
  }).listen(PORT, () => log(`serving /maplevels on :${PORT}, recording ${UNDERLYINGS.join(', ')} into ${DIR}`))
  await tick()
  setInterval(() => void tick().catch((e) => log('tick failed:', e)), TICK_MS)
  setInterval(() => void prune().catch(() => {}), 6 * 3600_000)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
