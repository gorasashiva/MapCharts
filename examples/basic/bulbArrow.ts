// "Bulb and arrow" — Indicators-menu entry ported from bulbandarrow.pine.
// Math: src/overlays/bulbArrowModel.ts. Drawn through the canvas-indicator hook
// (see CanvasSource in custom-indicators.ts): RSI-SMA cross arrows, Oikio bulbs,
// arrow confirmations and the optional Reversal Zone labels + zigzag.
//
// Not ported: alertcondition() (no alert hook for canvas indicators) and the
// input.source() picker — the RSI source is fixed to close.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { BULB_ARROW_DEFAULTS, computeBulbArrow, type BulbArrowResult, type SwingPoint } from '../../src/overlays/bulbArrowModel'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const D = BULB_ARROW_DEFAULTS
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })

const G_RSI = 'RSI SMA Cross'
const G_BULB = 'Oikio Bulb'

export const bulbArrow: IndicatorDef = {
  id: 'bulb_and_arrow',
  label: 'Bulb and arrow',
  shortLabel: 'Bulb&Arrow',
  placement: 'overlay',
  params: [
    toggle('showCross', 'RSI SMA cross arrows', true, G_RSI),
    num('rsiLength', 'RSI Length', D.rsiLength, G_RSI, 1, 200, 1),
    num('smaLength', 'RSI SMA Length', D.smaLength, G_RSI, 1, 200, 1),
    toggle('bulb', 'Bulb', true, G_BULB),
    num('bulbSize', 'Bulb size (px)', 7, G_BULB, 2, 20, 1),
    toggle('arrow', 'Arrow Confirm', true, G_BULB),
    toggle('reversal', 'Reversal Zone', false, G_BULB),
    num('overbought', 'Overbought (RSI ≥)', D.overbought, G_BULB, 50, 100, 1),
    num('oversold', 'Oversold (RSI ≤)', D.oversold, G_BULB, 0, 50, 1),
  ],
  compute: () => [],
}

interface Display {
  showCross: boolean
  bulb: boolean
  bulbSize: number
  arrow: boolean
  reversal: boolean
}

export interface BulbArrowModel {
  display: Display
  result: BulbArrowResult
}

export function computeBulbArrowModel(candles: Candle[], p: Record<string, number>, _ctx: CanvasIndicatorContext): BulbArrowModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  return {
    display: { showCross: b('showCross', true), bulb: b('bulb', true), bulbSize: Math.max(2, n('bulbSize', 7)), arrow: b('arrow', true), reversal: b('reversal', false) },
    result: computeBulbArrow(candles, {
      ...D,
      rsiLength: Math.max(1, Math.round(n('rsiLength', D.rsiLength))),
      smaLength: Math.max(1, Math.round(n('smaLength', D.smaLength))),
      overbought: n('overbought', D.overbought),
      oversold: n('oversold', D.oversold),
    }),
  }
}

// ---------------------------------------------------------------------------
// Drawing (Pine palette: upcolor #3eff3b, downcolor #ff3b3b, plotshape green/red)
// ---------------------------------------------------------------------------
const C = {
  buy: '#4caf50',
  sell: '#f23645',
  up: '#3eff3b',
  down: '#ff3b3b',
  upBulb: 'rgba(62, 255, 59, 0.5)',
  downBulb: 'rgba(255, 59, 59, 0.5)',
  zigzag: '#2962ff',
}
const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const GAP = 4 // px between the bar and the first marker

/** Pine shape.arrowup / arrowdown: head + shaft, tip at (x, y). */
function arrow(g: CanvasRenderingContext2D, x: number, y: number, up: boolean, color: string): void {
  const d = up ? 1 : -1
  g.fillStyle = color
  g.beginPath()
  g.moveTo(x, y)
  g.lineTo(x - 5, y + d * 7)
  g.lineTo(x - 2, y + d * 7)
  g.lineTo(x - 2, y + d * 14)
  g.lineTo(x + 2, y + d * 14)
  g.lineTo(x + 2, y + d * 7)
  g.lineTo(x + 5, y + d * 7)
  g.closePath()
  g.fill()
}

/** Pine label.style_triangleup / down (size.tiny), tip pointing at the bar. */
function triangle(g: CanvasRenderingContext2D, x: number, y: number, up: boolean, color: string): void {
  const d = up ? 1 : -1
  g.fillStyle = color
  g.beginPath()
  g.moveTo(x, y)
  g.lineTo(x - 4, y + d * 7)
  g.lineTo(x + 4, y + d * 7)
  g.closePath()
  g.fill()
}

/** Pine label.style_label_down / up with text: box plus a pointer toward the bar. */
function zoneLabel(g: CanvasRenderingContext2D, x: number, y: number, above: boolean, color: string): void {
  const text = 'Reversal Zone'
  g.font = FONT
  const w = g.measureText(text).width + 10
  const h = 16
  const top = above ? y - 5 - h : y + 5
  g.fillStyle = color
  g.beginPath()
  g.roundRect(x - w / 2, top, w, h, 3)
  g.moveTo(x - 4, above ? top + h : top)
  g.lineTo(x, y)
  g.lineTo(x + 4, above ? top + h : top)
  g.fill()
  g.fillStyle = '#fff'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, x, top + h / 2 + 0.5)
}

export function drawBulbArrow(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: BulbArrowModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  const { display: s, result: r } = model
  const t0 = conv.xToTime(rect.x - 50)
  const t1 = conv.xToTime(rect.x + rect.width + 50)
  const visible = (i: number): boolean => candles[i].time >= t0 && candles[i].time <= t1
  const X = (i: number): number => conv.timeToX(candles[i].time)
  const Y = (p: number): number => conv.priceToY(p)

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  // Offset (px) taken by markers already stacked above / below each bar.
  const above = new Map<number, number>()
  const below = new Map<number, number>()
  const stack = (m: Map<number, number>, i: number, h: number): number => {
    const used = m.get(i) ?? 0
    m.set(i, used + h + 2)
    return GAP + used
  }

  // Reversal Zone: zigzag between consecutive swings, then the labels.
  if (s.reversal) {
    g.strokeStyle = C.zigzag
    g.lineWidth = 1
    for (let k = 1; k < r.zones.length; k++) {
      const a = r.zones[k - 1]
      const b = r.zones[k]
      if (!visible(a.index) && !visible(b.index)) continue
      g.beginPath()
      g.moveTo(X(a.index), Y(a.price))
      g.lineTo(X(b.index), Y(b.price))
      g.stroke()
    }
    for (const z of r.zones) {
      if (!visible(z.index)) continue
      const hiSide = z.dir > 0
      const off = stack(hiSide ? above : below, z.index, 22)
      const c = candles[z.index]
      zoneLabel(g, X(z.index), hiSide ? Y(c.high) - off : Y(c.low) + off, hiSide, hiSide ? C.down : C.up)
    }
  }

  // Arrow confirm: tiny triangles on the RSI(15) swing bars.
  if (s.arrow) {
    for (const z of r.zones) {
      if (!visible(z.index)) continue
      const c = candles[z.index]
      if (z.dir > 0) triangle(g, X(z.index), Y(c.high) - stack(above, z.index, 7), false, C.down)
      else triangle(g, X(z.index), Y(c.low) + stack(below, z.index, 7), true, C.up)
    }
  }

  // RSI-SMA cross arrows.
  if (s.showCross) {
    for (const i of r.buys) if (visible(i)) arrow(g, X(i), Y(candles[i].low) + stack(below, i, 14), true, C.buy)
    for (const i of r.sells) if (visible(i)) arrow(g, X(i), Y(candles[i].high) - stack(above, i, 14), false, C.sell)
  }

  // Bulbs: translucent dots at the RSI(7) swing price.
  if (s.bulb) {
    const dot = (p: SwingPoint): void => {
      g.fillStyle = p.dir > 0 ? C.downBulb : C.upBulb
      g.beginPath()
      g.arc(X(p.index), Y(p.price), s.bulbSize, 0, Math.PI * 2)
      g.fill()
    }
    for (const p of r.bulbs) if (visible(p.index)) dot(p)
  }

  g.restore()
}
