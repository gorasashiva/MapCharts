/**
 * Expanded line, channel and fork tools (professional-grade set):
 *
 * LINES group:
 *  - infoline:   trend segment with a midpoint chip (Δprice / % / bars / angle)
 *  - crossline:  infinite horizontal + vertical line through one point
 *  - trendangle: segment with an angle-from-horizontal arc + "<n>°" label
 *
 * CHANNELS group:
 *  - channeldisjoint: two independent (non-parallel) edges, translucent fill
 *  - channelflat:     sloped base line + flat (horizontal) top, filled between
 *  - regression:      linear-regression channel over the p0-p1 bar range (data-aware)
 *  - pitchforkschiff: Schiff pitchfork (median origin at the midpoint of p0-p1)
 *  - pitchforkmod:    modified Schiff pitchfork
 *  - pitchforkinside: inside pitchfork (tines at 0.25/0.75 of the p1-p2 span)
 *  - gannfan:         Gann angle fan (1x1 … 8x1) from p0, scaled by p1
 *  - gannbox:         Gann box p0-p1 with price/time ratio grid
 *
 * Pure canvas 2D. Colors derive from d.color via alpha variants; labels use
 * env.pricePrecision / env.barMs. Every render tolerates a partial point array.
 */
import type { ReactElement } from 'react'
import type { Candle } from '../core/types'
import type { Converters, Drawing, DrawingToolId, ToolImpl } from './types'
import type { Pt } from './helpers'
import {
  FONT_10,
  FONT_11,
  contrastText,
  crisp,
  distToLine,
  drawChip,
  drawHandles,
  extendLine,
  fillDot,
  formatPrice,
  formatSignedPercent,
  formatSignedPrice,
  formatTimeLabel,
  logicalSize,
  measureTextWidth,
  pointInBox,
  pointInPolygon,
  roundRectPath,
  segDist,
  strokeLine,
  strokeTol,
  toXY,
  withAlpha,
} from './helpers'

// ---------------------------------------------------------------------------
// Shared constants & small utilities
// ---------------------------------------------------------------------------

const UP_COLOR = '#089981'
const DOWN_COLOR = '#f23645'
const CHANNEL_FILL_ALPHA = 0.08
const FORK_FILL_ALPHA = 0.06
const REG_FILL_ALPHA = 0.07
const GANN_FILL_ALPHA = 0.05

/** Number of bars spanned by p0->p1 (rounded, never negative). */
function barCount(d: Drawing, barMs: number): number {
  const p1 = d.points[1]
  if (!p1 || !(barMs > 0)) return 0
  return Math.round(Math.abs(p1.time - d.points[0].time) / barMs)
}

function barsLabel(n: number): string {
  return n === 1 ? '1 bar' : `${n} bars`
}

/** Signed % change p0->p1, or null when undefined (|p0.price| <= 0). */
function pctChange(p0: number, p1: number): number | null {
  if (!(Math.abs(p0) > 0)) return null
  const pct = ((p1 - p0) / Math.abs(p0)) * 100
  return isFinite(pct) ? pct : null
}

/** Angle (degrees) of the screen vector a->b, measured from the horizontal. */
function screenAngleDeg(a: Pt, b: Pt): number {
  // Canvas y grows downward; negate dy so "up" reads as a positive angle.
  return (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI
}

/** A faint dashed line in d.color (restores context state afterward). */
function dashedLine(
  ctx: CanvasRenderingContext2D,
  color: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  alpha = 0.5,
): void {
  ctx.save()
  ctx.setLineDash([4, 4])
  ctx.strokeStyle = withAlpha(ctx, color, alpha)
  ctx.lineWidth = 1
  strokeLine(ctx, x0, y0, x1, y1)
  ctx.restore()
}

/** Largest parametric t at which origin + t·(dx,dy) is still on the w×h canvas. */
function tToCanvasEdge(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  w: number,
  h: number,
  len: number,
): number {
  let t = 1
  if (dx !== 0) t = Math.max(t, (0 - ox) / dx, (w - ox) / dx)
  if (dy !== 0) t = Math.max(t, (0 - oy) / dy, (h - oy) / dy)
  return Math.min(t, len > 0 ? 1e6 / len : 1)
}

// ===========================================================================
// LINES group
// ===========================================================================

const infoline: ToolImpl = {
  id: 'infoline',
  label: 'Info Line',
  group: 'lines',
  pointsNeeded: 2,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    const p1 = d.points[1]
    if (!p1) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, p1)
    const up = p1.price >= d.points[0].price
    const color = up ? UP_COLOR : DOWN_COLOR

    // Trend segment in the direction color.
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1, d.width)
    strokeLine(ctx, a.x, a.y, b.x, b.y)

    // Midpoint chip: Δprice · % · bars · angle.
    const delta = p1.price - d.points[0].price
    const pct = pctChange(d.points[0].price, p1.price)
    const bars = barCount(d, env.barMs)
    const angle = screenAngleDeg(a, b)
    const head =
      pct === null
        ? `Δ ${formatSignedPrice(delta, env.pricePrecision)}`
        : `Δ ${formatSignedPrice(delta, env.pricePrecision)}  ${formatSignedPercent(pct)}`
    const label = `${head}  ·  ${barsLabel(bars)}  ·  ${angle.toFixed(0)}°`
    drawChip(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, [label], color)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    return distToLine(x, y, a.x, a.y, b.x, b.y, 0, 1) <= strokeTol(d)
  },
}

const crossline: ToolImpl = {
  id: 'crossline',
  label: 'Cross Line',
  group: 'lines',
  pointsNeeded: 1,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    const { w, h } = logicalSize(ctx)
    const xc = crisp(a.x, ctx.lineWidth)
    const yc = crisp(a.y, ctx.lineWidth)
    strokeLine(ctx, 0, yc, w, yc) // infinite horizontal
    strokeLine(ctx, xc, 0, xc, h) // infinite vertical

    // Price pill at the right edge, time pill at the bottom edge.
    const priceTxt = formatPrice(d.points[0].price, env.pricePrecision)
    drawPill(ctx, Math.max(2, w - pillWidth(ctx, priceTxt) - 2), yc, priceTxt, d.color)
    const timeTxt = formatTimeLabel(d.points[0].time, env.barMs)
    const tw = pillWidth(ctx, timeTxt)
    drawPill(ctx, Math.max(2, Math.min(w - tw - 2, xc - tw / 2)), h - 10, timeTxt, d.color)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    const tol = strokeTol(d)
    return Math.abs(x - a.x) <= tol || Math.abs(y - a.y) <= tol
  },
}

const trendangle: ToolImpl = {
  id: 'trendangle',
  label: 'Trend Angle',
  group: 'lines',
  pointsNeeded: 2,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const p1 = d.points[1]
    if (!p1) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, p1)
    strokeLine(ctx, a.x, a.y, b.x, b.y)

    // Reference horizontal from p0 in the segment's x-direction.
    const dir = b.x >= a.x ? 1 : -1
    const radius = Math.min(34, Math.max(16, Math.hypot(b.x - a.x, b.y - a.y) * 0.45))
    dashedLine(ctx, d.color, a.x, a.y, a.x + dir * radius, a.y, 0.5)

    // Arc between the horizontal (angle 0) and the segment.
    const segAng = Math.atan2(b.y - a.y, b.x - a.x) // canvas-space (y down)
    const baseAng = dir > 0 ? 0 : Math.PI
    ctx.save()
    ctx.beginPath()
    ctx.strokeStyle = withAlpha(ctx, d.color, 0.7)
    ctx.lineWidth = 1
    ctx.setLineDash([])
    const ccw = dir > 0 ? segAng < baseAng : segAng > baseAng
    ctx.arc(a.x, a.y, radius, baseAng, segAng, ccw)
    ctx.stroke()
    ctx.restore()

    // Angle label just outside the arc, on the bisector.
    const deg = screenAngleDeg(a, b)
    const midAng = (baseAng + segAng) / 2
    const lx = a.x + Math.cos(midAng) * (radius + 12)
    const ly = a.y + Math.sin(midAng) * (radius + 12)
    drawChip(ctx, lx, ly, [`${deg.toFixed(0)}°`], d.color, FONT_11)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    return distToLine(x, y, a.x, a.y, b.x, b.y, 0, 1) <= strokeTol(d)
  },
}

// ===========================================================================
// CHANNELS group
// ===========================================================================

const channeldisjoint: ToolImpl = {
  id: 'channeldisjoint',
  label: 'Disjoint Channel',
  group: 'channels',
  pointsNeeded: 4,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const p1 = d.points[1]
    if (!p1) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, p1)
    const p2 = d.points[2]
    const p3 = d.points[3]

    // Translucent fill between the two edges once both are placed.
    if (p2 && p3) {
      const c = toXY(conv, p2)
      const e = toXY(conv, p3)
      ctx.fillStyle = withAlpha(ctx, d.color, CHANNEL_FILL_ALPHA)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.lineTo(e.x, e.y)
      ctx.lineTo(c.x, c.y)
      ctx.closePath()
      ctx.fill()
      strokeLine(ctx, c.x, c.y, e.x, e.y)
    } else if (p2) {
      // Third anchor placed: mark where the second edge will start.
      const c = toXY(conv, p2)
      fillDot(ctx, c.x, c.y, d.width)
    }
    strokeLine(ctx, a.x, a.y, b.x, b.y)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[3]) return false
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    const c = toXY(conv, d.points[2])
    const e = toXY(conv, d.points[3])
    const tol = strokeTol(d)
    if (segDist(x, y, a, b) <= tol || segDist(x, y, c, e) <= tol) return true
    return pointInPolygon(x, y, [a, b, e, c])
  },
}

const channelflat: ToolImpl = {
  id: 'channelflat',
  label: 'Flat Channel',
  group: 'channels',
  pointsNeeded: 3,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const p1 = d.points[1]
    if (!p1) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, p1)
    const p2 = d.points[2]
    if (p2) {
      // Flat top: horizontal line at p2's price, spanning the base x-range.
      const yFlat = conv.priceToY(p2.price)
      const ta: Pt = { x: a.x, y: yFlat }
      const tb: Pt = { x: b.x, y: yFlat }
      ctx.fillStyle = withAlpha(ctx, d.color, CHANNEL_FILL_ALPHA)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.lineTo(tb.x, tb.y)
      ctx.lineTo(ta.x, ta.y)
      ctx.closePath()
      ctx.fill()
      strokeLine(ctx, ta.x, ta.y, tb.x, tb.y)
    }
    strokeLine(ctx, a.x, a.y, b.x, b.y)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[2]) return false
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    const yFlat = conv.priceToY(d.points[2].price)
    const ta: Pt = { x: a.x, y: yFlat }
    const tb: Pt = { x: b.x, y: yFlat }
    const tol = strokeTol(d)
    if (segDist(x, y, a, b) <= tol || segDist(x, y, ta, tb) <= tol) return true
    return pointInPolygon(x, y, [a, b, tb, ta])
  },
}

// --- regression channel (data-aware) ---------------------------------------

/** Index of the first candle with time >= t (candles ascending). */
function lowerBound(candles: Candle[], t: number): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].time < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

interface Regression {
  i0: number // first bar index (inclusive)
  i1: number // last bar index (inclusive)
  slope: number // price per bar
  intercept: number // price at i0
  sigma: number // stddev of residuals
}

/**
 * Least-squares fit of close ~ (index - i0) over the bar range spanned by
 * p0.time..p1.time. Returns null when fewer than 2 bars fall in range.
 */
function computeRegression(d: Drawing, env: DrawEnvLike): Regression | null {
  const { candles } = env
  if (candles.length < 2 || !d.points[1]) return null
  const t0 = Math.min(d.points[0].time, d.points[1].time)
  const t1 = Math.max(d.points[0].time, d.points[1].time)
  let i0 = lowerBound(candles, t0)
  let i1 = lowerBound(candles, t1)
  if (i1 >= candles.length) i1 = candles.length - 1
  if (i0 > i1) i0 = i1
  const n = i1 - i0 + 1
  if (n < 2) return null

  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = i0; i <= i1; i++) {
    const k = i - i0
    const c = candles[i].close
    sx += k
    sy += c
    sxx += k * k
    sxy += k * c
  }
  const denom = n * sxx - sx * sx
  if (Math.abs(denom) < 1e-12) return null
  const slope = (n * sxy - sx * sy) / denom
  const intercept = (sy - slope * sx) / n

  let ssr = 0
  for (let i = i0; i <= i1; i++) {
    const k = i - i0
    const r = candles[i].close - (intercept + slope * k)
    ssr += r * r
  }
  const sigma = Math.sqrt(ssr / n)
  return { i0, i1, slope, intercept, sigma }
}

/** DrawEnv shape the data-aware tools actually read (candles + precision + barMs). */
interface DrawEnvLike {
  candles: Candle[]
  pricePrecision: number
  barMs: number
}

const regression: ToolImpl = {
  id: 'regression',
  label: 'Regression Channel',
  group: 'channels',
  pointsNeeded: 2,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    const p1 = d.points[1]
    if (!p1) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, p1)
    const reg = computeRegression(d, env)
    if (!reg) {
      // Not enough bars in range: fall back to a faint connector preview.
      dashedLine(ctx, d.color, a.x, a.y, b.x, b.y, 0.6)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const { candles } = env
    const { i0, i1, slope, intercept, sigma } = reg
    const priceAt = (k: number): number => intercept + slope * k
    const xL = conv.timeToX(candles[i0].time)
    const xR = conv.timeToX(candles[i1].time)
    const kR = i1 - i0
    const yMidL = conv.priceToY(priceAt(0))
    const yMidR = conv.priceToY(priceAt(kR))
    const band = 2 * sigma

    // ±2σ parallel channel fill.
    const yUpL = conv.priceToY(priceAt(0) + band)
    const yUpR = conv.priceToY(priceAt(kR) + band)
    const yDnL = conv.priceToY(priceAt(0) - band)
    const yDnR = conv.priceToY(priceAt(kR) - band)
    ctx.fillStyle = withAlpha(ctx, d.color, REG_FILL_ALPHA)
    ctx.beginPath()
    ctx.moveTo(xL, yUpL)
    ctx.lineTo(xR, yUpR)
    ctx.lineTo(xR, yDnR)
    ctx.lineTo(xL, yDnL)
    ctx.closePath()
    ctx.fill()

    // Channel edges (translucent) + the regression line (solid).
    ctx.save()
    ctx.strokeStyle = withAlpha(ctx, d.color, 0.6)
    ctx.lineWidth = 1
    strokeLine(ctx, xL, yUpL, xR, yUpR)
    strokeLine(ctx, xL, yDnL, xR, yDnR)
    ctx.restore()
    ctx.strokeStyle = d.color
    ctx.lineWidth = Math.max(1, d.width)
    strokeLine(ctx, xL, yMidL, xR, yMidR)

    // Slope label (price change per bar) near the right end of the mid line.
    const slopeTxt = `${formatSignedPrice(slope, env.pricePrecision)}/bar`
    drawChip(ctx, xR + 4 + measureChipHalf(ctx, slopeTxt), yMidR, [slopeTxt], d.color, FONT_10)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv, env) {
    if (!d.points[1]) return false
    const reg = computeRegression(d, env)
    if (!reg) return false
    const { candles } = env
    const { i0, i1, slope, intercept, sigma } = reg
    const priceAt = (k: number): number => intercept + slope * k
    const xL = conv.timeToX(candles[i0].time)
    const xR = conv.timeToX(candles[i1].time)
    const kR = i1 - i0
    const tol = strokeTol(d)
    if (x < Math.min(xL, xR) - tol || x > Math.max(xL, xR) + tol) return false
    const up: Pt[] = [
      { x: xL, y: conv.priceToY(priceAt(0) + 2 * sigma) },
      { x: xR, y: conv.priceToY(priceAt(kR) + 2 * sigma) },
    ]
    const dn: Pt[] = [
      { x: xL, y: conv.priceToY(priceAt(0) - 2 * sigma) },
      { x: xR, y: conv.priceToY(priceAt(kR) - 2 * sigma) },
    ]
    const mid: Pt[] = [
      { x: xL, y: conv.priceToY(priceAt(0)) },
      { x: xR, y: conv.priceToY(priceAt(kR)) },
    ]
    if (
      segDist(x, y, up[0], up[1]) <= tol ||
      segDist(x, y, dn[0], dn[1]) <= tol ||
      segDist(x, y, mid[0], mid[1]) <= tol
    )
      return true
    return pointInPolygon(x, y, [up[0], up[1], dn[1], dn[0]])
  },
}

/** Half-width (px) of a chip drawn with `drawChip` for a single line of text. */
function measureChipHalf(ctx: CanvasRenderingContext2D, text: string): number {
  ctx.font = FONT_10
  return (measureTextWidth(ctx, FONT_10, text) + 16) / 2
}

// --- pitchfork family -------------------------------------------------------

interface ForkBase {
  origin: Pt // median origin
  b: Pt // tine anchor 1
  c: Pt // tine anchor 2
  target: Pt // point the median heads toward
}

/** Draw a pitchfork given its median origin, target, and two tine anchors. */
function drawFork(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  conv: Converters,
  fork: ForkBase,
  selected: boolean,
): void {
  const { origin, b, c, target } = fork
  const dx = target.x - origin.x
  const dy = target.y - origin.y
  const len = Math.hypot(dx, dy)
  const { w, h } = logicalSize(ctx)
  if (len < 1e-6) {
    strokeLine(ctx, b.x, b.y, c.x, c.y)
    if (selected) drawHandles(ctx, d, conv)
    return
  }
  const tOrigin = tToCanvasEdge(origin.x, origin.y, dx, dy, w, h, len)
  const tB = tToCanvasEdge(b.x, b.y, dx, dy, w, h, len)
  const tC = tToCanvasEdge(c.x, c.y, dx, dy, w, h, len)
  const bEnd: Pt = { x: b.x + dx * tB, y: b.y + dy * tB }
  const cEnd: Pt = { x: c.x + dx * tC, y: c.y + dy * tC }

  // Translucent band between the tines.
  ctx.fillStyle = withAlpha(ctx, d.color, FORK_FILL_ALPHA)
  ctx.beginPath()
  ctx.moveTo(b.x, b.y)
  ctx.lineTo(bEnd.x, bEnd.y)
  ctx.lineTo(cEnd.x, cEnd.y)
  ctx.lineTo(c.x, c.y)
  ctx.closePath()
  ctx.fill()

  // Tines (translucent) + the p1-p2 base (dashed), then the median on top.
  ctx.save()
  ctx.strokeStyle = withAlpha(ctx, d.color, 0.85)
  ctx.lineWidth = Math.max(1, d.width)
  strokeLine(ctx, b.x, b.y, bEnd.x, bEnd.y)
  strokeLine(ctx, c.x, c.y, cEnd.x, cEnd.y)
  ctx.restore()
  dashedLine(ctx, d.color, b.x, b.y, c.x, c.y, 0.5)
  ctx.strokeStyle = d.color
  ctx.lineWidth = Math.max(1, d.width)
  strokeLine(ctx, origin.x, origin.y, origin.x + dx * tOrigin, origin.y + dy * tOrigin)

  if (selected) drawHandles(ctx, d, conv)
}

/** Hit-test a fork: median ray, both tine rays, or the p1-p2 base. */
function forkHit(d: Drawing, x: number, y: number, conv: Converters, fork: ForkBase): boolean {
  const { origin, b, c, target } = fork
  const dx = target.x - origin.x
  const dy = target.y - origin.y
  const tol = strokeTol(d)
  if (Math.hypot(dx, dy) < 1e-6) return segDist(x, y, b, c) <= tol
  const INF = Number.POSITIVE_INFINITY
  return (
    distToLine(x, y, origin.x, origin.y, origin.x + dx, origin.y + dy, 0, INF) <= tol ||
    distToLine(x, y, b.x, b.y, b.x + dx, b.y + dy, 0, INF) <= tol ||
    distToLine(x, y, c.x, c.y, c.x + dx, c.y + dy, 0, INF) <= tol ||
    segDist(x, y, b, c) <= tol
  )
}

function mid(p: Pt, q: Pt): Pt {
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
}

function lerp(p: Pt, q: Pt, t: number): Pt {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
}

/** Resolve the three screen anchors, returning null while points are missing. */
function forkAnchors(d: Drawing, conv: Converters): { a: Pt; b: Pt; c: Pt } | null {
  if (!d.points[1] || !d.points[2]) return null
  return { a: toXY(conv, d.points[0]), b: toXY(conv, d.points[1]), c: toXY(conv, d.points[2]) }
}

/** Shared partial-preview for the 3-point fork variants. */
function forkPartial(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  conv: Converters,
  selected: boolean,
): boolean {
  const a = toXY(conv, d.points[0])
  const p1 = d.points[1]
  if (!p1) {
    fillDot(ctx, a.x, a.y, d.width)
    if (selected) drawHandles(ctx, d, conv)
    return true
  }
  if (!d.points[2]) {
    const b = toXY(conv, p1)
    strokeLine(ctx, a.x, a.y, b.x, b.y)
    if (selected) drawHandles(ctx, d, conv)
    return true
  }
  return false
}

const pitchforkschiff: ToolImpl = {
  id: 'pitchforkschiff',
  label: 'Schiff Pitchfork',
  group: 'channels',
  pointsNeeded: 3,
  render(ctx, d, conv, selected) {
    if (forkPartial(ctx, d, conv, selected)) return
    const { a, b, c } = forkAnchors(d, conv)!
    // Median origin at the midpoint of p0-p1, heading to the midpoint of p1-p2.
    drawFork(ctx, d, conv, { origin: mid(a, b), b, c, target: mid(b, c) }, selected)
  },
  hitTest(d, x, y, conv) {
    const anc = forkAnchors(d, conv)
    if (!anc) return false
    return forkHit(d, x, y, conv, {
      origin: mid(anc.a, anc.b),
      b: anc.b,
      c: anc.c,
      target: mid(anc.b, anc.c),
    })
  },
}

const pitchforkmod: ToolImpl = {
  id: 'pitchforkmod',
  label: 'Modified Schiff Pitchfork',
  group: 'channels',
  pointsNeeded: 3,
  render(ctx, d, conv, selected) {
    if (forkPartial(ctx, d, conv, selected)) return
    const { a, b, c } = forkAnchors(d, conv)!
    // Median origin at the midpoint between p0 and the midpoint of p1-p2.
    const target = mid(b, c)
    drawFork(ctx, d, conv, { origin: mid(a, target), b, c, target }, selected)
  },
  hitTest(d, x, y, conv) {
    const anc = forkAnchors(d, conv)
    if (!anc) return false
    const target = mid(anc.b, anc.c)
    return forkHit(d, x, y, conv, { origin: mid(anc.a, target), b: anc.b, c: anc.c, target })
  },
}

const pitchforkinside: ToolImpl = {
  id: 'pitchforkinside',
  label: 'Inside Pitchfork',
  group: 'channels',
  pointsNeeded: 3,
  render(ctx, d, conv, selected) {
    if (forkPartial(ctx, d, conv, selected)) return
    const { a, b, c } = forkAnchors(d, conv)!
    // Median from p0 to the midpoint of p1-p2; tines at 0.25/0.75 of p1-p2.
    drawFork(
      ctx,
      d,
      conv,
      { origin: a, b: lerp(b, c, 0.25), c: lerp(b, c, 0.75), target: mid(b, c) },
      selected,
    )
  },
  hitTest(d, x, y, conv) {
    const anc = forkAnchors(d, conv)
    if (!anc) return false
    return forkHit(d, x, y, conv, {
      origin: anc.a,
      b: lerp(anc.b, anc.c, 0.25),
      c: lerp(anc.b, anc.c, 0.75),
      target: mid(anc.b, anc.c),
    })
  },
}

// --- Gann tools -------------------------------------------------------------

/** Gann angle ratios: each is (price-units : time-units) relative to 1x1. */
const GANN_RATIOS: ReadonlyArray<{ label: string; mult: number }> = [
  { label: '8x1', mult: 8 },
  { label: '4x1', mult: 4 },
  { label: '2x1', mult: 2 },
  { label: '1x1', mult: 1 },
  { label: '1x2', mult: 1 / 2 },
  { label: '1x4', mult: 1 / 4 },
  { label: '1x8', mult: 1 / 8 },
]

/** Distinct muted colors for the Gann rays (1x1 is emphasized via d.color). */
const GANN_COLORS: readonly string[] = [
  '#9c27b0',
  '#f23645',
  '#ff9800',
  '#089981',
  '#00bcd4',
  '#3f7bd8',
  '#787b86',
]

const gannfan: ToolImpl = {
  id: 'gannfan',
  label: 'Gann Fan',
  group: 'channels',
  pointsNeeded: 2,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const p1 = d.points[1]
    if (!p1) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, p1)
    const { w, h } = logicalSize(ctx)
    // 1x1 unit cell derived so the 1x1 ray passes through p1.
    const unitX = b.x - a.x
    const unitY = b.y - a.y
    if (Math.abs(unitX) < 1e-6 && Math.abs(unitY) < 1e-6) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    ctx.save()
    ctx.lineWidth = 1
    ctx.font = FONT_10
    ctx.textBaseline = 'middle'
    for (let i = 0; i < GANN_RATIOS.length; i++) {
      const ratio = GANN_RATIOS[i]
      // price-axis (y) scaled by mult vs the time-axis (x).
      const dx = unitX
      const dy = unitY * ratio.mult
      const len = Math.hypot(dx, dy)
      if (len < 1e-6) continue
      const t = tToCanvasEdge(a.x, a.y, dx, dy, w, h, len)
      const ex = a.x + dx * t
      const ey = a.y + dy * t
      const is11 = ratio.mult === 1
      ctx.strokeStyle = is11 ? d.color : withAlpha(ctx, GANN_COLORS[i], 0.85)
      strokeLine(ctx, a.x, a.y, ex, ey)
      // Faint label a little way along the ray, kept on-canvas.
      const lt = Math.min(t, (0.42 * Math.min(w, h)) / len)
      const lx = a.x + dx * lt
      const ly = a.y + dy * lt
      if (lx > 2 && lx < w - 24 && ly > 8 && ly < h - 8) {
        ctx.fillStyle = withAlpha(ctx, is11 ? d.color : GANN_COLORS[i], 0.8)
        ctx.textAlign = dx >= 0 ? 'left' : 'right'
        ctx.fillText(ratio.label, lx + (dx >= 0 ? 3 : -3), ly - 6)
      }
    }
    ctx.restore()
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    const unitX = b.x - a.x
    const unitY = b.y - a.y
    const tol = strokeTol(d)
    const INF = Number.POSITIVE_INFINITY
    for (const ratio of GANN_RATIOS) {
      const dx = unitX
      const dy = unitY * ratio.mult
      if (Math.hypot(dx, dy) < 1e-6) continue
      if (distToLine(x, y, a.x, a.y, a.x + dx, a.y + dy, 0, INF) <= tol) return true
    }
    return false
  },
}

/** Gann box internal grid ratios (shared across both axes). */
const GANN_BOX_RATIOS: readonly number[] = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]

const gannbox: ToolImpl = {
  id: 'gannbox',
  label: 'Gann Box',
  group: 'channels',
  pointsNeeded: 2,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const p1 = d.points[1]
    if (!p1) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, p1)
    const x0 = Math.min(a.x, b.x)
    const x1 = Math.max(a.x, b.x)
    const y0 = Math.min(a.y, b.y)
    const y1 = Math.max(a.y, b.y)
    const bw = x1 - x0
    const bh = y1 - y0

    // Translucent body + box border.
    ctx.fillStyle = withAlpha(ctx, d.color, GANN_FILL_ALPHA)
    ctx.fillRect(x0, y0, bw, bh)

    // Internal ratio grid across both axes (faint), then the box outline.
    ctx.save()
    ctx.lineWidth = 1
    ctx.strokeStyle = withAlpha(ctx, d.color, 0.4)
    ctx.font = FONT_10
    ctx.fillStyle = withAlpha(ctx, d.color, 0.7)
    ctx.textBaseline = 'top'
    for (const r of GANN_BOX_RATIOS) {
      if (r === 0 || r === 1) continue
      const gx = x0 + bw * r
      const gy = y0 + bh * r
      strokeLine(ctx, gx, y0, gx, y1)
      strokeLine(ctx, x0, gy, x1, gy)
    }
    // Diagonals (1x1 both directions) for the classic Gann box look.
    ctx.strokeStyle = withAlpha(ctx, d.color, 0.55)
    strokeLine(ctx, x0, y0, x1, y1)
    strokeLine(ctx, x0, y1, x1, y0)
    ctx.restore()

    ctx.strokeStyle = d.color
    ctx.lineWidth = Math.max(1, d.width)
    ctx.strokeRect(x0, y0, bw, bh)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    return pointInBox(x, y, toXY(conv, d.points[0]), toXY(conv, d.points[1]), strokeTol(d))
  },
}

// ---------------------------------------------------------------------------
// Local pill helper (matches lines.ts drawPill, used by crossline)
// ---------------------------------------------------------------------------

/** Small price/time pill, left edge at x, vertically centered on y. */
function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  bg: string,
): void {
  ctx.font = FONT_10
  const padX = 4
  const w = measureTextWidth(ctx, FONT_10, text) + padX * 2
  const h = 15
  roundRectPath(ctx, x, y - h / 2, w, h, 3)
  ctx.fillStyle = bg
  ctx.fill()
  ctx.fillStyle = contrastText(ctx, bg)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + padX, y + 0.5)
}

function pillWidth(ctx: CanvasRenderingContext2D, text: string): number {
  ctx.font = FONT_10
  return measureTextWidth(ctx, FONT_10, text) + 8
}

// ===========================================================================
// Exports
// ===========================================================================

export const LINES2_IMPLS: ToolImpl[] = [
  // LINES group
  infoline,
  crossline,
  trendangle,
  // CHANNELS group
  channeldisjoint,
  channelflat,
  regression,
  pitchforkschiff,
  pitchforkmod,
  pitchforkinside,
  gannfan,
  gannbox,
]

// ---------------------------------------------------------------------------
// Icons — 18x18, stroke=currentColor (matches src/components/toolIcons.tsx)
// ---------------------------------------------------------------------------

const S = {
  width: 18,
  height: 18,
  viewBox: '0 0 18 18',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export const LINES2_ICONS: Partial<Record<DrawingToolId, ReactElement>> = {
  infoline: (
    <svg {...S}>
      <line x1="2.5" y1="14" x2="15.5" y2="4" />
      <rect x="6" y="7.5" width="6" height="3.2" rx="0.8" />
    </svg>
  ),
  crossline: (
    <svg {...S}>
      <line x1="9" y1="1.5" x2="9" y2="16.5" />
      <line x1="1.5" y1="9" x2="16.5" y2="9" />
    </svg>
  ),
  trendangle: (
    <svg {...S}>
      <line x1="3" y1="14.5" x2="15.5" y2="4" />
      <line x1="3" y1="14.5" x2="13.5" y2="14.5" />
      <path d="M11.5 14.5a8.5 8.5 0 0 0-2.4-5.6" />
    </svg>
  ),
  channeldisjoint: (
    <svg {...S}>
      <line x1="2" y1="11.5" x2="13" y2="2.5" />
      <line x1="5" y1="15.5" x2="16" y2="8.5" />
    </svg>
  ),
  channelflat: (
    <svg {...S}>
      <line x1="2.5" y1="4" x2="15.5" y2="4" />
      <line x1="2.5" y1="14" x2="15.5" y2="8.5" />
    </svg>
  ),
  regression: (
    <svg {...S}>
      <line x1="2.5" y1="14" x2="15.5" y2="4" />
      <line x1="2.5" y1="10" x2="15.5" y2="0.5" strokeDasharray="2.2 2.2" />
      <line x1="2.5" y1="17.5" x2="15.5" y2="7.5" strokeDasharray="2.2 2.2" />
    </svg>
  ),
  pitchforkschiff: (
    <svg {...S}>
      <line x1="3.5" y1="13" x2="14.5" y2="5" />
      <line x1="3" y1="15.5" x2="9" y2="2.5" />
      <line x1="9" y1="2.5" x2="15" y2="9" />
      <line x1="6" y1="9" x2="12" y2="5.7" />
    </svg>
  ),
  pitchforkmod: (
    <svg {...S}>
      <line x1="2.5" y1="14.5" x2="13.5" y2="6" />
      <line x1="3" y1="15.5" x2="9" y2="2.5" />
      <line x1="9" y1="2.5" x2="15" y2="9" />
      <circle cx="8" cy="10.2" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  pitchforkinside: (
    <svg {...S}>
      <line x1="2.5" y1="15.5" x2="12" y2="5.7" />
      <line x1="3" y1="15.5" x2="9" y2="2.5" />
      <line x1="9" y1="2.5" x2="15" y2="9" />
      <line x1="6.2" y1="8.5" x2="11.5" y2="11.5" strokeDasharray="2 2" />
    </svg>
  ),
  gannfan: (
    <svg {...S}>
      <line x1="2.5" y1="15.5" x2="16" y2="15.5" />
      <line x1="2.5" y1="15.5" x2="16" y2="9" />
      <line x1="2.5" y1="15.5" x2="14" y2="2.5" />
      <line x1="2.5" y1="15.5" x2="6" y2="2.5" />
    </svg>
  ),
  gannbox: (
    <svg {...S}>
      <rect x="2.5" y="3" width="13" height="12" rx="0.8" />
      <line x1="2.5" y1="3" x2="15.5" y2="15" />
      <line x1="9" y1="3" x2="9" y2="15" />
      <line x1="2.5" y1="9" x2="15.5" y2="9" />
    </svg>
  ),
}
