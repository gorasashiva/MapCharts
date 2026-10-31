/**
 * Drawings module — tool registry, dispatcher functions (render, hit-test,
 * pure transforms) and toolbar metadata for chart drawings. The chart engine
 * imports everything it needs from this file.
 */
import type { Converters, Drawing, DrawingPoint, DrawingToolId, DrawEnv } from './types'
import { TOOL_IMPLS, toolImpl } from './registry'
import { HANDLE_TOLERANCE } from './helpers'

export * from './types'

export { TOOL_IMPLS, TOOL_GROUPS, DRAWING_TOOLS, toolImpl, pointsNeeded } from './registry'

export { HIT_TOLERANCE, HANDLE_TOLERANCE, formatPrice } from './helpers'

export {
  FIB_LEVELS,
  FIB_LEVEL_COLORS,
  FIBEXT_LEVELS,
  FIBEXT_LEVEL_COLORS,
  fibLevelPrice,
  fibExtLevelPrice,
} from './fib'

/** Default stroke color for freshly placed drawings. */
export const DEFAULT_DRAWING_COLOR = '#2962ff'

/**
 * A new Drawing for `tool`, anchored at the user's first click. Random id,
 * default color/width, props cloned from the tool's defaultProps.
 */
export function defaultDrawing(tool: DrawingToolId, firstPoint: DrawingPoint): Drawing {
  const impl = toolImpl(tool)
  const d: Drawing = {
    id: `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    tool,
    points: [{ time: firstPoint.time, price: firstPoint.price }],
    color: DEFAULT_DRAWING_COLOR,
    width: 1,
  }
  if (impl.defaultProps) d.props = { ...impl.defaultProps }
  return d
}

/**
 * Render one drawing onto the price-pane canvas. Saves/restores all context
 * state and normalizes stroke defaults before dispatching to the tool impl.
 * Tolerates in-progress drawings with fewer points than required (each impl
 * renders a sensible partial preview).
 */
export function renderDrawing(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  conv: Converters,
  selected: boolean,
  env: DrawEnv,
): void {
  if (d.points.length === 0) return
  const impl = TOOL_IMPLS[d.tool]
  if (!impl) return
  ctx.save()
  ctx.lineWidth = Math.max(1, d.width)
  ctx.strokeStyle = d.color
  ctx.fillStyle = d.color
  // Optional line style from the drawing style toolbar; tools that draw their
  // own dashes (fib levels etc.) still set them explicitly.
  const style = d.props?.lineStyle
  const w = Math.max(1, d.width)
  ctx.setLineDash(style === 'dashed' ? [6 * w, 4 * w] : style === 'dotted' ? [w, 3 * w] : [])
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'miter'
  impl.render(ctx, d, conv, selected, env)
  ctx.restore()
}

/**
 * Whether screen point (x, y) hits the drawing (~6px tolerance). Always false
 * while the drawing is still missing points.
 */
export function hitTestDrawing(
  d: Drawing,
  x: number,
  y: number,
  conv: Converters,
  env: DrawEnv,
): boolean {
  const impl = TOOL_IMPLS[d.tool]
  if (!impl) return false
  const complete =
    impl.pointsNeeded >= 0 ? d.points.length >= impl.pointsNeeded : d.points.length >= 2
  if (!complete) return false
  return impl.hitTest(d, x, y, conv, env)
}

/**
 * Index of the anchor point whose handle is under (x, y), or -1. Tools may
 * override (impl.handleAt); the default checks 8px boxes on every anchor,
 * iterating last-to-first so the most recently placed point wins when
 * handles overlap (e.g. a freshly drawn zero-length trendline).
 */
export function hitTestHandle(
  d: Drawing,
  x: number,
  y: number,
  conv: Converters,
  env: DrawEnv,
): number {
  const impl = TOOL_IMPLS[d.tool]
  if (impl?.handleAt) return impl.handleAt(d, x, y, conv, env)
  for (let i = d.points.length - 1; i >= 0; i--) {
    const p = d.points[i]
    if (
      Math.abs(x - conv.timeToX(p.time)) <= HANDLE_TOLERANCE &&
      Math.abs(y - conv.priceToY(p.price)) <= HANDLE_TOLERANCE
    ) {
      return i
    }
  }
  return -1
}

/** Pure: a new Drawing with EVERY anchor shifted by (dTime, dPrice). */
export function translateDrawing(d: Drawing, dTime: number, dPrice: number): Drawing {
  return {
    ...d,
    points: d.points.map((p) => ({ time: p.time + dTime, price: p.price + dPrice })),
  }
}

/**
 * Pure: what dragging handle `index` to `p` means. Tools may override
 * (impl.moveHandle, e.g. price-only handles); the default replaces
 * points[index] with p.
 */
export function movePoint(d: Drawing, index: number, p: DrawingPoint, env: DrawEnv): Drawing {
  if (index < 0) return d
  const impl = TOOL_IMPLS[d.tool]
  // A tool's moveHandle may use synthetic handle indices beyond points[] (e.g.
  // position-tool edge handles that resize the box), so let it run before the
  // default bounds guard.
  if (impl?.moveHandle) return impl.moveHandle(d, index, p, env)
  if (index >= d.points.length) return d
  return {
    ...d,
    points: d.points.map((pt, i) => (i === index ? { time: p.time, price: p.price } : pt)),
  }
}
