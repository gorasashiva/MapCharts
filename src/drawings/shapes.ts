/**
 * Shape tools: rectangle, ellipse, triangle, arrow, freehand brush.
 */
import type { ToolImpl } from './types'
import {
  HANDLE_TOLERANCE,
  drawHandles,
  fillArrowHead,
  fillDot,
  pointInBox,
  pointInPolygon,
  screenPts,
  segDist,
  strokeLine,
  strokeTol,
  toXY,
  withAlpha,
} from './helpers'

/** Fill opacity for translucent shape bodies. */
const SHAPE_FILL_ALPHA = 0.12

const rect: ToolImpl = {
  id: 'rect',
  label: 'Rectangle',
  group: 'shapes',
  pointsNeeded: 2,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const b = d.points[1] ? toXY(conv, d.points[1]) : a
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const w = Math.abs(b.x - a.x)
    const h = Math.abs(b.y - a.y)
    ctx.fillStyle = withAlpha(ctx, d.color, SHAPE_FILL_ALPHA)
    ctx.fillRect(x, y, w, h)
    ctx.strokeRect(x, y, w, h)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    // Filled zone: anywhere inside (or within tolerance of the border) hits.
    return pointInBox(x, y, toXY(conv, d.points[0]), toXY(conv, d.points[1]), strokeTol(d))
  },
}

const ellipse: ToolImpl = {
  id: 'ellipse',
  label: 'Ellipse',
  group: 'shapes',
  pointsNeeded: 2,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const b = d.points[1] ? toXY(conv, d.points[1]) : a
    const cx = (a.x + b.x) / 2
    const cy = (a.y + b.y) / 2
    const rx = Math.max(Math.abs(b.x - a.x) / 2, 0.5)
    const ry = Math.max(Math.abs(b.y - a.y) / 2, 0.5)
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
    ctx.fillStyle = withAlpha(ctx, d.color, SHAPE_FILL_ALPHA)
    ctx.fill()
    ctx.stroke()
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    const cx = (a.x + b.x) / 2
    const cy = (a.y + b.y) / 2
    const rx = Math.max(Math.abs(b.x - a.x) / 2, 1)
    const ry = Math.max(Math.abs(b.y - a.y) / 2, 1)
    // Normalized radial distance: <= 1 is the interior; the border band is
    // approximated by scaling the tolerance into normalized units.
    const v = Math.hypot((x - cx) / rx, (y - cy) / ry)
    return v <= 1 + strokeTol(d) / Math.min(rx, ry)
  },
}

const triangle: ToolImpl = {
  id: 'triangle',
  label: 'Triangle',
  group: 'shapes',
  pointsNeeded: 3,
  render(ctx, d, conv, selected) {
    const pts = screenPts(d, conv)
    if (pts.length === 1) {
      fillDot(ctx, pts[0].x, pts[0].y, d.width)
    } else if (pts.length === 2) {
      strokeLine(ctx, pts[0].x, pts[0].y, pts[1].x, pts[1].y)
    } else {
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      ctx.lineTo(pts[1].x, pts[1].y)
      ctx.lineTo(pts[2].x, pts[2].y)
      ctx.closePath()
      ctx.fillStyle = withAlpha(ctx, d.color, SHAPE_FILL_ALPHA)
      ctx.fill()
      ctx.lineJoin = 'round'
      ctx.stroke()
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const pts = screenPts(d, conv)
    if (pointInPolygon(x, y, pts)) return true
    const tol = strokeTol(d)
    return (
      segDist(x, y, pts[0], pts[1]) <= tol ||
      segDist(x, y, pts[1], pts[2]) <= tol ||
      segDist(x, y, pts[2], pts[0]) <= tol
    )
  },
}

const arrow: ToolImpl = {
  id: 'arrow',
  label: 'Arrow',
  group: 'shapes',
  pointsNeeded: 2,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const b = d.points[1] ? toXY(conv, d.points[1]) : a
    const lw = Math.max(1, d.width)
    const head = 6 + lw * 3 // solid head scaled by stroke width
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 1) {
      fillDot(ctx, a.x, a.y, lw)
    } else {
      const ang = Math.atan2(dy, dx)
      const ux = dx / len
      const uy = dy / len
      const inset = Math.min(head * 0.7, len)
      ctx.lineCap = 'round'
      strokeLine(ctx, a.x, a.y, b.x - ux * inset, b.y - uy * inset)
      fillArrowHead(ctx, b.x, b.y, ang, head)
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    return segDist(x, y, a, b) <= Math.max(strokeTol(d), 3 + d.width * 1.5)
  },
}

const brush: ToolImpl = {
  id: 'brush',
  label: 'Brush',
  group: 'shapes',
  pointsNeeded: -1, // freehand: the engine streams points while dragging
  render(ctx, d, conv, selected) {
    const pts = screenPts(d, conv)
    if (pts.length === 0) return
    if (pts.length === 1) {
      fillDot(ctx, pts[0].x, pts[0].y, Math.max(1.5, d.width))
    } else {
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
    }
    // Endpoint handles only — per-vertex handles would bury the stroke.
    if (selected) drawHandles(ctx, d, conv, pts.length > 1 ? [0, pts.length - 1] : [0])
  },
  hitTest(d, x, y, conv) {
    const pts = screenPts(d, conv)
    const tol = strokeTol(d)
    if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y) <= tol
    for (let i = 0; i < pts.length - 1; i++) {
      if (segDist(x, y, pts[i], pts[i + 1]) <= tol) return true
    }
    return false
  },
  handleAt(d, x, y, conv) {
    const idxs = d.points.length > 1 ? [d.points.length - 1, 0] : [0]
    for (const i of idxs) {
      const p = d.points[i]
      if (
        Math.abs(x - conv.timeToX(p.time)) <= HANDLE_TOLERANCE &&
        Math.abs(y - conv.priceToY(p.price)) <= HANDLE_TOLERANCE
      ) {
        return i
      }
    }
    return -1
  },
}

export const SHAPE_IMPLS: ToolImpl[] = [rect, ellipse, triangle, arrow, brush]
