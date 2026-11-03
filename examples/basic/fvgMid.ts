// "FVG Midpoints" — Indicators-menu entry ported from FVG-mid.pine.
// Math: src/overlays/fvgMidModel.ts. Drawn through the canvas-indicator hook
// (see CanvasSource in custom-indicators.ts): a line at each fair-value-gap
// midpoint, removed once price trades through it, as in the Pine script.
//
// Added to the port (all optional, Pine behaviour by default): line length
// "until mitigated" / "to the right edge", faint lines for mitigated midpoints
// ending at the touch, price tags, and colour / width / style.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { FVG_MID_DEFAULTS, computeFvgMid, type FvgMid, type FvgMidResult } from '../../src/overlays/fvgMidModel'
import { COL, PALETTE, colorOpts } from './flyingCpr'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const D = FVG_MID_DEFAULTS
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
const pick = (key: string, label: string, def: number, group: string, options: { value: number; label: string }[]): IndicatorParam => ({ key, label, default: def, group, options })

const G_IN = 'Inputs'
const G_ST = 'Style'

export const fvgMid: IndicatorDef = {
  id: 'fvg_midpoints',
  label: 'FVG Midpoints (Clean & Stable)',
  shortLabel: 'FVG Mid',
  placement: 'overlay',
  params: [
    toggle('bullish', 'Show Bullish Midpoints', D.bullish, G_IN),
    toggle('bearish', 'Show Bearish Midpoints', D.bearish, G_IN),
    num('maxLines', 'Max Midpoints (per side)', D.maxLines, G_IN, 1, 5000, 1),
    num('extendBars', 'Extend Bars', 10, G_IN, 1, 2000, 1),
    toggle('removeOnMitigation', 'Remove Midpoint on Mitigation', D.removeOnMitigation, G_IN),

    pick('lineLength', 'Line length', 0, G_ST, [
      { value: 0, label: 'Extend Bars (as Pine)' },
      { value: 1, label: 'To the right edge' },
    ]),
    toggle('showMitigated', 'Show mitigated midpoints (faint, ending at the touch)', false, G_ST),
    pick('bullColor', 'Bullish colour', COL.Green, G_ST, colorOpts),
    pick('bearColor', 'Bearish colour', COL.Red, G_ST, colorOpts),
    pick('width', 'Width', 1, G_ST, [1, 2, 3, 4].map((w) => ({ value: w, label: `${w}px` }))),
    pick('style', 'Style', 0, G_ST, [
      { value: 0, label: 'Solid' },
      { value: 1, label: 'Dashed' },
      { value: 2, label: 'Dotted' },
    ]),
    num('opacity', 'Opacity %', 100, G_ST, 10, 100, 5),
    toggle('labels', 'Price tags on active midpoints', false, G_ST),
  ],
  compute: () => [],
}

interface Display {
  extendBars: number
  toRightEdge: boolean
  showMitigated: boolean
  bull: string
  bear: string
  width: number
  dash: number[]
  alpha: number
  labels: boolean
}

export interface FvgMidModel {
  display: Display
  result: FvgMidResult
}

const DASHES = [[], [6, 4], [1.5, 3]]
const rgba = (hex: string, a: number): string => {
  const v = parseInt(hex.slice(1), 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`
}
const fmtPrice = (v: number): string => (v >= 10 ? v.toFixed(2) : v.toPrecision(5))

export function computeFvgMidModel(candles: Candle[], p: Record<string, number>, _ctx: CanvasIndicatorContext): FvgMidModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const col = (k: string, d: number): string => (PALETTE[Math.round(n(k, d))] ?? PALETTE[d])[1]
  return {
    result: computeFvgMid(candles, {
      bullish: b('bullish', D.bullish),
      bearish: b('bearish', D.bearish),
      maxLines: Math.max(1, Math.round(n('maxLines', D.maxLines))),
      removeOnMitigation: b('removeOnMitigation', D.removeOnMitigation),
    }),
    display: {
      extendBars: Math.max(1, Math.round(n('extendBars', 10))),
      toRightEdge: Math.round(n('lineLength', 0)) === 1,
      showMitigated: b('showMitigated', false),
      bull: col('bullColor', COL.Green),
      bear: col('bearColor', COL.Red),
      width: n('width', 1),
      dash: DASHES[Math.round(n('style', 0))] ?? [],
      alpha: Math.min(1, Math.max(0.1, n('opacity', 100) / 100)),
      labels: b('labels', false),
    },
  }
}

export function drawFvgMid(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: FvgMidModel, _ctx: CanvasIndicatorContext): void {
  const n = candles.length
  if (n < 3) return
  const { display: s, result: r } = model
  const right = rect.x + rect.width
  const barW = Math.abs(conv.timeToX(candles[1].time) - conv.timeToX(candles[0].time)) || 6
  const X = (i: number): number => conv.timeToX(candles[Math.min(i, n - 1)].time)
  // x of bar index i, continuing past the last bar for lines that reach into the future (Pine's bar_index + extendBars)
  const xAt = (i: number): number => (i <= n - 1 ? X(i) : X(n - 1) + (i - (n - 1)) * barW)
  const endOf = (m: FvgMid): number => (s.toRightEdge ? right : xAt(m.index + s.extendBars))

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  const line = (m: FvgMid, endX: number, alpha: number): void => {
    const x1 = X(m.index)
    if (endX < rect.x || x1 > right) return
    const y = Math.round(conv.priceToY(m.price)) + 0.5
    if (y < rect.y || y > rect.y + rect.height) return
    g.strokeStyle = rgba(m.side > 0 ? s.bull : s.bear, alpha)
    g.lineWidth = s.width
    g.setLineDash(s.dash)
    g.beginPath()
    g.moveTo(x1, y)
    g.lineTo(endX, y)
    g.stroke()
  }

  // active midpoints (Pine's on-chart set)
  for (const m of r.active) line(m, endOf(m), s.alpha)
  // mitigated ones, faint, ending where price touched them
  if (s.showMitigated) for (const m of r.all) if (m.mitigatedAt !== null) line(m, Math.min(endOf(m), X(m.mitigatedAt)), s.alpha * 0.35)
  g.setLineDash([])

  if (s.labels) {
    g.font = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    g.textBaseline = 'middle'
    g.textAlign = 'left'
    for (const m of r.active) {
      const y = conv.priceToY(m.price)
      if (y < rect.y || y > rect.y + rect.height) continue
      const text = fmtPrice(m.price)
      const w = g.measureText(text).width + 8
      const x = Math.min(endOf(m) + 3, right - w - 2)
      if (x + w < rect.x) continue
      g.fillStyle = rgba(m.side > 0 ? s.bull : s.bear, 0.9)
      g.beginPath()
      g.roundRect(x, y - 7, w, 14, 3)
      g.fill()
      g.fillStyle = '#fff'
      g.fillText(text, x + 4, y + 0.5)
    }
  }
  g.restore()
}
