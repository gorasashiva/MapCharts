/**
 * Line tools: trendline, ray, xline (infinite), hray, hline, vline.
 */
import type { ToolImpl } from './types'
import {
  FONT_10,
  contrastText,
  crisp,
  distToLine,
  drawHandles,
  extendLine,
  fillDot,
  formatPrice,
  formatTimeLabel,
  logicalSize,
  roundRectPath,
  strokeLine,
  strokeTol,
  toXY,
} from './helpers'

/** Small price/time pill. Anchored by its left edge at (x, centered on y). */
function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  bg: string,
): void {
  ctx.font = FONT_10
  const padX = 4
  const w = ctx.measureText(text).width + padX * 2
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
  return ctx.measureText(text).width + 8
}

const trendline: ToolImpl = {
  id: 'trendline',
  label: 'Trend Line',
  group: 'lines',
  pointsNeeded: 2,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const b = d.points[1] ? toXY(conv, d.points[1]) : a
    strokeLine(ctx, a.x, a.y, b.x, b.y)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    return distToLine(x, y, a.x, a.y, b.x, b.y, 0, 1) <= strokeTol(d)
  },
}

const ray: ToolImpl = {
  id: 'ray',
  label: 'Ray',
  group: 'lines',
  pointsNeeded: 2,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const b = d.points[1] ? toXY(conv, d.points[1]) : a
    const { w, h } = logicalSize(ctx)
    const ext = extendLine(a.x, a.y, b.x, b.y, w, h, false, true)
    if (ext) strokeLine(ctx, ext[0], ext[1], ext[2], ext[3])
    else fillDot(ctx, a.x, a.y, d.width) // degenerate: keep it visible
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    return distToLine(x, y, a.x, a.y, b.x, b.y, 0, Number.POSITIVE_INFINITY) <= strokeTol(d)
  },
}

const xline: ToolImpl = {
  id: 'xline',
  label: 'Extended Line',
  group: 'lines',
  pointsNeeded: 2,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const b = d.points[1] ? toXY(conv, d.points[1]) : a
    const { w, h } = logicalSize(ctx)
    const ext = extendLine(a.x, a.y, b.x, b.y, w, h, true, true)
    if (ext) strokeLine(ctx, ext[0], ext[1], ext[2], ext[3])
    else fillDot(ctx, a.x, a.y, d.width)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    return (
      distToLine(x, y, a.x, a.y, b.x, b.y, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY) <=
      strokeTol(d)
    )
  },
}

const hray: ToolImpl = {
  id: 'hray',
  label: 'Horizontal Ray',
  group: 'lines',
  pointsNeeded: 1,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    const { w } = logicalSize(ctx)
    const y = crisp(a.y, ctx.lineWidth)
    if (a.x < w) {
      strokeLine(ctx, a.x, y, w, y)
      // Price pill pinned to the right edge, where the ray runs off the pane.
      const text = formatPrice(d.points[0].price, env.pricePrecision)
      drawPill(ctx, Math.max(a.x, w - pillWidth(ctx, text) - 2), y, text, d.color)
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    const tol = strokeTol(d)
    return Math.abs(y - a.y) <= tol && x >= a.x - tol
  },
}

const hline: ToolImpl = {
  id: 'hline',
  label: 'Horizontal Line',
  group: 'lines',
  pointsNeeded: 1,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    const { w } = logicalSize(ctx)
    const y = crisp(a.y, ctx.lineWidth)
    strokeLine(ctx, 0, y, w, y)
    drawPill(ctx, 2, y, formatPrice(d.points[0].price, env.pricePrecision), d.color)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    return Math.abs(y - conv.priceToY(d.points[0].price)) <= strokeTol(d)
  },
}

const vline: ToolImpl = {
  id: 'vline',
  label: 'Vertical Line',
  group: 'lines',
  pointsNeeded: 1,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    const { w, h } = logicalSize(ctx)
    const x = crisp(a.x, ctx.lineWidth)
    strokeLine(ctx, x, 0, x, h)
    // Small time pill hugging the bottom edge, centered on the line.
    const text = formatTimeLabel(d.points[0].time, env.barMs)
    const pw = pillWidth(ctx, text)
    const px = Math.max(2, Math.min(w - pw - 2, x - pw / 2))
    drawPill(ctx, px, h - 10, text, d.color)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, _y, conv) {
    return Math.abs(x - conv.timeToX(d.points[0].time)) <= strokeTol(d)
  },
}

export const LINE_IMPLS: ToolImpl[] = [trendline, ray, xline, hray, hline, vline]
