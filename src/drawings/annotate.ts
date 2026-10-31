/**
 * Annotation tools: note — a map-pin anchor with a rounded text bubble.
 */
import type { Drawing, ToolImpl } from './types'
import { FONT_11, roundRectPath, toXY, withAlpha, wrapText } from './helpers'

const MAX_CHARS = 24
const MAX_LINES = 3
const LINE_H = 15
const PAD_X = 8
const PAD_Y = 6
const BUBBLE_GAP = 12 // px between the pin and the bubble's left edge
const PIN_R = 6.5
const PIN_RISE = 15 // pin-head center sits this far above the anchor

interface BubbleRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Bubble rects measured during render, reused by hitTest (which has no canvas
 * context to measure text with). Falls back to a char-width estimate for
 * drawings that have never rendered.
 */
const bubbleCache = new Map<string, BubbleRect>()

function noteLines(d: Drawing): { lines: string[]; placeholder: boolean } {
  const raw = (d.text ?? '').trim()
  const placeholder = raw.length === 0
  const lines = wrapText(placeholder ? 'Note' : raw, MAX_CHARS, MAX_LINES)
  const emoji = typeof d.props?.emoji === 'string' ? d.props.emoji.trim() : ''
  if (emoji.length > 0) lines[0] = `${emoji} ${lines[0]}`
  return { lines, placeholder }
}

function estimateBubble(d: Drawing, px: number, py: number): BubbleRect {
  const { lines } = noteLines(d)
  let maxLen = 0
  for (const l of lines) maxLen = Math.max(maxLen, l.length)
  const w = maxLen * 6.5 + PAD_X * 2
  const h = lines.length * LINE_H + PAD_Y * 2
  return { x: px + BUBBLE_GAP, y: py - PIN_RISE - h / 2, w, h }
}

const note: ToolImpl = {
  id: 'note',
  label: 'Note',
  group: 'annotate',
  pointsNeeded: 1,
  defaultProps: { emoji: '' },
  render(ctx, d, conv, selected) {
    const a = toXY(conv, d.points[0])
    const headY = a.y - PIN_RISE

    // Map-pin glyph: teardrop with its tip at the anchor, dot in the head.
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(a.x - PIN_R, a.y - 9, a.x - PIN_R, headY)
    ctx.arc(a.x, headY, PIN_R, Math.PI, 0, false)
    ctx.quadraticCurveTo(a.x + PIN_R, a.y - 9, a.x, a.y)
    ctx.closePath()
    ctx.fillStyle = d.color
    ctx.fill()
    ctx.beginPath()
    ctx.arc(a.x, headY, 2.4, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()

    // Text bubble to the right of the pin.
    const { lines, placeholder } = noteLines(d)
    ctx.font = FONT_11
    let textW = 0
    for (const l of lines) textW = Math.max(textW, ctx.measureText(l).width)
    const w = textW + PAD_X * 2
    const h = lines.length * LINE_H + PAD_Y * 2
    const bx = a.x + BUBBLE_GAP
    const by = headY - h / 2
    if (bubbleCache.size > 512) bubbleCache.clear()
    bubbleCache.set(d.id, { x: bx, y: by, w, h })

    roundRectPath(ctx, bx, by, w, h, 6)
    ctx.fillStyle = withAlpha(ctx, d.color, 0.14)
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = selected ? d.color : withAlpha(ctx, d.color, 0.35)
    ctx.stroke()

    ctx.fillStyle = placeholder ? withAlpha(ctx, d.color, 0.55) : d.color
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], bx + PAD_X, by + PAD_Y + LINE_H * (i + 0.5))
    }
  },
  hitTest(d, x, y, conv) {
    const a = toXY(conv, d.points[0])
    // The pin body…
    if (Math.abs(x - a.x) <= PIN_R + 3 && y >= a.y - PIN_RISE - PIN_R - 3 && y <= a.y + 3) {
      return true
    }
    // …or anywhere inside the bubble.
    const r = bubbleCache.get(d.id) ?? estimateBubble(d, a.x, a.y)
    return x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y - 2 && y <= r.y + r.h + 2
  },
}

export const ANNOTATE_IMPLS: ToolImpl[] = [note]
