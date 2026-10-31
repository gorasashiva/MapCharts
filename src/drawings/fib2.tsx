/**
 * Extended Fibonacci family (professional-grade):
 *   - fibtimezone : vertical fib-multiple time zones from the p0-p1 span
 *   - fibfan      : speed/resistance fan of fib-level rays from p0 through p1
 *   - fibchannel  : parallel fib channel (3 points; p2 sets the 1.0 offset)
 *   - fibcircle   : concentric fib circles centred at p0, radius to p1
 *   - fibtimeext  : trend-based fib TIME extension (3 points A-B-C)
 *   - fibwedge    : fib speed-resistance ARCS centred at p0
 *
 * All circles/arcs are computed in PIXEL space (radius taken from the screen
 * distance p0->p1) so they stay circular regardless of price/time scaling.
 * Every render tolerates an in-progress drawing with fewer than pointsNeeded.
 */
import type { ReactElement } from 'react'
import type { Converters, Drawing, DrawingToolId, ToolImpl } from './types'
import type { Pt } from './helpers'
import {
  FONT_10,
  crisp,
  drawHandles,
  extendLine,
  fillDot,
  formatPrice,
  logicalSize,
  strokeLine,
  strokeTol,
  toXY,
  withAlpha,
} from './helpers'
import { readFibLevels } from './fibLevels'

/** Fill opacity for translucent fib bands / disc tints. */
const FIB_BAND_ALPHA = 0.07
/** Stroke opacity for the structural lines (rings, arcs, fan rays). */
const FIB_LINE_ALPHA = 0.85
/** Faint dashed connector between the measured anchors. */
const CONNECTOR_ALPHA = 0.55

/** Default ratios worth a printed label on the fan/wedge (a level's own label overrides). */
const FAN_LABELLED = new Set<number>([0.382, 0.5, 0.618])

/** Faint dashed connector between two anchor points (shows what was measured). */
function dashedConnector(
  ctx: CanvasRenderingContext2D,
  color: string,
  a: Pt,
  b: Pt,
): void {
  ctx.save()
  ctx.setLineDash([4, 4])
  ctx.strokeStyle = withAlpha(ctx, color, CONNECTOR_ALPHA)
  ctx.lineWidth = 1
  strokeLine(ctx, a.x, a.y, b.x, b.y)
  ctx.restore()
}

// ===========================================================================
// fibtimezone — vertical lines at fib-multiple bar offsets from p0
// ===========================================================================

const fibtimezone: ToolImpl = {
  id: 'fibtimezone',
  label: 'Fib Time Zone',
  group: 'fib',
  pointsNeeded: 2,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const p1 = d.points[1]
    if (!p1) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    // Unit = the p0->p1 time span; vertical zones land at fib multiples of it.
    const unit = d.points[1].time - d.points[0].time
    const { w, h } = logicalSize(ctx)
    const lineWidth = Math.max(1, d.width)
    ctx.lineWidth = lineWidth
    ctx.font = FONT_10
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    for (const lv of readFibLevels(d, 'fibtimezone')) {
      if (!lv.visible) continue
      const step = lv.ratio
      const x = crisp(conv.timeToX(d.points[0].time + unit * step), lineWidth)
      if (x < -2 || x > w + 2) continue
      const isAnchor = step === 0 || step === 1
      ctx.strokeStyle = withAlpha(ctx, lv.color ?? d.color, isAnchor ? FIB_LINE_ALPHA : 0.6)
      strokeLine(ctx, x, 0, x, h)
      ctx.fillStyle = withAlpha(ctx, lv.color ?? d.color, 0.95)
      ctx.fillText(lv.label ?? String(step), x, h - 4)
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    const unit = d.points[1].time - d.points[0].time
    const tol = strokeTol(d)
    for (const lv of readFibLevels(d, 'fibtimezone')) {
      if (!lv.visible) continue
      if (Math.abs(x - conv.timeToX(d.points[0].time + unit * lv.ratio)) <= tol) return true
    }
    return false
  },
}

// ===========================================================================
// fibfan — speed/resistance fan from p0 through the fib points of the span
// ===========================================================================

const fibfan: ToolImpl = {
  id: 'fibfan',
  label: 'Fib Speed Fan',
  group: 'fib',
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
    const dx = b.x - a.x
    const dy = b.y - a.y

    // Bounding box of the move: rays go from p0 to each fib-level point on the
    // vertical (price) edge at p1's x. level 0 -> p0's price, level 1 -> p1's.
    ctx.font = FONT_10
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = Math.max(1, d.width)
    for (const lv of readFibLevels(d, 'fibfan')) {
      if (!lv.visible) continue
      const level = lv.ratio
      // Target point: same x as p1, price interpolated p0->p1 by `level`.
      const ty = a.y + dy * level
      const tx = a.x + dx
      const ext = extendLine(a.x, a.y, tx, ty, w, h, false, true)
      if (!ext) continue
      ctx.strokeStyle = withAlpha(ctx, lv.color ?? d.color, FIB_LINE_ALPHA)
      strokeLine(ctx, ext[0], ext[1], ext[2], ext[3])
      if (lv.label ?? FAN_LABELLED.has(level)) {
        ctx.fillStyle = withAlpha(ctx, lv.color ?? d.color, 0.95)
        ctx.fillText(lv.label ?? String(level), tx + 4, ty)
      }
    }
    // The p0->p1 reference handle, dashed.
    dashedConnector(ctx, d.color, a, b)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    const dx = b.x - a.x
    const dy = b.y - a.y
    const tol = strokeTol(d)
    const INF = Number.POSITIVE_INFINITY
    for (const lv of readFibLevels(d, 'fibfan')) {
      if (!lv.visible) continue
      const ty = a.y + dy * lv.ratio
      const tx = a.x + dx
      if (distToRay(x, y, a.x, a.y, tx, ty, tol, INF)) return true
    }
    return false
  },
}

/** True when (x,y) is within `tol` of the ray a->b (clamped to [0, tMax]). */
function distToRay(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tol: number,
  tMax: number,
): boolean {
  const dx = x1 - x0
  const dy = y1 - y0
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lenSq
  t = Math.max(0, Math.min(tMax, t))
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)) <= tol
}

// ===========================================================================
// fibchannel — parallel fib channel (base p0-p1, p2 sets the 1.0 offset)
// ===========================================================================

/**
 * Screen-space offset carrying the base line p0-p1 onto the parallel line
 * through p2 (vertical at p2's x for non-vertical bases; horizontal else).
 * Matches the convention in channels.ts.
 */
function baseOffset(a: Pt, b: Pt, c: Pt): Pt {
  if (Math.abs(b.x - a.x) > 1e-9) {
    const t = (c.x - a.x) / (b.x - a.x)
    const yOnBase = a.y + t * (b.y - a.y)
    return { x: 0, y: c.y - yOnBase }
  }
  return { x: c.x - a.x, y: 0 }
}

const fibchannel: ToolImpl = {
  id: 'fibchannel',
  label: 'Fib Channel',
  group: 'fib',
  pointsNeeded: 3,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    const p1 = d.points[1]
    if (!p1) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, p1)
    const p2 = d.points[2]
    if (!p2) {
      // Only the base placed so far: preview it as a plain segment.
      strokeLine(ctx, a.x, a.y, b.x, b.y)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const off = baseOffset(a, b, toXY(conv, p2))
    const lineWidth = Math.max(1, d.width)
    const levels = readFibLevels(d, 'fibchannel')

    // Translucent bands between consecutive levels (skipped if either is hidden).
    for (let i = 0; i < levels.length - 1; i++) {
      if (!levels[i].visible || !levels[i + 1].visible) continue
      const lo = levels[i].ratio
      const hi = levels[i + 1].ratio
      ctx.fillStyle = withAlpha(ctx, levels[i + 1].color ?? d.color, FIB_BAND_ALPHA)
      ctx.beginPath()
      ctx.moveTo(a.x + off.x * lo, a.y + off.y * lo)
      ctx.lineTo(b.x + off.x * lo, b.y + off.y * lo)
      ctx.lineTo(b.x + off.x * hi, b.y + off.y * hi)
      ctx.lineTo(a.x + off.x * hi, a.y + off.y * hi)
      ctx.closePath()
      ctx.fill()
    }

    // One parallel line per fib level, labelled "ratio — price".
    ctx.font = FONT_10
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.lineWidth = lineWidth
    for (const lv of levels) {
      if (!lv.visible) continue
      const level = lv.ratio
      const a2: Pt = { x: a.x + off.x * level, y: a.y + off.y * level }
      const b2: Pt = { x: b.x + off.x * level, y: b.y + off.y * level }
      const isEdge = level === 0 || level === 1
      ctx.strokeStyle = withAlpha(ctx, lv.color ?? d.color, isEdge ? FIB_LINE_ALPHA : 0.6)
      strokeLine(ctx, a2.x, a2.y, b2.x, b2.y)
      // Price label keyed to the level: 0 -> p0.price, 1 -> p2.price.
      const price = d.points[0].price + (d.points[2].price - d.points[0].price) * level
      ctx.fillStyle = withAlpha(ctx, lv.color ?? d.color, 0.95)
      ctx.fillText(`${lv.label ?? level} — ${formatPrice(price, env.pricePrecision)}`, b2.x + 4, b2.y - 2)
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1] || !d.points[2]) return false
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    const off = baseOffset(a, b, toXY(conv, d.points[2]))
    const tol = strokeTol(d)
    for (const lv of readFibLevels(d, 'fibchannel')) {
      if (!lv.visible) continue
      const a2: Pt = { x: a.x + off.x * lv.ratio, y: a.y + off.y * lv.ratio }
      const b2: Pt = { x: b.x + off.x * lv.ratio, y: b.y + off.y * lv.ratio }
      if (segDistInline(x, y, a2, b2) <= tol) return true
    }
    return false
  },
}

/** Inline segment distance (mirrors helpers.segDist; avoids an extra import). */
function segDistInline(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

// ===========================================================================
// fibcircle — concentric circles centred at p0, radii = |p0→p1|·level (px)
// ===========================================================================

const fibcircle: ToolImpl = {
  id: 'fibcircle',
  label: 'Fib Circle',
  group: 'fib',
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
    // Radius measured in PIXELS so the rings stay perfectly circular.
    const baseR = Math.hypot(b.x - a.x, b.y - a.y)
    const lineWidth = Math.max(1, d.width)
    ctx.lineWidth = lineWidth
    ctx.font = FONT_10
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'

    const levels = readFibLevels(d, 'fibcircle')
    // Translucent disc tint, largest ring first so inner rings stay readable.
    for (let i = levels.length - 1; i >= 0; i--) {
      const lv = levels[i]
      if (!lv.visible || lv.ratio <= 0) continue
      const r = baseR * lv.ratio
      if (r < 0.5) continue
      ctx.beginPath()
      ctx.ellipse(a.x, a.y, r, r, 0, 0, Math.PI * 2)
      ctx.fillStyle = withAlpha(ctx, lv.color ?? d.color, FIB_BAND_ALPHA)
      ctx.fill()
    }
    for (const lv of levels) {
      if (!lv.visible || lv.ratio <= 0) continue
      const r = baseR * lv.ratio
      if (r < 0.5) continue
      ctx.beginPath()
      ctx.ellipse(a.x, a.y, r, r, 0, 0, Math.PI * 2)
      ctx.strokeStyle = withAlpha(ctx, lv.color ?? d.color, lv.ratio === 1 ? FIB_LINE_ALPHA : 0.6)
      ctx.stroke()
      // Ring label sits just above the top of each circle.
      ctx.fillStyle = withAlpha(ctx, lv.color ?? d.color, 0.95)
      ctx.fillText(lv.label ?? String(lv.ratio), a.x, a.y - r - 2)
    }
    dashedConnector(ctx, d.color, a, b)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    const baseR = Math.hypot(b.x - a.x, b.y - a.y)
    const dist = Math.hypot(x - a.x, y - a.y)
    const tol = strokeTol(d)
    for (const lv of readFibLevels(d, 'fibcircle')) {
      if (!lv.visible || lv.ratio <= 0) continue
      if (Math.abs(dist - baseR * lv.ratio) <= tol) return true
    }
    return false
  },
}

// ===========================================================================
// fibtimeext — trend-based fib TIME extension (A-B-C, projected from C)
// ===========================================================================

const fibtimeext: ToolImpl = {
  id: 'fibtimeext',
  label: 'Fib Time Extension',
  group: 'fib',
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
    if (!p2) {
      // A-B placed: preview the measured swing.
      dashedConnector(ctx, d.color, a, b)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const c = toXY(conv, p2)
    // Unit = the A->B time span; vertical lines project forward from C.
    const unit = d.points[1].time - d.points[0].time
    const { w, h } = logicalSize(ctx)
    const lineWidth = Math.max(1, d.width)

    // Connectors A->B->C show the measured trend.
    dashedConnector(ctx, d.color, a, b)
    dashedConnector(ctx, d.color, b, c)

    ctx.lineWidth = lineWidth
    ctx.font = FONT_10
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    for (const lv of readFibLevels(d, 'fibtimeext')) {
      if (!lv.visible) continue
      const ratio = lv.ratio
      const x = crisp(conv.timeToX(d.points[2].time + unit * ratio), lineWidth)
      if (x < -2 || x > w + 2) continue
      ctx.strokeStyle = withAlpha(ctx, lv.color ?? d.color, ratio === 0 || ratio === 1 ? FIB_LINE_ALPHA : 0.6)
      strokeLine(ctx, x, 0, x, h)
      ctx.fillStyle = withAlpha(ctx, lv.color ?? d.color, 0.95)
      ctx.fillText(lv.label ?? String(ratio), x, h - 4)
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1] || !d.points[2]) return false
    const unit = d.points[1].time - d.points[0].time
    const tol = strokeTol(d)
    for (const lv of readFibLevels(d, 'fibtimeext')) {
      if (!lv.visible) continue
      if (Math.abs(x - conv.timeToX(d.points[2].time + unit * lv.ratio)) <= tol) return true
    }
    return false
  },
}

// ===========================================================================
// fibwedge — fib speed-resistance ARCS centred at p0, opening toward p1
// ===========================================================================

const fibwedge: ToolImpl = {
  id: 'fibwedge',
  label: 'Fib Wedge',
  group: 'fib',
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
    const baseR = Math.hypot(b.x - a.x, b.y - a.y)
    // Arc centre angle points from p0 toward p1; each arc spans a half-circle.
    const ang = Math.atan2(b.y - a.y, b.x - a.x)
    const start = ang - Math.PI / 2
    const end = ang + Math.PI / 2
    const lineWidth = Math.max(1, d.width)
    ctx.lineWidth = lineWidth
    ctx.font = FONT_10
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const lv of readFibLevels(d, 'fibwedge')) {
      if (!lv.visible) continue
      const level = lv.ratio
      const r = baseR * level
      if (r < 0.5) continue
      ctx.beginPath()
      ctx.ellipse(a.x, a.y, r, r, 0, start, end)
      ctx.strokeStyle = withAlpha(ctx, lv.color ?? d.color, level === 1 ? FIB_LINE_ALPHA : 0.6)
      ctx.stroke()
      if (lv.label ?? FAN_LABELLED.has(level)) {
        // Label along the arc's centre direction (toward p1).
        const lx = a.x + Math.cos(ang) * r
        const ly = a.y + Math.sin(ang) * r
        ctx.fillStyle = withAlpha(ctx, lv.color ?? d.color, 0.95)
        ctx.fillText(lv.label ?? String(level), lx, ly)
      }
    }
    dashedConnector(ctx, d.color, a, b)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (!d.points[1]) return false
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    const baseR = Math.hypot(b.x - a.x, b.y - a.y)
    const ang = Math.atan2(b.y - a.y, b.x - a.x)
    // Only the half facing p1 counts; reject points behind the centre.
    const ptAng = Math.atan2(y - a.y, x - a.x)
    let delta = Math.abs(ptAng - ang)
    if (delta > Math.PI) delta = Math.PI * 2 - delta
    if (delta > Math.PI / 2) return false
    const dist = Math.hypot(x - a.x, y - a.y)
    const tol = strokeTol(d)
    for (const lv of readFibLevels(d, 'fibwedge')) {
      if (!lv.visible) continue
      if (Math.abs(dist - baseR * lv.ratio) <= tol) return true
    }
    return false
  },
}

export const FIB2_IMPLS: ToolImpl[] = [
  fibtimezone,
  fibfan,
  fibchannel,
  fibcircle,
  fibtimeext,
  fibwedge,
]

// ===========================================================================
// Icons — 18x18, stroke=currentColor, matching src/components/toolIcons.tsx
// ===========================================================================

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

export const FIB2_ICONS: Partial<Record<DrawingToolId, ReactElement>> = {
  // Vertical zones at increasing (fib) spacing.
  fibtimezone: (
    <svg {...S}>
      <line x1="2.5" y1="3" x2="2.5" y2="15" />
      <line x1="4.5" y1="3" x2="4.5" y2="15" />
      <line x1="7.5" y1="3" x2="7.5" y2="15" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  ),
  // Rays fanning out from a bottom-left origin.
  fibfan: (
    <svg {...S}>
      <line x1="3" y1="15" x2="15.5" y2="3" />
      <line x1="3" y1="15" x2="15.5" y2="8" />
      <line x1="3" y1="15" x2="15.5" y2="13" />
      <circle cx="3" cy="15" r="1.3" />
    </svg>
  ),
  // Two parallel groups of fib lines slanting across the box.
  fibchannel: (
    <svg {...S}>
      <line x1="2" y1="9" x2="13" y2="3" />
      <line x1="3.5" y1="12" x2="14.5" y2="6" />
      <line x1="5" y1="15" x2="16" y2="9" />
    </svg>
  ),
  // Concentric circles around a centre dot.
  fibcircle: (
    <svg {...S}>
      <circle cx="9" cy="9" r="6.5" />
      <circle cx="9" cy="9" r="3.8" />
      <circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  // A-B-C zig with projected vertical extension lines.
  fibtimeext: (
    <svg {...S}>
      <polyline points="2.5,12 5.5,5.5 8.5,9" strokeDasharray="2.2 2.2" />
      <line x1="11" y1="3" x2="11" y2="15" />
      <line x1="14.5" y1="3" x2="14.5" y2="15" />
    </svg>
  ),
  // Concentric half-arcs opening to the right.
  fibwedge: (
    <svg {...S}>
      <path d="M3 2.5a6.5 6.5 0 0 1 0 13" />
      <path d="M3 6a3 3 0 0 1 0 6" />
      <circle cx="3" cy="9" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
}
