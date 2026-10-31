/**
 * Expanded annotation tools (group 'annotate'):
 *
 * - text       — a plain text box at p0 (subtle background, no pin/bubble)
 * - callout    — a rounded text bubble at p1 with a leader arrow to anchor p0
 * - comment    — a speech-bubble (rounded rect + tail) at p0
 * - pricelabel — a manual axis-style price tag on a horizontal tick at p0
 * - signpost   — a vertical pole up to p0 topped with a flag label + date
 * - arrowup    — an upward (bullish) marker glyph at p0
 * - arrowdown  — a downward (bearish) marker glyph at p0
 * - flag       — a flag-on-a-pole marker at p0
 *
 * Typography matches the existing note bubble (12px body, d.color alpha
 * variants). Every tool tolerates an in-progress / empty-text drawing.
 */
import type { ReactElement } from 'react'
import type { Drawing, DrawingToolId, ToolImpl } from './types'
import type { Pt } from './helpers'
import {
  FONT_12,
  contrastText,
  crisp,
  drawHandles,
  fillArrowHead,
  formatPrice,
  formatTimeLabel,
  logicalSize,
  measureTextWidth,
  roundRectPath,
  strokeLine,
  toXY,
  withAlpha,
  wrapText,
} from './helpers'

// ---------------------------------------------------------------------------
// Shared text-box geometry
// ---------------------------------------------------------------------------

const MAX_CHARS = 26
const MAX_LINES = 3
const LINE_H = 16
const PAD_X = 8
const PAD_Y = 6

/** Theme up/down accents (match measure.ts) for the directional markers. */
const UP_COLOR = '#089981'
const DOWN_COLOR = '#f23645'

/**
 * The palette's "default"/neutral stroke colors. The directional markers fall
 * back to a semantic green/red only while the user is still on one of these;
 * any deliberately-chosen color is honored verbatim.
 */
const DEFAULT_COLORS = new Set(
  ['#2962ff', '#787b86', '#5d606b', '#b2b5be', '#ffffff', '#000000'].map((c) => c.toLowerCase()),
)

function isDefaultColor(color: string): boolean {
  return DEFAULT_COLORS.has(color.trim().toLowerCase())
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Measured text-box rects, cached during render so hitTest (which has no
 * canvas to measure with) can reuse them. Falls back to a char-width estimate
 * for drawings that have never rendered.
 */
const boxCache = new Map<string, Box>()

function cacheBox(id: string, box: Box): Box {
  if (boxCache.size > 512) boxCache.clear()
  boxCache.set(id, box)
  return box
}

/** Wrapped lines for a text-bearing tool, with a placeholder when empty. */
function textLines(d: Drawing, placeholder: string): { lines: string[]; isPlaceholder: boolean } {
  const raw = (d.text ?? '').trim()
  const isPlaceholder = raw.length === 0
  const lines = wrapText(isPlaceholder ? placeholder : raw, MAX_CHARS, MAX_LINES)
  const emoji = typeof d.props?.emoji === 'string' ? d.props.emoji.trim() : ''
  if (emoji.length > 0 && lines.length > 0) lines[0] = `${emoji} ${lines[0]}`
  return { lines, isPlaceholder }
}

/** Inner box size needed to hold `lines` of 12px text. */
function measureBox(ctx: CanvasRenderingContext2D, lines: string[]): { w: number; h: number } {
  ctx.font = FONT_12
  let textW = 0
  for (const l of lines) textW = Math.max(textW, measureTextWidth(ctx, FONT_12, l))
  return { w: textW + PAD_X * 2, h: lines.length * LINE_H + PAD_Y * 2 }
}

/** Char-width estimate for never-rendered drawings (hitTest fallback). */
function estimateSize(lines: string[]): { w: number; h: number } {
  let maxLen = 0
  for (const l of lines) maxLen = Math.max(maxLen, l.length)
  return { w: maxLen * 7 + PAD_X * 2, h: lines.length * LINE_H + PAD_Y * 2 }
}

/** Paint the wrapped lines inside a box at (bx, by), left-aligned. */
function fillLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  bx: number,
  by: number,
  color: string,
  isPlaceholder: boolean,
): void {
  ctx.font = FONT_12
  ctx.fillStyle = isPlaceholder ? withAlpha(ctx, color, 0.55) : color
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], bx + PAD_X, by + PAD_Y + LINE_H * (i + 0.5))
  }
}

function pointInBoxRect(x: number, y: number, b: Box, tol: number): boolean {
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol
}

// ---------------------------------------------------------------------------
// text — plain box at p0
// ---------------------------------------------------------------------------

const text: ToolImpl = {
  id: 'text',
  label: 'Text',
  group: 'annotate',
  pointsNeeded: 1,
  defaultProps: { emoji: '' },
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const { lines, isPlaceholder } = textLines(d, 'Text')
    const { w, h } = measureBox(ctx, lines)
    // p0 anchors the top-left corner of the text block.
    const bx = a.x
    const by = a.y
    const box = cacheBox(d.id, { x: bx, y: by, w, h })

    // Subtle background rect so text stays legible over candles.
    roundRectPath(ctx, box.x, box.y, box.w, box.h, 4)
    ctx.fillStyle = withAlpha(ctx, d.color, 0.08)
    ctx.fill()
    if (selected) {
      ctx.lineWidth = 1
      ctx.strokeStyle = withAlpha(ctx, d.color, 0.6)
      ctx.stroke()
    }

    fillLines(ctx, lines, box.x, box.y, d.color, isPlaceholder)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    const cached = boxCache.get(d.id)
    if (cached) return pointInBoxRect(x, y, cached, 2)
    const { lines } = textLines(d, 'Text')
    const { w, h } = estimateSize(lines)
    return pointInBoxRect(x, y, { x: a.x, y: a.y, w, h }, 2)
  },
}

// ---------------------------------------------------------------------------
// callout — bubble at p1 with a leader arrow to anchor p0
// ---------------------------------------------------------------------------

const callout: ToolImpl = {
  id: 'callout',
  label: 'Callout',
  group: 'annotate',
  pointsNeeded: 2,
  defaultProps: { emoji: '' },
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0]) // anchor (arrow tip)
    if (!d.points[1]) {
      // Partial: just the anchor dot until the bubble point lands.
      ctx.fillStyle = d.color
      ctx.beginPath()
      ctx.arc(a.x, a.y, Math.max(2, d.width + 1), 0, Math.PI * 2)
      ctx.fill()
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    const b = toXY(conv, d.points[1]) // bubble center

    const { lines, isPlaceholder } = textLines(d, 'Callout')
    const { w, h } = measureBox(ctx, lines)
    const bx = b.x - w / 2
    const by = b.y - h / 2
    const box = cacheBox(d.id, { x: bx, y: by, w, h })

    // Leader: from the nearest edge of the bubble to the anchor, with an arrow
    // head at the anchor end.
    const edge = nearestEdgePoint(box, a.x, a.y)
    ctx.lineWidth = Math.max(1, d.width)
    ctx.strokeStyle = d.color
    ctx.fillStyle = d.color
    const len = Math.hypot(a.x - edge.x, a.y - edge.y)
    if (len > 1) {
      const ang = Math.atan2(a.y - edge.y, a.x - edge.x)
      const head = 7
      const ux = (a.x - edge.x) / len
      const uy = (a.y - edge.y) / len
      strokeLine(ctx, edge.x, edge.y, a.x - ux * Math.min(head * 0.7, len), a.y - uy * Math.min(head * 0.7, len))
      fillArrowHead(ctx, a.x, a.y, ang, head)
    }

    // Bubble.
    roundRectPath(ctx, box.x, box.y, box.w, box.h, 6)
    ctx.fillStyle = withAlpha(ctx, d.color, 0.14)
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = selected ? d.color : withAlpha(ctx, d.color, 0.5)
    ctx.stroke()

    fillLines(ctx, lines, box.x, box.y, d.color, isPlaceholder)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    const b = toXY(conv, d.points[1])
    let box = boxCache.get(d.id)
    if (!box) {
      const { lines } = textLines(d, 'Callout')
      const { w, h } = estimateSize(lines)
      box = { x: b.x - w / 2, y: b.y - h / 2, w, h }
    }
    if (pointInBoxRect(x, y, box, 2)) return true
    // Leader line.
    const edge = nearestEdgePoint(box, a.x, a.y)
    return segDistLocal(x, y, edge, a) <= Math.max(6, d.width / 2 + 3)
  },
}

/** Point on the perimeter of `box` closest to the line toward (tx, ty). */
function nearestEdgePoint(box: Box, tx: number, ty: number): Pt {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const dx = tx - cx
  const dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  // Scale the direction so it lands on the nearest box edge.
  const hx = box.w / 2
  const hy = box.h / 2
  const sx = dx !== 0 ? hx / Math.abs(dx) : Infinity
  const sy = dy !== 0 ? hy / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s }
}

/** Local segment-distance (avoids importing both segDist and Pt twice). */
function segDistLocal(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

// ---------------------------------------------------------------------------
// comment — speech bubble (rounded rect + tail) at p0
// ---------------------------------------------------------------------------

const TAIL_W = 9
const TAIL_DROP = 12

const comment: ToolImpl = {
  id: 'comment',
  label: 'Comment',
  group: 'annotate',
  pointsNeeded: 1,
  defaultProps: { emoji: '' },
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0]) // tail tip sits at the anchor
    const { lines, isPlaceholder } = textLines(d, 'Comment')
    const { w, h } = measureBox(ctx, lines)
    // Bubble sits above the anchor; tail points down to p0.
    const bx = a.x - w / 2
    const by = a.y - TAIL_DROP - h
    const box = cacheBox(d.id, { x: bx, y: by, w, h })

    // Body.
    roundRectPath(ctx, box.x, box.y, box.w, box.h, 7)
    ctx.fillStyle = withAlpha(ctx, d.color, 0.14)
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = selected ? d.color : withAlpha(ctx, d.color, 0.5)
    ctx.stroke()

    // Tail (little triangle dropping from the bottom edge to the anchor).
    const tailBaseX = Math.min(Math.max(a.x, box.x + 8), box.x + box.w - 8)
    ctx.beginPath()
    ctx.moveTo(tailBaseX - TAIL_W / 2, box.y + box.h - 0.5)
    ctx.lineTo(tailBaseX + TAIL_W / 2, box.y + box.h - 0.5)
    ctx.lineTo(a.x, a.y)
    ctx.closePath()
    ctx.fillStyle = withAlpha(ctx, d.color, 0.14)
    ctx.fill()
    ctx.strokeStyle = selected ? d.color : withAlpha(ctx, d.color, 0.5)
    // Stroke only the two slanted sides so the join with the body stays clean.
    ctx.beginPath()
    ctx.moveTo(tailBaseX - TAIL_W / 2, box.y + box.h - 0.5)
    ctx.lineTo(a.x, a.y)
    ctx.lineTo(tailBaseX + TAIL_W / 2, box.y + box.h - 0.5)
    ctx.stroke()

    fillLines(ctx, lines, box.x, box.y, d.color, isPlaceholder)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    let box = boxCache.get(d.id)
    if (!box) {
      const { lines } = textLines(d, 'Comment')
      const { w, h } = estimateSize(lines)
      box = { x: a.x - w / 2, y: a.y - TAIL_DROP - h, w, h }
    }
    if (pointInBoxRect(x, y, box, 2)) return true
    // The tail / anchor region.
    return Math.abs(x - a.x) <= TAIL_W && y >= box.y + box.h - 2 && y <= a.y + 2
  },
}

// ---------------------------------------------------------------------------
// pricelabel — manual axis-style price tag on a horizontal tick at p0
// ---------------------------------------------------------------------------

const TICK_LEN = 14

const pricelabel: ToolImpl = {
  id: 'pricelabel',
  label: 'Price Label',
  group: 'annotate',
  pointsNeeded: 1,
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    const y = crisp(a.y, ctx.lineWidth)
    const txt = formatPrice(d.points[0].price, env.pricePrecision)

    // Short horizontal tick at the anchor.
    ctx.lineWidth = Math.max(1, d.width)
    ctx.strokeStyle = d.color
    strokeLine(ctx, a.x - TICK_LEN / 2, y, a.x + TICK_LEN / 2, y)

    // Tag pill to the right of the tick, vertically centered on it.
    ctx.font = FONT_12
    const padX = 6
    const tagW = measureTextWidth(ctx, FONT_12, txt) + padX * 2
    const tagH = 18
    const tx = a.x + TICK_LEN / 2 + 4
    const ty = y - tagH / 2
    cacheBox(d.id, { x: a.x - TICK_LEN / 2, y: ty, w: TICK_LEN / 2 + 4 + tagW, h: tagH })

    roundRectPath(ctx, tx, ty, tagW, tagH, 3)
    ctx.fillStyle = d.color
    ctx.fill()
    ctx.fillStyle = contrastText(ctx, d.color)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(txt, tx + padX, y + 0.5)

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv, env) {
    const a = toXY(conv, d.points[0])
    const cached = boxCache.get(d.id)
    if (cached) return pointInBoxRect(x, y, cached, 2)
    const w = formatPrice(d.points[0].price, env.pricePrecision).length * 7 + 12 + TICK_LEN
    return x >= a.x - TICK_LEN / 2 - 2 && x <= a.x + w && Math.abs(y - a.y) <= 11
  },
}

// ---------------------------------------------------------------------------
// signpost — vertical pole up to p0 topped with a flag label + date
// ---------------------------------------------------------------------------

const SIGNPOST_PADX = 8
const SIGNPOST_PADY = 5

const signpost: ToolImpl = {
  id: 'signpost',
  label: 'Signpost',
  group: 'annotate',
  pointsNeeded: 1,
  defaultProps: { emoji: '' },
  render(ctx, d, conv, selected, env) {
    const a = toXY(conv, d.points[0])
    const { h } = logicalSize(ctx)
    const x = crisp(a.x, ctx.lineWidth)

    // Pole from the bottom of the pane up to the anchor.
    ctx.lineWidth = Math.max(1, d.width)
    ctx.strokeStyle = d.color
    strokeLine(ctx, x, h, x, a.y)

    // Label content: user text (placeholder) + the anchor's date.
    const { lines, isPlaceholder } = textLines(d, 'Signpost')
    const dateLine = formatTimeLabel(d.points[0].time, env.barMs)
    ctx.font = FONT_12
    let textW = measureTextWidth(ctx, FONT_12, dateLine)
    for (const l of lines) textW = Math.max(textW, measureTextWidth(ctx, FONT_12, l))
    const boxW = textW + SIGNPOST_PADX * 2
    const rows = lines.length + 1 // + date row
    const boxH = rows * LINE_H + SIGNPOST_PADY * 2

    // Flag box sits at the top of the pole, offset to the right of the pole.
    const bx = x
    const by = a.y - boxH
    const box = cacheBox(d.id, { x: bx, y: by, w: boxW, h: boxH })

    roundRectPath(ctx, box.x, box.y, box.w, box.h, 4)
    ctx.fillStyle = withAlpha(ctx, d.color, 0.16)
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = selected ? d.color : withAlpha(ctx, d.color, 0.55)
    ctx.stroke()

    // Body text.
    ctx.font = FONT_12
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < lines.length; i++) {
      ctx.fillStyle = isPlaceholder ? withAlpha(ctx, d.color, 0.55) : d.color
      ctx.fillText(lines[i], box.x + SIGNPOST_PADX, box.y + SIGNPOST_PADY + LINE_H * (i + 0.5))
    }
    // Date row, dimmed.
    ctx.fillStyle = withAlpha(ctx, d.color, 0.7)
    ctx.fillText(dateLine, box.x + SIGNPOST_PADX, box.y + SIGNPOST_PADY + LINE_H * (lines.length + 0.5))

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    const cached = boxCache.get(d.id)
    if (cached && pointInBoxRect(x, y, cached, 2)) return true
    // The pole itself (from the anchor downward).
    return Math.abs(x - a.x) <= Math.max(6, d.width / 2 + 3) && y >= a.y - 2
  },
}

// ---------------------------------------------------------------------------
// arrowup / arrowdown — directional marker glyphs at p0 (no text)
// ---------------------------------------------------------------------------

const MARKER_SIZE = 13 // half-height of the arrow glyph

function markerColor(d: Drawing, bullish: boolean): string {
  if (isDefaultColor(d.color)) return bullish ? UP_COLOR : DOWN_COLOR
  return d.color
}

/** Filled chevron arrow centered horizontally on `x`, tip at `tipY`. */
function drawMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  tipY: number,
  up: boolean,
  color: string,
): void {
  const s = MARKER_SIZE
  const dir = up ? 1 : -1 // tail extends downward for up-arrow, upward for down
  const halfW = s * 0.62
  const stemW = s * 0.26
  const tip = tipY
  const shoulder = tipY + dir * s * 0.7
  const tail = tipY + dir * s * 1.6
  ctx.beginPath()
  ctx.moveTo(x, tip) // tip
  ctx.lineTo(x - halfW, shoulder) // left shoulder
  ctx.lineTo(x - stemW, shoulder) // left inner
  ctx.lineTo(x - stemW, tail) // left tail
  ctx.lineTo(x + stemW, tail) // right tail
  ctx.lineTo(x + stemW, shoulder) // right inner
  ctx.lineTo(x + halfW, shoulder) // right shoulder
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = 1
  ctx.lineJoin = 'round'
  ctx.strokeStyle = withAlpha(ctx, color, 0.9)
  ctx.stroke()
}

const arrowup: ToolImpl = {
  id: 'arrowup',
  label: 'Arrow Up',
  group: 'annotate',
  pointsNeeded: 1,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    // Bullish arrow points UP, with its tip just above the anchor.
    drawMarker(ctx, a.x, a.y, true, markerColor(d, true))
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    return Math.abs(x - a.x) <= MARKER_SIZE * 0.7 + 3 && y >= a.y - 3 && y <= a.y + MARKER_SIZE * 1.6 + 3
  },
}

const arrowdown: ToolImpl = {
  id: 'arrowdown',
  label: 'Arrow Down',
  group: 'annotate',
  pointsNeeded: 1,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    // Bearish arrow points DOWN, tip just below the anchor.
    drawMarker(ctx, a.x, a.y, false, markerColor(d, false))
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    return Math.abs(x - a.x) <= MARKER_SIZE * 0.7 + 3 && y <= a.y + 3 && y >= a.y - MARKER_SIZE * 1.6 - 3
  },
}

// ---------------------------------------------------------------------------
// flag — flag-on-a-pole marker at p0 (filled with d.color)
// ---------------------------------------------------------------------------

const FLAG_POLE = 22
const FLAG_W = 14
const FLAG_H = 10

const flag: ToolImpl = {
  id: 'flag',
  label: 'Flag',
  group: 'annotate',
  pointsNeeded: 1,
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const x = crisp(a.x, ctx.lineWidth)
    const topY = a.y - FLAG_POLE

    // Pole rising from the anchor.
    ctx.lineWidth = Math.max(1.5, d.width)
    ctx.strokeStyle = d.color
    ctx.lineCap = 'round'
    strokeLine(ctx, x, a.y, x, topY)

    // Pennant filled with d.color, hanging from the top of the pole.
    ctx.beginPath()
    ctx.moveTo(x, topY)
    ctx.lineTo(x + FLAG_W, topY + FLAG_H / 2)
    ctx.lineTo(x, topY + FLAG_H)
    ctx.closePath()
    ctx.fillStyle = d.color
    ctx.fill()

    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    const topY = a.y - FLAG_POLE
    // Pole or pennant bounding region.
    const onPole = Math.abs(x - a.x) <= Math.max(6, d.width / 2 + 3) && y >= topY - 2 && y <= a.y + 2
    const onFlag = x >= a.x - 2 && x <= a.x + FLAG_W + 2 && y >= topY - 2 && y <= topY + FLAG_H + 2
    return onPole || onFlag
  },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ANNOTATE2_IMPLS: ToolImpl[] = [
  text,
  callout,
  comment,
  pricelabel,
  signpost,
  arrowup,
  arrowdown,
  flag,
]

// ---------------------------------------------------------------------------
// Icons — 18x18, stroke = currentColor (match src/components/toolIcons.tsx)
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

export const ANNOTATE2_ICONS: Partial<Record<DrawingToolId, ReactElement>> = {
  text: (
    <svg {...S}>
      <line x1="4" y1="4" x2="14" y2="4" />
      <line x1="9" y1="4" x2="9" y2="14" />
    </svg>
  ),
  callout: (
    <svg {...S}>
      <rect x="6" y="2.5" width="9.5" height="7" rx="1.5" />
      <line x1="6" y1="8" x2="2.5" y2="15.5" />
    </svg>
  ),
  comment: (
    <svg {...S}>
      <path d="M3 3.5h12a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3.5 3.5v-3.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" />
    </svg>
  ),
  pricelabel: (
    <svg {...S}>
      <line x1="2" y1="9" x2="6" y2="9" />
      <rect x="6.5" y="6" width="9" height="6" rx="1" />
      <line x1="8.5" y1="9" x2="13.5" y2="9" />
    </svg>
  ),
  signpost: (
    <svg {...S}>
      <line x1="6" y1="16" x2="6" y2="3" />
      <rect x="6" y="2.5" width="9.5" height="6" rx="1" />
    </svg>
  ),
  arrowup: (
    <svg {...S}>
      <line x1="9" y1="15.5" x2="9" y2="3.5" />
      <polyline points="4.5,8 9,3.5 13.5,8" />
    </svg>
  ),
  arrowdown: (
    <svg {...S}>
      <line x1="9" y1="2.5" x2="9" y2="14.5" />
      <polyline points="4.5,10 9,14.5 13.5,10" />
    </svg>
  ),
  flag: (
    <svg {...S}>
      <line x1="5" y1="16" x2="5" y2="2.5" />
      <path d="M5 3h8l-2.5 3L13 9H5z" />
    </svg>
  ),
}
