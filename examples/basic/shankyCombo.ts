// "Shankys Combo" — port of "shanky combo.pine" as an Indicators-menu entry.
// Math: src/overlays/shankyComboModel.ts. Its plots need per-bar colours,
// dots, fills, bar colouring, zigzag lines, labels and boxes — beyond the
// line-only IndicatorOutput — so it draws through the canvas-indicator hook
// (see CanvasSource in custom-indicators.ts) on the chart-synced overlay.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import {
  SHANKY_ATR_SMOOTHING,
  SHANKY_DEFAULTS,
  SHANKY_MA,
  SHANKY_ZZ_ATR,
  computeShankyCombo,
  type ShankyMa,
  type ShankyOptions,
  type ShankyResult,
} from '../../src/overlays/shankyComboModel'
import { sessionClosedWeekends, sessionOpenHourUTC } from '../../src/core/session'

type Rect = { x: number; y: number; width: number; height: number }

export interface CanvasIndicatorContext {
  symbol: string
  chartType: string
  /** Draw-time only: reserve blank px right of the last bar (see IChartEngine.ensureRightGutter). */
  ensureRightGutter?: (px: number) => void
  /** Chart interval ('1m', '5m', …). */
  interval?: string
  /** Box size of the Renko bricks on screen (0 when the chart type isn't Renko). */
  renkoBox?: number
  /** Draw-time only: x (CSS px) of the center of drawn-series bar `index` (a brick index on Renko). */
  barX?: (index: number) => number
}

const D = SHANKY_DEFAULTS
const maOpts = (list: readonly ShankyMa[]): { value: number; label: string }[] => list.map((m) => ({ value: SHANKY_MA.indexOf(m), label: m }))
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })

const G_CPR = 'CPR'
const G_ZZ = 'Auto Buy Sell (zigzag)'
const G_RB = 'Rainbow'

export const shankyCombo: IndicatorDef = {
  id: 'shanky_combo',
  label: 'Shankys Combo (CPR + Auto Buy Sell + Rainbow)',
  shortLabel: 'Shankys Combo',
  placement: 'overlay',
  params: [
    toggle('showCPR', 'Show CPR', D.showCPR, G_CPR),
    num('cprDays', 'Daily CPR (last N days)', D.cprDays, G_CPR, 0, 60, 1),

    toggle('showAutoBS', 'Show Auto Buy Sell', D.showAutoBS, G_ZZ),
    { key: 'zzMethod', label: 'Zigzag reversal method', default: 0, group: G_ZZ, options: SHANKY_ZZ_ATR.map((n, i) => ({ value: i, label: n === 0 ? 'Manual %' : `ATR${String(n).padStart(3, '0')} × X` })) },
    num('zzPercent', 'Manual reversal (% of last pivot)', D.zzPercent, G_ZZ, 0, 99, 0.05),
    num('zzAtrMult', 'ATR multiplier (X)', D.zzAtrMult, G_ZZ, 0, 20, 0.1),
    toggle('showRealPivots', 'Real zigzag pivots', D.showRealPivots, G_ZZ),
    toggle('showZigzagLines', 'Zigzag lines', D.showZigzagLines, G_ZZ),
    toggle('showPivotPrice', 'Price labels on zigzag', D.showPivotPrice, G_ZZ),
    toggle('showTriangleRates', 'Rate labels on triangles', D.showTriangleRates, G_ZZ),
    toggle('showPatterns', 'Patterns', D.showPatterns, G_ZZ),
    num('patternError', 'Pattern margin of error (%)', D.patternError, G_ZZ, 0, 50, 0.5),
    toggle('showProjections', 'Projection forecast', D.showProjections, G_ZZ),
    toggle('showProjectionBox', 'Projection bounds box', D.showProjectionBox, G_ZZ),
    toggle('showProjectionRates', 'Projection target labels', D.showProjectionRates, G_ZZ),
    num('statsLength', 'Projection averaging length', D.statsLength, G_ZZ, 1, 100, 1),

    toggle('showRainbow', 'Show Rainbow', D.showRainbow, G_RB),
    toggle('showBaseline', 'Baseline + channel', D.showBaseline, G_RB),
    toggle('showSZ', 'SZ line', D.showSZ, G_RB),
    toggle('showATR', 'ATR bands', D.showATR, G_RB),
    toggle('colorBars', 'Colour bars', D.colorBars, G_RB),
    num('atrLen', 'ATR period', D.atrLen, G_RB, 1, 200, 1),
    num('atrMult', 'ATR multiplier', D.atrMult, G_RB, 0, 10, 0.1),
    { key: 'atrSmoothing', label: 'ATR smoothing', default: SHANKY_ATR_SMOOTHING.indexOf(D.atrSmoothing), group: G_RB, options: SHANKY_ATR_SMOOTHING.map((s, i) => ({ value: i, label: s })) },
    { key: 'baselineType', label: 'SZ / Baseline type', default: SHANKY_MA.indexOf(D.baselineType), group: G_RB, options: maOpts(SHANKY_MA) },
    num('baselineLen', 'SZ / Baseline length', D.baselineLen, G_RB, 1, 500, 1),
    { key: 'sxType', label: 'SX / Continuation type', default: SHANKY_MA.indexOf(D.sxType), group: G_RB, options: maOpts(['SMA', 'EMA', 'DEMA', 'TEMA', 'WMA', 'MF', 'VAMA', 'TMA', 'HMA', 'JMA', 'McGinley']) },
    num('sxLen', 'SX length', D.sxLen, G_RB, 1, 500, 1),
    { key: 'exitType', label: 'Exit type', default: SHANKY_MA.indexOf(D.exitType), group: G_RB, options: maOpts(['DEMA', 'TEMA', 'LSMA', 'VAMA', 'TMA', 'HMA', 'JMA', 'Kijun v2', 'McGinley', 'MF']) },
    num('exitLen', 'Exit length', D.exitLen, G_RB, 1, 500, 1),
    toggle('useTrueRange', 'Channel uses true range', D.useTrueRange, G_RB),
    num('channelMult', 'Base channel multiplier', D.channelMult, G_RB, 0, 5, 0.05),
    num('contAtr', 'Continuation ATR criteria', D.contAtr, G_RB, 0, 5, 0.1),
    num('kijunDiv', 'Kijun MOD divider', D.kijunDiv, G_RB, 1, 4, 1),
    num('jurikPhase', 'JMA phase', D.jurikPhase, G_RB, -100, 100, 1),
    num('jurikPower', 'JMA power', D.jurikPower, G_RB, 1, 10, 1),
    num('vamaLookback', 'VAMA volatility lookback', D.vamaLookback, G_RB, 1, 200, 1),
    num('mfBeta', 'Modular filter beta', D.mfBeta, G_RB, 0, 1, 0.1),
    toggle('mfFeedback', 'Modular filter feedback', D.mfFeedback, G_RB),
    num('mfZ', 'Modular filter feedback weighting', D.mfZ, G_RB, 0, 1, 0.1),
    num('ssfLength', 'EDSMA super smoother length', D.ssfLength, G_RB, 1, 200, 1),
    { key: 'ssfPoles', label: 'EDSMA super smoother poles', default: D.ssfPoles, group: G_RB, options: [{ value: 2, label: '2' }, { value: 3, label: '3' }] },
  ],
  // Everything is drawn by the canvas hook below; no engine line series.
  compute: () => [],
}

function optionsFrom(p: Record<string, number>): ShankyOptions {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const ma = (k: string, d: ShankyMa): ShankyMa => SHANKY_MA[n(k, SHANKY_MA.indexOf(d))] ?? d
  return {
    showCPR: b('showCPR', D.showCPR),
    cprDays: n('cprDays', D.cprDays),
    showAutoBS: b('showAutoBS', D.showAutoBS),
    zzAtrLen: SHANKY_ZZ_ATR[n('zzMethod', 0)] ?? 0,
    zzPercent: n('zzPercent', D.zzPercent),
    zzAtrMult: n('zzAtrMult', D.zzAtrMult),
    showRealPivots: b('showRealPivots', D.showRealPivots),
    showZigzagLines: b('showZigzagLines', D.showZigzagLines),
    showPivotPrice: b('showPivotPrice', D.showPivotPrice),
    showTriangleRates: b('showTriangleRates', D.showTriangleRates),
    showPatterns: b('showPatterns', D.showPatterns),
    showProjections: b('showProjections', D.showProjections),
    showProjectionBox: b('showProjectionBox', D.showProjectionBox),
    showProjectionRates: b('showProjectionRates', D.showProjectionRates),
    statsLength: n('statsLength', D.statsLength),
    patternError: n('patternError', D.patternError),
    showRainbow: b('showRainbow', D.showRainbow),
    showBaseline: b('showBaseline', D.showBaseline),
    showSZ: b('showSZ', D.showSZ),
    showATR: b('showATR', D.showATR),
    atrLen: Math.max(1, Math.round(n('atrLen', D.atrLen))),
    atrMult: n('atrMult', D.atrMult),
    atrSmoothing: SHANKY_ATR_SMOOTHING[n('atrSmoothing', 3)] ?? D.atrSmoothing,
    baselineType: ma('baselineType', D.baselineType),
    baselineLen: n('baselineLen', D.baselineLen),
    sxType: ma('sxType', D.sxType),
    sxLen: n('sxLen', D.sxLen),
    exitType: ma('exitType', D.exitType),
    exitLen: n('exitLen', D.exitLen),
    kijunDiv: n('kijunDiv', D.kijunDiv),
    jurikPhase: n('jurikPhase', D.jurikPhase),
    jurikPower: n('jurikPower', D.jurikPower),
    vamaLookback: Math.max(1, Math.round(n('vamaLookback', D.vamaLookback))),
    mfBeta: n('mfBeta', D.mfBeta),
    mfFeedback: b('mfFeedback', D.mfFeedback),
    mfZ: n('mfZ', D.mfZ),
    ssfLength: n('ssfLength', D.ssfLength),
    ssfPoles: n('ssfPoles', D.ssfPoles) === 3 ? 3 : 2,
    useTrueRange: b('useTrueRange', D.useTrueRange),
    channelMult: n('channelMult', D.channelMult),
    colorBars: b('colorBars', D.colorBars),
    contAtr: n('contAtr', D.contAtr),
  }
}

export interface ShankyModel {
  opts: ShankyOptions
  result: ShankyResult
}

export function computeShankyModel(candles: Candle[], params: Record<string, number>, ctx: CanvasIndicatorContext): ShankyModel {
  const opts = optionsFrom(params)
  return { opts, result: computeShankyCombo(candles, opts, sessionOpenHourUTC(ctx.symbol), sessionClosedWeekends(ctx.symbol)) }
}

// ---------------------------------------------------------------------------
// Drawing — colours follow the Pine script.
// ---------------------------------------------------------------------------
const C = {
  blue: '#2196F3',
  red: '#FF5252',
  green: '#4CAF50',
  lime: '#00E676',
  zzRed: '#FF5252',
  bull: '#00E113',
  bear: '#E16024',
  gray: '#787B86',
  sxBuy: '#4CAF50',
  sxSell: '#9C27B0',
  white: '#FFFFFF',
  orange: '#FF9800',
  proj: '#0066FF',
  silver: '#C0C0C0',
}
const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const CANDLE_TYPES = new Set(['candles', 'hollow', 'volcandles'])

function visibleRange(candles: Candle[], conv: Converters, rect: Rect): [number, number] {
  const t0 = conv.xToTime(rect.x)
  const t1 = conv.xToTime(rect.x + rect.width)
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (candles[m].time < t0) lo = m + 1
    else hi = m
  }
  let end = lo
  while (end < candles.length - 1 && candles[end].time <= t1) end++
  return [Math.max(0, lo - 1), end]
}

function polyline(g: CanvasRenderingContext2D, conv: Converters, candles: Candle[], from: number, to: number, v: number[], color: (i: number) => string, width: number): void {
  g.lineWidth = width
  g.lineJoin = 'round'
  for (let i = Math.max(from, 1); i <= to; i++) {
    const a = v[i - 1]
    const b = v[i]
    if (!isFinite(a) || !isFinite(b)) continue
    g.strokeStyle = color(i)
    g.beginPath()
    g.moveTo(conv.timeToX(candles[i - 1].time), conv.priceToY(a))
    g.lineTo(conv.timeToX(candles[i].time), conv.priceToY(b))
    g.stroke()
  }
}

function dots(g: CanvasRenderingContext2D, conv: Converters, candles: Candle[], from: number, to: number, v: (i: number) => number, color: (i: number) => string, r: number): void {
  for (let i = from; i <= to; i++) {
    const y = v(i)
    if (!isFinite(y)) continue
    g.fillStyle = color(i)
    g.beginPath()
    g.arc(conv.timeToX(candles[i].time), conv.priceToY(y), r, 0, Math.PI * 2)
    g.fill()
  }
}

function seg(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width: number, dash: number[] = []): void {
  g.strokeStyle = color
  g.lineWidth = width
  g.setLineDash(dash)
  g.beginPath()
  g.moveTo(x1, y1)
  g.lineTo(x2, y2)
  g.stroke()
  g.setLineDash([])
}

function arrowHead(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string): void {
  const a = Math.atan2(y2 - y1, x2 - x1)
  g.fillStyle = color
  g.beginPath()
  g.moveTo(x2, y2)
  g.lineTo(x2 - 7 * Math.cos(a - 0.4), y2 - 7 * Math.sin(a - 0.4))
  g.lineTo(x2 - 7 * Math.cos(a + 0.4), y2 - 7 * Math.sin(a + 0.4))
  g.closePath()
  g.fill()
}

/** Pine label: rounded box with a pointer at (x, y); `below` = labelup (box under the point). */
function label(g: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string, below: boolean): void {
  const lines = text.split('\n')
  g.font = FONT
  const lh = 13
  const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 10
  const h = lines.length * lh + 6
  const top = below ? y + 6 : y - 6 - h
  g.fillStyle = bg
  g.beginPath()
  g.roundRect(x - w / 2, top, w, h, 3)
  g.fill()
  g.beginPath()
  const py = below ? top : top + h
  g.moveTo(x - 5, py)
  g.lineTo(x + 5, py)
  g.lineTo(x, below ? py - 6 : py + 6)
  g.closePath()
  g.fill()
  g.fillStyle = fg
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  lines.forEach((l, k) => g.fillText(l, x, top + 3 + lh * k + lh / 2))
}

export function drawShankyCombo(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: ShankyModel, ctx: CanvasIndicatorContext): void {
  const { opts: o, result: r } = model
  if (candles.length < 2) return
  const [from, to] = visibleRange(candles, conv, rect)
  const barW = Math.abs(conv.timeToX(candles[1].time) - conv.timeToX(candles[0].time)) || 6

  // ---- Rainbow ----
  const rb = r.rainbow
  if (rb) {
    const zoneColor = (i: number): string => (rb.zone[i] === 1 ? C.bull : rb.zone[i] === -1 ? C.bear : C.gray)
    if (o.showBaseline) {
      // Channel fill (transp 90), per-bar colour.
      for (let i = Math.max(from, 1); i <= to; i++) {
        const u0 = rb.upperK[i - 1]
        const u1 = rb.upperK[i]
        const l0 = rb.lowerK[i - 1]
        const l1 = rb.lowerK[i]
        if (![u0, u1, l0, l1].every(isFinite)) continue
        const x0 = conv.timeToX(candles[i - 1].time)
        const x1 = conv.timeToX(candles[i].time)
        g.globalAlpha = 0.1
        g.fillStyle = zoneColor(i)
        g.beginPath()
        g.moveTo(x0, conv.priceToY(u0))
        g.lineTo(x1, conv.priceToY(u1))
        g.lineTo(x1, conv.priceToY(l1))
        g.lineTo(x0, conv.priceToY(l0))
        g.closePath()
        g.fill()
        g.globalAlpha = 1
      }
    }
    if (o.colorBars && CANDLE_TYPES.has(ctx.chartType)) {
      // barcolor(): repaint each candle in its zone colour over the engine's candle.
      const bw = Math.max(1, barW * 0.7)
      for (let i = from; i <= to; i++) {
        const c = candles[i]
        if (!isFinite(rb.upperK[i])) continue
        const x = conv.timeToX(c.time)
        const col = zoneColor(i)
        g.strokeStyle = col
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(Math.round(x) + 0.5, conv.priceToY(c.high))
        g.lineTo(Math.round(x) + 0.5, conv.priceToY(c.low))
        g.stroke()
        const yo = conv.priceToY(c.open)
        const yc = conv.priceToY(c.close)
        g.fillStyle = col
        g.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)))
      }
    }
    if (o.showATR) {
      g.globalAlpha = 0.2
      polyline(g, conv, candles, from, to, rb.upperBand, () => C.white, 1)
      polyline(g, conv, candles, from, to, rb.lowerBand, () => C.white, 1)
      g.globalAlpha = 1
    }
    if (o.showBaseline) {
      polyline(g, conv, candles, from, to, rb.upperK, zoneColor, 1)
      polyline(g, conv, candles, from, to, rb.lowerK, zoneColor, 1)
      polyline(g, conv, candles, from, to, rb.baseline, zoneColor, 4)
    }
    if (o.showSZ) {
      g.globalAlpha = 0.9
      polyline(g, conv, candles, from, to, rb.sz, (i) => (rb.szAbove[i] ? C.bull : C.bear), 3)
      g.globalAlpha = 1
    }
    dots(g, conv, candles, from, to, (i) => rb.sx[i], (i) => (rb.sxState[i] === 1 ? C.sxBuy : rb.sxState[i] === -1 ? C.sxSell : C.white), 2)
    // Diamonds at the top of the pane on oversized candles near the baseline.
    g.fillStyle = C.red
    for (let i = from; i <= to; i++) {
      if (!rb.diamond[i]) continue
      const x = conv.timeToX(candles[i].time)
      const y = rect.y + 8
      g.beginPath()
      g.moveTo(x, y - 4)
      g.lineTo(x + 4, y)
      g.lineTo(x, y + 4)
      g.lineTo(x - 4, y)
      g.closePath()
      g.fill()
    }
    // Exit arrows (plotarrow): up under the bar, down over it.
    for (let i = from; i <= to; i++) {
      const a = rb.arrow[i]
      if (!a) continue
      const c = candles[i]
      const x = conv.timeToX(c.time)
      const y0 = a > 0 ? conv.priceToY(c.low) + 6 : conv.priceToY(c.high) - 6
      const y1 = y0 + a * 18
      const col = a > 0 ? C.bull : C.bear
      g.globalAlpha = 0.8
      seg(g, x, y1, x, y0 + a * 5, col, 2)
      arrowHead(g, x, y1, x, y0, col)
      g.globalAlpha = 1
    }
  }

  // ---- CPR (dots per bar, previous high / low as lines) ----
  if (r.cpr.length) {
    let d = 0
    for (let i = from; i <= to; i++) {
      const t = candles[i].time
      while (d < r.cpr.length && r.cpr[d].end <= t) d++
      const day = r.cpr[d]
      if (!day || t < day.start) continue
      const x = conv.timeToX(t)
      const dot = (p: number, col: string): void => {
        g.fillStyle = col
        g.beginPath()
        g.arc(x, conv.priceToY(p), 1.5, 0, Math.PI * 2)
        g.fill()
      }
      if (r.intraday) {
        dot(day.tc, C.blue)
        dot(day.pp, C.red)
        dot(day.bc, C.blue)
      }
      for (const p of day.r) dot(p, C.red)
      for (const p of day.s) dot(p, C.green)
    }
    for (const day of r.cpr) {
      const x0 = Math.max(rect.x, conv.timeToX(Math.max(day.start, candles[0].time)))
      const x1 = Math.min(rect.x + rect.width, conv.timeToX(Math.min(day.end, candles[candles.length - 1].time)))
      if (x1 <= x0) continue
      seg(g, x0, conv.priceToY(day.ph), x1, conv.priceToY(day.ph), C.green, 2)
      seg(g, x0, conv.priceToY(day.pl), x1, conv.priceToY(day.pl), C.red, 2)
    }
  }

  // ---- Auto Buy Sell (zigzag) ----
  const zz = r.zigzag
  if (zz) {
    // Reversal line: grey step line shifted one bar right, white dot on the newest value.
    g.globalAlpha = 0.6
    g.strokeStyle = C.gray
    g.lineWidth = 1
    g.beginPath()
    let pen = false
    for (let i = from; i <= to; i++) {
      const v = zz.reverse[i]
      if (!isFinite(v)) {
        pen = false
        continue
      }
      const x = conv.timeToX(candles[i].time) + barW
      const y = conv.priceToY(v)
      if (pen) g.lineTo(x, y)
      else g.moveTo(x, y)
      g.lineTo(x + barW, y)
      pen = true
    }
    g.stroke()
    const last = zz.reverse[candles.length - 1]
    if (isFinite(last)) {
      g.fillStyle = C.white
      g.beginPath()
      g.arc(conv.timeToX(candles[candles.length - 1].time) + barW, conv.priceToY(last), 3, 0, Math.PI * 2)
      g.fill()
    }
    g.globalAlpha = 1

    const vis = (t: number): boolean => {
      const x = conv.timeToX(t)
      return x >= rect.x - 200 && x <= rect.x + rect.width + 200
    }
    if (o.showZigzagLines) {
      for (const l of zz.legs) {
        if (!vis(l.t1) && !vis(l.t2)) continue
        seg(g, conv.timeToX(l.t1), conv.priceToY(l.p1), conv.timeToX(l.t2), conv.priceToY(l.p2), l.up ? C.lime : C.zzRed, 2)
      }
    }
    for (const rl of zz.rateLines) {
      seg(g, conv.timeToX(rl.x1), conv.priceToY(rl.y1), conv.timeToX(rl.x2), conv.priceToY(rl.y2), C.gray, 1, [4, 4])
      label(g, conv.timeToX((rl.x1 + rl.x2) / 2), conv.priceToY((rl.y1 + rl.y2) / 2), rl.text, C.silver, '#000', rl.up)
    }
    for (const p of zz.pivots) {
      if (!vis(p.time) || !p.text) continue
      label(g, conv.timeToX(p.time), conv.priceToY(p.price), p.text, p.high ? C.zzRed : C.lime, '#000', !p.high)
    }
    const pj = zz.projection
    if (pj) {
      const [t1, p1, t2, p2] = pj.mid
      const x1 = conv.timeToX(t1)
      const y1 = conv.priceToY(p1)
      const x2 = conv.timeToX(t2)
      const y2 = conv.priceToY(p2)
      // extend.right: carry the dashed midline to the pane edge.
      const xr = rect.x + rect.width
      const yr = x2 !== x1 ? y1 + ((y2 - y1) * (xr - x1)) / (x2 - x1) : y2
      seg(g, x1, y1, xr, yr, C.orange, 1, [6, 4])
      for (const [a, b, c, d] of [pj.priceDev, pj.timeDev]) {
        const ax = conv.timeToX(a)
        const ay = conv.priceToY(b)
        const bx = conv.timeToX(c)
        const by = conv.priceToY(d)
        seg(g, ax, ay, bx, by, C.proj, 1)
        arrowHead(g, ax, ay, bx, by, C.proj)
        arrowHead(g, bx, by, ax, ay, C.proj)
      }
      if (pj.box) {
        const [bt1, bp1, bt2, bp2] = pj.box
        g.strokeStyle = C.gray
        g.lineWidth = 2
        g.setLineDash([6, 4])
        const bx1 = conv.timeToX(bt1)
        const by1 = conv.priceToY(bp1)
        g.strokeRect(bx1, by1, conv.timeToX(bt2) - bx1, conv.priceToY(bp2) - by1)
        g.setLineDash([])
      }
      for (const l of pj.labels) label(g, conv.timeToX(l.time), conv.priceToY(l.price), l.text, C.silver, '#000', l.up)
    }
  }
}
