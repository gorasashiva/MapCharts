/**
 * Measure tools, styled like a measuring tape: translucent box + arrow +
 * centered label chip (12px text).
 *
 * - pricerange: vertical Δprice / Δ% (green up, red down)
 * - daterange:  bar count + humanized elapsed time
 * - sigmatape:  data-aware — %, bars, ATR multiples, historical percentile
 */
import type { Candle } from '../core/types'
import type { Drawing, ToolImpl } from './types'
import type { Pt } from './helpers'
import {
  atrAt,
  drawChip,
  drawHandles,
  fillDot,
  formatSignedPercent,
  formatSignedPrice,
  humanizeDuration,
  nBarMovePercentile,
  ordinal,
  pointInBox,
  strokeArrow,
  toXY,
  withAlpha,
} from './helpers'

const BOX_FILL_ALPHA = 0.08
const BOX_BORDER_ALPHA = 0.35
const UP_COLOR = '#089981'
const DOWN_COLOR = '#f23645'

/** Direction color for price-delta measures: green up / red down. */
function dirColor(d: Drawing): string {
  return (d.points[1]?.price ?? d.points[0].price) >= d.points[0].price ? UP_COLOR : DOWN_COLOR
}

interface PercentileCacheEntry {
  candlesRef: Candle[]
  candlesLen: number
  lastClose: number
  bars: number
  absPct: number
  result: number | null
}

const percentileCache = new WeakMap<Drawing, PercentileCacheEntry>()

/**
 * Cached wrapper around nBarMovePercentile() — an O(candles.length) full-
 * history scan that render() otherwise re-runs on EVERY repaint frame for
 * every sigma-tape drawing on screen, regardless of viewport or whether
 * anything actually changed. Keyed per drawing instance; a cache hit still
 * requires the same bars/absPct (which move continuously while the user is
 * actively dragging the tape, so this doesn't help mid-drag — only once the
 * drawing is settled and other frame activity, e.g. panning or live ticks
 * elsewhere on the chart, would otherwise keep re-scanning it for nothing).
 */
function nBarMovePercentileCached(d: Drawing, candles: Candle[], bars: number, absPct: number): number | null {
  const last = candles.length > 0 ? candles[candles.length - 1] : null
  const cached = percentileCache.get(d)
  if (
    cached &&
    cached.candlesRef === candles &&
    cached.candlesLen === candles.length &&
    cached.bars === bars &&
    cached.absPct === absPct &&
    (last === null || cached.lastClose === last.close)
  ) {
    return cached.result
  }
  const result = nBarMovePercentile(candles, bars, absPct)
  percentileCache.set(d, {
    candlesRef: candles,
    candlesLen: candles.length,
    lastClose: last ? last.close : NaN,
    bars,
    absPct,
    result,
  })
  return result
}

/** Tape body: translucent fill + thin dashed border over the p0/p1 box. */
function drawTapeBox(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, color: string): void {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const w = Math.abs(b.x - a.x)
  const h = Math.abs(b.y - a.y)
  ctx.fillStyle = withAlpha(ctx, color, BOX_FILL_ALPHA)
  ctx.fillRect(x, y, w, h)
  ctx.save()
  ctx.setLineDash([4, 4])
  ctx.lineWidth = 1
  ctx.strokeStyle = withAlpha(ctx, color, BOX_BORDER_ALPHA)
  ctx.strokeRect(x, y, w, h)
  ctx.restore()
}

/** Signed % change from p0 to p1, or null when undefined (p0.price <= 0). */
function pctChange(d: Drawing): number | null {
  const from = d.points[0].price
  const to = d.points[1].price
  if (!(Math.abs(from) > 0)) return null
  const pct = ((to - from) / Math.abs(from)) * 100
  return isFinite(pct) ? pct : null
}

function barCount(d: Drawing, barMs: number): number {
  if (!(barMs > 0)) return 0
  return Math.round(Math.abs(d.points[1].time - d.points[0].time) / barMs)
}

function barsLabel(n: number): string {
  return n === 1 ? '1 bar' : `${n} bars`
}

const pricerange: ToolImpl = {
  id: 'pricerange',
  label: 'Price Range',
  group: 'measure',
  pointsNeeded: 2,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    if (!d.points[1]) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, d.points[1])
    const color = dirColor(d)
    drawTapeBox(ctx, a, b, color)

    // Vertical double-headed arrow down the middle of the box.
    const cx = (a.x + b.x) / 2
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = Math.max(1, d.width)
    strokeArrow(ctx, cx, a.y, cx, b.y, 7, true)

    const delta = d.points[1].price - d.points[0].price
    const pct = pctChange(d)
    const deltaTxt = formatSignedPrice(delta, env.pricePrecision)
    const label = pct === null ? `Δ ${deltaTxt}` : `Δ ${deltaTxt}  (${formatSignedPercent(pct)})`
    drawChip(ctx, cx, (a.y + b.y) / 2, [label], color)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    return pointInBox(x, y, toXY(conv, d.points[0]), toXY(conv, d.points[1]), 6)
  },
}

const daterange: ToolImpl = {
  id: 'daterange',
  label: 'Date Range',
  group: 'measure',
  pointsNeeded: 2,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    if (!d.points[1]) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, d.points[1])
    drawTapeBox(ctx, a, b, d.color)

    // Horizontal arrow across the middle, head pointing toward p1.
    const cy = (a.y + b.y) / 2
    ctx.strokeStyle = d.color
    ctx.fillStyle = d.color
    ctx.lineWidth = Math.max(1, d.width)
    strokeArrow(ctx, a.x, cy, b.x, cy, 7, false)

    const dt = Math.abs(d.points[1].time - d.points[0].time)
    const label = `${barsLabel(barCount(d, env.barMs))} · ${humanizeDuration(dt)}`
    drawChip(ctx, (a.x + b.x) / 2, cy, [label], d.color)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    return pointInBox(x, y, toXY(conv, d.points[0]), toXY(conv, d.points[1]), 6)
  },
}

const sigmatape: ToolImpl = {
  id: 'sigmatape',
  label: 'Sigma Tape',
  group: 'measure',
  pointsNeeded: 2,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    if (!d.points[1]) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, d.points[1])
    const color = dirColor(d)
    drawTapeBox(ctx, a, b, color)

    // Diagonal arrow along the measured move.
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = Math.max(1, d.width)
    strokeArrow(ctx, a.x, a.y, b.x, b.y, 7, false)

    const pct = pctChange(d)
    const bars = barCount(d, env.barMs)
    const line1 =
      pct === null ? barsLabel(bars) : `${formatSignedPercent(pct)} · ${barsLabel(bars)}`

    // Data-aware context: how big is this move in ATRs, and how rare is an
    // n-bar move of this size historically?
    const parts: string[] = []
    const atr = atrAt(env.candles, Math.max(d.points[0].time, d.points[1].time), 14)
    const deltaAbs = Math.abs(d.points[1].price - d.points[0].price)
    if (atr !== null && atr > 0) parts.push(`${(deltaAbs / atr).toFixed(1)}× ATR`)
    if (pct !== null) {
      const pctile = nBarMovePercentileCached(d, env.candles, bars, Math.abs(pct))
      if (pctile !== null) parts.push(`${ordinal(pctile)} %ile`)
    }

    const lines = parts.length > 0 ? [line1, parts.join(' · ')] : [line1]
    drawChip(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, lines, color)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    return pointInBox(x, y, toXY(conv, d.points[0]), toXY(conv, d.points[1]), 6)
  },
}

export const MEASURE_IMPLS: ToolImpl[] = [pricerange, daterange, sigmatape]
