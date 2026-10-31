// avwap — anchored VWAP with ±1σ bands.
//
// One click anchors at the nearest candle; from there forward the tool plots
// the cumulative volume-weighted mean of typical price (H+L+C)/3 plus
// volume-weighted ±1σ bands. computeSeries() is an O(n) pass over the
// anchored span — cached per drawing instance (getSeries()) since render(),
// hitTest() and handleAt() each need it, and hitTest() in particular runs on
// every mousemove: without the cache, moving the mouse over a chart with a
// long-anchored AVWAP would re-run the O(n) pass on every single event.

import type { Candle } from '../../core/types'
import type { Converters, Drawing, ToolImpl } from '../types'
import {
  HANDLE_TOL,
  HIT_TOL,
  distToSegment,
  drawChip,
  drawHandle,
  fmtPrice,
  nearestIndex,
  withAlpha,
} from './helpers'

const BAND_LINE_ALPHA = 0.5
const BAND_FILL_ALPHA = 0.08

interface Series {
  start: number // anchor index into candles
  n: number // candles from anchor to the end (>= 1)
  vwap: Float64Array
  sd: Float64Array
}

function computeSeries(candles: Candle[], anchorTime: number): Series | null {
  const start = nearestIndex(candles, anchorTime)
  if (start < 0) return null
  const n = candles.length - start
  const vwap = new Float64Array(n)
  const sd = new Float64Array(n)
  let pv = 0 // Σ tp·vol
  let pv2 = 0 // Σ tp²·vol
  let vol = 0 // Σ vol
  let tpSum = 0 // fallback for zero-volume spans
  for (let k = 0; k < n; k++) {
    const c = candles[start + k]
    const tp = (c.high + c.low + c.close) / 3
    const v = c.volume > 0 ? c.volume : 0
    pv += tp * v
    pv2 += tp * tp * v
    vol += v
    tpSum += tp
    if (vol > 0) {
      const m = pv / vol
      vwap[k] = m
      sd[k] = Math.sqrt(Math.max(0, pv2 / vol - m * m))
    } else {
      // No volume yet: fall back to the simple mean of typical price.
      vwap[k] = tpSum / (k + 1)
      sd[k] = 0
    }
  }
  return { start, n, vwap, sd }
}

interface SeriesCacheEntry {
  candlesRef: Candle[]
  candlesLen: number
  anchorTime: number
  lastHigh: number
  lastLow: number
  lastClose: number
  lastVolume: number
  series: Series | null
}

const seriesCache = new WeakMap<Drawing, SeriesCacheEntry>()

/**
 * Cached wrapper around computeSeries(), keyed per drawing instance. Drawing
 * objects are replaced (not mutated) on edit — see moveHandle() below — so a
 * stable `d` reference across calls means nothing about the drawing changed;
 * a cache hit still needs the LAST candle's OHLCV to be unchanged too, since
 * candles is mutated in place for live ticks (same array reference/length,
 * different tail values) rather than reassigned.
 */
function getSeries(d: Drawing, candles: Candle[], anchorTime: number): Series | null {
  const last = candles.length > 0 ? candles[candles.length - 1] : null
  const cached = seriesCache.get(d)
  if (
    cached &&
    cached.candlesRef === candles &&
    cached.candlesLen === candles.length &&
    cached.anchorTime === anchorTime &&
    (last === null ||
      (cached.lastHigh === last.high && cached.lastLow === last.low && cached.lastClose === last.close && cached.lastVolume === last.volume))
  ) {
    return cached.series
  }
  const series = computeSeries(candles, anchorTime)
  seriesCache.set(d, {
    candlesRef: candles,
    candlesLen: candles.length,
    anchorTime,
    lastHigh: last ? last.high : NaN,
    lastLow: last ? last.low : NaN,
    lastClose: last ? last.close : NaN,
    lastVolume: last ? last.volume : NaN,
    series,
  })
  return series
}

/** Stroke the polyline of vwap[k] + off·sd[k] over precomputed xs. */
function tracePath(
  ctx: CanvasRenderingContext2D,
  conv: Converters,
  xs: Float64Array,
  s: Series,
  off: number,
): void {
  ctx.beginPath()
  for (let k = 0; k < s.n; k++) {
    const y = conv.priceToY(s.vwap[k] + off * s.sd[k])
    if (k === 0) ctx.moveTo(xs[k], y)
    else ctx.lineTo(xs[k], y)
  }
  ctx.stroke()
}

/** Small anchor flag: pole + pennant + dot, sitting on the VWAP start. */
function drawFlag(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(x + 0.5, y - 3)
  ctx.lineTo(x + 0.5, y - 16)
  ctx.stroke()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x + 0.5, y - 16)
  ctx.lineTo(x + 10, y - 13)
  ctx.lineTo(x + 0.5, y - 10)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.arc(x, y, 2.5, 0, Math.PI * 2)
  ctx.fill()
}

export const avwapImpl: ToolImpl = {
  id: 'avwap',
  label: 'Anchored VWAP',
  group: 'smart',
  pointsNeeded: 1,

  render(ctx, d, conv, selected, env) {
    const p0 = d.points[0]
    if (!p0 || env.candles.length === 0) return
    const s = getSeries(d, env.candles, p0.time)
    if (!s) return
    ctx.save()

    const xs = new Float64Array(s.n)
    for (let k = 0; k < s.n; k++) xs[k] = conv.timeToX(env.candles[s.start + k].time)

    if (s.n > 1) {
      // ±1σ band fill (upper path forward, lower path back).
      ctx.beginPath()
      for (let k = 0; k < s.n; k++) {
        const y = conv.priceToY(s.vwap[k] + s.sd[k])
        if (k === 0) ctx.moveTo(xs[k], y)
        else ctx.lineTo(xs[k], y)
      }
      for (let k = s.n - 1; k >= 0; k--) {
        ctx.lineTo(xs[k], conv.priceToY(s.vwap[k] - s.sd[k]))
      }
      ctx.closePath()
      ctx.fillStyle = withAlpha(ctx, d.color, BAND_FILL_ALPHA)
      ctx.fill()

      // σ band edges (thin) + the VWAP line itself (emphasized).
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.lineWidth = 1
      ctx.strokeStyle = withAlpha(ctx, d.color, BAND_LINE_ALPHA)
      tracePath(ctx, conv, xs, s, 1)
      tracePath(ctx, conv, xs, s, -1)
      ctx.lineWidth = Math.max(1, d.width) + 1
      ctx.strokeStyle = d.color
      tracePath(ctx, conv, xs, s, 0)
    } else {
      // Anchored at the last candle: just a dot until more candles arrive.
      ctx.fillStyle = d.color
      ctx.beginPath()
      ctx.arc(xs[0], conv.priceToY(s.vwap[0]), Math.max(1, d.width) + 1, 0, Math.PI * 2)
      ctx.fill()
    }

    drawFlag(ctx, xs[0], conv.priceToY(s.vwap[0]), d.color)

    const yEnd = conv.priceToY(s.vwap[s.n - 1])
    drawChip(
      ctx,
      xs[s.n - 1] + 8,
      yEnd,
      `AVWAP ${fmtPrice(s.vwap[s.n - 1], env.pricePrecision)}`,
      d.color,
      'left',
    )

    if (selected) drawHandle(ctx, xs[0], conv.priceToY(s.vwap[0]), d.color)
    ctx.restore()
  },

  hitTest(d, x, y, conv, env) {
    const p0 = d.points[0]
    if (!p0 || env.candles.length === 0) return false
    const s = getSeries(d, env.candles, p0.time)
    if (!s) return false
    const candles = env.candles
    const tol = HIT_TOL + (Math.max(1, d.width) + 1) / 2

    const xFirst = conv.timeToX(candles[s.start].time)
    const xLast = conv.timeToX(candles[candles.length - 1].time)
    if (x < xFirst - tol || x > xLast + tol) return false
    if (s.n === 1) return Math.hypot(x - xFirst, y - conv.priceToY(s.vwap[0])) <= tol

    // Candle times map monotonically to x: jump near the cursor, then check
    // the few neighboring segments instead of walking the whole polyline.
    let k = nearestIndex(candles, conv.xToTime(x)) - s.start
    if (k < 0) k = 0
    if (k > s.n - 1) k = s.n - 1
    const k0 = Math.max(0, k - 2)
    const k1 = Math.min(s.n - 2, k + 1)
    for (let i = k0; i <= k1; i++) {
      const xa = conv.timeToX(candles[s.start + i].time)
      const xb = conv.timeToX(candles[s.start + i + 1].time)
      const ya = conv.priceToY(s.vwap[i])
      const yb = conv.priceToY(s.vwap[i + 1])
      if (distToSegment(x, y, xa, ya, xb, yb) <= tol) return true
    }
    return false
  },

  handleAt(d, x, y, conv, env) {
    const p0 = d.points[0]
    if (!p0 || env.candles.length === 0) return -1
    const s = getSeries(d, env.candles, p0.time)
    if (!s) return -1
    const hx = conv.timeToX(env.candles[s.start].time)
    const hy = conv.priceToY(s.vwap[0])
    return Math.abs(x - hx) <= HANDLE_TOL && Math.abs(y - hy) <= HANDLE_TOL ? 0 : -1
  },

  moveHandle(d, index, p) {
    // Dragging the anchor re-anchors the VWAP.
    if (index !== 0) return d
    return { ...d, points: [{ time: p.time, price: p.price }] }
  },
}
