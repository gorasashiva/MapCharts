// Book heatmap rollups on disk, and the /book/heat answer built from them. Read-only for the chart.
//
// The recorder writes raw hour files (BOOK_DIR/<SYMBOL>/<YYYY-MM-DD>/<HH>.ndjson[.gz]). This module
// turns them into one summary row per minute (src/overlays/bookHeatRollup.ts) in
//   BOOK_DIR/heat/<SYMBOL>/<YYYY-MM-DD>.ndjson        one JSON row per minute
//   BOOK_DIR/heat/<SYMBOL>/checkpoint.json            { "m": last minute covered }
// rollupRange() is idempotent: it resumes after the checkpoint, so the recorder can run it every few
// minutes and the first run back-fills whatever raw history is on disk.
//
//   GET /book/heat?symbol=XAUTUSD&from=<ms>&to=<ms>&cols=600&rows=200&minUsd=0

import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { hourKey, parseLine } from '../src/overlays/bookTape.ts'
import {
  BookReplayer,
  MinuteAccumulator,
  MINUTE_MS,
  ROLLUP_BAND_PCT,
  binStepFor,
  heatGridFromRows,
  tradesAndBboFromRows,
  mergeRows,
  zoneReactions,
  type MinuteRow,
} from '../src/overlays/bookHeatRollup.ts'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const MAX_LOOKBACK_HOURS = 24
const MAX_QUERY_MS = 400 * DAY_MS
const SAMPLE_MS = 500

async function readHourText(file: string): Promise<string | null> {
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

const hourFile = (dir: string, symbol: string, h: number): string => {
  const { day, hour } = hourKey(h)
  return path.join(dir, symbol, day, `${hour}.ndjson`)
}

/** Start of the earliest raw hour on disk for this symbol, or null when there is none. */
async function earliestRawHour(dir: string, symbol: string): Promise<number | null> {
  let days: string[]
  try {
    days = (await readdir(path.join(dir, symbol))).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  } catch {
    return null
  }
  for (const day of days) {
    const files = (await readdir(path.join(dir, symbol, day)).catch(() => [] as string[])).filter((f) => /^\d{2}\.ndjson(\.gz)?$/.test(f)).sort()
    if (files.length) return Date.parse(`${day}T${files[0].slice(0, 2)}:00:00Z`)
  }
  return null
}

async function readCheckpoint(dir: string, symbol: string): Promise<{ m: number } | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'heat', symbol, 'checkpoint.json'), 'utf8')) as { m: number }
  } catch {
    return null
  }
}

/**
 * Rolls raw book files up into minute rows for [from, to) and appends them to the day files.
 * `from` defaults to the minute after the checkpoint (or the earliest raw hour on the first run).
 * Only minutes that end before `to` are written, so callers pass the start of the current minute.
 */
export async function rollupRange(dir: string, symbol: string, to: number, from?: number): Promise<{ minutes: number; from: number; to: number; complete: boolean }> {
  const sym = symbol.toUpperCase()
  const reqEnd = Math.floor(to / MINUTE_MS) * MINUTE_MS
  let toMin = reqEnd
  let start: number
  if (from !== undefined) start = from
  else {
    const cp = await readCheckpoint(dir, sym)
    start = cp ? cp.m + MINUTE_MS : ((await earliestRawHour(dir, sym)) ?? toMin)
  }
  start = Math.floor(start / MINUTE_MS) * MINUTE_MS
  // At most one day per call, so a long back-fill runs in bounded memory (callers loop until `complete`).
  toMin = Math.min(reqEnd, start + DAY_MS)
  if (start >= toMin) return { minutes: 0, from: start, to: toMin, complete: toMin === reqEnd }

  // Book state at `start` comes from the latest snapshot at or before it: walk back to an hour that has one.
  const firstHour = Math.floor(start / HOUR_MS) * HOUR_MS
  let hourStart = firstHour
  for (let back = 0; back <= MAX_LOOKBACK_HOURS; back++) {
    const h = firstHour - back * HOUR_MS
    const text = await readHourText(hourFile(dir, sym, h))
    if (text !== null && text.includes(',"s",')) {
      hourStart = h
      break
    }
  }

  const replayer = new BookReplayer({ from: start, to: toMin - 1, sampleMs: SAMPLE_MS, bandPct: ROLLUP_BAND_PCT })
  const acc = new MinuteAccumulator(binStepFor(sym))
  const rows: MinuteRow[] = []
  for (let h = hourStart; h < toMin; h += HOUR_MS) {
    const text = await readHourText(hourFile(dir, sym, h))
    if (text === null) {
      // no file for this hour: drop the book, so nothing carries across the gap
      replayer.feed({ kind: 'gap', recvMs: h, reason: 'no recording' })
      continue
    }
    for (const line of text.split('\n')) {
      const rec = parseLine(line)
      if (!rec) continue
      if (rec.kind === 'trade') {
        if (rec.recvMs >= start && rec.recvMs < toMin) acc.addTrade(rec)
        continue
      }
      const snap = replayer.feed(rec)
      if (snap) for (const row of acc.add(snap)) if (row.m >= start && row.m < toMin) rows.push(row)
    }
  }
  const last = acc.flush()
  if (last && last.m >= start && last.m < toMin) rows.push(last)

  const byDay = new Map<string, string[]>()
  for (const r of rows) {
    const day = new Date(r.m).toISOString().slice(0, 10)
    const list = byDay.get(day) ?? []
    list.push(JSON.stringify(r))
    byDay.set(day, list)
  }
  const outDir = path.join(dir, 'heat', sym)
  await mkdir(outDir, { recursive: true })
  for (const [day, lines] of byDay) await appendFile(path.join(outDir, `${day}.ndjson`), lines.join('\n') + '\n')
  // Minutes with no book (quiet market or gap) still count as covered, so the next run starts after them.
  await writeFile(path.join(outDir, 'checkpoint.json'), JSON.stringify({ m: toMin - MINUTE_MS }))
  return { minutes: rows.length, from: start, to: toMin, complete: toMin === reqEnd }
}

/** Minute rows in [from, to) from the day files. */
export async function readRollupRows(dir: string, symbol: string, from: number, to: number): Promise<MinuteRow[]> {
  const out: MinuteRow[] = []
  const sym = symbol.toUpperCase()
  for (let d = Math.floor(from / DAY_MS) * DAY_MS; d < to; d += DAY_MS) {
    const day = new Date(d).toISOString().slice(0, 10)
    let text: string
    try {
      text = await readFile(path.join(dir, 'heat', sym, `${day}.ndjson`), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as MinuteRow
        if (r.m >= from && r.m < to) out.push(r)
      } catch {
        /* torn last line after a crash */
      }
    }
  }
  return out
}

export interface HeatParams {
  symbol: string
  from: number
  to: number
  cols: number
  rows: number
  minUsd: number
  /** Strong zones to mark (after merging neighbouring levels). */
  zones: number
  /** Column width in ms (a chart timeframe); null = derived from `cols`. */
  colMs: number | null
}

/** Parses and bounds the query; returns an error message when it is not usable. */
export function parseHeatParams(q: URLSearchParams, nowMs: number): HeatParams | string {
  const symbol = (q.get('symbol') ?? '').toUpperCase()
  if (!/^[A-Z0-9]{3,20}$/.test(symbol)) return 'symbol is required (e.g. XAUTUSD)'
  const to = Number(q.get('to') ?? nowMs)
  const from = Number(q.get('from') ?? to - HOUR_MS)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 'from and to must be ms timestamps with to > from'
  if (to - from > MAX_QUERY_MS) return 'window is capped at 400 days'
  const num = (k: string, def: number, lo: number, hi: number): number => {
    const v = Number(q.get(k) ?? def)
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def
  }
  return {
    symbol,
    from,
    to,
    cols: Math.round(num('cols', 600, 20, 1200)),
    colMs: q.get('colMs') ? Math.max(MINUTE_MS, Math.ceil(num('colMs', MINUTE_MS, MINUTE_MS, 365 * DAY_MS) / MINUTE_MS) * MINUTE_MS) : null,
    rows: Math.round(num('rows', 200, 10, 400)),
    minUsd: num('minUsd', 0, 0, 1_000_000),
    zones: Math.round(num('zones', 8, 0, 40)),
  }
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
  minutes: number
  /** [col, row, bid (1) or ask (0), value in USD] */
  cells: [number, number, number, number][]
  /** Trade bubbles: [col, row, USD bought, USD sold, trade count] */
  trades: [number, number, number, number, number][]
  /** Best bid and ask per column: [col, bid, ask] */
  bbo: [number, number, number][]
  /** Zones: merged strong levels with their size, touches and reactions. */
  zones: { lo: number; hi: number; usd: number; touches: number; reactions: number }[]
  /** Reaction markers: [column, price of the zone centre, count] */
  reacts: [number, number, number][]
}

/** The grid for one request, from the rollups. */
export async function heatGrid(dir: string, p: HeatParams): Promise<HeatResponse> {
  const derived = Math.max(MINUTE_MS, Math.ceil((p.to - p.from) / p.cols / MINUTE_MS) * MINUTE_MS)
  // A requested timeframe is honoured, but never into more than 2000 columns.
  const colMs = p.colMs ? Math.max(p.colMs, Math.ceil((p.to - p.from) / 2000 / MINUTE_MS) * MINUTE_MS) : derived
  const data = await readRollupRows(dir, p.symbol, p.from, p.to)
  const g = heatGridFromRows(data, { from: p.from, to: p.to, colMs, maxRows: p.rows, minUsd: p.minUsd })
  const tb = tradesAndBboFromRows(data, g, { from: p.from, to: p.to })
  const zones = zoneBands(data, g, p)
  return {
    symbol: p.symbol,
    from: p.from,
    to: p.to,
    colMs: g.colMs,
    t0: g.t0,
    cols: g.cols,
    lo: g.lo,
    step: g.step,
    rows: g.rows,
    scale: g.scale,
    mid: g.mid,
    minutes: g.minutes,
    cells: g.cells.map((c) => [c.col, c.row, c.bid ? 1 : 0, Math.round(c.value * 100) / 100]),
    trades: tb.trades.map((t) => [t.col, t.row, Math.round(t.buy), Math.round(t.sell), t.n]),
    bbo: tb.bbo.map((b) => [b.col, b.bid, b.ask]),
    zones: zones.map((z) => ({ lo: z.lo, hi: z.hi, usd: z.usd, touches: z.touches, reactions: z.reactions })),
    reacts: zones.flatMap((z) => z.reactCols.map(([c, n]) => [c, z.centre, n] as [number, number, number])),
  }
}

// Responses are cached briefly, so several charts asking for the same window read the files once.
const CACHE_MS = 30_000
const CACHE_MAX = 50
const cache = new Map<string, { at: number; status: number; body: string }>()

/** HTTP handler body for /book/heat: returns the status and JSON text to send. */
export async function handleBookHeat(url: URL, dir: string, nowMs = Date.now()): Promise<{ status: number; body: string }> {
  const p = parseHeatParams(url.searchParams, nowMs)
  if (typeof p === 'string') return { status: 400, body: JSON.stringify({ error: p }) }
  const key = `${dir}|${p.symbol}|${p.from}|${p.to}|${p.cols}|${p.rows}|${p.minUsd}|${p.colMs ?? ''}`
  const hit = cache.get(key)
  if (hit && nowMs - hit.at < CACHE_MS) return { status: hit.status, body: hit.body }
  const res = { status: 200, body: JSON.stringify(await heatGrid(dir, p)) }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(key, { at: nowMs, ...res })
  return res
}

/** Symbols that have a raw recording on disk. */
export async function recordedSymbols(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const out: string[] = []
  for (const n of names) if (/^[A-Z0-9]{3,20}$/.test(n) && (await earliestRawHour(dir, n)) !== null) out.push(n)
  return out
}

/** Strong zones from the grid: the top rows merged into bands, each with its reactions to price. */
function zoneBands(
  data: MinuteRow[],
  g: { t0: number; colMs: number; cols: number; lo: number; step: number; rows: number; mid?: number | null; cells: { row: number; value: number }[] },
  p: HeatParams,
): { lo: number; hi: number; centre: number; usd: number; touches: number; reactions: number; reactCols: [number, number][] }[] {
  if (p.zones <= 0 || g.cells.length === 0) return []
  const totals = new Map<number, number>()
  for (const c of g.cells) totals.set(c.row, (totals.get(c.row) ?? 0) + c.value)
  // Zones a trader can act on are near the latest price: only levels within 3% of the last mid are ranked.
  const mid = g.mid ?? null
  const near = [...totals.entries()].filter(([row]) => mid === null || Math.abs(g.lo + (row + 0.5) * g.step - mid) <= mid * 0.03)
  const top = near.sort((a, b) => b[1] - a[1]).slice(0, p.zones).map(([row]) => row)
  return mergeRows(top, 2).map((rows) => {
    const row0 = Math.min(...rows)
    const row1 = Math.max(...rows)
    const lo = g.lo + row0 * g.step
    const hi = g.lo + (row1 + 1) * g.step
    const usd = rows.reduce((s, r) => s + (totals.get(r) ?? 0), 0) / Math.max(1, g.cols)
    // Reaction: price leaves the zone by 0.15% within 15 minutes of touching it.
    const rx = zoneReactions(data, lo, hi, { reactPct: 0.0015, windowMin: 15 })
    const byCol = new Map<number, number>()
    for (const m of rx.reactMs) {
      const col = Math.min(g.cols - 1, Math.max(0, Math.floor((m - g.t0) / g.colMs)))
      byCol.set(col, (byCol.get(col) ?? 0) + 1)
    }
    return { lo, hi, centre: (lo + hi) / 2, usd, touches: rx.touches, reactions: rx.reactions, reactCols: [...byCol.entries()] }
  })
}
