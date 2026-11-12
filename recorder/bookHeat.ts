// Book heatmap history — serves the recorded order book (BOOK_DIR, written by bookRecorder.mjs)
// as the time × price grid the DOM Heatmap indicator draws. Read-only.
//
//   GET /book/heat?symbol=XAUTUSD&from=<ms>&to=<ms>&colSec=5&rows=60&rangePct=1.5&minUsd=0
//
// Reads the hour files covering [from, to] (<SYMBOL>/<YYYY-MM-DD>/<HH>.ndjson, or .ndjson.gz once
// the hour is closed), rebuilds the book from the updates, and bins it with buildHeatGrid.
// Window is capped at 6 hours so one request stays cheap.

import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { parseLine, hourKey, type BookTapeRecord } from '../src/overlays/bookTape.ts'
import { buildHeatGrid, replayBookSnaps } from '../src/overlays/domHeatmapModel.ts'

const HOUR_MS = 3_600_000
const MAX_WINDOW_MS = 6 * HOUR_MS
const SAMPLE_MS = 500

export interface HeatParams {
  symbol: string
  from: number
  to: number
  colSec: number
  rows: number
  rangePct: number
  minUsd: number
}

export interface HeatResponse {
  symbol: string
  from: number
  to: number
  colMs: number
  t0: number
  cols: number
  lo: number
  step: number
  rows: number
  scale: number
  mid: number | null
  snapCount: number
  /** [col, row, bid (1) or ask (0), value in USD] */
  cells: [number, number, number, number][]
}

/** Parses and bounds the query; returns an error message instead of params when it is not usable. */
export function parseHeatParams(q: URLSearchParams, nowMs: number): HeatParams | string {
  const symbol = (q.get('symbol') ?? '').toUpperCase()
  if (!/^[A-Z0-9]{3,20}$/.test(symbol)) return 'symbol is required (e.g. XAUTUSD)'
  const to = Number(q.get('to') ?? nowMs)
  const from = Number(q.get('from') ?? to - HOUR_MS)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 'from and to must be ms timestamps with to > from'
  if (to - from > MAX_WINDOW_MS) return 'window is capped at 6 hours'
  const num = (k: string, def: number, lo: number, hi: number): number => {
    const v = Number(q.get(k) ?? def)
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def
  }
  return {
    symbol,
    from,
    to,
    colSec: num('colSec', 5, 1, 60),
    rows: Math.round(num('rows', 60, 10, 200)),
    rangePct: num('rangePct', 1.5, 0.2, 5),
    minUsd: num('minUsd', 0, 0, 1_000_000),
  }
}

async function readHour(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    /* not plain: maybe closed and gzipped */
  }
  try {
    return gunzipSync(await readFile(`${file}.gz`)).toString('utf8')
  } catch {
    return null
  }
}

const MAX_LOOKBACK_HOURS = 24

/**
 * Every record needed to rebuild the book over [from, to], in file (arrival) order. Snapshots are only
 * written when the recorder connects, so the window may start mid-session: walk back from the window's
 * first hour to the latest hour that holds a snapshot and read from there, so the book is known at `from`.
 */
export async function readRecords(dir: string, symbol: string, from: number, to: number): Promise<BookTapeRecord[]> {
  const firstHour = Math.floor(from / HOUR_MS) * HOUR_MS
  let start = firstHour
  for (let back = 0; back <= MAX_LOOKBACK_HOURS; back++) {
    const h = firstHour - back * HOUR_MS
    const { day, hour } = hourKey(h)
    const text = await readHour(path.join(dir, symbol, day, `${hour}.ndjson`))
    if (text !== null && text.includes(',"s",')) {
      start = h
      break
    }
  }
  const out: BookTapeRecord[] = []
  for (let h = start; h <= to; h += HOUR_MS) {
    const { day, hour } = hourKey(h)
    const text = await readHour(path.join(dir, symbol, day, `${hour}.ndjson`))
    if (text === null) {
      // no file for this hour: say so, so the replay drops the book instead of carrying old levels across
      out.push({ kind: 'gap', recvMs: h, reason: 'no recording' })
      continue
    }
    for (const line of text.split('\n')) {
      const rec = parseLine(line)
      if (rec) out.push(rec)
    }
  }
  return out
}

/** Builds the grid for one request. */
export async function heatGrid(dir: string, p: HeatParams): Promise<HeatResponse> {
  const records = await readRecords(dir, p.symbol, p.from, p.to)
  const snaps = replayBookSnaps(records, { from: p.from, to: p.to, sampleMs: SAMPLE_MS, bandPct: p.rangePct / 100 })
  const last = snaps[snaps.length - 1]
  const mid = last && last.bids[0] && last.asks[0] ? (last.bids[0][0] + last.asks[0][0]) / 2 : null
  if (mid === null) {
    return { symbol: p.symbol, from: p.from, to: p.to, colMs: p.colSec * 1000, t0: p.from, cols: 0, lo: 0, step: 0, rows: p.rows, scale: 1, mid: null, snapCount: snaps.length, cells: [] }
  }
  const grid = buildHeatGrid(snaps, {
    now: p.to,
    historyMs: p.to - p.from,
    colMs: p.colSec * 1000,
    mid,
    rangePct: p.rangePct / 100,
    rows: p.rows,
    minUsd: p.minUsd,
  })
  return {
    symbol: p.symbol,
    from: p.from,
    to: p.to,
    colMs: grid.colMs,
    t0: grid.t0,
    cols: grid.cols,
    lo: grid.lo,
    step: grid.step,
    rows: grid.rows,
    scale: grid.scale,
    mid,
    snapCount: snaps.length,
    cells: grid.cells.map((c) => [c.col, c.row, c.bid ? 1 : 0, Math.round(c.value * 100) / 100]),
  }
}

// Responses are cached briefly, so several charts asking for the same window read the files once.
const CACHE_MS = 15_000
const CACHE_MAX = 50
const cache = new Map<string, { at: number; status: number; body: string }>()

/** HTTP handler body for /book/heat: returns the status and JSON text to send. */
export async function handleBookHeat(url: URL, dir: string, nowMs = Date.now()): Promise<{ status: number; body: string }> {
  const p = parseHeatParams(url.searchParams, nowMs)
  if (typeof p === 'string') return { status: 400, body: JSON.stringify({ error: p }) }
  const key = `${dir}|${p.symbol}|${p.from}|${p.to}|${p.colSec}|${p.rows}|${p.rangePct}|${p.minUsd}`
  const hit = cache.get(key)
  if (hit && nowMs - hit.at < CACHE_MS) return { status: hit.status, body: hit.body }
  const res = { status: 200, body: JSON.stringify(await heatGrid(dir, p)) }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(key, { at: nowMs, ...res })
  return res
}
