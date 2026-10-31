/**
 * Channel tools: parallel channel (3 anchors) and Andrews pitchfork.
 */
import type { Converters, Drawing, ToolImpl } from './types'
import type { Pt } from './helpers'
import {
  distToLine,
  drawHandles,
  extendLine,
  fillDot,
  logicalSize,
  pointInPolygon,
  segDist,
  strokeLine,
  strokeTol,
  toXY,
  withAlpha,
} from './helpers'

/** Fill opacity for the channel body / pitchfork tine band. */
const CHANNEL_FILL_ALPHA = 0.08
const FORK_FILL_ALPHA = 0.06

/**
 * Screen-space offset that carries the base line p0-p1 onto the parallel
 * line through p2. Measured vertically at p2's x for non-vertical bases
 * (matches how traders read channels); falls back to a horizontal offset
 * when the base line is vertical.
 */
function channelOffset(a: Pt, b: Pt, c: Pt): Pt {
  if (Math.abs(b.x - a.x) > 1e-9) {
    const t = (c.x - a.x) / (b.x - a.x)
    const yOnBase = a.y + t * (b.y - a.y)
    return { x: 0, y: c.y - yOnBase }
  }
  return { x: c.x - a.x, y: 0 }
}

const channel: ToolImpl = {
  id: 'channel',
  label: 'Parallel Channel',
  group: 'channels',
  pointsNeeded: 3,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const p1 = d.points[1]
    const p2 = d.points[2]
    if (!p1) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, p1)
    if (p2) {
      const off = channelOffset(a, b, toXY(conv, p2))
      const a2: Pt = { x: a.x + off.x, y: a.y + off.y }
      const b2: Pt = { x: b.x + off.x, y: b.y + off.y }
      // Body fill between the two parallel segments.
      ctx.fillStyle = withAlpha(ctx, d.color, CHANNEL_FILL_ALPHA)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.lineTo(b2.x, b2.y)
      ctx.lineTo(a2.x, a2.y)
      ctx.closePath()
      ctx.fill()
      // Parallel line + dashed midline.
      strokeLine(ctx, a2.x, a2.y, b2.x, b2.y)
      ctx.save()
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = withAlpha(ctx, d.color, 0.45)
      ctx.lineWidth = 1
      strokeLine(ctx, a.x + off.x / 2, a.y + off.y / 2, b.x + off.x / 2, b.y + off.y / 2)
      ctx.restore()
    }
    // Base line (drawn last so it stays crisp over the fill).
    strokeLine(ctx, a.x, a.y, b.x, b.y)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    const off = channelOffset(a, b, toXY(conv, d.points[2]))
    const a2: Pt = { x: a.x + off.x, y: a.y + off.y }
    const b2: Pt = { x: b.x + off.x, y: b.y + off.y }
    const tol = strokeTol(d)
    if (segDist(x, y, a, b) <= tol || segDist(x, y, a2, b2) <= tol) return true
    return pointInPolygon(x, y, [a, b, b2, a2])
  },
}

/** Largest parametric t at which origin + t·(dx,dy) is still inside the w×h canvas. */
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
  return Math.min(t, 1e6 / len)
}

interface Fork {
  a: Pt
  b: Pt
  c: Pt
  mid: Pt
  dx: number
  dy: number
  len: number
}

function forkGeometry(d: Drawing, conv: Converters): Fork | null {
  if (!d.points[1] || !d.points[2]) return null
  const a = toXY(conv, d.points[0])
  const b = toXY(conv, d.points[1])
  const c = toXY(conv, d.points[2])
  const mid: Pt = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 }
  const dx = mid.x - a.x
  const dy = mid.y - a.y
  return { a, b, c, mid, dx, dy, len: Math.hypot(dx, dy) }
}

const pitchfork: ToolImpl = {
  id: 'pitchfork',
  label: 'Pitchfork',
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
    const fork = forkGeometry(d, conv)
    if (!fork) {
      // Two anchors placed: preview the handle-to-first-tine segment.
      const b = toXY(conv, p1)
      strokeLine(ctx, a.x, a.y, b.x, b.y)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const { b, c, mid, dx, dy, len } = fork
    const { w, h } = logicalSize(ctx)
    if (len < 1e-6) {
      strokeLine(ctx, b.x, b.y, c.x, c.y)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const tB = tToCanvasEdge(b.x, b.y, dx, dy, w, h, len)
    const tC = tToCanvasEdge(c.x, c.y, dx, dy, w, h, len)
    const tA = tToCanvasEdge(a.x, a.y, dx, dy, w, h, len)
    const bEnd: Pt = { x: b.x + dx * tB, y: b.y + dy * tB }
    const cEnd: Pt = { x: c.x + dx * tC, y: c.y + dy * tC }

    // Subtle band between the tines.
    ctx.fillStyle = withAlpha(ctx, d.color, FORK_FILL_ALPHA)
    ctx.beginPath()
    ctx.moveTo(b.x, b.y)
    ctx.lineTo(bEnd.x, bEnd.y)
    ctx.lineTo(cEnd.x, cEnd.y)
    ctx.lineTo(c.x, c.y)
    ctx.closePath()
    ctx.fill()

    // Tines (slightly translucent) and the p1-p2 base, then the median on top.
    ctx.strokeStyle = withAlpha(ctx, d.color, 0.85)
    strokeLine(ctx, b.x, b.y, bEnd.x, bEnd.y)
    strokeLine(ctx, c.x, c.y, cEnd.x, cEnd.y)
    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = withAlpha(ctx, d.color, 0.5)
    ctx.lineWidth = 1
    strokeLine(ctx, b.x, b.y, c.x, c.y)
    ctx.restore()
    ctx.strokeStyle = d.color
    strokeLine(ctx, a.x, a.y, a.x + dx * tA, a.y + dy * tA)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const fork = forkGeometry(d, conv)
    if (!fork) return false
    const { a, b, c, dx, dy, len } = fork
    const tol = strokeTol(d)
    if (len < 1e-6) return segDist(x, y, b, c) <= tol
    const INF = Number.POSITIVE_INFINITY
    return (
      distToLine(x, y, a.x, a.y, a.x + dx, a.y + dy, 0, INF) <= tol ||
      distToLine(x, y, b.x, b.y, b.x + dx, b.y + dy, 0, INF) <= tol ||
      distToLine(x, y, c.x, c.y, c.x + dx, c.y + dy, 0, INF) <= tol ||
      segDist(x, y, b, c) <= tol
    )
  },
}

export const CHANNEL_IMPLS: ToolImpl[] = [channel, pitchfork]
