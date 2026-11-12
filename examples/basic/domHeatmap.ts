// DOM Heatmap — every price level's resting liquidity over time, as a liquidity heat map behind the
// candles (the look of the liquidity heat map reference: a navy → blue → yellow → orange → red ramp over
// price × time). The strongest levels are marked as zones with their price and size.
// Trade bubbles and the best bid / ask line can be switched on or off.
//
// History: the instance recorder keeps a one-minute summary of Delta's recorded book for gold, BTC and
// ETH (heatRollup.ts) and serves it as /book/heat, up to 21 days. Columns are the chart's own timeframe,
// so the strips line up on 1m, 5m, 1h and so on. When the recorder can't be reached (e.g. a local dev
// page), the chart shows the live depth samples from the last hour instead, and a note says so.
//
// This is separate from GEX Heatmap (gexDeep.ts), which shows dealer gamma by strike from options.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import type { DepthSnapshot } from '../../src/data/types'
import { buildHeatGrid, type BookSnap, type HeatGrid } from '../../src/overlays/domHeatmapModel'
import type { GridBbo, GridTrade } from '../../src/overlays/bookHeatRollup'
import { PALETTE, COL, colorOpts } from './flyingCpr'
import { rgba, type Rect } from './canvasPlot'
import type { CanvasIndicatorContext } from './shankyCombo'

const SAMPLE_MS = 500
const KEEP_MS = 60 * 60_000
const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const HISTORY_EVERY_MS = 30_000
const HISTORY_COLUMNS = 2000
const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

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
const onOff = (key: string, label: string, def: number, group: string): IndicatorParam =>
  pick(key, label, def, group, [
    { value: 0, label: 'Off' },
    { value: 1, label: 'On' },
  ])

const G_TIME = 'Time'
const G_PRICE = 'Price'

export const domHeatmap: IndicatorDef = {
  id: 'dom_heatmap',
  label: 'DOM Heatmap — liquidity heat map of resting orders (Delta book)',
  shortLabel: 'DOM Heatmap',
  placement: 'overlay',
  params: [
    pick('range', 'History shown', 576000, G_TIME, [
      { value: 60, label: 'Last hour' },
      { value: 360, label: 'Last 6 hours' },
      { value: 1440, label: 'Last day' },
      { value: 10080, label: 'Last 7 days' },
      { value: 576000, label: 'All recorded (everything the recorder has kept)' },
    ]),
    num('rows', 'Price rows (max)', 300, G_PRICE, 20, 400, 1),
    num('minUsd', 'Ignore resting size below (USD)', 0, G_PRICE, 0, 1_000_000, 100),
    num('levels', 'Zones marked (highest resting levels)', 6, G_PRICE, 0, 40, 1),
    num('transparency', 'Transparency (%, higher = fainter)', 25, 'Display', 0, 95, 1),
    onOff('showBbo', 'Best bid / ask line', 1, 'Display'),
    onOff('showTrades', 'Trade bubbles', 1, 'Display'),
    colour('bidColor', 'Buy limits (bubbles, lines)', 'Green'),
    colour('askColor', 'Sell limits (bubbles, lines)', 'Purple'),
  ],
  compute: () => [],
}

/** A strong zone: neighbouring high-liquidity price levels merged, with how often price touched and reacted to it. */
export interface ZoneBand {
  lo: number
  hi: number
  usd: number
  touches: number
  reactions: number
}

export interface DomHeatmapModel {
  grid: HeatGrid | null
  /** 0..1 overall opacity of the heat map. */
  opacity: number
  /** Strong zones (merged strongest levels), from the recorder. */
  zoneBands: ZoneBand[]
  /** Reaction markers: [column, zone centre price, count]. */
  reacts: [number, number, number][]
  bidColor: string
  askColor: string
  waiting: string
  /** Shown under the waiting line: e.g. why the history isn't there. */
  note: string
  trades: GridTrade[]
  bbo: GridBbo[]
  showTrades: boolean
  showBbo: boolean
}

const hexOf = (idx: number, fallback: string): string => (PALETTE[idx] ? PALETTE[idx][1] : fallback)
/** Resting size in compact form: 995, 12.4K, 1.3M. */
const fmtUsd = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : `${Math.round(v)}`)
const fmtPrice = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: 2 })

/** Chart interval ('1m', '5m', '1h', 'D', …) as milliseconds. */
export function intervalMs(iv: string | undefined): number {
  if (!iv) return MINUTE_MS
  if (iv === 'D' || iv === '1D') return DAY_MS
  const m = /^(\d+)([mhdw])$/i.exec(iv)
  if (!m) return MINUTE_MS
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  return n * (unit === 'm' ? MINUTE_MS : unit === 'h' ? 60 * MINUTE_MS : unit === 'd' ? DAY_MS : 7 * DAY_MS)
}

// The reference's ramp: navy (thin) → blue → light → yellow → orange → red (heaviest).
const RAMP: [number, [number, number, number]][] = [
  [0, [8, 12, 40]],
  [0.15, [20, 50, 160]],
  [0.35, [40, 140, 255]],
  [0.55, [235, 240, 245]],
  [0.7, [255, 225, 60]],
  [0.85, [255, 140, 0]],
  [1, [255, 30, 30]],
]
function rampAt(t: number): [number, number, number] {
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i]
    const [t0, c0] = RAMP[i - 1]
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0)
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f]
    }
  }
  return RAMP[RAMP.length - 1][1]
}

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
  trades: [number, number, number, number, number][]
  bbo: [number, number, number][]
  zones: ZoneBand[]
  reacts: [number, number, number][]
  error?: string
}
interface HistoryState {
  at: number
  inflight: boolean
  grid: HeatGrid | null
  minutes: number
  trades: GridTrade[]
  bbo: GridBbo[]
  zoneBands: ZoneBand[]
  reacts: [number, number, number][]
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

function historyFor(symbol: string, p: Record<string, number>, now: number, colMs: number): HistoryState {
  const rangeMin = Math.max(60, Math.round(p.range ?? 60))
  const rows = Math.max(20, Math.round(p.rows ?? 300))
  const minUsd = Math.max(0, p.minUsd ?? 0)
  const zoneCount = Math.max(0, Math.round(p.levels ?? 6))
  const key = [symbol, rangeMin, rows, minUsd, colMs, zoneCount].join('|')
  let st = histories.get(key)
  if (!st) {
    st = { at: 0, inflight: false, grid: null, minutes: 0, trades: [], bbo: [], zoneBands: [], reacts: [], error: null }
    histories.set(key, st)
  }
  if (!st.inflight && now - st.at > HISTORY_EVERY_MS) {
    const entry = st
    entry.inflight = true
    const qs = new URLSearchParams({
      symbol,
      from: String(now - rangeMin * MINUTE_MS),
      to: String(now),
      cols: String(HISTORY_COLUMNS),
      colMs: String(colMs),
      rows: String(rows),
      minUsd: String(minUsd),
      zones: String(Math.max(0, Math.round(zoneCount))),
    })
    fetch(`${bookBase()}/book/heat?${qs.toString()}`)
      .then(async (r) => {
        const j = (await r.json()) as HistoryResponse
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
        entry.minutes = j.minutes
        entry.zoneBands = j.zones ?? []
        entry.reacts = j.reacts ?? []
        entry.trades = (j.trades ?? []).map(([col, row, buy, sell, n]) => ({ col, row, buy, sell, n }))
        entry.bbo = (j.bbo ?? []).map(([col, bid, ask]) => ({ col, bid, ask }))
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
  const now = Date.now()
  const colMs = intervalMs(ctx.interval)
  const base: DomHeatmapModel = {
    grid: null,
    opacity: (100 - Math.max(0, Math.min(95, p.transparency ?? 25))) / 100,
    zoneBands: [],
    reacts: [],
    bidColor: hexOf(Math.round(p.bidColor ?? (COL as Record<string, number>).Green), '#4CAF50'),
    askColor: hexOf(Math.round(p.askColor ?? (COL as Record<string, number>).Purple), '#9C27B0'),
    waiting: '',
    note: '',
    trades: [],
    bbo: [],
    showTrades: (p.showTrades ?? 1) !== 0,
    showBbo: (p.showBbo ?? 1) !== 0,
  }
  const hist = historyFor(ctx.symbol, p, now, colMs)
  if (hist.grid && !hist.error) {
    const note = hist.minutes === 0 ? 'No recorded book in this range yet' : ''
    const grid = hist.grid
    return { ...base, grid, note, trades: hist.trades, bbo: hist.bbo, zoneBands: hist.zoneBands, reacts: hist.reacts }
  }
  void candles

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
    rows: Math.max(20, Math.min(400, Math.round(p.rows ?? 300))),
    minUsd: Math.max(0, p.minUsd ?? 0),
  })
  return { ...base, grid, note }
}

// ---------------------------------------------------------------------------
// Drawing: one raster of the whole grid (every level, every column), stretched over the chart's
// time and price range, so the strips are soft like the reference. Built once per grid.
// ---------------------------------------------------------------------------
const rasters = new WeakMap<HeatGrid, { opacity: number; canvas: HTMLCanvasElement | null }>()

function rasterOf(grid: HeatGrid, opacity: number): HTMLCanvasElement | null {
  const cached = rasters.get(grid)
  if (cached && cached.opacity === opacity) return cached.canvas
  let canvas: HTMLCanvasElement | null = null
  if (typeof document !== 'undefined' && grid.cols > 0 && grid.rows > 0) {
    canvas = document.createElement('canvas')
    canvas.width = grid.cols
    canvas.height = grid.rows
    const c2 = canvas.getContext('2d')
    if (c2) {
      // value per (column, row), both sides together: a level is liquidity whichever side it sits on
      const total = new Map<number, number>()
      for (const c of grid.cells) {
        const key = c.col * grid.rows + c.row
        total.set(key, (total.get(key) ?? 0) + c.value)
      }
      const img = c2.createImageData(grid.cols, grid.rows)
      const data = img.data
      for (const [key, value] of total) {
        const x = Math.floor(key / grid.rows)
        const row = key % grid.rows
        const y = grid.rows - 1 - row // price increases upwards
        const t = Math.min(1, Math.pow(value / grid.scale, 0.7)) // gamma 0.7, as in the reference
        if (t < 0.04) continue // faint cells are left out
        const [r, gr, b] = rampAt(t)
        const i = (y * grid.cols + x) * 4
        data[i] = r
        data[i + 1] = gr
        data[i + 2] = b
        data[i + 3] = Math.round(255 * Math.min(1, 0.25 + t))
      }
      c2.putImageData(img, 0, 0)
    }
  }
  rasters.set(grid, { opacity, canvas })
  return canvas
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
    const raster = rasterOf(grid, m.opacity)
    if (raster) {
      const x0 = conv.timeToX(grid.t0)
      const x1 = conv.timeToX(grid.t0 + grid.cols * grid.colMs)
      const yTop = conv.priceToY(grid.lo + grid.rows * grid.step)
      const yBot = conv.priceToY(grid.lo)
      g.imageSmoothingEnabled = true
      g.imageSmoothingQuality = 'high'
      g.drawImage(raster, x0, yTop, x1 - x0, yBot - yTop)
    }

    // Zones: merged strong levels as a soft band, with a dashed centre line, their size, and how often
    // price reacted to them (reacted N/M = N of M touches were followed by a move away).
    g.font = FONT
    const labelled: number[] = []
    for (const z of [...m.zoneBands].sort((a, b) => b.usd - a.usd)) {
      const yTop = conv.priceToY(z.hi)
      const yBot = conv.priceToY(z.lo)
      if (Math.max(yTop, yBot) < rect.y || Math.min(yTop, yBot) > rect.y + rect.height) continue
      g.fillStyle = 'rgba(255, 140, 0, 0.10)'
      g.fillRect(rect.x, Math.min(yTop, yBot), rect.width, Math.max(1, Math.abs(yBot - yTop)))
      const y = Math.round((yTop + yBot) / 2) + 0.5
      g.setLineDash([4, 3])
      g.strokeStyle = 'rgba(255, 140, 0, 0.9)'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(rect.x, y)
      g.lineTo(right, y)
      g.stroke()
      g.setLineDash([])
      // Labels of close zones would sit on top of each other: the stronger one keeps its label.
      if (labelled.some((ly) => Math.abs(ly - y) < 12)) continue
      labelled.push(y)
      g.textAlign = 'right'
      g.textBaseline = 'bottom'
      g.fillStyle = 'rgba(255, 224, 138, 0.98)'
      g.fillText(`ZONE ${fmtPrice(z.lo)}–${fmtPrice(z.hi)} · ${fmtUsd(z.usd)} · reacted ${z.reactions}/${z.touches}`, right - 8, y - 2)
    }
    // Reaction markers: where price left a zone within 15 minutes of touching it.
    for (const [col, price, n] of m.reacts) {
      const x = conv.timeToX(grid.t0 + (col + 0.5) * grid.colMs)
      if (x < rect.x || x > right) continue
      g.beginPath()
      g.arc(x, conv.priceToY(price), 3 + Math.min(4, n), 0, Math.PI * 2)
      g.fillStyle = 'rgba(255, 255, 255, 0.9)'
      g.fill()
      g.strokeStyle = 'rgba(255, 140, 0, 1)'
      g.lineWidth = 1.5
      g.stroke()
    }

    const colX = (col: number): number => conv.timeToX(grid.t0 + (col + 0.5) * grid.colMs)
    const rowY = (row: number): number => conv.priceToY(grid.lo + (row + 0.5) * grid.step)
    // Best bid (buy colour) and best ask (sell colour) per column, as lines.
    if (m.showBbo && m.bbo.length > 1) {
      for (const side of ['bid', 'ask'] as const) {
        g.strokeStyle = rgba(side === 'bid' ? m.bidColor : m.askColor, 0.9)
        g.lineWidth = 1.5
        g.beginPath()
        m.bbo.forEach((b, i) => {
          const x = colX(b.col)
          const y = conv.priceToY(b[side])
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        })
        g.stroke()
      }
    }
    // Trades as bubbles: area grows with USD traded, buys in the buy colour, sells in the sell colour.
    if (m.showTrades && m.trades.length) {
      let maxUsd = 1
      for (const t of m.trades) maxUsd = Math.max(maxUsd, t.buy + t.sell)
      for (const t of m.trades) {
        const x = colX(t.col)
        if (x < rect.x || x > right) continue
        const y = rowY(t.row)
        for (const [usd, color] of [
          [t.buy, m.bidColor],
          [t.sell, m.askColor],
        ] as const) {
          if (usd <= 0) continue
          g.beginPath()
          g.arc(x, y, 2 + 12 * Math.sqrt(usd / maxUsd), 0, Math.PI * 2)
          g.fillStyle = rgba(color, 0.55)
          g.fill()
        }
      }
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
