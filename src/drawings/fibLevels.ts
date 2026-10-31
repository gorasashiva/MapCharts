/**
 * Editable per-drawing Fibonacci levels.
 *
 * Every fib tool ships a canonical default set of levels (ratios + colors), but
 * each placed drawing can override them: toggle a level off, retune its ratio,
 * recolor it, or rename its label. The override is stored as a JSON STRING in
 * `Drawing.props.levels` (props values are number|string|boolean, so the array
 * rides as a string) and read back through `readFibLevels`, which falls back to
 * the tool's defaults whenever the prop is missing or malformed — so existing
 * drawings (saved before this feature) render exactly as before.
 */
import type { Drawing, DrawingToolId } from './types'
import {
  FIB_LEVELS,
  FIB_LEVEL_COLORS,
  FIBEXT_LEVELS,
  FIBEXT_LEVEL_COLORS,
} from './fib'

/** One Fibonacci level. `color`/`label` are optional overrides of the tool defaults. */
export interface FibLevel {
  /** Ratio (retracement/extension) or, for time tools, the bar-multiple / time-ratio. */
  ratio: number
  /** When false the level (line/ring/zone) is hidden but kept for re-enabling. */
  visible: boolean
  /** Per-level color; when omitted the renderer's fallback color is used. */
  color?: string
  /** Per-level label; when omitted the renderer prints the raw ratio. */
  label?: string
}

/** The fib-family tools that carry editable levels. */
export const FIB_TOOLS: ReadonlySet<DrawingToolId> = new Set<DrawingToolId>([
  'fib',
  'fibext',
  'fibtimezone',
  'fibfan',
  'fibchannel',
  'fibcircle',
  'fibtimeext',
  'fibwedge',
])

// Canonical defaults for the tools whose levels live in fib2.tsx (kept in sync
// with the constants there). fib/fibext defaults come from fib.ts directly.
const FIB_TIME_STEPS: readonly number[] = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]
const FIB_TIME_RATIOS: readonly number[] = [0, 0.382, 0.618, 1, 1.618, 2.618, 4.236]
const FIB_FAN_LEVELS: readonly number[] = [0.236, 0.382, 0.5, 0.618, 0.786, 1]

/** Build a FibLevel[] from parallel ratio/color arrays (color optional). */
function build(ratios: readonly number[], colors?: readonly string[]): FibLevel[] {
  return ratios.map((ratio, i) => {
    const lv: FibLevel = { ratio, visible: true }
    if (colors && colors[i]) lv.color = colors[i]
    return lv
  })
}

/** The tool's canonical level set (a fresh copy every call — safe to mutate). */
export function defaultFibLevels(tool: DrawingToolId): FibLevel[] {
  switch (tool) {
    case 'fib':
      return build(FIB_LEVELS, FIB_LEVEL_COLORS)
    case 'fibext':
      return build(FIBEXT_LEVELS, FIBEXT_LEVEL_COLORS)
    case 'fibchannel':
    case 'fibcircle':
      return build(FIB_LEVELS)
    case 'fibtimezone':
      return build(FIB_TIME_STEPS)
    case 'fibtimeext':
      return build(FIB_TIME_RATIOS)
    case 'fibfan':
    case 'fibwedge':
      return build(FIB_FAN_LEVELS)
    default:
      return build(FIB_LEVELS)
  }
}

/** Parse + sanitize a stored levels string; returns null on absent/garbage input. */
export function parseFibLevels(raw: unknown): FibLevel[] | null {
  if (typeof raw !== 'string') return null
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(arr)) return null
  const out: FibLevel[] = []
  for (const e of arr) {
    if (typeof e !== 'object' || e === null) continue
    const o = e as Record<string, unknown>
    if (typeof o.ratio !== 'number' || !Number.isFinite(o.ratio)) continue
    const lv: FibLevel = { ratio: o.ratio, visible: o.visible !== false }
    if (typeof o.color === 'string' && o.color) lv.color = o.color
    if (typeof o.label === 'string' && o.label) lv.label = o.label.slice(0, 24)
    out.push(lv)
  }
  return out.length ? out : null
}

/**
 * Levels to render for a drawing: the user's override when present and valid,
 * otherwise the tool's canonical defaults.
 */
export function readFibLevels(d: Drawing, tool: DrawingToolId): FibLevel[] {
  return parseFibLevels(d.props?.levels) ?? defaultFibLevels(tool)
}

/** Serialize edited levels for storage in `props.levels`. */
export function writeFibLevels(levels: FibLevel[]): string {
  return JSON.stringify(levels)
}
