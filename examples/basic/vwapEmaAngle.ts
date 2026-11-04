// "VWAP Angle" — Indicators-menu entry ported from the "VWAP and EMA Angle
// Confluence" Pine script (indicators collate/indicator 1).
// Math: src/overlays/vwapEmaAngleModel.ts. Drawn through the canvas-indicator
// hook (CanvasSource in custom-indicators.ts).
//
// Pine behaviour by default; every line, band, fill, label and table is
// styleable. Added (all optional): ATR-measured angle (one threshold for any
// symbol), line breaks at each new VWAP period, BUY / SELL markers where the
// momentum signal flips, and closed-bar alerts.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { INTERVAL_MS, type Interval } from '../../src/core/types'
import { VEA_DEFAULTS, VEA_SETUPS, VEA_SETUP_COLORS, computeVwapEmaAngle, type VeaAnchor, type VeaOptions, type VeaResult, type VeaSource } from '../../src/overlays/vwapEmaAngleModel'
import { COL, PALETTE, colorOpts } from './flyingCpr'
import type { CanvasIndicatorContext } from './shankyCombo'
import { DASHES, candleSig, cornerXY, fillBetween, fmtPrice, makeMemo, rgba, strokeSeries, visibleRange, type Rect } from './canvasPlot'
import { askNotificationPermissionOnce, fireSignalAlert } from './signalAlert'

const D = VEA_DEFAULTS
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
const pick = (key: string, label: string, def: number, group: string, options: { value: number; label: string }[]): IndicatorParam => ({ key, label, default: def, group, options })

const ANCHORS: VeaAnchor[] = ['session', 'week', 'month', 'quarter', 'year']
const SOURCES: VeaSource[] = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4']
const widthOpts = [1, 2, 3, 4, 5].map((w) => ({ value: w, label: `${w}px` }))
const styleOpts = [
  { value: 0, label: 'Solid' },
  { value: 1, label: 'Dashed' },
  { value: 2, label: 'Dotted' },
]
const cornerOpts = [
  { value: 0, label: 'Top right' },
  { value: 1, label: 'Top left' },
  { value: 2, label: 'Bottom right' },
  { value: 3, label: 'Bottom left' },
]
const sizeOpts = [
  { value: 0, label: 'Small' },
  { value: 1, label: 'Normal' },
  { value: 2, label: 'Large' },
]

const G_V = 'VWAP'
const G_B = 'Bands'
const G_E = 'EMA angle'
const G_L = 'Label & dashboard'
const G_A = 'Alerts'

export const vwapEmaAngle: IndicatorDef = {
  id: 'vwap_ema_angle',
  label: 'VWAP Angle',
  shortLabel: 'VWAP Angle',
  placement: 'overlay',
  params: [
    toggle('showVwap', 'Show VWAP', true, G_V),
    toggle('hideDwm', 'Hide VWAP on 1D or above', false, G_V),
    pick('anchor', 'Anchor period', 0, G_V, ANCHORS.map((a, i) => ({ value: i, label: a[0].toUpperCase() + a.slice(1) }))),
    pick('source', 'Source', SOURCES.indexOf(D.source), G_V, SOURCES.map((s, i) => ({ value: i, label: s }))),
    num('offset', 'Offset (bars)', 0, G_V, 0, 50, 1),
    pick('vwapColor', 'VWAP colour', COL.Blue, G_V, colorOpts),
    pick('vwapWidth', 'VWAP width', 1, G_V, widthOpts),
    pick('vwapStyle', 'VWAP style', 0, G_V, styleOpts),
    toggle('breakPeriod', 'Break lines at each new period', true, G_V),

    pick('bandsMode', 'Bands calculation', 0, G_B, [
      { value: 0, label: 'Standard deviation' },
      { value: 1, label: 'Percentage (1 = 1%)' },
    ]),
    toggle('band1', 'Band #1', true, G_B),
    num('mult1', 'Band #1 multiplier', D.mult1, G_B, 0, 10, 0.5),
    pick('band1Color', 'Band #1 colour', COL.Green, G_B, colorOpts),
    toggle('band2', 'Band #2', false, G_B),
    num('mult2', 'Band #2 multiplier', D.mult2, G_B, 0, 10, 0.5),
    pick('band2Color', 'Band #2 colour', COL.Olive, G_B, colorOpts),
    toggle('band3', 'Band #3', false, G_B),
    num('mult3', 'Band #3 multiplier', D.mult3, G_B, 0, 10, 0.5),
    pick('band3Color', 'Band #3 colour', COL.Teal, G_B, colorOpts),
    pick('bandWidth', 'Band line width', 1, G_B, widthOpts),
    pick('bandStyle', 'Band line style', 0, G_B, styleOpts),
    toggle('bandFill', 'Fill between bands', true, G_B),
    num('bandFillOpacity', 'Band fill opacity %', 5, G_B, 0, 60, 1),

    toggle('showEma', 'Show EMA', true, G_E),
    num('emaLength', 'EMA length', D.emaLength, G_E, 1, 500, 1),
    num('angleThreshold', 'Angle threshold (°)', D.angleThreshold, G_E, 0, 89, 0.5),
    pick('angleBasis', 'Angle measured on', 0, G_E, [
      { value: 0, label: 'Price change (as Pine)' },
      { value: 1, label: 'Change in ATRs (same for every symbol)' },
    ]),
    pick('buyColor', 'BUY colour', COL.Green, G_E, colorOpts),
    pick('sellColor', 'SELL colour', COL.Red, G_E, colorOpts),
    pick('waitColor', 'WAIT colour', COL.White, G_E, colorOpts),
    pick('emaWidth', 'EMA width', 2, G_E, widthOpts),
    toggle('markers', 'BUY / SELL markers where the signal flips', false, G_E),

    toggle('showLabel', 'Status label (last bar)', true, G_L),
    toggle('showTable', 'Confluence dashboard', true, G_L),
    pick('tablePos', 'Dashboard position', 0, G_L, cornerOpts),
    pick('textSize', 'Text size', 0, G_L, sizeOpts),

    toggle('alertSignal', 'Alert: EMA angle signal changed', false, G_A),
    toggle('alertVwap', 'Alert: price crossed VWAP', false, G_A),
    toggle('alertSetup', 'Alert: confluence setup changed', false, G_A),
    toggle('alertSound', 'Alert sound', true, G_A),
  ],
  compute: () => [],
}

interface Display {
  showVwap: boolean
  offset: number
  vwapColor: string
  vwapWidth: number
  vwapDash: number[]
  breakPeriod: boolean
  bands: { on: boolean; mult: number; color: string; upper: Float64Array; lower: Float64Array }[]
  bandWidth: number
  bandDash: number[]
  bandFill: number
  showEma: boolean
  buy: string
  sell: string
  wait: string
  emaWidth: number
  markers: boolean
  showLabel: boolean
  showTable: boolean
  tablePos: number
  font: number
  emaLength: number
}

export interface VwapEmaAngleModel {
  display: Display
  r: VeaResult
}

const memo = makeMemo<VwapEmaAngleModel>()
const alertSeen = new Map<string, number>() // chart → last bar time alerted on

export function computeVwapEmaAngleModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): VwapEmaAngleModel {
  const key = `${ctx.symbol}|${ctx.interval}`
  const model = memo(key, candleSig(candles, p), () => build(candles, p, ctx))
  runAlerts(candles, model, p, ctx)
  return model
}

function build(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): VwapEmaAngleModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const col = (k: string, d: number): string => (PALETTE[Math.round(n(k, d))] ?? PALETTE[d])[1]
  const opts: VeaOptions = {
    anchor: ANCHORS[Math.round(n('anchor', 0))] ?? 'session',
    source: SOURCES[Math.round(n('source', SOURCES.indexOf(D.source)))] ?? D.source,
    bandsMode: Math.round(n('bandsMode', 0)) === 1 ? 'pct' : 'stdev',
    mult1: n('mult1', D.mult1),
    mult2: n('mult2', D.mult2),
    mult3: n('mult3', D.mult3),
    emaLength: Math.max(1, Math.round(n('emaLength', D.emaLength))),
    angleThreshold: n('angleThreshold', D.angleThreshold),
    angleBasis: Math.round(n('angleBasis', 0)) === 1 ? 'atr' : 'price',
  }
  const ivMs = INTERVAL_MS[ctx.interval as Interval] ?? 60_000
  const dwm = ivMs >= 86_400_000
  const r = computeVwapEmaAngle(candles, ctx.symbol, opts)
  // band edges, built once per compute (not per frame)
  const band = (on: boolean, mult: number, color: string): Display['bands'][number] => {
    const upper = new Float64Array(on ? r.vwap.length : 0)
    const lower = new Float64Array(on ? r.vwap.length : 0)
    for (let i = 0; i < upper.length; i++) {
      upper[i] = r.vwap[i] + r.dist[i] * mult
      lower[i] = r.vwap[i] - r.dist[i] * mult
    }
    return { on, mult, color, upper, lower }
  }
  return {
    r,
    display: {
      showVwap: b('showVwap', true) && !(b('hideDwm', false) && dwm),
      offset: Math.max(0, Math.round(n('offset', 0))),
      vwapColor: col('vwapColor', COL.Blue),
      vwapWidth: n('vwapWidth', 1),
      vwapDash: DASHES[Math.round(n('vwapStyle', 0))] ?? [],
      breakPeriod: b('breakPeriod', true),
      bands: [
        band(b('band1', true), opts.mult1, col('band1Color', COL.Green)),
        band(b('band2', false), opts.mult2, col('band2Color', COL.Olive)),
        band(b('band3', false), opts.mult3, col('band3Color', COL.Teal)),
      ],
      bandWidth: n('bandWidth', 1),
      bandDash: DASHES[Math.round(n('bandStyle', 0))] ?? [],
      bandFill: b('bandFill', true) ? Math.min(0.6, Math.max(0, n('bandFillOpacity', 5) / 100)) : 0,
      showEma: b('showEma', true),
      buy: col('buyColor', COL.Green),
      sell: col('sellColor', COL.Red),
      wait: col('waitColor', COL.White),
      emaWidth: n('emaWidth', 2),
      markers: b('markers', false),
      showLabel: b('showLabel', true),
      showTable: b('showTable', true),
      tablePos: Math.round(n('tablePos', 0)),
      font: [10, 11.5, 13][Math.round(n('textSize', 0))] ?? 10,
      emaLength: opts.emaLength,
    },
  }
}

const SIG_TEXT = ['WAIT', 'BUY', 'SELL']
const sigText = (s: number): string => SIG_TEXT[s === 1 ? 1 : s === -1 ? 2 : 0]

// alerts fire on the bar that just closed, once per bar (as Pine's alertcondition on bar close)
function runAlerts(candles: Candle[], m: VwapEmaAngleModel, p: Record<string, number>, ctx: CanvasIndicatorContext): void {
  const want = { sig: p.alertSignal === 1, vwap: p.alertVwap === 1, setup: p.alertSetup === 1 }
  if (!want.sig && !want.vwap && !want.setup) return
  const n = candles.length
  if (n < 3) return
  const i = n - 2 // last closed bar
  const key = `${ctx.symbol}|${ctx.interval}`
  const t = candles[i].time
  const last = alertSeen.get(key)
  alertSeen.set(key, t)
  if (last === undefined || last >= t) return // first look (priming) or nothing new
  const { r } = m
  const sound = p.alertSound !== 0
  const title = `VWAP Angle · ${ctx.symbol}`
  askNotificationPermissionOnce()
  if (want.sig && r.signal[i] !== r.signal[i - 1]) fireSignalAlert(title, `EMA ${m.display.emaLength} angle signal changed to ${sigText(r.signal[i])} (${r.angle[i].toFixed(2)}°)`, sound)
  const c0 = candles[i - 1].close
  const c1 = candles[i].close
  if (want.vwap && Number.isFinite(r.vwap[i]) && !r.newPeriod[i] && (c0 - r.vwap[i - 1]) * (c1 - r.vwap[i]) < 0) fireSignalAlert(title, `Price crossed VWAP at ${fmtPrice(c1)}`, sound)
  if (want.setup && r.setup[i] !== r.setup[i - 1]) fireSignalAlert(title, `Confluence setup changed to: ${VEA_SETUPS[r.setup[i]]}`, sound)
}

export function drawVwapEmaAngle(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: VwapEmaAngleModel, ctx: CanvasIndicatorContext): void {
  const n = candles.length
  if (n < 2) return
  const { r, display: s } = model
  const [from, to] = visibleRange(candles, conv, rect)
  if (to < from) return
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  const brk = s.breakPeriod ? r.newPeriod : null
  if (s.showVwap) {
    // fills first, then lines (outermost first so inner ones sit on top)
    for (let k = 2; k >= 0; k--) {
      const band = s.bands[k]
      if (band.on && s.bandFill > 0) fillBetween(g, conv, candles, band.upper, band.lower, from, to, rgba(band.color, s.bandFill), brk, s.offset)
    }
    for (let k = 2; k >= 0; k--) {
      const band = s.bands[k]
      if (!band.on) continue
      strokeSeries(g, conv, candles, band.upper, from, to, band.color, s.bandWidth, s.bandDash, brk, null, s.offset)
      strokeSeries(g, conv, candles, band.lower, from, to, band.color, s.bandWidth, s.bandDash, brk, null, s.offset)
    }
    strokeSeries(g, conv, candles, r.vwap, from, to, s.vwapColor, s.vwapWidth, s.vwapDash, brk, null, s.offset)
  }

  const sigCol = (i: number): string => (r.signal[i] === 1 ? s.buy : r.signal[i] === -1 ? s.sell : s.wait)
  if (s.showEma) strokeSeries(g, conv, candles, r.ema, from, to, s.wait, s.emaWidth, [], null, sigCol)

  if (s.markers) {
    for (let i = Math.max(1, from); i <= to; i++) {
      const sg = r.signal[i]
      if (sg === 0 || sg === r.signal[i - 1]) continue
      const c = candles[i]
      const x = conv.timeToX(c.time)
      const up = sg === 1
      const y = conv.priceToY(up ? c.low : c.high) + (up ? 10 : -10)
      g.fillStyle = up ? s.buy : s.sell
      g.beginPath()
      g.moveTo(x, y + (up ? -6 : 6))
      g.lineTo(x - 5, y + (up ? 3 : -3))
      g.lineTo(x + 5, y + (up ? 3 : -3))
      g.closePath()
      g.fill()
    }
  }

  const last = n - 1
  g.font = `600 ${s.font}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
  g.textBaseline = 'middle'
  const angleTxt = Number.isFinite(r.angle[last]) ? `${r.angle[last].toFixed(2)}°` : '—'
  const setup = VEA_SETUPS[r.setup[last]]

  if (s.showLabel && Number.isFinite(r.ema[last])) {
    const lines = [`EMA Angle: ${angleTxt}`, `Signal: ${sigText(r.signal[last])}`, `Setup: ${setup}`]
    const lh = s.font + 4
    const w = Math.max(...lines.map((t) => g.measureText(t).width)) + 12
    const h = lines.length * lh + 6
    ctx.ensureRightGutter?.(w + 18) // blank space right of the last bar, so the label never covers candles
    let x = conv.timeToX(candles[last].time) + 10
    if (x + w > rect.x + rect.width - 4) x = rect.x + rect.width - w - 4
    const y = Math.min(Math.max(conv.priceToY(r.ema[last]) - h / 2, rect.y + 4), rect.y + rect.height - h - 4)
    g.fillStyle = sigCol(last)
    g.beginPath()
    g.roundRect(x, y, w, h, 4)
    g.fill()
    g.fillStyle = '#111'
    g.textAlign = 'left'
    lines.forEach((t, k) => g.fillText(t, x + 6, y + 3 + lh * k + lh / 2))
  }

  if (s.showTable) {
    const head = ['Metric', 'Value', 'Momentum', 'Confluence Setup']
    const row = [`VWAP + EMA ${s.emaLength}`, `EMA Angle: ${angleTxt}`, sigText(r.signal[last]), setup]
    const pad = 6
    const cw = head.map((t, k) => Math.max(g.measureText(t).width, g.measureText(row[k]).width) + pad * 2)
    const rh = s.font + 10
    const w = cw.reduce((a, b) => a + b, 0)
    const [x0, y0] = cornerXY(rect, w, rh * 2, s.tablePos)
    g.fillStyle = 'rgba(0, 0, 0, 0.8)'
    g.fillRect(x0, y0, w, rh * 2)
    let x = x0
    for (let k = 0; k < 4; k++) {
      g.fillStyle = 'rgba(33, 150, 243, 0.7)'
      g.fillRect(x, y0, cw[k], rh)
      g.fillStyle = k === 2 ? sigCol(last) : k === 3 ? VEA_SETUP_COLORS[r.setup[last]] : 'rgba(120, 123, 134, 0.2)'
      g.fillRect(x, y0 + rh, cw[k], rh)
      g.strokeStyle = 'rgba(0, 0, 0, 0.9)'
      g.lineWidth = 1
      g.strokeRect(x + 0.5, y0 + 0.5, cw[k] - 1, rh * 2 - 1)
      g.textAlign = 'center'
      g.fillStyle = '#fff'
      g.fillText(head[k], x + cw[k] / 2, y0 + rh / 2)
      g.fillStyle = k === 2 ? '#111' : '#fff'
      g.fillText(row[k], x + cw[k] / 2, y0 + rh + rh / 2)
      x += cw[k]
    }
  }
  g.restore()
}
