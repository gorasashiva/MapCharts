/**
 * Shared helpers for drawing-tool implementations: color math, canvas
 * primitives (chips, arrows, rounded rects), 2D hit-test geometry, label
 * formatting and small candle-array statistics. Canvas 2D only — no DOM.
 */
import type { Candle } from '../core/types'
import type { Converters, Drawing, DrawingPoint } from './types'

// ---------------------------------------------------------------------------
// Tolerances & fonts
// ---------------------------------------------------------------------------

/** Base pixel tolerance for hit-testing a drawing's stroke. */
export const HIT_TOLERANCE = 6

/** Pixel half-extent for anchor-handle hit-testing (a bit larger than the visual handle). */
export const HANDLE_TOLERANCE = 8

/** Visual side length (px) of the square anchor handles drawn when selected. */
export const HANDLE_SIZE = 7

const FONT_STACK = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

/** Small label font (fib levels, axis pills). */
export const FONT_10 = `10px ${FONT_STACK}`

/** Note-bubble body font. */
export const FONT_11 = `11px ${FONT_STACK}`

/** Measure-chip font. */
export const FONT_12 = `12px ${FONT_STACK}`

/** Stroke hit tolerance widened for thick strokes so the whole visible line is grabbable. */
export function strokeTol(d: Drawing): number {
  return Math.max(HIT_TOLERANCE, d.width / 2 + 3)
}

// ---------------------------------------------------------------------------
// Screen-space points
// ---------------------------------------------------------------------------

export interface Pt {
  x: number
  y: number
}

/** Screen coordinates of one anchor. */
export function toXY(conv: Converters, p: DrawingPoint): Pt {
  return { x: conv.timeToX(p.time), y: conv.priceToY(p.price) }
}

/** Screen coordinates of every anchor, in order. */
export function screenPts(d: Drawing, conv: Converters): Pt[] {
  return d.points.map((p) => toXY(conv, p))
}

/**
 * Logical (CSS-pixel) size of the drawing surface. The engine pre-scales the
 * context by devicePixelRatio, so divide the backing-store size by the
 * context's current scale instead of trusting canvas.width raw.
 */
export function logicalSize(ctx: CanvasRenderingContext2D): { w: number; h: number } {
  const t = ctx.getTransform()
  const sx = t.a !== 0 ? Math.abs(t.a) : 1
  const sy = t.d !== 0 ? Math.abs(t.d) : 1
  return { w: ctx.canvas.width / sx, h: ctx.canvas.height / sy }
}

// ---------------------------------------------------------------------------
// Color math (all tool colors derive from d.color via alpha variants)
// ---------------------------------------------------------------------------

interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

// Cache parsed colors — render runs every frame.
const colorCache = new Map<string, RGBA>()

/**
 * Parse any CSS color without touching the DOM: assigning to ctx.fillStyle
 * normalizes the value to "#rrggbb" (opaque) or "rgba(r, g, b, a)".
 */
function parseColor(ctx: CanvasRenderingContext2D, color: string): RGBA {
  const cached = colorCache.get(color)
  if (cached) return cached

  const prev = ctx.fillStyle
  ctx.fillStyle = color
  const norm = ctx.fillStyle
  ctx.fillStyle = prev

  let out: RGBA = { r: 0, g: 0, b: 0, a: 1 }
  if (typeof norm === 'string') {
    if (norm.charAt(0) === '#' && norm.length >= 7) {
      out = {
        r: parseInt(norm.slice(1, 3), 16),
        g: parseInt(norm.slice(3, 5), 16),
        b: parseInt(norm.slice(5, 7), 16),
        a: 1,
      }
    } else {
      const m = /rgba?\(([^)]+)\)/.exec(norm)
      if (m && m[1]) {
        const parts = m[1].split(',').map((s) => parseFloat(s))
        out = { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 }
      }
    }
  }
  if (colorCache.size > 256) colorCache.clear() // hard cap; colors are few in practice
  colorCache.set(color, out)
  return out
}

// Cache measured text widths the same way colors are cached above — chips
// redraw every frame for every measure/annotation/note drawing on screen,
// and ctx.measureText() is the more expensive of the two canvas calls.
const textWidthCache = new Map<string, number>()

export function measureTextWidth(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  const key = font + ' ' + text
  const cached = textWidthCache.get(key)
  if (cached !== undefined) return cached
  const w = ctx.measureText(text).width // caller must have already set ctx.font = font
  if (textWidthCache.size > 2048) textWidthCache.clear()
  textWidthCache.set(key, w)
  return w
}

/** CSS color string = `color` with its alpha multiplied by `alpha`. */
export function withAlpha(ctx: CanvasRenderingContext2D, color: string, alpha: number): string {
  const c = parseColor(ctx, color)
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a * alpha).toFixed(3)})`
}

/** Black or white, whichever reads best on top of `bg`. */
export function contrastText(ctx: CanvasRenderingContext2D, bg: string): string {
  const c = parseColor(ctx, bg)
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  return lum > 145 ? '#0f0f0f' : '#ffffff'
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Fixed-precision price with thousands separators (matches the chart axes). */
export function formatPrice(value: number, precision: number): string {
  if (!isFinite(value)) return '—'
  const p = Math.max(0, Math.min(8, Math.round(precision)))
  return value.toLocaleString('en-US', {
    minimumFractionDigits: p,
    maximumFractionDigits: p,
  })
}

/** Price with an explicit leading sign ("+1,234.56" / "-1,234.56"). */
export function formatSignedPrice(value: number, precision: number): string {
  const s = formatPrice(value, precision)
  return value >= 0 ? `+${s}` : s
}

/** Percentage with explicit sign: "+2.13%" / "-0.45%". */
export function formatSignedPercent(pct: number): string {
  if (!isFinite(pct)) return '—'
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

/**
 * Compact date(+time for intraday bar spacing) label, local time — matches
 * the time-axis / crosshair convention in src/chart/scales.ts.
 */
export function formatTimeLabel(time: number, barMs: number): string {
  const dt = new Date(time)
  const base = `${dt.getDate()} ${MONTHS[dt.getMonth()]} '${pad2(dt.getFullYear() % 100)}`
  if (barMs >= 86_400_000) return base
  return `${base} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`
}

/** "2d 4h" / "3h 12m" / "45m" / "30s" — top two non-zero units. */
export function humanizeDuration(ms: number): string {
  const abs = Math.abs(ms)
  const totalMin = Math.floor(abs / 60_000)
  if (totalMin < 1) return `${Math.round(abs / 1000)}s`
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  return `${mins}m`
}

/** "1st", "2nd", "3rd", "11th", "87th"… */
export function ordinal(n: number): string {
  const mod100 = Math.abs(n) % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  switch (Math.abs(n) % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

/**
 * Greedy word-wrap to `maxChars` per line, at most `maxLines` lines; overflow
 * is truncated with a trailing ellipsis. Over-long words are hard-broken.
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  const lines: string[] = []
  let cur = ''
  const flush = (): void => {
    if (cur.length > 0) {
      lines.push(cur)
      cur = ''
    }
  }
  for (const w of words) {
    let word = w
    if (cur.length > 0 && cur.length + 1 + word.length <= maxChars) {
      cur += ' ' + word
      continue
    }
    flush()
    while (word.length > maxChars) {
      lines.push(word.slice(0, maxChars))
      word = word.slice(maxChars)
    }
    cur = word
  }
  flush()
  if (lines.length === 0) lines.push('')
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    const last = kept[maxLines - 1]
    kept[maxLines - 1] = (last.length >= maxChars ? last.slice(0, maxChars - 1) : last) + '…'
    return kept
  }
  return lines
}

// ---------------------------------------------------------------------------
// Canvas primitives
// ---------------------------------------------------------------------------

/** Manual rounded-rect path (avoids relying on CanvasPath.roundRect lib types). */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** Offset that keeps odd-width horizontal/vertical strokes pixel-crisp. */
export function crisp(v: number, lineWidth: number): number {
  return Math.round(lineWidth) % 2 === 1 ? Math.round(v) + 0.5 : Math.round(v)
}

export function strokeLine(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.stroke()
}

/** Filled dot — used as the degenerate preview when anchors coincide. */
export function fillDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath()
  ctx.arc(x, y, Math.max(1, r), 0, Math.PI * 2)
  ctx.fill()
}

/** Filled triangular arrowhead with its tip at (x, y), pointing along `angle`. */
export function fillArrowHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  size: number,
): void {
  const spread = 0.42 // half-angle of the head, radians (~24°)
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - size * Math.cos(angle - spread), y - size * Math.sin(angle - spread))
  ctx.lineTo(x - size * Math.cos(angle + spread), y - size * Math.sin(angle + spread))
  ctx.closePath()
  ctx.fill()
}

/**
 * Measuring-tape arrow: a straight shaft with a solid head at the (x1, y1)
 * end, and optionally at the (x0, y0) end too (double-headed). The shaft is
 * inset so it doesn't poke through the heads. Uses the current strokeStyle /
 * fillStyle / lineWidth.
 */
export function strokeArrow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  headSize: number,
  doubleHeaded: boolean,
): void {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy)
  if (len < 1) return
  const ang = Math.atan2(dy, dx)
  const inset = Math.min(headSize * 0.8, len / 2)
  const ux = dx / len
  const uy = dy / len
  const sx0 = doubleHeaded ? x0 + ux * inset : x0
  const sy0 = doubleHeaded ? y0 + uy * inset : y0
  strokeLine(ctx, sx0, sy0, x1 - ux * inset, y1 - uy * inset)
  fillArrowHead(ctx, x1, y1, ang, headSize)
  if (doubleHeaded) fillArrowHead(ctx, x0, y0, ang + Math.PI, headSize)
}

/**
 * Rounded label chip centered at (cx, cy) with one or more text lines.
 * Text color is auto-picked for contrast against `bg`.
 */
export function drawChip(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  lines: string[],
  bg: string,
  font: string = FONT_12,
): void {
  if (lines.length === 0) return
  ctx.font = font
  const padX = 8
  const padY = 4
  const fontPx = parseInt(font, 10) || 12
  const lineH = fontPx + 4
  let textW = 0
  for (const l of lines) textW = Math.max(textW, measureTextWidth(ctx, font, l))
  const w = textW + padX * 2
  const h = lines.length * lineH + padY * 2
  const x = cx - w / 2
  const y = cy - h / 2
  roundRectPath(ctx, x, y, w, h, 4)
  ctx.fillStyle = bg
  ctx.fill()
  ctx.fillStyle = contrastText(ctx, bg)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], cx, y + padY + lineH * (i + 0.5))
  }
}

/**
 * Square anchor handles (white fill, d.color border) — the standard
 * "selected" affordance. `indices` limits which anchors get handles.
 */
export function drawHandles(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  conv: Converters,
  indices?: number[],
): void {
  const half = HANDLE_SIZE / 2
  ctx.lineWidth = 1
  ctx.setLineDash([])
  const idxs = indices ?? d.points.map((_, i) => i)
  for (const i of idxs) {
    const p = d.points[i]
    if (!p) continue
    const x = conv.timeToX(p.time)
    const y = conv.priceToY(p.price)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x - half, y - half, HANDLE_SIZE, HANDLE_SIZE)
    ctx.strokeStyle = d.color
    ctx.strokeRect(x - half, y - half, HANDLE_SIZE, HANDLE_SIZE)
  }
}

// ---------------------------------------------------------------------------
// Hit-test geometry
// ---------------------------------------------------------------------------

/**
 * Distance from (px, py) to the line through (x0,y0)->(x1,y1), with the
 * parametric position clamped to [tMin, tMax]:
 *   [0, 1]               -> segment
 *   [0, Infinity]        -> ray starting at (x0, y0)
 *   [-Infinity, Infinity] -> infinite line
 * Degenerate (zero-length) lines collapse to the distance to (x0, y0).
 */
export function distToLine(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tMin: number,
  tMax: number,
): number {
  const dx = x1 - x0
  const dy = y1 - y0
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lenSq
  t = Math.max(tMin, Math.min(tMax, t))
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))
}

/** Distance from (px, py) to the segment a-b. */
export function segDist(px: number, py: number, a: Pt, b: Pt): number {
  return distToLine(px, py, a.x, a.y, b.x, b.y, 0, 1)
}

/** Ray-cast point-in-polygon test (screen space). */
export function pointInPolygon(x: number, y: number, pts: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x
    const yi = pts[i].y
    const xj = pts[j].x
    const yj = pts[j].y
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Point inside the axis-aligned box spanned by a and b (inflated by tol). */
export function pointInBox(x: number, y: number, a: Pt, b: Pt, tol: number): boolean {
  return (
    x >= Math.min(a.x, b.x) - tol &&
    x <= Math.max(a.x, b.x) + tol &&
    y >= Math.min(a.y, b.y) - tol &&
    y <= Math.max(a.y, b.y) + tol
  )
}

/**
 * Extend the segment (x0,y0)->(x1,y1) so it spans the w×h canvas in the
 * requested direction(s). t=0 at the first point, t=1 at the second; the
 * drawn parametric range always includes [0, 1]. Near-axis lines can yield
 * astronomically large t, so the extension is capped at 1e6 px from t=0.
 * Returns null when the two points coincide (caller should draw a dot).
 */
export function extendLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  h: number,
  extendStart: boolean,
  extendEnd: boolean,
): [number, number, number, number] | null {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return null
  const cap = 1e6 / len
  let t0 = 0
  let t1 = 1
  const ts: number[] = []
  if (dx !== 0) ts.push((0 - x0) / dx, (w - x0) / dx)
  if (dy !== 0) ts.push((0 - y0) / dy, (h - y0) / dy)
  if (ts.length > 0) {
    let lo = ts[0]
    let hi = ts[0]
    for (const t of ts) {
      lo = Math.min(lo, t)
      hi = Math.max(hi, t)
    }
    if (extendStart) t0 = Math.max(Math.min(0, lo), -cap)
    if (extendEnd) t1 = Math.min(Math.max(1, hi), cap)
  }
  return [x0 + dx * t0, y0 + dy * t0, x0 + dx * t1, y0 + dy * t1]
}

// ---------------------------------------------------------------------------
// Candle-array statistics (used by data-aware measure tools)
// ---------------------------------------------------------------------------

/**
 * Simple-average ATR over `period` true ranges, ending at the last candle
 * whose open time is <= `time`. Null when there isn't enough history.
 */
export function atrAt(candles: Candle[], time: number, period = 14): number | null {
  if (candles.length < period + 1) return null
  let idx = candles.length - 1
  while (idx > 0 && candles[idx].time > time) idx--
  if (idx < period) return null
  let sum = 0
  for (let i = idx - period + 1; i <= idx; i++) {
    const c = candles[i]
    const prevClose = candles[i - 1].close
    sum += Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
  }
  return sum / period
}

/**
 * Percentile rank (0–100) of an absolute n-bar percentage move against every
 * historical n-bar close-to-close move in `candles`. Null when the sample is
 * too small (< 30 observations) to be meaningful.
 */
export function nBarMovePercentile(
  candles: Candle[],
  bars: number,
  absPct: number,
): number | null {
  const n = candles.length
  if (bars < 1 || n - bars < 30) return null
  let total = 0
  let atOrBelow = 0
  for (let i = 0; i + bars < n; i++) {
    const a = candles[i].close
    if (!(a > 0)) continue
    total++
    if (Math.abs((candles[i + bars].close / a - 1) * 100) <= absPct) atOrBelow++
  }
  if (total < 30) return null
  return Math.round((100 * atOrBelow) / total)
}
