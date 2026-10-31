/**
 * Expanded shape & projection tools (professional-grade set).
 *
 * SHAPES group:
 *  - rotrect   3-point rotated rectangle (edge p0-p1 + perpendicular width p2)
 *  - circle    centre p0, pixel-radius to p1 (stays circular under zoom)
 *  - arc       circular arc centred at p1, from the p0 angle to the p2 angle
 *  - curve     quadratic Bézier p0 -> (control p1) -> p2
 *  - polyline  4-vertex open polyline (see notes — the generic engine has a
 *              fixed pointsNeeded, so a true click-to-extend polyline is not
 *              possible; this is a fixed 4-anchor approximation)
 *
 * PROJECTION group:
 *  - forecast    dashed projection + translucent outcome cone p0 -> p1
 *  - barspattern data-aware: copy the real candles in p0..p1 forward as ghosts
 *  - ghostfeed   data-aware: synthetic ghost candles interpolating p0 -> p1
 *  - dprange     combined date + price range box (Δprice, Δ%, bars, duration)
 *
 * Pure canvas 2D. All colors derive from d.color; prices use env.pricePrecision
 * via formatPrice; bar/time math uses env.barMs and env.candles.
 */
import type { ReactElement } from 'react'
import type { Candle } from '../core/types'
import type { Converters, Drawing, DrawingToolId, ToolImpl } from './types'
import type { Pt } from './helpers'
import {
  drawChip,
  drawHandles,
  fillDot,
  formatSignedPercent,
  formatSignedPrice,
  humanizeDuration,
  pointInBox,
  pointInPolygon,
  screenPts,
  segDist,
  strokeLine,
  strokeTol,
  toXY,
  withAlpha,
} from './helpers'

// ---------------------------------------------------------------------------
// Shared local constants & helpers
// ---------------------------------------------------------------------------

/** Fill opacity for translucent shape bodies (matches shapes.ts). */
const SHAPE_FILL_ALPHA = 0.12
/** Fill opacity for projection cones / range boxes (matches measure.ts box). */
const PROJ_FILL_ALPHA = 0.1
const PROJ_BORDER_ALPHA = 0.4
/** Low alpha for ghost / projected candle outlines. */
const GHOST_ALPHA = 0.45
const GHOST_FILL_ALPHA = 0.12

/** The 4 screen-space corners of the rotated rectangle, or null when partial. */
function rotRectCorners(d: Drawing, conv: Converters): [Pt, Pt, Pt, Pt] | null {
  const p0 = d.points[0]
  const p1 = d.points[1]
  const p2 = d.points[2]
  if (!p0 || !p1 || !p2) return null
  const a = toXY(conv, p0)
  const b = toXY(conv, p1)
  const c = toXY(conv, p2)
  const ex = b.x - a.x
  const ey = b.y - a.y
  const len = Math.hypot(ex, ey)
  if (len < 1e-6) return null
  // Unit perpendicular to the p0-p1 edge (pixel space).
  const nx = -ey / len
  const ny = ex / len
  // Signed perpendicular distance of p2 from the edge line.
  const dist = (c.x - a.x) * nx + (c.y - a.y) * ny
  const ox = nx * dist
  const oy = ny * dist
  return [
    a,
    b,
    { x: b.x + ox, y: b.y + oy },
    { x: a.x + ox, y: a.y + oy },
  ]
}

/** First candle index whose open time is >= time (binary search). */
function lowerBound(candles: Candle[], time: number): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].time < time) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Draw a single ghost OHLC candle (low-alpha body + wick) in d.color. */
function drawGhostCandle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  halfW: number,
  o: number,
  h: number,
  l: number,
  c: number,
  conv: Converters,
  color: string,
): void {
  const yO = conv.priceToY(o)
  const yH = conv.priceToY(h)
  const yL = conv.priceToY(l)
  const yC = conv.priceToY(c)
  ctx.strokeStyle = withAlpha(ctx, color, GHOST_ALPHA)
  ctx.lineWidth = 1
  // Wick.
  strokeLine(ctx, cx, yH, cx, yL)
  // Body (outline + faint fill); guarantee >= 1px tall so dojis are visible.
  const top = Math.min(yO, yC)
  const bot = Math.max(yO, yC)
  const bh = Math.max(bot - top, 1)
  ctx.fillStyle = withAlpha(ctx, color, GHOST_FILL_ALPHA)
  ctx.fillRect(cx - halfW, top, halfW * 2, bh)
  ctx.strokeRect(cx - halfW, top, halfW * 2, bh)
}

// ---------------------------------------------------------------------------
// SHAPES
// ---------------------------------------------------------------------------

const rotrect: ToolImpl = {
  id: 'rotrect',
  label: 'Rotated Rectangle',
  group: 'shapes',
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
    if (!d.points[2]) {
      // Only the base edge so far.
      strokeLine(ctx, a.x, a.y, b.x, b.y)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const corners = rotRectCorners(d, conv)
    if (!corners) {
      strokeLine(ctx, a.x, a.y, b.x, b.y)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    ctx.beginPath()
    ctx.moveTo(corners[0].x, corners[0].y)
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y)
    ctx.closePath()
    ctx.fillStyle = withAlpha(ctx, d.color, SHAPE_FILL_ALPHA)
    ctx.fill()
    ctx.lineJoin = 'round'
    ctx.stroke()
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const corners = rotRectCorners(d, conv)
    if (!corners) return false
    if (pointInPolygon(x, y, corners)) return true
    const tol = strokeTol(d)
    for (let i = 0; i < corners.length; i++) {
      if (segDist(x, y, corners[i], corners[(i + 1) % corners.length]) <= tol) return true
    }
    return false
  },
}

const circle: ToolImpl = {
  id: 'circle',
  label: 'Circle',
  group: 'shapes',
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
    const r = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 0.5)
    ctx.beginPath()
    ctx.arc(a.x, a.y, r, 0, Math.PI * 2)
    ctx.fillStyle = withAlpha(ctx, d.color, SHAPE_FILL_ALPHA)
    ctx.fill()
    ctx.stroke()
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    const r = Math.hypot(b.x - a.x, b.y - a.y)
    // Interior fill or near the ring.
    return Math.hypot(x - a.x, y - a.y) <= r + strokeTol(d)
  },
}

const arc: ToolImpl = {
  id: 'arc',
  label: 'Arc',
  group: 'shapes',
  pointsNeeded: 3,
  render(ctx, d, conv, selected) {
    const p0 = d.points[0]
    const p1 = d.points[1]
    const p2 = d.points[2]
    const a = toXY(conv, p0)
    if (!p1) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const centre = toXY(conv, p1)
    if (!p2) {
      // Radius preview from the centre candidate (p1) to p0.
      strokeLine(ctx, centre.x, centre.y, a.x, a.y)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const c = toXY(conv, p2)
    const r = Math.max(Math.hypot(a.x - centre.x, a.y - centre.y), 0.5)
    const start = Math.atan2(a.y - centre.y, a.x - centre.x)
    const end = Math.atan2(c.y - centre.y, c.x - centre.x)
    ctx.beginPath()
    ctx.arc(centre.x, centre.y, r, start, end)
    ctx.lineCap = 'round'
    ctx.stroke()
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[2]) return false
    const centre = toXY(conv, d.points[1])
    const a = toXY(conv, d.points[0])
    const c = toXY(conv, d.points[2])
    const r = Math.hypot(a.x - centre.x, a.y - centre.y)
    const dr = Math.abs(Math.hypot(x - centre.x, y - centre.y) - r)
    if (dr > strokeTol(d)) return false
    // Within the radial band: confirm the cursor angle lies on the drawn sweep
    // (atan2 from start to end the same direction ctx.arc walks).
    let start = Math.atan2(a.y - centre.y, a.x - centre.x)
    let end = Math.atan2(c.y - centre.y, c.x - centre.x)
    let ang = Math.atan2(y - centre.y, x - centre.x)
    const norm = (t: number): number => (t < 0 ? t + Math.PI * 2 : t)
    start = norm(start)
    end = norm(end)
    ang = norm(ang)
    const sweep = norm(end - start)
    const rel = norm(ang - start)
    return rel <= sweep
  },
}

const curve: ToolImpl = {
  id: 'curve',
  label: 'Curve',
  group: 'shapes',
  pointsNeeded: 3,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const p1 = d.points[1]
    if (!p1) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const ctrl = toXY(conv, p1)
    const p2 = d.points[2]
    if (!p2) {
      // Show the would-be control leg as a straight preview.
      strokeLine(ctx, a.x, a.y, ctrl.x, ctrl.y)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, p2)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(ctrl.x, ctrl.y, b.x, b.y)
    ctx.lineCap = 'round'
    ctx.stroke()
    if (selected) {
      // Dashed control handle lines, then square handles on all anchors.
      ctx.save()
      ctx.setLineDash([3, 3])
      ctx.lineWidth = 1
      ctx.strokeStyle = withAlpha(ctx, d.color, 0.5)
      strokeLine(ctx, a.x, a.y, ctrl.x, ctrl.y)
      strokeLine(ctx, b.x, b.y, ctrl.x, ctrl.y)
      ctx.restore()
      drawHandles(ctx, d, conv)
    }
  },
  hitTest(d, x, y, conv) {
    if (!d.points[2]) return false
    const a = toXY(conv, d.points[0])
    const ctrl = toXY(conv, d.points[1])
    const b = toXY(conv, d.points[2])
    const tol = strokeTol(d)
    // Flatten the quadratic into short segments and test each.
    const steps = 24
    let prevX = a.x
    let prevY = a.y
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const mt = 1 - t
      const px = mt * mt * a.x + 2 * mt * t * ctrl.x + t * t * b.x
      const py = mt * mt * a.y + 2 * mt * t * ctrl.y + t * t * b.y
      if (segDist(x, y, { x: prevX, y: prevY }, { x: px, y: py }) <= tol) return true
      prevX = px
      prevY = py
    }
    return false
  },
}

const polyline: ToolImpl = {
  id: 'polyline',
  label: 'Polyline',
  group: 'shapes',
  // NOTE: a true click-to-extend polyline needs variable point capture the
  // generic placement engine does not provide for non-freehand tools, so this
  // is a fixed 4-vertex open polyline. See file notes.
  pointsNeeded: 4,
  render(ctx, d, conv, selected) {
    const pts = screenPts(d, conv)
    if (pts.length === 0) return
    if (pts.length === 1) {
      fillDot(ctx, pts[0].x, pts[0].y, d.width)
    } else {
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (d.points.length < 4) return false
    const pts = screenPts(d, conv)
    const tol = strokeTol(d)
    for (let i = 0; i < pts.length - 1; i++) {
      if (segDist(x, y, pts[i], pts[i + 1]) <= tol) return true
    }
    return false
  },
}

// ---------------------------------------------------------------------------
// PROJECTION
// ---------------------------------------------------------------------------

/** Signed % change p0 -> p1, or null when undefined (p0.price <= 0). */
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

const forecast: ToolImpl = {
  id: 'forecast',
  label: 'Forecast',
  group: 'projection',
  pointsNeeded: 2,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    if (!d.points[1]) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, d.points[1])
    // Cone half-width grows to ±25% of the p0->p1 price move, in pixels.
    const move = d.points[1].price - d.points[0].price
    const coneTopPrice = d.points[1].price + Math.abs(move) * 0.25
    const coneBotPrice = d.points[1].price - Math.abs(move) * 0.25
    const yTop = conv.priceToY(coneTopPrice)
    const yBot = conv.priceToY(coneBotPrice)

    // Translucent cone: apex at p0, mouth spanning [yBot, yTop] at p1's x.
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, yTop)
    ctx.lineTo(b.x, yBot)
    ctx.closePath()
    ctx.fillStyle = withAlpha(ctx, d.color, PROJ_FILL_ALPHA)
    ctx.fill()
    ctx.save()
    ctx.setLineDash([2, 3])
    ctx.lineWidth = 1
    ctx.strokeStyle = withAlpha(ctx, d.color, PROJ_BORDER_ALPHA)
    strokeLine(ctx, a.x, a.y, b.x, yTop)
    strokeLine(ctx, a.x, a.y, b.x, yBot)
    ctx.restore()

    // Dashed central projection line p0 -> p1.
    ctx.save()
    ctx.setLineDash([5, 4])
    ctx.lineWidth = Math.max(1, d.width)
    ctx.strokeStyle = d.color
    strokeLine(ctx, a.x, a.y, b.x, b.y)
    ctx.restore()

    const pct = pctChange(d)
    const bars = barCount(d, env.barMs)
    const label =
      pct === null
        ? `${bars} bars`
        : `${formatSignedPercent(pct)} · ${bars} bars`
    drawChip(ctx, b.x, b.y, [label], d.color)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    const move = d.points[1].price - d.points[0].price
    const yTop = conv.priceToY(d.points[1].price + Math.abs(move) * 0.25)
    const yBot = conv.priceToY(d.points[1].price - Math.abs(move) * 0.25)
    // Inside the cone triangle, or near the central projection line.
    const cone: Pt[] = [a, { x: b.x, y: yTop }, { x: b.x, y: yBot }]
    if (pointInPolygon(x, y, cone)) return true
    return segDist(x, y, a, b) <= strokeTol(d)
  },
}

const barspattern: ToolImpl = {
  id: 'barspattern',
  label: 'Bars Pattern',
  group: 'projection',
  pointsNeeded: 2,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    if (!d.points[1]) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, d.points[1])
    const candles = env.candles
    // Selection rectangle preview (dashed) over the picked source range.
    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1
    ctx.strokeStyle = withAlpha(ctx, d.color, PROJ_BORDER_ALPHA)
    ctx.strokeRect(
      Math.min(a.x, b.x),
      Math.min(a.y, b.y),
      Math.abs(b.x - a.x),
      Math.abs(b.y - a.y),
    )
    ctx.restore()

    if (candles.length > 0 && env.barMs > 0) {
      const tLo = Math.min(d.points[0].time, d.points[1].time)
      const tHi = Math.max(d.points[0].time, d.points[1].time)
      const i0 = lowerBound(candles, tLo)
      const i1 = lowerBound(candles, tHi + 1)
      const slice = candles.slice(i0, i1)
      if (slice.length > 0) {
        // Project the pattern starting one bar after the last loaded candle,
        // re-based so its first open sits on the last close (continuity).
        const last = candles[candles.length - 1]
        const startTime = last.time + env.barMs
        const offset = last.close - slice[0].open
        const x0 = conv.timeToX(startTime)
        const x1 = conv.timeToX(startTime + env.barMs)
        const halfW = Math.max(1, Math.abs(x1 - x0) * 0.32)
        for (let k = 0; k < slice.length; k++) {
          const s = slice[k]
          const cx = conv.timeToX(startTime + k * env.barMs)
          drawGhostCandle(
            ctx,
            cx,
            halfW,
            s.open + offset,
            s.high + offset,
            s.low + offset,
            s.close + offset,
            conv,
            d.color,
          )
        }
        drawChip(
          ctx,
          conv.timeToX(startTime + (slice.length - 1) * env.barMs),
          conv.priceToY(slice[slice.length - 1].close + offset),
          [`${slice.length} bars →`],
          d.color,
        )
      }
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    // The selection box is the grabbable region for editing the source range.
    return pointInBox(x, y, toXY(conv, d.points[0]), toXY(conv, d.points[1]), strokeTol(d))
  },
}

const ghostfeed: ToolImpl = {
  id: 'ghostfeed',
  label: 'Ghost Feed',
  group: 'projection',
  pointsNeeded: 2,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    if (!d.points[1]) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, d.points[1])
    // Guide line p0 -> p1.
    ctx.save()
    ctx.setLineDash([2, 3])
    ctx.lineWidth = 1
    ctx.strokeStyle = withAlpha(ctx, d.color, PROJ_BORDER_ALPHA)
    strokeLine(ctx, a.x, a.y, b.x, b.y)
    ctx.restore()

    const barMs = env.barMs
    if (barMs > 0) {
      const t0 = d.points[0].time
      const t1 = d.points[1].time
      const p0 = d.points[0].price
      const p1 = d.points[1].price
      const span = Math.max(1, Math.round(Math.abs(t1 - t0) / barMs))
      const dir = t1 >= t0 ? 1 : -1
      const x0 = conv.timeToX(t0)
      const x1 = conv.timeToX(t0 + dir * barMs)
      const halfW = Math.max(1, Math.abs(x1 - x0) * 0.32)
      // Synthetic candles: linear price interpolation p0 -> p1, with a small
      // deterministic wiggle so the ghost feed reads as candles, not a ramp.
      let prevClose = p0
      for (let k = 1; k <= span; k++) {
        const f = k / span
        const close = p0 + (p1 - p0) * f
        const open = prevClose
        // Wiggle amplitude scales with the per-bar step.
        const step = Math.abs(close - open)
        const wig = step * 0.6 + Math.abs(p1 - p0) / span / 4
        const phase = (k % 2 === 0 ? 1 : -1) * wig
        const hi = Math.max(open, close) + Math.abs(phase) * 0.5 + wig * 0.3
        const lo = Math.min(open, close) - Math.abs(phase) * 0.5 - wig * 0.3
        const cx = conv.timeToX(t0 + dir * k * barMs)
        drawGhostCandle(ctx, cx, halfW, open, hi, lo, close, conv, d.color)
        prevClose = close
      }
      drawChip(ctx, b.x, b.y, [`ghost ×${span}`], d.color)
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    return pointInBox(x, y, toXY(conv, d.points[0]), toXY(conv, d.points[1]), strokeTol(d))
  },
}

const dprange: ToolImpl = {
  id: 'dprange',
  label: 'Date & Price Range',
  group: 'projection',
  pointsNeeded: 2,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    if (!d.points[1]) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, d.points[1])
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const w = Math.abs(b.x - a.x)
    const h = Math.abs(b.y - a.y)
    ctx.fillStyle = withAlpha(ctx, d.color, PROJ_FILL_ALPHA)
    ctx.fillRect(x, y, w, h)
    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1
    ctx.strokeStyle = withAlpha(ctx, d.color, PROJ_BORDER_ALPHA)
    ctx.strokeRect(x, y, w, h)
    ctx.restore()

    const delta = d.points[1].price - d.points[0].price
    const pct = pctChange(d)
    const bars = barCount(d, env.barMs)
    const dt = Math.abs(d.points[1].time - d.points[0].time)
    const deltaTxt = formatSignedPrice(delta, env.pricePrecision)
    const pctTxt = pct === null ? '' : ` (${formatSignedPercent(pct)})`
    const barsTxt = bars === 1 ? '1 bar' : `${bars} bars`
    const label = `Δ ${deltaTxt}${pctTxt} · ${barsTxt} · ${humanizeDuration(dt)}`
    drawChip(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, [label], d.color)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    return pointInBox(x, y, toXY(conv, d.points[0]), toXY(conv, d.points[1]), strokeTol(d))
  },
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const SHAPES2_IMPLS: ToolImpl[] = [
  rotrect,
  circle,
  arc,
  curve,
  polyline,
  forecast,
  barspattern,
  ghostfeed,
  dprange,
]

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

export const SHAPES2_ICONS: Partial<Record<DrawingToolId, ReactElement>> = {
  rotrect: (
    <svg {...S}>
      <polygon points="4,7 11,3 15,8.5 8,12.5" />
    </svg>
  ),
  circle: (
    <svg {...S}>
      <circle cx="9" cy="9" r="6" />
      <circle cx="9" cy="9" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  arc: (
    <svg {...S}>
      <path d="M2.5 14a8 8 0 0 1 13-6" />
    </svg>
  ),
  curve: (
    <svg {...S}>
      <path d="M2.5 14.5C7 14.5 6 4 15.5 4" />
      <circle cx="2.5" cy="14.5" r="1.4" />
      <circle cx="15.5" cy="4" r="1.4" />
    </svg>
  ),
  polyline: (
    <svg {...S}>
      <polyline points="2.5,13 6.5,5.5 10,11 15.5,4" />
    </svg>
  ),
  forecast: (
    <svg {...S}>
      <line x1="2.5" y1="9" x2="15.5" y2="9" strokeDasharray="2.5 2.5" />
      <line x1="2.5" y1="9" x2="15.5" y2="4" />
      <line x1="2.5" y1="9" x2="15.5" y2="14" />
    </svg>
  ),
  barspattern: (
    <svg {...S}>
      <line x1="4" y1="4" x2="4" y2="14" />
      <rect x="2.7" y="6.5" width="2.6" height="5" />
      <line x1="9" y1="3.5" x2="9" y2="13" />
      <rect x="7.7" y="6" width="2.6" height="4" strokeDasharray="2 1.5" />
      <line x1="14" y1="5" x2="14" y2="14.5" />
      <rect x="12.7" y="8" width="2.6" height="4.5" strokeDasharray="2 1.5" />
    </svg>
  ),
  ghostfeed: (
    <svg {...S}>
      <path d="M3 11a2 2 0 0 1 4 0v4H3z" strokeDasharray="2 1.5" />
      <line x1="5" y1="6" x2="5" y2="9.2" strokeDasharray="2 1.5" />
      <path d="M11 8a2 2 0 0 1 4 0v3h-4z" strokeDasharray="2 1.5" />
      <line x1="13" y1="4" x2="13" y2="6.2" strokeDasharray="2 1.5" />
    </svg>
  ),
  dprange: (
    <svg {...S}>
      <rect x="3" y="4.5" width="12" height="9" rx="1" strokeDasharray="3 2" />
      <line x1="9" y1="4.5" x2="9" y2="13.5" strokeDasharray="2 2" />
      <line x1="3" y1="9" x2="15" y2="9" strokeDasharray="2 2" />
    </svg>
  ),
}
