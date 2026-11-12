// DOM Heatmap — resting limit orders over time, drawn behind the candles, in the spirit of
// DeepCharts' DeepDOM heatmap. Each column is a slice of time, each row an absolute price band, and a
// band's brightness is the resting size (USD) that stood there. Only the strongest price levels are
// drawn, as continuous bands with their size on the right edge.
// Green = resting buy limits, purple = resting sell limits.
//
// History: the recorder on the instance keeps a one-minute summary of the recorded book (heatRollup.ts)
// and serves it as /book/heat, covering everything recorded (up to 21 days). When that can't be reached
// (e.g. a local dev page with no recorder), the chart uses the live depth feed from the last hour
// instead, and a note says so.
//
// This is separate from GEX Heatmap (gexDeep.ts), which shows dealer gamma by strike from options.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import type { DepthSnapshot } from '../../src/data/types'
import { bandRuns, buildHeatGrid, levelLabels, strongRows, type BookSnap, type HeatGrid } from '../../src/overlays/domHeatmapModel'
import { PALETTE, COL, colorOpts } from './flyingCpr'
import { rgba, type Rect } from './canvasPlot'
import type { CanvasIndicatorContext } from './shankyCombo'

const SAMPLE_MS = 500
const KEEP_MS = 60 * 60_000
const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const HISTORY_EVERY_MS = 30_000
const HISTORY_COLUMNS = 600

// ---------------------------------------------------------------------------
// Live sampler (fallback): one depth subscription per symbol, shared by every chart pane
// ---------------------------------------------------------------------------
export interface DepthSource {
  subscribeDepth(symbol: string, onDepth: (depth: DepthSnapshot) => void): () => void
}

interface Feed {
  snaps: BookSnap[]
  lastAt: number
}
const feeds = new Map<string, Feed>()

/** Starts sampling the book for `symbol` (once). Safe to call on every render. */
export function ensureDomHeatFeed(symbol: string, src: DepthSource): void {
  if (feeds.has(symbol)) return
  const feed: Feed = { snaps: [], lastAt: 0 }
  feeds.set(symbol, feed)
  src.subscribeDepth(symbol, (d) => {
    const now = Date.now()
    if (now - feed.lastAt < SAMPLE_MS) return
    feed.lastAt = now
    feed.snaps.push({ t: now, bids: d.bids, asks: d.asks })
    const cut = now - KEEP_MS
    while (feed.snaps.length && feed.snaps[0].t < cut) feed.snaps.shift()
  })
}

// ---------------------------------------------------------------------------
// Indicator
// ---------------------------------------------------------------------------
const num = (key: string, label: string, def: number, group: string, min: number, max: number, step: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
const pick = (key: string, label: string, def: number, group: string, options: { value: number; label: string }[]): IndicatorParam => ({ key, label, default: def, group, options })
const colour = (key: string, label: string, name: string): IndicatorParam => pick(key, label, (COL as Record<string, number>)[name] ?? 0, 'Colours', colorOpts)

const G_TIME = 'Time'
const G_PRICE = 'Price'

export const domHeatmap: IndicatorDef = {
  id: 'dom_heatmap',
  label: 'DOM Heatmap — resting orders over time (Delta book)',
  shortLabel: 'DOM Heatmap',
  placement: 'overlay',
  params: [
    pick('range', 'History shown', 60, G_TIME, [
      { value: 60, label: 'Last hour' },
      { value: 360, label: 'Last 6 hours' },
      { value: 1440, label: 'Last day' },
      { value: 10080, label: 'Last 7 days' },
      { value: 30240, label: 'Last 21 days (all recorded)' },
    ]),
    num('rows', 'Price rows (max)', 200, G_PRICE, 10, 400, 1),
    num('minUsd', 'Ignore resting size below (USD)', 0, G_PRICE, 0, 1_000_000, 100),
    num('levels', 'Strongest price levels shown', 6, G_PRICE, 1, 40, 1),
    num('transparency', 'Transparency (%, higher = fainter)', 65, 'Display', 0, 95, 1),
    colour('bidColor', 'Buy limits', 'Green'),
    colour('askColor', 'Sell limits', 'Purple'),
  ],
  compute: () => [],
}

export interface DomHeatmapModel {
  grid: HeatGrid | null
  opacity: number
  /** Price rows to draw (the strongest levels); null = every row. */
  keep: Set<number> | null
  bidColor: string
  askColor: string
  waiting: string
  /** Shown under the waiting line: e.g. why the history isn't there. */
  note: string
}

const hexOf = (idx: number, fallback: string): string => (PALETTE[idx] ? PALETTE[idx][1] : fallback)
/** Resting size in compact form: 995, 12.4K, 1.3M. */
const fmtUsd = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : `${Math.round(v)}`)

// ---------------------------------------------------------------------------
// History from the recorder (/book/heat on the instance)
// ---------------------------------------------------------------------------
interface HistoryResponse {
  t0: number
  colMs: number
  cols: number
  lo: number
  step: number
  rows: number
  scale: number
  cells: [number, number, number, number][]
  mid: number | null
  minutes: number
  error?: string
}
interface HistoryState {
  at: number
  inflight: boolean
  grid: HeatGrid | null
  minutes: number
  error: string | null
}
const histories = new Map<string, HistoryState>()

let onUpdate: (() => void) | null = null
/** Called whenever a history refresh lands, so the chart can redraw the backdrop. */
export function onDomHeatUpdate(fn: (() => void) | null): void {
  onUpdate = fn
}

/** Base address of the recorder. Empty = same origin (nginx proxies /book/ on the instance). */
function bookBase(): string {
  const g = globalThis as { CANDL_BOOK_URL?: string }
  return typeof g.CANDL_BOOK_URL === 'string' ? g.CANDL_BOOK_URL : ''
}

function historyFor(symbol: string, p: Record<string, number>, now: number): HistoryState {
  const rangeMin = Math.max(60, Math.round(p.range ?? 60))
  const rows = Math.max(10, Math.round(p.rows ?? 200))
  const minUsd = Math.max(0, p.minUsd ?? 0)
  const key = [symbol, rangeMin, rows, minUsd].join('|')
  let st = histories.get(key)
  if (!st) {
    st = { at: 0, inflight: false, grid: null, minutes: 0, error: null }
    histories.set(key, st)
  }
  if (!st.inflight && now - st.at > HISTORY_EVERY_MS) {
    const entry = st
    entry.inflight = true
    const qs = new URLSearchParams({
      symbol,
      from: String(now - rangeMin * 60_000),
      to: String(now),
      cols: String(HISTORY_COLUMNS),
      rows: String(rows),
      minUsd: String(minUsd),
    })
    fetch(`${bookBase()}/book/heat?${qs.toString()}`)
      .then(async (r) => {
        const j = (await r.json()) as HistoryResponse
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
        entry.minutes = j.minutes
        entry.grid = {
          t0: j.t0,
          colMs: j.colMs,
          cols: j.cols,
          lo: j.lo,
          step: j.step,
          rows: j.rows,
          scale: j.scale,
          cells: j.cells.map(([col, row, bid, value]) => ({ col, row, bid: bid === 1, value })),
        }
        entry.error = null
      })
      .catch((err: unknown) => {
        // A dev page has no /book/heat: the response is the page HTML, which fails to parse as JSON.
        entry.error = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        entry.at = Date.now()
        entry.inflight = false
        onUpdate?.()
      })
  }
  return st
}

export function computeDomHeatmapModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): DomHeatmapModel {
  const m = computeGridModel(candles, p, ctx)
  // Only the strongest levels are drawn: a few bands, not every price row.
  return m.grid ? { ...m, keep: strongRows(m.grid, Math.max(1, Math.round(p.levels ?? 6))) } : m
}

function computeGridModel(_candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): DomHeatmapModel {
  const now = Date.now()
  const base: DomHeatmapModel = {
    grid: null,
    opacity: (100 - Math.max(0, Math.min(95, p.transparency ?? 65))) / 100,
    keep: null,
    bidColor: hexOf(Math.round(p.bidColor ?? (COL as Record<string, number>).Green), '#4CAF50'),
    askColor: hexOf(Math.round(p.askColor ?? (COL as Record<string, number>).Purple), '#9C27B0'),
    waiting: '',
    note: '',
  }
  const hist = historyFor(ctx.symbol, p, now)
  if (hist.grid && !hist.error) {
    const note = hist.minutes === 0 ? 'No recorded book in this range yet' : ''
    return { ...base, grid: hist.grid, note }
  }

  // Fallback: the live samples since this chart opened, last hour, around the current mid.
  const feed = feeds.get(ctx.symbol)
  const last = feed?.snaps[feed.snaps.length - 1]
  const note = hist.error ? `History not available here (${hist.error}); showing the live samples since this chart opened` : ''
  if (!feed || !last) return { ...base, note, waiting: '⏳ Sampling the order book…' }
  const bestBid = last.bids[0]?.[0]
  const bestAsk = last.asks[0]?.[0]
  if (!(bestBid > 0) || !(bestAsk > 0)) return { ...base, note, waiting: '⚠ No book on the feed yet' }
  const mid = (bestBid + bestAsk) / 2
  const grid = buildHeatGrid(feed.snaps, {
    now,
    historyMs: 60 * 60_000,
    colMs: 5_000,
    mid,
    rangePct: 0.015,
    rows: Math.max(10, Math.min(200, Math.round(p.rows ?? 200))),
    minUsd: Math.max(0, p.minUsd ?? 0),
  })
  return { ...base, grid, note }
}

export function drawDomHeatmap(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: DomHeatmapModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  const right = rect.x + rect.width
  if (m.grid) {
    const grid = m.grid
    const rows = m.keep ?? new Set(grid.cells.map((c) => c.row))
    // One band per stretch of time where a strong level rested (DeepDOM look), not one block per cell.
    for (const r of bandRuns(grid, rows)) {
      const x0 = conv.timeToX(grid.t0 + r.c0 * grid.colMs)
      const x1 = conv.timeToX(grid.t0 + (r.c1 + 1) * grid.colMs)
      if (x1 < rect.x || x0 > right) continue
      const yTop = conv.priceToY(grid.lo + (r.row + 1) * grid.step)
      const yBot = conv.priceToY(grid.lo + r.row * grid.step)
      g.fillStyle = rgba(r.bid ? m.bidColor : m.askColor, Math.max(0.05, m.opacity * (0.35 + 0.65 * r.intensity)))
      g.fillRect(x0, Math.min(yTop, yBot), Math.max(1, x1 - x0), Math.max(1, Math.abs(yBot - yTop) - 0.5))
    }
    // Size of each strong level, at the right edge (the DeepDOM volume column).
    g.font = FONT
    g.textAlign = 'right'
    g.textBaseline = 'middle'
    for (const l of levelLabels(grid, rows)) {
      const y = conv.priceToY(grid.lo + (l.row + 0.5) * grid.step)
      if (y < rect.y || y > rect.y + rect.height) continue
      g.fillStyle = rgba(l.bid ? m.bidColor : m.askColor, 0.95)
      g.fillText(fmtUsd(l.usd), right - 6, y)
    }
  }
  if (m.waiting) {
    g.font = FONT
    g.fillStyle = '#9aa3b2'
    g.textAlign = 'right'
    g.textBaseline = 'top'
    g.fillText(m.waiting, right - 8, rect.y + 8)
  }
  if (m.note) {
    g.font = FONT
    g.fillStyle = 'rgba(255, 193, 7, 0.9)'
    g.textAlign = 'right'
    g.textBaseline = 'top'
    g.fillText(m.note, right - 8, rect.y + 22)
  }
  g.restore()
}
