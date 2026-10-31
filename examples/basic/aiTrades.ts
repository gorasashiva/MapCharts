// "AI Trades" — Indicators-menu entry ported from "AI trades.pine" (SUNDARI AI v5.8 - ATR Trailing SL).
// Math: src/overlays/aiTradesModel.ts. Drawn through the canvas-indicator hook
// (see CanvasSource in custom-indicators.ts): EMA fast / slow, BUY / SELL triangles,
// the step line, T1–T4 target lines and the live ATR trailing-stop segment.
//
// Not ported: the "Min Val" and table inputs (the script draws no tables), and the
// raw-ATR plot (an ATR value can't share the price scale). "Plot Target Lines" and
// "Extend Targets by Bars" are declared but unused in the script; here they hide the
// targets and extend the current signal's targets past the last bar.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { INTERVAL_MS, type Interval } from '../../src/core/types'
import { AI_TRADES_DEFAULTS, computeAiTrades, type AiTradesOptions, type AiTradesResult } from '../../src/overlays/aiTradesModel'
import { detectChartSec } from '../../src/overlays/mtfCisdModel'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const D = AI_TRADES_DEFAULTS
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })

const G_S = 'Signals'
const G_T = 'Targets'
const G_A = 'ATR trailing SL'

export const aiTrades: IndicatorDef = {
  id: 'ai_trades',
  label: 'AI Trades (SUNDARI AI v5.8)',
  shortLabel: 'AI Trades',
  placement: 'overlay',
  params: [
    num('f1', 'F1 Parameter', D.f1, G_S, 1, 500, 1),
    num('f2', 'F2 Parameter', D.f2, G_S, 1, 500, 1),
    num('f3', 'F3 Parameter', D.f3, G_S, 1, 500, 1),
    toggle('confirmOnClose', 'Confirm Signals on Close (no intrabar repaint)', D.confirmOnClose, G_S),

    toggle('plotTargets', 'Plot Target Lines', true, G_T),
    num('extendBars', 'Extend Targets by Bars', 5, G_T, 1, 100, 1),

    num('atrLen', 'ATR Length', D.atrLen, G_A, 1, 200, 1),
    num('atrMult', 'ATR Multiplier', D.atrMult, G_A, 0.1, 20, 0.1),
    toggle('showAtrSl', 'Show ATR Trailing SL', true, G_A),
  ],
  compute: () => [],
}

export interface AiTradesModel {
  plotTargets: boolean
  extendBars: number
  showAtrSl: boolean
  /** Bar spacing, ms — places the right-hand extensions past the last bar. */
  barMs: number
  result: AiTradesResult
}

export function computeAiTradesModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): AiTradesModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const opts: AiTradesOptions = {
    f1: Math.max(1, Math.round(n('f1', D.f1))),
    f2: Math.max(1, Math.round(n('f2', D.f2))),
    f3: Math.max(1, Math.round(n('f3', D.f3))),
    atrLen: Math.max(1, Math.round(n('atrLen', D.atrLen))),
    atrMult: n('atrMult', D.atrMult),
    confirmOnClose: b('confirmOnClose', D.confirmOnClose),
  }
  const intervalMs = ctx.interval ? INTERVAL_MS[ctx.interval as Interval] : undefined
  return {
    plotTargets: b('plotTargets', true),
    extendBars: Math.max(1, Math.round(n('extendBars', 5))),
    showAtrSl: b('showAtrSl', true),
    barMs: intervalMs ?? detectChartSec(candles) * 1000,
    result: computeAiTrades(candles, opts),
  }
}

// ---------------------------------------------------------------------------
// Drawing — Pine v5 palette
// ---------------------------------------------------------------------------
const C = {
  buy: '#4CAF50',
  sell: '#FF5252',
  step: 'rgba(120, 123, 134, 0.8)', // color.new(gray, 20)
  emaFast: 'rgba(33, 150, 243, 0.15)', // color.new(blue, 85)
  emaSlow: 'rgba(255, 152, 0, 0.15)', // color.new(orange, 85)
  sl: '#FF9800',
}
/** Pine max_lines_count = 500: four target lines per signal, one for the ATR SL. */
const MAX_TARGET_SETS = 124
const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

/** First index whose time is >= t. */
function lowerBound(candles: Candle[], t: number): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (candles[m].time < t) lo = m + 1
    else hi = m
  }
  return lo
}

/** Pine shape.triangleup / down at size.small, tip toward the bar. */
function triangle(g: CanvasRenderingContext2D, x: number, y: number, up: boolean, color: string): void {
  const w = 6
  const h = 9
  g.fillStyle = color
  g.beginPath()
  if (up) {
    g.moveTo(x, y)
    g.lineTo(x - w, y + h)
    g.lineTo(x + w, y + h)
  } else {
    g.moveTo(x, y)
    g.lineTo(x - w, y - h)
    g.lineTo(x + w, y - h)
  }
  g.closePath()
  g.fill()
}

export function drawAiTrades(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: AiTradesModel, ctx: CanvasIndicatorContext): void {
  const n = candles.length
  if (n < 2) return
  const r = model.result
  const last = n - 1
  const X = (i: number): number => (i <= last ? conv.timeToX(candles[i].time) : conv.timeToX(candles[last].time + (i - last) * model.barMs))
  const Y = (p: number): number => conv.priceToY(p)
  const i0 = Math.max(0, lowerBound(candles, conv.xToTime(rect.x)) - 1)
  const i1 = Math.min(last, lowerBound(candles, conv.xToTime(rect.x + rect.width)) + 1)

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  g.lineJoin = 'round'

  // EMA fast / slow (faint, as the script's 85% transparency)
  const series = (v: number[], color: string): void => {
    g.strokeStyle = color
    g.lineWidth = 1
    g.beginPath()
    let pen = false
    for (let i = i0; i <= i1; i++) {
      if (!Number.isFinite(v[i])) {
        pen = false
        continue
      }
      if (pen) g.lineTo(X(i), Y(v[i]))
      else g.moveTo(X(i), Y(v[i]))
      pen = true
    }
    g.stroke()
  }
  series(r.fast, C.emaFast)
  series(r.slow, C.emaSlow)

  // Step line: hold the value, jump at the signal bar
  g.strokeStyle = C.step
  g.lineWidth = 2
  g.beginPath()
  for (let i = Math.max(1, i0); i <= i1; i++) {
    const a = r.step[i - 1]
    const b = r.step[i]
    if (!Number.isFinite(b)) continue
    if (!Number.isFinite(a)) {
      g.moveTo(X(i), Y(b))
      continue
    }
    g.moveTo(X(i - 1), Y(a))
    g.lineTo(X(i), Y(a))
    g.lineTo(X(i), Y(b))
  }
  g.stroke()

  g.font = FONT
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  let gutter = 0

  // T1–T4 targets: each signal's set runs until the next signal; the current set extends past the last bar
  if (model.plotTargets) {
    const sets = r.signals.slice(-MAX_TARGET_SETS)
    for (let k = 0; k < sets.length; k++) {
      const s = sets[k]
      const active = k === sets.length - 1
      const end = active ? last + model.extendBars : s.end
      if (end < i0 || s.index > i1) continue
      const color = s.dir > 0 ? C.buy : C.sell
      const x1 = X(s.index)
      const x2 = X(end)
      g.strokeStyle = color
      g.fillStyle = color
      g.lineWidth = 1
      s.targets.forEach((p, t) => {
        const y = Math.round(Y(p)) + 0.5
        g.beginPath()
        g.moveTo(x1, y)
        g.lineTo(x2, y)
        g.stroke()
        g.fillText(`T${t + 1}`, x2, y)
      })
      if (active) gutter = Math.max(gutter, x2 - X(last) + g.measureText('T4').width / 2 + 6)
    }
  }

  // ATR trailing SL: the live value, from the previous bar to 5 bars past the last
  if (model.showAtrSl && Number.isFinite(r.trail[last])) {
    const y = Math.round(Y(r.trail[last])) + 0.5
    const x2 = X(last + 5)
    g.strokeStyle = C.sl
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(X(last - 1), y)
    g.lineTo(x2, y)
    g.stroke()
    // Label just past the line end, so it never sits on the T1–T4 labels (centred on their line ends).
    g.fillStyle = C.sl
    g.textAlign = 'left'
    g.fillText('ATR SL', x2 + 8, y)
    g.textAlign = 'center'
    gutter = Math.max(gutter, x2 - X(last) + 8 + g.measureText('ATR SL').width + 6)
  }
  if (gutter > 0) ctx.ensureRightGutter?.(Math.ceil(gutter))

  // BUY below the bar, SELL above it
  for (const s of r.signals) {
    if (s.index < i0 || s.index > i1) continue
    const c = candles[s.index]
    if (s.dir > 0) triangle(g, X(s.index), Y(c.low) + 4, true, C.buy)
    else triangle(g, X(s.index), Y(c.high) - 4, false, C.sell)
  }
  g.restore()
}
