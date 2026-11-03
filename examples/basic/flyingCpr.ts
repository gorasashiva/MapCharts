// "Flying CPR Signals" — Indicators-menu entry ported from "Flying CPR.pine".
// Math: src/overlays/flyingCprModel.ts. Drawn through the canvas-indicator hook
// (see CanvasSource in custom-indicators.ts): opening-range high / low, the six
// Fibonacci extensions each side, A–D setup labels, the original breakout arrows
// and the dashboard. Every plot has its own show / colour / width / style.
//
// Not ported: alertcondition() (no alert hook for canvas indicators). The range is
// read from the chart's bars, not a 1-minute request — exact on 1m, close on 3m / 5m.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import type { SessTz } from '../../src/overlays/sessionsModel'
import { FC_RATIOS, FLYING_CPR_DEFAULTS, computeFlyingCpr, marioState, type FcSetup, type FlyingCprOptions, type FlyingCprResult } from '../../src/overlays/flyingCprModel'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const D = FLYING_CPR_DEFAULTS

// Pine's color.* constants, offered as a dropdown (params are numeric).
export const PALETTE = [
  ['Red', '#FF5252'],
  ['Green', '#4CAF50'],
  ['Lime', '#00E676'],
  ['Teal', '#00897B'],
  ['Aqua', '#00BCD4'],
  ['Blue', '#2196F3'],
  ['Navy', '#311B92'],
  ['Purple', '#9C27B0'],
  ['Fuchsia', '#E040FB'],
  ['Maroon', '#880E4F'],
  ['Orange', '#FF9800'],
  ['Yellow', '#FFEB3B'],
  ['Olive', '#808000'],
  ['White', '#FFFFFF'],
  ['Silver', '#B2B5BE'],
  ['Gray', '#787B86'],
  ['Black', '#363A45'],
] as const
export const COL = Object.fromEntries(PALETTE.map(([name], i) => [name, i])) as Record<(typeof PALETTE)[number][0], number>
export const colorOpts = PALETTE.map(([name], i) => ({ value: i, label: name }))
const widthOpts = [1, 2, 3, 4, 5].map((w) => ({ value: w, label: `${w}px` }))
const styleOpts = [
  { value: 0, label: 'Solid' },
  { value: 1, label: 'Dashed' },
  { value: 2, label: 'Dotted' },
]
const sizeOpts = [
  { value: 0, label: 'Tiny' },
  { value: 1, label: 'Small' },
  { value: 2, label: 'Normal' },
  { value: 3, label: 'Large' },
  { value: 4, label: 'Huge' },
]
const TZS: SessTz[] = ['Asia/Kolkata', 'UTC', 'America/New_York', 'Europe/London']
const tzOpts = [
  { value: 0, label: 'Asia/Kolkata (IST)' },
  { value: 1, label: 'UTC' },
  { value: 2, label: 'America/New_York (follows DST)' },
  { value: 3, label: 'Europe/London (follows DST)' },
]

const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
const pick = (key: string, label: string, def: number, group: string, options: { value: number; label: string }[]): IndicatorParam => ({ key, label, default: def, group, options })

const G_SESS = 'Session (opening range)'
const G_SIG = 'Signals'
const G_TUNE = 'Signal tuning'
const G_TIME = 'Time-of-day filter (UTC)'
const G_DOW = 'Day-of-week filter'
const G_LINES = 'Lines — general'
const G_RANGE = 'Style — Session High / Low'
const G_ZONE = 'Style — extension zone fills'
const G_SIGV = 'Style — signal labels'
const G_DASH = 'Dashboard'

/** Per-level defaults: Pine colours (blue / purple / purple / blue / orange / orange). */
const LEVELS = FC_RATIOS.map((r, k) => ({
  key: `f${String(r).replace('.', '')}`,
  name: `F${r.toFixed(2)}`,
  color: [COL.Blue, COL.Purple, COL.Purple, COL.Blue, COL.Orange, COL.Orange][k],
}))
const SETUPS: { id: FcSetup; name: string; buy: number; sell: number; size: number }[] = [
  { id: 'A', name: 'A — Range Breakout (trend day)', buy: COL.Lime, sell: COL.Red, size: 1 },
  { id: 'B', name: 'B — Fib Extension Rejection', buy: COL.Aqua, sell: COL.Orange, size: 0 },
  { id: 'C', name: 'C — NY-Reversal Fade ⭐', buy: COL.Aqua, sell: COL.Fuchsia, size: 2 },
  { id: 'D', name: 'D — Extreme Capitulation', buy: COL.Fuchsia, sell: COL.Purple, size: 3 },
]
const SETUP_TEXT: Record<FcSetup, [string, string]> = { A: ['BO Long', 'BO Short'], B: ['Fib Fade', 'Fib Fade'], C: ['NY Fade', 'NY Fade'], D: ['EXTREME', 'EXTREME'] }

export const flyingCpr: IndicatorDef = {
  id: 'flying_cpr',
  label: 'Flying CPR Signals (opening range + Fib extensions, A–D setups)',
  shortLabel: 'Flying CPR',
  placement: 'overlay',
  params: [
    pick('tz', 'Timezone for session window', 0, G_SESS, tzOpts),
    num('sessStartH', 'Session start hour', 9, G_SESS, 0, 23, 1),
    num('sessStartM', 'Session start minute', 31, G_SESS, 0, 59, 1),
    num('sessEndH', 'Session end hour', 9, G_SESS, 0, 23, 1),
    num('sessEndM', 'Session end minute', 59, G_SESS, 0, 59, 1),
    num('resetH', 'Daily reset hour', 9, G_SESS, 0, 23, 1),
    num('resetM', 'Daily reset minute', 30, G_SESS, 0, 59, 1),
    toggle('useMario', 'Mario mode (NSE options)', false, G_SESS),

    ...SETUPS.map((s) => toggle(`use${s.id}`, s.name, true, G_SIG)),
    toggle('useArrows', 'Show original breakout arrows', false, G_SIG),

    num('wideBodyATR', 'A: wide-body min (× ATR14)', D.wideBodyATR, G_TUNE, 0.3, 10, 0.1),
    num('narrowRange', 'A: narrow range (session ÷ ATR14)', D.narrowRange, G_TUNE, 0.1, 10, 0.1),
    num('fadeBuffer', 'B/D: rejection buffer (× ATR14)', D.fadeBuffer, G_TUNE, 0.05, 5, 0.05),
    num('volMult', 'C: vol mult (× SMA vol)', D.volMult, G_TUNE, 1, 10, 0.05),
    num('capVolMult', 'D: capitulation vol mult', D.capVolMult, G_TUNE, 1.2, 10, 0.1),
    num('volLen', 'Volume avg length', D.volLen, G_TUNE, 5, 500, 1),

    toggle('useTimeFlt', 'Enable time-of-day filter', D.useTimeFlt, G_TIME),
    toggle('tradeAsia', 'Asian session (22:00–06:00 UTC)', D.tradeAsia, G_TIME),
    toggle('tradeLondon', 'London (07:00–12:00 UTC)', D.tradeLondon, G_TIME),
    toggle('tradeNYover', 'NY-London overlap (12:00–16:00 UTC) ⭐', D.tradeNYover, G_TIME),
    toggle('tradeNYpm', 'NY afternoon (16:00–21:00 UTC)', D.tradeNYpm, G_TIME),
    toggle('tradeLate', 'Post-21:00 UTC', D.tradeLate, G_TIME),

    toggle('useDowFlt', 'Enable day-of-week filter', D.useDowFlt, G_DOW),
    ...['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((d, i) => toggle(`day${i}`, d, true, G_DOW)),
    toggle('flatFriPM', 'Block new entries Fri after 16:00 UTC', D.flatFriPM, G_DOW),

    pick('lineMode', 'Line shape', 0, G_LINES, [
      { value: 0, label: 'Steps (flat levels)' },
      { value: 1, label: 'Connected (as Pine plot)' },
    ]),
    num('lineOpacity', 'Line opacity %', 100, G_LINES, 5, 100, 5),
    toggle('showHistory', 'Show past days', true, G_LINES),
    num('historyOpacity', 'Past days opacity %', 45, G_LINES, 5, 100, 5),
    toggle('extendRight', 'Extend current levels to the right edge', true, G_LINES),
    pick('priceLabels', 'Level labels (right edge)', 2, G_LINES, [
      { value: 0, label: 'Off' },
      { value: 1, label: 'Name only' },
      { value: 2, label: 'Name + price' },
      { value: 3, label: 'Price only' },
    ]),
    pick('labelSize', 'Level label size', 1, G_LINES, sizeOpts),

    toggle('showSH', 'Show Session High', true, G_RANGE),
    pick('shColor', 'High colour', COL.Red, G_RANGE, colorOpts),
    toggle('showSL', 'Show Session Low', true, G_RANGE),
    pick('slColor', 'Low colour', COL.Green, G_RANGE, colorOpts),
    pick('rangeWidth', 'Width', 2, G_RANGE, widthOpts),
    pick('rangeStyle', 'Style', 0, G_RANGE, styleOpts),
    toggle('rangeFill', 'Shade the opening range', false, G_RANGE),
    pick('rangeFillColor', 'Shade colour', COL.Gray, G_RANGE, colorOpts),
    num('rangeFillOpacity', 'Shade opacity %', 10, G_RANGE, 1, 100, 1),

    ...LEVELS.flatMap((lv): IndicatorParam[] => {
      const g = `Style — ${lv.name} (up / down)`
      return [
        toggle(`${lv.key}Up`, `Show ${lv.name} up`, true, g),
        toggle(`${lv.key}Down`, `Show ${lv.name} down`, true, g),
        pick(`${lv.key}Color`, 'Up colour', lv.color, g, colorOpts),
        pick(`${lv.key}DownColor`, 'Down colour', lv.color, g, colorOpts),
        pick(`${lv.key}Width`, 'Width', 1, g, widthOpts),
        pick(`${lv.key}Style`, 'Style', 0, g, styleOpts),
      ]
    }),

    toggle('zone1', 'Fill F2.07 – F2.57 zone', false, G_ZONE),
    toggle('zone2', 'Fill F4.07 – F4.57 zone', false, G_ZONE),
    toggle('zone3', 'Fill F10.07 – F10.57 zone', false, G_ZONE),
    pick('zoneUpColor', 'Upper zones colour', COL.Red, G_ZONE, colorOpts),
    pick('zoneDownColor', 'Lower zones colour', COL.Green, G_ZONE, colorOpts),
    num('zoneOpacity', 'Zone opacity %', 12, G_ZONE, 1, 100, 1),

    pick('sigStyle', 'Label style', 0, G_SIGV, [
      { value: 0, label: 'Label with text (as Pine)' },
      { value: 1, label: 'Compact (setup + arrow)' },
      { value: 2, label: 'Triangle only' },
    ]),
    num('sigScale', 'Label size scale %', 100, G_SIGV, 50, 250, 10),
    ...SETUPS.flatMap((s): IndicatorParam[] => [
      pick(`sig${s.id}Buy`, `${s.id} buy colour`, s.buy, G_SIGV, colorOpts),
      pick(`sig${s.id}Sell`, `${s.id} sell colour`, s.sell, G_SIGV, colorOpts),
      pick(`sig${s.id}Size`, `${s.id} size`, s.size, G_SIGV, sizeOpts),
    ]),
    pick('arrowUpColor', 'Breakout arrow up colour', COL.Lime, G_SIGV, colorOpts),
    pick('arrowDownColor', 'Breakout arrow down colour', COL.Red, G_SIGV, colorOpts),

    toggle('showDash', 'Show dashboard', true, G_DASH),
    pick('dashPos', 'Position', 0, G_DASH, [
      { value: 0, label: 'Top right' },
      { value: 1, label: 'Top left' },
      { value: 2, label: 'Bottom right' },
      { value: 3, label: 'Bottom left' },
    ]),
    toggle('dashLegend', 'Pattern legend rows', true, G_DASH),
    pick('dashSize', 'Text size', 1, G_DASH, sizeOpts),
    num('dashOpacity', 'Background opacity %', 80, G_DASH, 0, 100, 5),
  ],
  compute: () => [],
}

interface LineStyle {
  up: boolean
  down: boolean
  color: string
  downColor: string
  width: number
  dash: number[]
}

interface Display {
  lineMode: number
  lineAlpha: number
  history: boolean
  historyAlpha: number
  extendRight: boolean
  priceLabels: number
  labelPx: number
  sh: LineStyle
  levels: LineStyle[]
  rangeFill: string | null
  zones: boolean[]
  zoneUp: string
  zoneDown: string
  sigStyle: number
  sig: Record<FcSetup, { buy: string; sell: string; px: number }>
  arrows: boolean
  arrowUp: string
  arrowDown: string
  dash: boolean
  dashPos: number
  dashLegend: boolean
  dashPx: number
  dashAlpha: number
  mario: boolean
}

export interface FlyingCprModel {
  opts: FlyingCprOptions
  display: Display
  result: FlyingCprResult
  mario: { active: boolean; ce: number; pe: number }
  symbol: string
}

const SIZE_PX = [8, 10, 11, 13, 15]
const DASHES = [[], [6, 4], [1.5, 3]]
const rgba = (hex: string, a: number): string => {
  const v = parseInt(hex.slice(1), 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`
}
/** Black or white text, whichever reads on `hex`. */
const ink = (hex: string): string => {
  const v = parseInt(hex.slice(1), 16)
  return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255) > 150 ? '#000' : '#fff'
}

export function computeFlyingCprModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): FlyingCprModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const col = (k: string, d: number): string => (PALETTE[Math.round(n(k, d))] ?? PALETTE[d])[1]
  const pct = (k: string, d: number): number => Math.min(1, Math.max(0, n(k, d) / 100))
  const mins = (h: string, m: string, dh: number, dm: number): number => Math.round(n(h, dh)) * 60 + Math.round(n(m, dm))
  const tz = TZS[Math.round(n('tz', 0))] ?? D.tz

  const opts: FlyingCprOptions = {
    tz,
    sessStart: mins('sessStartH', 'sessStartM', 9, 31),
    sessEnd: mins('sessEndH', 'sessEndM', 9, 59),
    reset: mins('resetH', 'resetM', 9, 30),
    useA: b('useA', true),
    useB: b('useB', true),
    useC: b('useC', true),
    useD: b('useD', true),
    wideBodyATR: n('wideBodyATR', D.wideBodyATR),
    narrowRange: n('narrowRange', D.narrowRange),
    fadeBuffer: n('fadeBuffer', D.fadeBuffer),
    volMult: n('volMult', D.volMult),
    capVolMult: n('capVolMult', D.capVolMult),
    volLen: Math.max(1, Math.round(n('volLen', D.volLen))),
    useTimeFlt: b('useTimeFlt', D.useTimeFlt),
    tradeAsia: b('tradeAsia', D.tradeAsia),
    tradeLondon: b('tradeLondon', D.tradeLondon),
    tradeNYover: b('tradeNYover', D.tradeNYover),
    tradeNYpm: b('tradeNYpm', D.tradeNYpm),
    tradeLate: b('tradeLate', D.tradeLate),
    useDowFlt: b('useDowFlt', D.useDowFlt),
    days: [0, 1, 2, 3, 4].map((i) => b(`day${i}`, true)) as FlyingCprOptions['days'],
    flatFriPM: b('flatFriPM', D.flatFriPM),
  }
  const sigScale = Math.max(0.5, n('sigScale', 100) / 100)
  const result = computeFlyingCpr(candles, opts)

  return {
    opts,
    symbol: ctx.symbol,
    result,
    mario: marioState(candles, result, tz),
    display: {
      lineMode: Math.round(n('lineMode', 0)),
      lineAlpha: pct('lineOpacity', 100),
      history: b('showHistory', true),
      historyAlpha: pct('historyOpacity', 45),
      extendRight: b('extendRight', true),
      priceLabels: Math.round(n('priceLabels', 2)),
      labelPx: SIZE_PX[Math.round(n('labelSize', 1))] ?? 10,
      sh: {
        up: b('showSH', true),
        down: b('showSL', true),
        color: col('shColor', COL.Red),
        downColor: col('slColor', COL.Green),
        width: n('rangeWidth', 2),
        dash: DASHES[Math.round(n('rangeStyle', 0))] ?? [],
      },
      levels: LEVELS.map((lv) => ({
        up: b(`${lv.key}Up`, true),
        down: b(`${lv.key}Down`, true),
        color: col(`${lv.key}Color`, lv.color),
        downColor: col(`${lv.key}DownColor`, lv.color),
        width: n(`${lv.key}Width`, 1),
        dash: DASHES[Math.round(n(`${lv.key}Style`, 0))] ?? [],
      })),
      rangeFill: b('rangeFill', false) ? rgba(col('rangeFillColor', COL.Gray), pct('rangeFillOpacity', 10)) : null,
      zones: [b('zone1', false), b('zone2', false), b('zone3', false)],
      zoneUp: rgba(col('zoneUpColor', COL.Red), pct('zoneOpacity', 12)),
      zoneDown: rgba(col('zoneDownColor', COL.Green), pct('zoneOpacity', 12)),
      sigStyle: Math.round(n('sigStyle', 0)),
      sig: Object.fromEntries(
        SETUPS.map((s) => [s.id, { buy: col(`sig${s.id}Buy`, s.buy), sell: col(`sig${s.id}Sell`, s.sell), px: (SIZE_PX[Math.round(n(`sig${s.id}Size`, s.size))] ?? 10) * sigScale }]),
      ) as Display['sig'],
      arrows: b('useArrows', false),
      arrowUp: col('arrowUpColor', COL.Lime),
      arrowDown: col('arrowDownColor', COL.Red),
      dash: b('showDash', true),
      dashPos: Math.round(n('dashPos', 0)),
      dashLegend: b('dashLegend', true),
      dashPx: SIZE_PX[Math.round(n('dashSize', 1))] ?? 10,
      dashAlpha: pct('dashOpacity', 80),
      mario: b('useMario', false),
    },
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const font = (px: number, weight = 600): string => `${weight} ${px}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
const fmtPrice = (p: number): string => (p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p.toPrecision(5))

export function drawFlyingCpr(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: FlyingCprModel, _ctx: CanvasIndicatorContext): void {
  const n = candles.length
  if (n < 2) return
  const { display: s, result: r } = model
  const X = (i: number): number => conv.timeToX(candles[i].time)
  const Y = (v: number): number => conv.priceToY(v)
  const barW = Math.abs(X(1) - X(0)) || 6
  const right = rect.x + rect.width
  const t0 = conv.xToTime(rect.x - 50)
  const t1 = conv.xToTime(right + 50)
  // visible index window (+1 each side so lines reach the edges)
  let i0 = 0
  while (i0 < n - 1 && candles[i0 + 1].time < t0) i0++
  let i1 = n - 1
  while (i1 > 0 && candles[i1 - 1].time > t1) i1--

  // first bar of the current day's levels: the run of set values ending at the last bar (a reset leaves a gap)
  let cur = n
  for (let k = n - 1; k >= 0 && !Number.isNaN(r.sh[k]); k--) cur = k
  const from = s.history ? i0 : Math.max(i0, cur)

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  // ---- fills (under the lines) ----
  const band = (a: Float64Array, b: Float64Array, fill: string): void => {
    g.fillStyle = fill
    for (let i = from; i <= i1; i++) {
      if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue
      const xa = X(i) - barW / 2
      const xb = i === n - 1 && s.extendRight ? right : X(i) + barW / 2
      const ya = Y(a[i])
      const yb = Y(b[i])
      g.fillRect(xa, Math.min(ya, yb), xb - xa, Math.abs(yb - ya))
    }
  }
  if (s.rangeFill) band(r.sh, r.sl, s.rangeFill)
  s.zones.forEach((on, z) => {
    if (!on) return
    band(r.up[z * 2], r.up[z * 2 + 1], s.zoneUp)
    band(r.down[z * 2], r.down[z * 2 + 1], s.zoneDown)
  })

  // ---- level lines: past days faint, the current day at full strength ----
  const stroke = (v: Float64Array, lo: number, hi: number, alpha: number): void => {
    if (hi < lo) return
    g.globalAlpha = alpha
    g.beginPath()
    let open = false
    for (let i = lo; i <= hi; i++) {
      if (Number.isNaN(v[i])) {
        open = false
        continue
      }
      const x = X(i)
      const y = Math.round(Y(v[i])) + 0.5
      if (!open) {
        g.moveTo(x - barW / 2, y)
        open = true
      } else if (s.lineMode === 0) {
        g.lineTo(x - barW / 2, Math.round(Y(v[i - 1])) + 0.5)
        g.lineTo(x - barW / 2, y)
      }
      g.lineTo(x, y)
      if (i === n - 1) g.lineTo(s.extendRight ? right : x + barW / 2, y)
    }
    g.stroke()
  }
  const lines: { v: Float64Array; color: string; width: number; dash: number[]; name: string }[] = []
  if (s.sh.up) lines.push({ v: r.sh, color: s.sh.color, width: s.sh.width, dash: s.sh.dash, name: 'SH' })
  if (s.sh.down) lines.push({ v: r.sl, color: s.sh.downColor, width: s.sh.width, dash: s.sh.dash, name: 'SL' })
  s.levels.forEach((lv, k) => {
    const name = `F${FC_RATIOS[k].toFixed(2)}`
    if (lv.up) lines.push({ v: r.up[k], color: lv.color, width: lv.width, dash: lv.dash, name: `${name}▲` })
    if (lv.down) lines.push({ v: r.down[k], color: lv.downColor, width: lv.width, dash: lv.dash, name: `${name}▼` })
  })
  for (const l of lines) {
    g.strokeStyle = l.color
    g.lineWidth = l.width
    g.setLineDash(l.dash)
    if (s.history) stroke(l.v, from, Math.min(i1, cur - 1), s.lineAlpha * s.historyAlpha)
    stroke(l.v, Math.max(from, cur), i1, s.lineAlpha)
  }
  g.globalAlpha = 1
  g.setLineDash([])

  // markers stacked above / below each bar
  const above = new Map<number, number>()
  const below = new Map<number, number>()
  const stack = (m: Map<number, number>, i: number, h: number): number => {
    const used = m.get(i) ?? 0
    m.set(i, used + h + 2)
    return 4 + used
  }

  // ---- original breakout arrows ----
  if (s.arrows) {
    g.font = font(9)
    for (const a of r.arrows) {
      if (a.index < i0 || a.index > i1) continue
      const c = candles[a.index]
      const upSide = a.side > 0
      const off = stack(upSide ? below : above, a.index, 20)
      const x = X(a.index)
      const y = upSide ? Y(c.low) + off : Y(c.high) - off
      const d = upSide ? 1 : -1
      g.fillStyle = upSide ? s.arrowUp : s.arrowDown
      g.beginPath()
      g.moveTo(x, y)
      g.lineTo(x - 4, y + d * 7)
      g.lineTo(x + 4, y + d * 7)
      g.closePath()
      g.fill()
      g.textAlign = 'center'
      g.textBaseline = upSide ? 'top' : 'bottom'
      g.fillText(`${upSide ? '▲' : '▼'} ${a.level}`, x, y + d * 9)
    }
  }

  // ---- A–D signal labels ----
  for (const sg of r.signals) {
    if (sg.index < i0 || sg.index > i1) continue
    const st = s.sig[sg.setup]
    const c = candles[sg.index]
    const buy = sg.side > 0
    const color = buy ? st.buy : st.sell
    const x = X(sg.index)
    const px = st.px
    if (s.sigStyle === 2) {
      const off = stack(buy ? below : above, sg.index, px)
      const y = buy ? Y(c.low) + off : Y(c.high) - off
      const d = buy ? 1 : -1
      g.fillStyle = color
      g.beginPath()
      g.moveTo(x, y)
      g.lineTo(x - px * 0.6, y + d * px)
      g.lineTo(x + px * 0.6, y + d * px)
      g.closePath()
      g.fill()
      continue
    }
    const head = `${sg.setup}${buy ? '▲' : '▼'}`
    const text = s.sigStyle === 1 ? head : `${head} ${SETUP_TEXT[sg.setup][buy ? 0 : 1]}`
    g.font = font(px)
    const w = g.measureText(text).width + px * 0.9
    const h = px + 6
    const off = stack(buy ? below : above, sg.index, h + 5)
    const tip = buy ? Y(c.low) + off : Y(c.high) - off
    const top = buy ? tip + 5 : tip - 5 - h
    g.fillStyle = color
    g.beginPath()
    g.roundRect(x - w / 2, top, w, h, 3)
    g.moveTo(x - 4, buy ? top : top + h)
    g.lineTo(x, tip)
    g.lineTo(x + 4, buy ? top : top + h)
    g.fill()
    g.fillStyle = ink(color)
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, x, top + h / 2 + 0.5)
  }

  // ---- right-edge level labels, nudged apart so they never overlap ----
  if (s.priceLabels > 0 && !Number.isNaN(r.sh[n - 1])) {
    const tags = lines
      .filter((l) => !Number.isNaN(l.v[n - 1]))
      .map((l) => {
        const v = l.v[n - 1]
        return { y: Y(v), color: l.color, text: s.priceLabels === 1 ? l.name : s.priceLabels === 3 ? fmtPrice(v) : `${l.name} ${fmtPrice(v)}` }
      })
      .filter((t) => t.y > rect.y - 20 && t.y < rect.y + rect.height + 20)
      .sort((a, b) => a.y - b.y)
    const h = s.labelPx + 6
    for (let k = 1; k < tags.length; k++) if (tags[k].y - tags[k - 1].y < h + 1) tags[k].y = tags[k - 1].y + h + 1
    g.font = font(s.labelPx)
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    for (const t of tags) {
      const w = g.measureText(t.text).width + 10
      g.globalAlpha = s.lineAlpha
      g.fillStyle = t.color
      g.beginPath()
      g.roundRect(right - w - 2, t.y - h / 2, w, h, 3)
      g.fill()
      g.globalAlpha = 1
      g.fillStyle = ink(t.color)
      g.fillText(t.text, right - w + 3, t.y + 0.5)
    }
  }

  if (s.dash) drawDashboard(g, rect, model)
  g.restore()
}

function drawDashboard(g: CanvasRenderingContext2D, rect: Rect, model: FlyingCprModel): void {
  const { display: s, result: r, mario: m, opts: o } = model
  const last = r.sh.length - 1
  if (last < 0) return
  const range = r.sh[last] - r.sl[last]
  const atr = r.atr[last]
  const ratio = Number.isNaN(range) || Number.isNaN(atr) || atr === 0 ? Number.NaN : range / atr
  const ratioColor = Number.isNaN(ratio) ? '#787B86' : ratio <= o.narrowRange ? '#00E676' : ratio > 1.5 ? '#FF9800' : '#fff'
  const ratioText = Number.isNaN(ratio) ? '—' : `${ratio.toFixed(2)}${ratio <= o.narrowRange ? ' (NARROW=trend)' : ratio > 1.5 ? ' (WIDE=range)' : ''}`
  const marioOn = s.mario && m.active

  // [left, right, right text colour, right background]
  const rows: [string, string, string, string?][] = [
    ['Mario Mode', s.mario ? 'ON' : 'OFF', '#fff', s.mario ? '#2196F3' : '#787B86'],
    ['Mario Status', marioOn ? 'ACTIVE ✅' : 'INACTIVE', '#fff', marioOn ? '#4CAF50' : '#787B86'],
    ['CE strike (≈F2.57)', marioOn ? fmtPrice(m.ce) : '—', '#fff'],
    ['PE strike (≈F2.57)', marioOn ? fmtPrice(m.pe) : '—', '#fff'],
    ['Session Range', Number.isNaN(range) ? '—' : fmtPrice(range), '#fff'],
    ['Range/ATR ratio', ratioText, ratioColor],
  ]
  // [left, right, left text colour]
  const legend: [string, string, string][] = s.dashLegend
    ? [
        ['A▲▼ BO', 'Range break + wide body', s.sig.A.buy],
        ['B▲▼ Fade', 'F2.07/F2.57 rejection', s.sig.B.buy],
        ['C▲▼ NY⭐', '13–15 UTC reversal at F2.57/F4.57', s.sig.C.sell],
        ['D▲▼ EXT', 'F4.57+ wick + vol spike', s.sig.D.sell],
      ]
    : []

  const px = s.dashPx
  const rowH = px + 7
  const all = [['Flying CPR Signals', model.symbol], ...rows, ...legend]
  g.font = font(px, 700)
  const c0 = Math.max(...all.map((a) => g.measureText(a[0]).width)) + 12
  const c1 = Math.max(...all.map((a) => g.measureText(a[1]).width)) + 12
  const W = c0 + c1
  const H = all.length * rowH
  const pad = 8
  // keep clear of the right-edge level labels and the time axis
  const x = s.dashPos === 1 || s.dashPos === 3 ? rect.x + pad : rect.x + rect.width - W - pad - 110
  const y = s.dashPos >= 2 ? rect.y + rect.height - H - pad - 24 : rect.y + pad

  g.fillStyle = `rgba(0, 0, 0, ${1 - s.dashAlpha * 0.8})`
  g.fillRect(x, y, W, H)
  g.strokeStyle = 'rgba(120, 123, 134, 0.6)'
  g.lineWidth = 1
  g.strokeRect(x + 0.5, y + 0.5, W, H)
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  const cell = (text: string, cx: number, cy: number, cw: number, color: string, bg?: string): void => {
    if (bg) {
      g.fillStyle = bg
      g.fillRect(cx + 1, cy + 1, cw - 2, rowH - 2)
    }
    g.fillStyle = color
    g.fillText(text, cx + 6, cy + rowH / 2 + 0.5)
  }
  let cy = y
  cell('Flying CPR Signals', x, cy, c0, '#FFEB3B', '#000')
  cell(model.symbol, x + c0, cy, c1, '#FFEB3B', '#000')
  g.font = font(px, 500)
  for (const [l, rt, rc, bg] of rows) {
    cy += rowH
    cell(l, x, cy, c0, '#fff')
    cell(rt, x + c0, cy, c1, rc, bg)
  }
  for (const [l, rt, lc] of legend) {
    cy += rowH
    cell(l, x, cy, c0, lc)
    cell(rt, x + c0, cy, c1, '#fff')
  }
}
