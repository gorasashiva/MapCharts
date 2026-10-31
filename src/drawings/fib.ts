/**
 * Fibonacci tools: retracement (2 anchors) and trend-based extension
 * (3 anchors A-B-C, levels projected from C).
 */
import type { Converters, Drawing, ToolImpl } from './types'
import {
  FONT_10,
  crisp,
  drawHandles,
  fillDot,
  formatPrice,
  strokeLine,
  strokeTol,
  toXY,
  withAlpha,
} from './helpers'
import type { FibLevel } from './fibLevels'
import { readFibLevels } from './fibLevels'

/** Fill opacity for the translucent bands between consecutive levels. */
const FIB_BAND_ALPHA = 0.08

/** Standard Fibonacci retracement ratios, ascending. */
export const FIB_LEVELS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

/**
 * One distinct muted color per retracement level, aligned 1:1 with FIB_LEVELS.
 * (standard Fibonacci palette; the endpoints 0 and 1 share the neutral gray.)
 */
export const FIB_LEVEL_COLORS: readonly string[] = [
  '#787b86', // 0
  '#f23645', // 0.236
  '#ff9800', // 0.382
  '#4caf50', // 0.5
  '#089981', // 0.618
  '#00bcd4', // 0.786
  '#787b86', // 1
]

/** Standard trend-based extension ratios, ascending. */
export const FIBEXT_LEVELS: readonly number[] = [0, 0.382, 0.618, 1, 1.272, 1.618, 2]

/** Colors per extension level, aligned 1:1 with FIBEXT_LEVELS. */
export const FIBEXT_LEVEL_COLORS: readonly string[] = [
  '#787b86', // 0 (at C)
  '#ff9800', // 0.382
  '#089981', // 0.618
  '#787b86', // 1
  '#00bcd4', // 1.272
  '#f23645', // 1.618
  '#9c27b0', // 2
]

/**
 * Price of one retracement level.
 * Convention (industry standard): level 0 sits at the second anchor's price
 * (the end of the measured move), level 1 at the first anchor's price.
 */
export function fibLevelPrice(d: Drawing, level: number): number {
  const start = d.points[0]
  const end = d.points[1] ?? start
  return end.price + (start.price - end.price) * level
}

/**
 * Price of one extension level for an A-B-C drawing: the A->B swing's size is
 * projected from C in the direction of the original move
 * (price = C + (B - A) · ratio).
 */
export function fibExtLevelPrice(d: Drawing, level: number): number {
  const a = d.points[0]
  const b = d.points[1] ?? a
  const c = d.points[2] ?? b
  return c.price + (b.price - a.price) * level
}

/** Banded level rendering shared by retracement and extension. */
function renderLevels(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  conv: Converters,
  left: number,
  width: number,
  levels: readonly FibLevel[],
  fallbackColor: (i: number) => string,
  priceAt: (ratio: number) => number,
  precision: number,
): void {
  const colorOf = (i: number): string => levels[i].color ?? fallbackColor(i)
  // Translucent bands between consecutive levels (tinted by the upper level's
  // color); a band is skipped if either bounding level is hidden.
  for (let i = 0; i < levels.length - 1; i++) {
    if (!levels[i].visible || !levels[i + 1].visible) continue
    const yA = conv.priceToY(priceAt(levels[i].ratio))
    const yB = conv.priceToY(priceAt(levels[i + 1].ratio))
    ctx.fillStyle = withAlpha(ctx, colorOf(i + 1), FIB_BAND_ALPHA)
    ctx.fillRect(left, Math.min(yA, yB), width, Math.abs(yB - yA))
  }
  // Level lines with "ratio — price" labels.
  const lineWidth = Math.max(1, d.width)
  ctx.font = FONT_10
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  ctx.lineWidth = lineWidth
  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i]
    if (!lv.visible) continue
    const price = priceAt(lv.ratio)
    const y = crisp(conv.priceToY(price), lineWidth)
    const col = colorOf(i)
    ctx.strokeStyle = col
    strokeLine(ctx, left, y, left + width, y)
    ctx.fillStyle = col
    ctx.fillText(`${lv.label ?? lv.ratio} — ${formatPrice(price, precision)}`, left + 4, y - 2)
  }
}

function dashedConnector(
  ctx: CanvasRenderingContext2D,
  color: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  ctx.save()
  ctx.setLineDash([4, 4])
  ctx.strokeStyle = withAlpha(ctx, color, 0.55)
  ctx.lineWidth = 1
  strokeLine(ctx, x0, y0, x1, y1)
  ctx.restore()
}

const fib: ToolImpl = {
  id: 'fib',
  label: 'Fib Retracement',
  group: 'fib',
  pointsNeeded: 2,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    const b = d.points[1] ? toXY(conv, d.points[1]) : a
    const left = Math.min(a.x, b.x)
    const width = Math.abs(b.x - a.x)
    renderLevels(
      ctx,
      d,
      conv,
      left,
      width,
      readFibLevels(d, 'fib'),
      (i) => FIB_LEVEL_COLORS[i] ?? d.color,
      (ratio) => fibLevelPrice(d, ratio),
      env.pricePrecision,
    )
    // Faint dashed connector between the two anchors (shows what was measured).
    dashedConnector(ctx, d.color, a.x, a.y, b.x, b.y)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const tol = strokeTol(d)
    const xa = conv.timeToX(d.points[0].time)
    const xb = conv.timeToX(d.points[1].time)
    if (x < Math.min(xa, xb) - tol || x > Math.max(xa, xb) + tol) return false
    for (const lv of readFibLevels(d, 'fib')) {
      if (!lv.visible) continue
      if (Math.abs(y - conv.priceToY(fibLevelPrice(d, lv.ratio))) <= tol) return true
    }
    return false
  },
}

/** X-extent of the extension's level lines: from C, rightward. */
function fibExtSpan(d: Drawing, conv: Converters): { left: number; width: number } {
  const xa = conv.timeToX(d.points[0].time)
  const xb = conv.timeToX(d.points[1].time)
  const xc = conv.timeToX(d.points[2].time)
  return { left: xc, width: Math.max(Math.abs(xb - xa), Math.abs(xc - xb), 60) }
}

const fibext: ToolImpl = {
  id: 'fibext',
  label: 'Fib Extension',
  group: 'fib',
  pointsNeeded: 3,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    if (!d.points[1]) {
      fillDot(ctx, a.x, a.y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, d.points[1])
    dashedConnector(ctx, d.color, a.x, a.y, b.x, b.y)
    if (d.points[2]) {
      const c = toXY(conv, d.points[2])
      dashedConnector(ctx, d.color, b.x, b.y, c.x, c.y)
      const { left, width } = fibExtSpan(d, conv)
      renderLevels(
        ctx,
        d,
        conv,
        left,
        width,
        readFibLevels(d, 'fibext'),
        (i) => FIBEXT_LEVEL_COLORS[i] ?? d.color,
        (ratio) => fibExtLevelPrice(d, ratio),
        env.pricePrecision,
      )
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const tol = strokeTol(d)
    const { left, width } = fibExtSpan(d, conv)
    if (x < left - tol || x > left + width + tol) return false
    for (const lv of readFibLevels(d, 'fibext')) {
      if (!lv.visible) continue
      if (Math.abs(y - conv.priceToY(fibExtLevelPrice(d, lv.ratio))) <= tol) return true
    }
    return false
  },
}

export const FIB_IMPLS: ToolImpl[] = [fib, fibext]
