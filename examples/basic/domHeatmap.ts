// DOM Heatmap — resting limit orders over time, drawn behind the candles, in the spirit of
// DeepCharts' DeepDOM heatmap. Each column is a slice of time, each row a price band, and a
// cell's brightness is the average resting size (USD) that stood there in that slice.
// Green = resting buy limits (below mid), purple = resting sell limits (above mid).
//
// Data: Delta's public depth feed (subscribeDepth), sampled every 500 ms and kept for one hour
// while the indicator is on. The feed only sends the top levels, so the picture shows the book
// near the touch, not the whole ladder. Exchanges don't publish past books, so history starts
// when the indicator is turned on. Math: src/overlays/domHeatmapModel.ts.
//
// This is separate from GEX Heatmap (gexDeep.ts), which shows dealer gamma by strike from options.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import type { DepthSnapshot } from '../../src/data/types'
import { buildHeatGrid, type BookSnap, type HeatGrid } from '../../src/overlays/domHeatmapModel'
import { PALETTE, COL, colorOpts } from './flyingCpr'
import { rgba, type Rect } from './canvasPlot'
import type { CanvasIndicatorContext } from './shankyCombo'

const SAMPLE_MS = 500
const KEEP_MS = 60 * 60_000
const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

// ---------------------------------------------------------------------------
// Sampler: one depth subscription per symbol, shared by every chart pane
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
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
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
    num('history', 'History (minutes, max 60)', 60, G_TIME, 5, 60, 1),
    num('colSec', 'Column width (seconds)', 5, G_TIME, 1, 60, 1),
    num('rows', 'Price rows', 60, G_PRICE, 10, 200, 1),
    num('rangePct', 'Price band (± % of mid)', 1.5, G_PRICE, 0.2, 5, 0.1),
    num('minUsd', 'Ignore resting size below (USD)', 0, G_PRICE, 0, 1_000_000, 100),
    num('opacity', 'Strongest cell opacity (%)', 85, 'Display', 10, 100, 1),
    colour('bidColor', 'Buy limits (below mid)', 'Green'),
    colour('askColor', 'Sell limits (above mid)', 'Purple'),
  ],
  compute: () => [],
}

export interface DomHeatmapModel {
  grid: HeatGrid | null
  opacity: number
  bidColor: string
  askColor: string
  waiting: string
  /** Shown under the waiting line: e.g. why the history isn't there. */
  note: string
}

const hexOf = (idx: number, fallback: string): string => (PALETTE[idx] ? PALETTE[idx][1] : fallback)

// ---------------------------------------------------------------------------
// History: the recorder on the instance serves the recorded book as a grid (/book/heat).
// Refreshed every 15 s per setting set. If it can't be reached (e.g. a local dev page with no
// recorder), the live sampler above is used and a note says so.
// ---------------------------------------------------------------------------
const HISTORY_EVERY_MS = 15_000

interface HistoryResponse {
  t0: number
  colMs: number
  cols: number
  lo: number
  step: number
  rows: number
  scale: number
  cells: [number, number, number, number][]
  snapCount: number
  mid: number | null
}
interface HistoryState {
  at: number
  inflight: boolean
  grid: HeatGrid | null
  error: string | null
}
const histories = new Map<string, HistoryState>()

/** Base address of the recorder. Empty = same origin (nginx proxies /book/ on the instance). */
function bookBase(): string {
  const g = globalThis as { CANDL_BOOK_URL?: string }
  return typeof g.CANDL_BOOK_URL === 'string' ? g.CANDL_BOOK_URL : ''
}

function historyFor(symbol: string, p: Record<string, number>, now: number): HistoryState {
  const historyMin = Math.max(5, Math.min(60, Math.round(p.history ?? 60)))
  const key = [symbol, historyMin, p.colSec, p.rows, p.rangePct, p.minUsd].join('|')
  let st = histories.get(key)
  if (!st) {
    st = { at: 0, inflight: false, grid: null, error: null }
    histories.set(key, st)
  }
  if (!st.inflight && now - st.at > HISTORY_EVERY_MS) {
    const entry = st
    entry.inflight = true
    const qs = new URLSearchParams({
      symbol,
      from: String(now - historyMin * 60_000),
      to: String(now),
      colSec: String(Math.max(1, p.colSec ?? 5)),
      rows: String(Math.max(10, Math.round(p.rows ?? 60))),
      rangePct: String(Math.max(0.2, p.rangePct ?? 1.5)),
      minUsd: String(Math.max(0, p.minUsd ?? 0)),
    })
    fetch(`${bookBase()}/book/heat?${qs.toString()}`)
      .then(async (r) => {
        const j = (await r.json()) as HistoryResponse & { error?: string }
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
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
        entry.error = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        entry.at = Date.now()
        entry.inflight = false
      })
  }
  return st
}

export function computeDomHeatmapModel(_candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): DomHeatmapModel {
  const now = Date.now()
  const base: DomHeatmapModel = {
    grid: null,
    opacity: Math.max(10, Math.min(100, p.opacity ?? 85)) / 100,
    bidColor: hexOf(Math.round(p.bidColor ?? (COL as Record<string, number>).Green), '#4CAF50'),
    askColor: hexOf(Math.round(p.askColor ?? (COL as Record<string, number>).Purple), '#9C27B0'),
    waiting: '',
    note: '',
  }
  const hist = historyFor(ctx.symbol, p, now)
  if (hist.grid && !hist.error) return { ...base, grid: hist.grid }

  const feed = feeds.get(ctx.symbol)
  const last = feed?.snaps[feed.snaps.length - 1]
  const note = hist.error ? `History unavailable (${hist.error}); showing live samples since this chart opened` : ''
  if (!feed || !last) return { ...base, note, waiting: '⏳ Sampling the order book…' }
  const bestBid = last.bids[0]?.[0]
  const bestAsk = last.asks[0]?.[0]
  if (!(bestBid > 0) || !(bestAsk > 0)) return { ...base, note, waiting: '⚠ No book on the feed yet' }
  const mid = (bestBid + bestAsk) / 2
  const historyMs = Math.max(5, Math.min(60, p.history ?? 60)) * 60_000
  const grid = buildHeatGrid(feed.snaps, {
    now,
    historyMs,
    colMs: Math.max(1, p.colSec ?? 5) * 1000,
    mid,
    rangePct: Math.max(0.002, (p.rangePct ?? 1.5) / 100),
    rows: Math.max(10, Math.round(p.rows ?? 60)),
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
    for (const c of grid.cells) {
      const t = grid.t0 + c.col * grid.colMs
      const x0 = conv.timeToX(t)
      const x1 = conv.timeToX(t + grid.colMs)
      if (x1 < rect.x || x0 > right) continue
      const yTop = conv.priceToY(grid.lo + (c.row + 1) * grid.step)
      const yBot = conv.priceToY(grid.lo + c.row * grid.step)
      const a = m.opacity * Math.min(1, c.value / grid.scale)
      g.fillStyle = rgba(c.bid ? m.bidColor : m.askColor, Math.max(0.05, a))
      g.fillRect(x0, Math.min(yTop, yBot), Math.max(1, x1 - x0), Math.max(1, Math.abs(yBot - yTop) - 0.5))
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
