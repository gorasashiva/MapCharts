// "DC CPR BB" — Indicators-menu entry ported from the "Donchian + CPR (D/W/M)
// + Bollinger Bands" Pine script (indicators collate/indicator 2).
// Math: src/overlays/dcCprBbModel.ts. Drawn through the canvas-indicator hook
// (CanvasSource in custom-indicators.ts).
//
// Pine behaviour by default; every part has its own show switch, colour,
// width and style. Added (all optional): hide the Bollinger / Donchian
// background, choose which lines a BUY / SELL candle must cross, drop the
// day-open filter, CPR level labels, and closed-bar alerts.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { INTERVAL_MS, type Interval } from '../../src/core/types'
import { DC_CPR_BB_DEFAULTS, computeDcCprBb, type BbMa, type CprSpan, type DcCprBbOptions, type DcCprBbResult } from '../../src/overlays/dcCprBbModel'
import type { VeaSource } from '../../src/overlays/vwapEmaAngleModel'
import { COL, PALETTE, colorOpts } from './flyingCpr'
import type { CanvasIndicatorContext } from './shankyCombo'
import { DASHES, candleSig, fillBetween, fmtPrice, makeMemo, rgba, strokeSeries, visibleRange, type Rect } from './canvasPlot'
import { askNotificationPermissionOnce, fireSignalAlert } from './signalAlert'

const D = DC_CPR_BB_DEFAULTS
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
const pick = (key: string, label: string, def: number, group: string, options: { value: number; label: string }[]): IndicatorParam => ({ key, label, default: def, group, options })

const SOURCES: VeaSource[] = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4']
const MAS: BbMa[] = ['sma', 'ema', 'wma', 'vwma']
const widthOpts = [1, 2, 3, 4, 5].map((w) => ({ value: w, label: `${w}px` }))
const styleOpts = [
  { value: 0, label: 'Solid' },
  { value: 1, label: 'Dashed' },
  { value: 2, label: 'Dotted' },
]
const sizeOpts = [
  { value: 0, label: 'Small' },
  { value: 1, label: 'Normal' },
  { value: 2, label: 'Large' },
]

const G_DC = 'Donchian Channel'
const G_BB = 'Bollinger Bands'
const G_CPR = 'CPR'
const G_DO = 'Day Open'
const G_SMA = 'SMAs'
const G_SIG = 'Signals'
const G_AL = 'Alerts'

const cprParams = (p: 'd' | 'w' | 'm', name: string, color: number): IndicatorParam[] => [
  toggle(`${p}Show`, `${name} CPR`, true, G_CPR),
  pick(`${p}Color`, `${name} colour`, color, G_CPR, colorOpts),
  toggle(`${p}SR`, `${name} R1 / S1 / R2 / S2`, false, G_CPR),
]

export const dcCprBb: IndicatorDef = {
  id: 'dc_cpr_bb',
  label: 'DC CPR BB',
  shortLabel: 'DC CPR BB',
  placement: 'overlay',
  params: [
    toggle('dcShow', 'Show Donchian Channel', true, G_DC),
    num('dcLen', 'Length', D.dcLen, G_DC, 1, 500, 1),
    pick('dcColor', 'Colour', COL.Aqua, G_DC, colorOpts),
    pick('dcWidth', 'Width', 1, G_DC, widthOpts),
    pick('dcStyle', 'Style', 0, G_DC, styleOpts),
    toggle('dcMid', 'Show middle line', true, G_DC),
    toggle('dcFill', 'Show background', true, G_DC),
    num('dcFillOpacity', 'Background opacity %', 6, G_DC, 1, 60, 1),

    toggle('bbShow', 'Show Bollinger Bands', true, G_BB),
    num('bbLen', 'Length', D.bbLen, G_BB, 1, 500, 1),
    pick('bbSource', 'Source', SOURCES.indexOf(D.bbSource), G_BB, SOURCES.map((s, i) => ({ value: i, label: s }))),
    num('bbMult', 'StdDev multiplier', D.bbMult, G_BB, 0.1, 10, 0.1),
    pick('bbMa', 'Basis MA type', 0, G_BB, MAS.map((m, i) => ({ value: i, label: m.toUpperCase() }))),
    pick('bbColor', 'Colour', COL.Yellow, G_BB, colorOpts),
    pick('bbWidth', 'Width', 1, G_BB, widthOpts),
    pick('bbStyle', 'Style', 0, G_BB, styleOpts),
    toggle('bbBasis', 'Show basis line', true, G_BB),
    toggle('bbFill', 'Show background', true, G_BB),
    num('bbFillOpacity', 'Background opacity %', 5, G_BB, 1, 60, 1),

    ...cprParams('d', 'Daily', COL.Fuchsia),
    ...cprParams('w', 'Weekly', COL.Orange),
    ...cprParams('m', 'Monthly', COL.Lime),
    num('cprFill', 'CPR fill opacity % (0 = none)', 15, G_CPR, 0, 80, 1),
    pick('cprWidth', 'TC / BC width', 1, G_CPR, widthOpts),
    pick('pivotWidth', 'Pivot width', 2, G_CPR, widthOpts),
    pick('cprStyle', 'Line style', 0, G_CPR, styleOpts),
    pick('rColor', 'R1 / R2 colour', COL.Red, G_CPR, colorOpts),
    pick('sColor', 'S1 / S2 colour', COL.Green, G_CPR, colorOpts),
    toggle('cprLabels', 'Level labels (P, TC, BC, R1…)', false, G_CPR),

    toggle('doShow', 'Show day open line', true, G_DO),
    pick('doColor', 'Colour', COL.White, G_DO, colorOpts),
    pick('doWidth', 'Width', 2, G_DO, widthOpts),
    pick('doStyle', 'Style', 0, G_DO, styleOpts),

    toggle('smaShow', 'Show SMAs', true, G_SMA),
    num('sma1Len', 'SMA 1 length', D.sma1Len, G_SMA, 1, 500, 1),
    pick('sma1Color', 'SMA 1 colour', COL.Blue, G_SMA, colorOpts),
    num('sma2Len', 'SMA 2 length', D.sma2Len, G_SMA, 1, 500, 1),
    pick('sma2Color', 'SMA 2 colour', COL.Purple, G_SMA, colorOpts),
    pick('smaWidth', 'Width', 2, G_SMA, widthOpts),

    toggle('sigShow', 'Show BUY / SELL arrows', true, G_SIG),
    toggle('useDcMid', 'Candle must cross the DC middle', true, G_SIG),
    toggle('useBbBasis', 'Candle must cross the BB basis', true, G_SIG),
    toggle('useSma1', 'Candle must cross SMA 1', true, G_SIG),
    toggle('useSma2', 'Candle must cross SMA 2', true, G_SIG),
    toggle('dayOpenFilter', 'BUY above / SELL below the day open', true, G_SIG),
    pick('buyColor', 'BUY colour', COL.Lime, G_SIG, colorOpts),
    pick('sellColor', 'SELL colour', COL.Red, G_SIG, colorOpts),
    pick('sigSize', 'Arrow size', 1, G_SIG, sizeOpts),
    toggle('sigText', 'Show BUY / SELL text', true, G_SIG),

    toggle('alBuySell', 'Alert: BUY / SELL signal', false, G_AL),
    toggle('alDc', 'Alert: Donchian breakout / breakdown', false, G_AL),
    toggle('alBb', 'Alert: price crossed upper / lower BB', false, G_AL),
    toggle('alCpr', 'Alert: price crossed daily TC / BC', false, G_AL),
    toggle('alSound', 'Alert sound', true, G_AL),
  ],
  compute: () => [],
}

interface CprStyle {
  on: boolean
  color: string
  sr: boolean
  label: string
}

interface Display {
  dc: boolean
  dcColor: string
  dcWidth: number
  dcDash: number[]
  dcMid: boolean
  dcFill: number
  bb: boolean
  bbColor: string
  bbWidth: number
  bbDash: number[]
  bbBasis: boolean
  bbFill: number
  cpr: [CprStyle, CprStyle, CprStyle]
  cprFill: number
  cprWidth: number
  pivotWidth: number
  cprDash: number[]
  rColor: string
  sColor: string
  cprLabels: boolean
  dayOpen: boolean
  doColor: string
  doWidth: number
  doDash: number[]
  sma: boolean
  sma1Color: string
  sma2Color: string
  smaWidth: number
  sig: boolean
  buy: string
  sell: string
  sigSize: number
  sigText: boolean
}

export interface DcCprBbModel {
  display: Display
  r: DcCprBbResult
}

const memo = makeMemo<DcCprBbModel>()
const alertSeen = new Map<string, number>()

export function computeDcCprBbModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): DcCprBbModel {
  const model = memo(`${ctx.symbol}|${ctx.interval}`, candleSig(candles, p), () => build(candles, p, ctx))
  runAlerts(candles, model, p, ctx)
  return model
}

function build(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): DcCprBbModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const col = (k: string, d: number): string => (PALETTE[Math.round(n(k, d))] ?? PALETTE[d])[1]
  const dash = (k: string): number[] => DASHES[Math.round(n(k, 0))] ?? []
  const opacity = (k: string, d: number): number => Math.min(0.8, Math.max(0, n(k, d) / 100))
  const opts: DcCprBbOptions = {
    dcLen: n('dcLen', D.dcLen),
    bbLen: n('bbLen', D.bbLen),
    bbSource: SOURCES[Math.round(n('bbSource', SOURCES.indexOf(D.bbSource)))] ?? D.bbSource,
    bbMult: n('bbMult', D.bbMult),
    bbMa: MAS[Math.round(n('bbMa', 0))] ?? 'sma',
    sma1Len: n('sma1Len', D.sma1Len),
    sma2Len: n('sma2Len', D.sma2Len),
    useDcMid: b('useDcMid', true),
    useBbBasis: b('useBbBasis', true),
    useSma1: b('useSma1', true),
    useSma2: b('useSma2', true),
    dayOpenFilter: b('dayOpenFilter', true),
  }
  // a CPR shows only on chart timeframes below its period (as Pine)
  const ivMs = INTERVAL_MS[ctx.interval as Interval] ?? 60_000
  const DAY = 86_400_000
  return {
    r: computeDcCprBb(candles, ctx.symbol, opts),
    display: {
      dc: b('dcShow', true),
      dcColor: col('dcColor', COL.Aqua),
      dcWidth: n('dcWidth', 1),
      dcDash: dash('dcStyle'),
      dcMid: b('dcMid', true),
      dcFill: b('dcFill', true) ? opacity('dcFillOpacity', 6) : 0,
      bb: b('bbShow', true),
      bbColor: col('bbColor', COL.Yellow),
      bbWidth: n('bbWidth', 1),
      bbDash: dash('bbStyle'),
      bbBasis: b('bbBasis', true),
      bbFill: b('bbFill', true) ? opacity('bbFillOpacity', 5) : 0,
      cpr: [
        { on: b('dShow', true) && ivMs < DAY, color: col('dColor', COL.Fuchsia), sr: b('dSR', false), label: 'D' },
        { on: b('wShow', true) && ivMs < 7 * DAY, color: col('wColor', COL.Orange), sr: b('wSR', false), label: 'W' },
        { on: b('mShow', true) && ivMs < 28 * DAY, color: col('mColor', COL.Lime), sr: b('mSR', false), label: 'M' },
      ],
      cprFill: opacity('cprFill', 15),
      cprWidth: n('cprWidth', 1),
      pivotWidth: n('pivotWidth', 2),
      cprDash: dash('cprStyle'),
      rColor: col('rColor', COL.Red),
      sColor: col('sColor', COL.Green),
      cprLabels: b('cprLabels', false),
      dayOpen: b('doShow', true) && ivMs < DAY,
      doColor: col('doColor', COL.White),
      doWidth: n('doWidth', 2),
      doDash: dash('doStyle'),
      sma: b('smaShow', true),
      sma1Color: col('sma1Color', COL.Blue),
      sma2Color: col('sma2Color', COL.Purple),
      smaWidth: n('smaWidth', 2),
      sig: b('sigShow', true),
      buy: col('buyColor', COL.Lime),
      sell: col('sellColor', COL.Red),
      sigSize: Math.round(n('sigSize', 1)),
      sigText: b('sigText', true),
    },
  }
}

/** The span covering bar i (spans are in order; the newest are checked first). */
function spanAt(spans: CprSpan[], i: number): CprSpan | null {
  for (let k = spans.length - 1; k >= 0; k--) {
    const s = spans[k]
    if (i > s.to) return null
    if (i >= s.from) return s
  }
  return null
}

function runAlerts(candles: Candle[], m: DcCprBbModel, p: Record<string, number>, ctx: CanvasIndicatorContext): void {
  const want = { sig: p.alBuySell === 1, dc: p.alDc === 1, bb: p.alBb === 1, cpr: p.alCpr === 1 }
  if (!want.sig && !want.dc && !want.bb && !want.cpr) return
  const n = candles.length
  if (n < 4) return
  const i = n - 2 // last closed bar
  const key = `${ctx.symbol}|${ctx.interval}`
  const t = candles[i].time
  const last = alertSeen.get(key)
  alertSeen.set(key, t)
  if (last === undefined || last >= t) return // first look (priming) or nothing new
  const { r } = m
  const c1 = candles[i].close
  const c0 = candles[i - 1].close
  const sound = p.alSound !== 0
  const title = `DC CPR BB · ${ctx.symbol}`
  const fire = (text: string): void => {
    askNotificationPermissionOnce()
    fireSignalAlert(title, text, sound)
  }
  const over = (a1: number, a0: number): boolean => c1 > a1 && c0 <= a0
  const under = (a1: number, a0: number): boolean => c1 < a1 && c0 >= a0
  const dayTxt = p.dayOpenFilter !== 0
  if (want.sig && r.signal[i] === 1) fire(`BUY at ${fmtPrice(c1)}: crossed every reference line${dayTxt ? ', above the day open' : ''}`)
  if (want.sig && r.signal[i] === -1) fire(`SELL at ${fmtPrice(c1)}: crossed every reference line${dayTxt ? ', below the day open' : ''}`)
  if (want.dc && over(r.dcUp[i - 1], r.dcUp[i - 2])) fire('Price broke above the Donchian upper')
  if (want.dc && under(r.dcLo[i - 1], r.dcLo[i - 2])) fire('Price broke below the Donchian lower')
  if (want.bb && over(r.bbUp[i], r.bbUp[i - 1])) fire('Price crossed above the upper Bollinger Band')
  if (want.bb && under(r.bbLo[i], r.bbLo[i - 1])) fire('Price crossed below the lower Bollinger Band')
  if (want.cpr) {
    const s1 = spanAt(r.cprD, i)
    const s0 = spanAt(r.cprD, i - 1)
    if (s1 && s0) {
      if (over(s1.lv.tc, s0.lv.tc)) fire(`Price crossed above the daily TC ${fmtPrice(s1.lv.tc)}`)
      if (under(s1.lv.bc, s0.lv.bc)) fire(`Price crossed below the daily BC ${fmtPrice(s1.lv.bc)}`)
    }
  }
}

export function drawDcCprBb(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: DcCprBbModel, _ctx: CanvasIndicatorContext): void {
  const n = candles.length
  if (n < 2) return
  const { r, display: s } = model
  const [from, to] = visibleRange(candles, conv, rect)
  if (to < from) return
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  const X = (i: number): number => conv.timeToX(candles[i].time)
  const right = rect.x + rect.width

  // ---- CPR (behind everything): monthly, weekly, then daily on top ----
  const periods: [CprSpan[], CprStyle][] = [
    [r.cprM, s.cpr[2]],
    [r.cprW, s.cpr[1]],
    [r.cprD, s.cpr[0]],
  ]
  g.font = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
  g.textBaseline = 'middle'
  g.textAlign = 'left'
  const yOf = (v: number): number => Math.round(conv.priceToY(v)) + 0.5
  for (const [spans, st] of periods) {
    if (!st.on) continue
    for (const sp of spans) {
      if (sp.to < from || sp.from > to) continue
      const x1 = X(sp.from)
      const x2 = X(sp.to)
      if (s.cprFill > 0) {
        g.fillStyle = rgba(st.color, s.cprFill)
        const yt = yOf(sp.lv.tc)
        g.fillRect(x1, yt, x2 - x1, yOf(sp.lv.bc) - yt)
      }
      const line = (v: number, color: string, w: number, tag: string): void => {
        const yy = yOf(v)
        if (yy < rect.y - 2 || yy > rect.y + rect.height + 2) return
        g.strokeStyle = color
        g.lineWidth = w
        g.setLineDash(s.cprDash)
        g.beginPath()
        g.moveTo(x1, yy)
        g.lineTo(x2, yy)
        g.stroke()
        if (s.cprLabels && x2 > rect.x && x2 < right - 4) {
          g.fillStyle = color
          g.fillText(`${st.label} ${tag}`, Math.min(x2 + 3, right - 40), yy)
        }
      }
      line(sp.lv.tc, st.color, s.cprWidth, 'TC')
      line(sp.lv.p, st.color, s.pivotWidth, 'P')
      line(sp.lv.bc, st.color, s.cprWidth, 'BC')
      if (st.sr) {
        line(sp.lv.r1, rgba(s.rColor, 0.8), 1, 'R1')
        line(sp.lv.s1, rgba(s.sColor, 0.8), 1, 'S1')
        line(sp.lv.r2, rgba(s.rColor, 0.5), 1, 'R2')
        line(sp.lv.s2, rgba(s.sColor, 0.5), 1, 'S2')
      }
    }
  }
  g.setLineDash([])

  // ---- Donchian ----
  if (s.dc) {
    if (s.dcFill > 0) fillBetween(g, conv, candles, r.dcUp, r.dcLo, from, to, rgba(s.dcColor, s.dcFill))
    strokeSeries(g, conv, candles, r.dcUp, from, to, s.dcColor, s.dcWidth, s.dcDash)
    strokeSeries(g, conv, candles, r.dcLo, from, to, s.dcColor, s.dcWidth, s.dcDash)
    if (s.dcMid) {
      // Pine draws the middle as circles
      g.fillStyle = rgba(s.dcColor, 0.6)
      g.beginPath()
      for (let i = from; i <= to; i++) {
        const v = r.dcMid[i]
        if (!Number.isFinite(v)) continue
        const x = X(i)
        const y = conv.priceToY(v)
        g.moveTo(x + 1.4, y)
        g.arc(x, y, 1.4, 0, Math.PI * 2)
      }
      g.fill()
    }
  }

  // ---- Bollinger (background can be hidden: "Show background") ----
  if (s.bb) {
    if (s.bbFill > 0) fillBetween(g, conv, candles, r.bbUp, r.bbLo, from, to, rgba(s.bbColor, s.bbFill))
    if (s.bbBasis) strokeSeries(g, conv, candles, r.bbBasis, from, to, rgba(s.bbColor, 0.7), s.bbWidth, s.bbDash)
    strokeSeries(g, conv, candles, r.bbUp, from, to, s.bbColor, s.bbWidth, s.bbDash)
    strokeSeries(g, conv, candles, r.bbLo, from, to, s.bbColor, s.bbWidth, s.bbDash)
  }

  // ---- Day open (breaks at each new day) ----
  if (s.dayOpen) strokeSeries(g, conv, candles, r.dayOpen, from, to, s.doColor, s.doWidth, s.doDash, r.newDay)

  // ---- SMAs ----
  if (s.sma) {
    strokeSeries(g, conv, candles, r.sma1, from, to, s.sma1Color, s.smaWidth, [])
    strokeSeries(g, conv, candles, r.sma2, from, to, s.sma2Color, s.smaWidth, [])
  }

  // ---- BUY / SELL arrows ----
  if (s.sig) {
    const k = [0.8, 1, 1.3][s.sigSize] ?? 1
    g.font = `700 ${Math.round(10 * k)}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
    g.textAlign = 'center'
    const h = 12 * k
    const w = 6 * k
    for (let i = from; i <= to; i++) {
      const sg = r.signal[i]
      if (!sg) continue
      const c = candles[i]
      const x = X(i)
      const up = sg === 1
      const dir = up ? 1 : -1
      const base = conv.priceToY(up ? c.low : c.high) + 6 * dir
      g.fillStyle = up ? s.buy : s.sell
      g.beginPath()
      g.moveTo(x, base)
      g.lineTo(x - w, base + h * 0.55 * dir)
      g.lineTo(x - w * 0.4, base + h * 0.55 * dir)
      g.lineTo(x - w * 0.4, base + h * dir)
      g.lineTo(x + w * 0.4, base + h * dir)
      g.lineTo(x + w * 0.4, base + h * 0.55 * dir)
      g.lineTo(x + w, base + h * 0.55 * dir)
      g.closePath()
      g.fill()
      if (s.sigText) g.fillText(up ? 'BUY' : 'SELL', x, base + (h + 8 * k) * dir)
    }
  }
  g.restore()
}
