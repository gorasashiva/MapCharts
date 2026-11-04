/**
 * Ultra V2 — ported from the "VWAP + IB (1st Hour) + Session Volume Profile +
 * TJR BOS + Supertrend" Pine Script (UltraV2.pine, v6). Combines five tools
 * in one overlay, matching the source's own bundled-indicator structure:
 *
 *   1. Session-anchored VWAP with StdDev/Percentage bands (3 configurable pairs).
 *   2. Initial Balance: the FIRST `ibMinutes` of each session's high/low/mid,
 *      frozen and extended right once the window closes, plus extra (x2/x3)
 *      and intermediate (50%) levels, a live provisional box while the
 *      window is still forming, and a rolling 20-session delta table.
 *   3. Session Volume Profile: a per-session POC/VAH/VAL histogram (today's
 *      session — the Pine source also rebuilds on `barstate.islast`, i.e.
 *      shows the live/current period, which is what this replicates).
 *   4. TJR's BOS 2.0: the source's own strict rule — a swing high forms on a
 *      bullish-then-bearish candle pair (using the higher wick), a swing low
 *      on bearish-then-bullish (lower wick); a break line prints the moment
 *      a close takes out the last swing, alternating up/down like the source.
 *      (This platform already has a separate, ICT-style fractal-swing BOS in
 *      overlays/ict.ts — TJR's rule is simpler and produces different lines,
 *      kept here as its own independent tool per the source.)
 *   5. Supertrend (ATR trailing-stop trend line, standard recurrence).
 *
 * Session boundary = the symbol's trading-day open (core/session.ts): 00:00
 * UTC by default, 22:00 UTC (03:30 IST) for gold — the equivalent of Pine's
 * `timeframe.change("D")` on an exchange-session chart.
 *
 * Like ict.ts, this recomputes from the whole `candles` array whenever its
 * signature (length + last bar's time/close) changes, rather than
 * incrementally maintaining line/box objects the way the Pine script does —
 * simpler, and cheap enough at chart data sizes.
 */
import { sessionIndex } from '../core/session'
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import { wilderSeries } from '../indicators/helpers'
import { attachFloatingWidget, type FloatingWidgetHandle } from './floatingWidget'
import { zoneHeadline } from './profileZones'
import { lazyCanvas } from './lazyCanvas'

type Rect = { x: number; y: number; width: number; height: number }


export interface UltraV2Options {
  // ---- VWAP ----
  /** Master switch for the VWAP group (line + bands). */
  showVwap: boolean
  showVwapLine: boolean
  vwapBandsMode: 'stdev' | 'pct'
  showVwapBand1: boolean
  vwapBand1Mult: number
  showVwapBand2: boolean
  vwapBand2Mult: number
  showVwapBand3: boolean
  vwapBand3Mult: number
  // ---- Initial Balance ----
  /** Master switch for the IB group. */
  showIB: boolean
  ibMinutes: number
  /** Completed sessions' IB boxes. */
  showIBBoxes: boolean
  /** Provisional box while the current IB window is still forming. */
  showIBLiveBox: boolean
  showIBHighLow: boolean
  showIBExtraLevels: boolean
  showIBIntermediateLevels: boolean
  showIBDeltaTable: boolean
  // ---- Session Volume Profile ----
  /** Master switch for the SVP group. */
  showSVP: boolean
  showSvpHistogram: boolean
  showSvpValueAreaFill: boolean
  showPoc: boolean
  showVahVal: boolean
  /** Demand/supply zones derived from the profile's high-volume rows. */
  showSvpZones: boolean
  /** A row joins a zone when its volume is ≥ this % of the POC row's volume. */
  svpZoneThresholdPct: number
  svpRows: number
  /** 0..1 — the source's own default (0.4) is unusually low vs. the 0.68-0.70
   *  convention most volume-profile tools use; kept faithful to the script. */
  svpValueAreaPct: number
  // ---- TJR BOS 2.0 ----
  showBOS: boolean
  showBosUp: boolean
  showBosDown: boolean
  // ---- Supertrend ----
  showSupertrend: boolean
  showSupertrendUp: boolean
  showSupertrendDown: boolean
  atrPeriod: number
  atrFactor: number
  // ---- Style (every colour is a #rrggbb hex) ----
  vwapColor: string
  vwapWidth: number
  band1Color: string
  band2Color: string
  band3Color: string
  bandWidth: number
  /** Source: each band pair is filled at 95% transparency. */
  vwapBandFill: boolean
  vwapBandFillOpacity: number
  ibHighColor: string
  ibLowColor: string
  ibMidColor: string
  ibAreaColor: string
  ibAreaOpacity: number
  ibLineWidth: number
  ibMainStyle: LineStyle
  ibExtStyle: LineStyle
  ibIntStyle: LineStyle
  /** Source's "Show labels": IBH 100% / IBL 0% / IBM 50% / x2 / x3 tags. */
  ibLabels: boolean
  /** Source's "Initial balance window coloration" (tints the bars inside the IB window). */
  ibWindowShade: boolean
  svpBarColor: string
  svpValueAreaColor: string
  svpBarOpacity: number
  svpBackgroundColor: string
  svpBackgroundOpacity: number
  /** Histogram width, % of the chart width (source: "Profile Width %" of the session). */
  svpWidthPct: number
  /** Row height % (source: "Height % per Row"). */
  svpRowHeightPct: number
  pocColor: string
  pocWidth: number
  vahColor: string
  valColor: string
  svpLabels: boolean
  bosUpColor: string
  bosDownColor: string
  bosWidth: number
  bosStyle: LineStyle
  stUpColor: string
  stDownColor: string
  stWidth: number
  /** Source: fills between the candle-body middle and the Supertrend line at 90% transparency. */
  stFill: boolean
  stFillOpacity: number
}

export type LineStyle = 'solid' | 'dashed' | 'dotted'
const DASH: Record<LineStyle, number[]> = { solid: [], dashed: [5, 4], dotted: [1.5, 3] }

export const ULTRA_V2_DEFAULTS: UltraV2Options = {
  showVwap: true,
  showVwapLine: true,
  vwapBandsMode: 'stdev',
  showVwapBand1: true,
  vwapBand1Mult: 1,
  showVwapBand2: false,
  vwapBand2Mult: 2,
  showVwapBand3: false,
  vwapBand3Mult: 3,
  showIB: true,
  ibMinutes: 60,
  showIBBoxes: true,
  showIBLiveBox: true,
  showIBHighLow: true,
  showIBExtraLevels: true,
  showIBIntermediateLevels: true,
  showIBDeltaTable: true,
  showSVP: true,
  showSvpHistogram: true,
  showSvpValueAreaFill: true,
  showPoc: true,
  showVahVal: true,
  showSvpZones: true,
  svpZoneThresholdPct: 70,
  svpRows: 24,
  svpValueAreaPct: 0.4,
  showBOS: true,
  showBosUp: true,
  showBosDown: true,
  showSupertrend: true,
  showSupertrendUp: true,
  showSupertrendDown: true,
  atrPeriod: 2,
  atrFactor: 2,
  vwapColor: '#2962FF',
  vwapWidth: 1.5,
  band1Color: '#26a69a',
  band2Color: '#8d8d00',
  band3Color: '#00897b',
  bandWidth: 1,
  vwapBandFill: true,
  vwapBandFillOpacity: 0.05,
  ibHighColor: '#26a69a',
  ibLowColor: '#ef5350',
  ibMidColor: '#ffa726',
  ibAreaColor: '#b8851f',
  ibAreaOpacity: 0.35,
  ibLineWidth: 1,
  ibMainStyle: 'solid',
  ibExtStyle: 'dashed',
  ibIntStyle: 'dotted',
  ibLabels: true,
  ibWindowShade: false,
  svpBarColor: '#787b86',
  svpValueAreaColor: '#9598a1',
  svpBarOpacity: 0.5,
  svpBackgroundColor: '#2962FF',
  svpBackgroundOpacity: 0.08,
  svpWidthPct: 25,
  svpRowHeightPct: 68,
  pocColor: '#ffc107',
  pocWidth: 2,
  vahColor: '#2962FF',
  valColor: '#2962FF',
  svpLabels: true,
  bosUpColor: '#2962FF',
  bosDownColor: '#ef5350',
  bosWidth: 2,
  bosStyle: 'solid',
  stUpColor: '#26a69a',
  stDownColor: '#ef5350',
  stWidth: 2,
  stFill: true,
  stFillOpacity: 0.1,
}

const hexA = (hex: string, a: number): string => {
  const v = parseInt((hex || '#000000').slice(1), 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${Math.max(0, Math.min(1, a))})`
}
const fmtLvl = (v: number): string => (Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toPrecision(5))

// ---------------------------------------------------------------------------
// 1. VWAP + bands
// ---------------------------------------------------------------------------

interface VwapPoint {
  time: number
  vwap: number
  upper1: number
  lower1: number
  upper2: number
  lower2: number
  upper3: number
  lower3: number
}

function computeVwap(candles: Candle[], opts: UltraV2Options, openHourUTC = 0): VwapPoint[] {
  const out: VwapPoint[] = new Array(candles.length)
  let cumPV = 0
  let cumPV2 = 0
  let cumVol = 0
  let sessionDay = NaN
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const day = sessionIndex(c.time, openHourUTC)
    if (day !== sessionDay) {
      sessionDay = day
      cumPV = 0
      cumPV2 = 0
      cumVol = 0
    }
    const typical = (c.high + c.low + c.close) / 3
    cumPV += typical * c.volume
    cumPV2 += typical * typical * c.volume
    cumVol += c.volume
    const vwap = cumVol > 0 ? cumPV / cumVol : typical
    const variance = cumVol > 0 ? Math.max(0, cumPV2 / cumVol - vwap * vwap) : 0
    const basis = opts.vwapBandsMode === 'stdev' ? Math.sqrt(variance) : vwap * 0.01
    out[i] = {
      time: c.time,
      vwap,
      upper1: vwap + basis * opts.vwapBand1Mult,
      lower1: vwap - basis * opts.vwapBand1Mult,
      upper2: vwap + basis * opts.vwapBand2Mult,
      lower2: vwap - basis * opts.vwapBand2Mult,
      upper3: vwap + basis * opts.vwapBand3Mult,
      lower3: vwap - basis * opts.vwapBand3Mult,
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 2. Initial Balance
// ---------------------------------------------------------------------------

interface IBSession {
  startTime: number
  /** Last candle time seen so far in this session (box/line right edge while live). */
  lastTime: number
  windowEndTime: number
  high: number
  low: number
  /** True once a bar at/after windowEndTime has been seen (the window is frozen). */
  done: boolean
}

function computeIBSessions(candles: Candle[], ibMinutes: number, openHourUTC = 0): IBSession[] {
  const sessions: IBSession[] = []
  const windowMs = Math.max(1, ibMinutes) * 60_000
  let sessionDay = NaN
  let cur: IBSession | null = null
  for (const c of candles) {
    const day = sessionIndex(c.time, openHourUTC)
    if (day !== sessionDay) {
      sessionDay = day
      cur = { startTime: c.time, lastTime: c.time, windowEndTime: c.time + windowMs, high: c.high, low: c.low, done: false }
      sessions.push(cur)
      continue
    }
    if (!cur) continue
    cur.lastTime = c.time
    if (c.time < cur.windowEndTime) {
      if (!cur.done) {
        cur.high = Math.max(cur.high, c.high)
        cur.low = Math.min(cur.low, c.low)
      }
    } else {
      cur.done = true
    }
  }
  return sessions
}

/** Nearest-distance-to-{max,avg,min} classification, matching the source's ib_sentiment(). */
function ibSentiment(delta: number, history: number[]): string {
  if (history.length === 0) return '—'
  const h = Math.max(...history)
  const l = Math.min(...history)
  const a = history.reduce((s, v) => s + v, 0) / history.length
  const hComp = Math.abs(delta - h)
  const lComp = Math.abs(delta - l)
  const aComp = Math.abs(delta - a)
  if (hComp < lComp && hComp < aComp) return 'Huge'
  if (lComp < hComp && lComp < aComp) return 'Small'
  return 'Medium'
}

// ---------------------------------------------------------------------------
// 3. Session Volume Profile
// ---------------------------------------------------------------------------

export interface SvpResult {
  startTime: number
  endTime: number
  loPrice: number
  hiPrice: number
  step: number
  bins: number[]
  /** Approximate buy-side volume per row (see computeSvp). */
  buyBins: number[]
  pocBin: number
  vahBin: number
  valBin: number
}

/**
 * Candles carry no aggressor side, so each bar's volume is split into buy/sell
 * by where it closed within its range (close at the high = all buying, at the
 * low = all selling, a zero-range bar = half and half) — the usual OHLC
 * approximation of delta.
 */
export function computeSvp(candles: Candle[], rows: number, valueAreaPct: number, openHourUTC = 0): SvpResult | null {
  if (candles.length === 0) return null
  const lastDay = sessionIndex(candles[candles.length - 1].time, openHourUTC)
  const session = candles.filter((c) => sessionIndex(c.time, openHourUTC) === lastDay)
  if (session.length === 0) return null
  let lo = Infinity
  let hi = -Infinity
  for (const c of session) {
    if (c.low < lo) lo = c.low
    if (c.high > hi) hi = c.high
  }
  if (!(hi > lo)) return null
  const step = (hi - lo) / rows
  const bins = new Array(rows).fill(0)
  const buyBins = new Array(rows).fill(0)
  for (const c of session) {
    if (!(c.volume > 0)) continue
    let startBucket = Math.min(Math.floor((c.low - lo) / step), rows - 1)
    let endBucket = Math.min(Math.floor((c.high - lo) / step), rows - 1)
    if (endBucket < startBucket) endBucket = startBucket
    const spanned = endBucket - startBucket + 1
    const perBucket = c.volume / spanned
    const range = c.high - c.low
    const buyShare = range > 0 ? (c.close - c.low) / range : 0.5
    for (let b = startBucket; b <= endBucket; b++) {
      bins[b] += perBucket
      buyBins[b] += perBucket * buyShare
    }
  }
  let pocBin = 0
  for (let b = 1; b < rows; b++) if (bins[b] > bins[pocBin]) pocBin = b
  const total = bins.reduce((s: number, v: number) => s + v, 0)
  const target = total * valueAreaPct
  let vahBin = pocBin
  let valBin = pocBin
  let covered = bins[pocBin]
  while (covered < target) {
    const canUp = vahBin < rows - 1
    const canDown = valBin > 0
    if (!canUp && !canDown) break
    const volUp = canUp ? bins[vahBin + 1] : -1
    const volDown = canDown ? bins[valBin - 1] : -1
    if (volUp >= volDown && canUp) {
      vahBin++
      covered += bins[vahBin]
    } else if (canDown) {
      valBin--
      covered += bins[valBin]
    } else break
  }
  return { startTime: session[0].time, endTime: session[session.length - 1].time, loPrice: lo, hiPrice: hi, step, bins, buyBins, pocBin, vahBin, valBin }
}

export interface SvpZone {
  lo: number
  hi: number
  /** 'demand' = fully below price, 'supply' = fully above, 'inplay' = price is inside it. */
  kind: 'demand' | 'supply' | 'inplay'
  /** 0..100 — approximate share of the zone's volume that was buying. */
  buyPct: number
  hasPoc: boolean
}

/**
 * Demand/supply zones from the session profile: runs of adjacent rows whose
 * volume is ≥ `thresholdPct` of the POC row's (high-volume nodes, where the
 * session accepted price), classified against the live price. Row count sets
 * the granularity — fewer rows, wider zones.
 */
export function computeSvpZones(svp: SvpResult, price: number, thresholdPct: number): SvpZone[] {
  const min = svp.bins[svp.pocBin] * (thresholdPct / 100)
  const zones: SvpZone[] = []
  let b = 0
  while (b < svp.bins.length) {
    if (!(svp.bins[b] > 0 && svp.bins[b] >= min)) {
      b++
      continue
    }
    let e = b
    while (e + 1 < svp.bins.length && svp.bins[e + 1] > 0 && svp.bins[e + 1] >= min) e++
    let vol = 0
    let buy = 0
    for (let k = b; k <= e; k++) {
      vol += svp.bins[k]
      buy += svp.buyBins[k]
    }
    const lo = svp.loPrice + b * svp.step
    const hi = svp.loPrice + (e + 1) * svp.step
    zones.push({
      lo,
      hi,
      kind: hi <= price ? 'demand' : lo >= price ? 'supply' : 'inplay',
      buyPct: vol > 0 ? (buy / vol) * 100 : 50,
      hasPoc: svp.pocBin >= b && svp.pocBin <= e,
    })
    b = e + 1
  }
  return zones
}

// ---------------------------------------------------------------------------
// 4. TJR BOS 2.0
// ---------------------------------------------------------------------------

interface BosLine {
  x1: number
  x2: number
  y: number
  up: boolean
}

function computeTjrBos(candles: Candle[]): BosLine[] {
  const lines: BosLine[] = []
  let lastHigh: number | null = null
  let lastHighTime = 0
  let lastLow: number | null = null
  let lastLowTime = 0
  let allowUp = true
  let allowDown = true
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    const p = candles[i - 1]
    if (p.close > p.open && c.close < c.open) {
      lastHigh = Math.max(p.high, c.high)
      lastHighTime = p.high > c.high ? p.time : c.time
    }
    if (p.close < p.open && c.close > c.open) {
      lastLow = Math.min(p.low, c.low)
      lastLowTime = p.low < c.low ? p.time : c.time
    }
    if (lastHigh !== null && c.close > lastHigh && allowUp) {
      lines.push({ x1: lastHighTime, x2: c.time, y: lastHigh, up: true })
      allowUp = false
      allowDown = true
    }
    if (lastLow !== null && c.close < lastLow && allowDown) {
      lines.push({ x1: lastLowTime, x2: c.time, y: lastLow, up: false })
      allowDown = false
      allowUp = true
    }
  }
  return lines.length > 500 ? lines.slice(lines.length - 500) : lines
}

// ---------------------------------------------------------------------------
// 5. Supertrend
// ---------------------------------------------------------------------------

export interface SupertrendPoint {
  time: number
  value: number
  up: boolean // true = uptrend (line acts as support, drawn green)
}

export function computeSupertrend(candles: Candle[], period: number, factor: number): SupertrendPoint[] {
  const n = candles.length
  const tr: (number | null)[] = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    const c = candles[i]
    tr[i] = i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))
  }
  const atr = wilderSeries(tr, period)
  const out: SupertrendPoint[] = new Array(n)
  let finalUpper = NaN
  let finalLower = NaN
  let up = true
  for (let i = 0; i < n; i++) {
    const c = candles[i]
    const a = atr[i]
    if (a === null) {
      out[i] = { time: c.time, value: NaN, up: true }
      continue
    }
    const hl2 = (c.high + c.low) / 2
    const basicUpper = hl2 + factor * a
    const basicLower = hl2 - factor * a
    const prevClose = i > 0 ? candles[i - 1].close : c.close
    finalUpper = !isNaN(finalUpper) && (basicUpper < finalUpper || prevClose > finalUpper) ? basicUpper : isNaN(finalUpper) ? basicUpper : finalUpper
    finalLower = !isNaN(finalLower) && (basicLower > finalLower || prevClose < finalLower) ? basicLower : isNaN(finalLower) ? basicLower : finalLower
    if (i === 0) {
      up = c.close >= hl2
    } else if (up) {
      up = c.close >= finalLower
    } else {
      up = c.close > finalUpper
    }
    out[i] = { time: c.time, value: up ? finalLower : finalUpper, up }
  }
  return out
}

// ---------------------------------------------------------------------------
// Overlay class
// ---------------------------------------------------------------------------

const COLORS = {
  vwap: '#2962FF',
  band1: '#26a69a',
  band2: '#8d8d00',
  band3: '#00897b',
  ibHigh: '#26a69a',
  ibLow: '#ef5350',
  ibMid: '#ffa726',
  ibArea: 'rgba(184,133,31,0.35)',
  poc: '#ffc107',
  vah: '#2962FF',
  val: '#2962FF',
  svpBar: 'rgba(120,123,134,0.45)',
  svpValueArea: 'rgba(120,123,134,0.7)',
  svpBackground: 'rgba(41,98,255,0.08)',
  demandFill: 'rgba(38,166,154,0.14)',
  demandEdge: '#26a69a',
  supplyFill: 'rgba(239,83,80,0.14)',
  supplyEdge: '#ef5350',
  inplayFill: 'rgba(255,193,7,0.12)',
  inplayEdge: '#ffc107',
  bosUp: '#2962FF',
  bosDown: '#ef5350',
  stUp: '#26a69a',
  stDown: '#ef5350',
}

export default class UltraV2Overlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private opts: UltraV2Options
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private ro: ResizeObserver | null = null
  private running = false
  private raf = 0
  private enabled = false

  private candles: Candle[] = []
  private openHourUTC = 0 // trading-day open — see core/session.ts
  private lastSig = ''
  private lastViewSig = ''
  private vwapSeries: VwapPoint[] = []
  private ibSessions: IBSession[] = []
  private svp: SvpResult | null = null
  private svpZones: SvpZone[] = []
  private bos: BosLine[] = []
  private supertrend: SupertrendPoint[] = []
  private ibDeltaHistory: number[] = []

  // IB delta analytics — a small floating widget (position.bottom_left in the source).
  private readonly widgetRoot: HTMLElement
  private readonly widgetBody: HTMLElement
  private readonly dock: FloatingWidgetHandle

  constructor(container: HTMLElement, engine: IChartEngine, opts?: Partial<UltraV2Options>) {
    this.container = container
    this.engine = engine
    this.opts = { ...ULTRA_V2_DEFAULTS, ...opts }

    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '18'
    container.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)

    this.widgetRoot = document.createElement('div')
    this.widgetRoot.className = 'uv2-widget'
    this.widgetRoot.style.display = 'none'
    const head = document.createElement('div')
    head.className = 'uv2-head'
    head.textContent = 'IB DELTA (1H)'
    this.widgetBody = document.createElement('div')
    this.widgetBody.className = 'uv2-body'
    this.widgetRoot.append(head, this.widgetBody)
    container.appendChild(this.widgetRoot)
    // bottom-right: the one corner nothing else in this demo currently docks
    // to (top-left has Buy/Sell Poll + Setup Checklist, top-right has
    // Dominance V2 + GEX V2, bottom-left has the Order Book Imbalance gauge).
    this.dock = attachFloatingWidget(container, this.widgetRoot, 'bottom-right')

    this.resize()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
  }

  resize(): void {
    const rect = this.container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.lastViewSig = ''
    this.dock.resize()
  }

  /** Call whenever the pane's candle array changes (load, symbol/interval switch, live tick). */
  setCandles(candles: Candle[]): void {
    this.candles = candles
  }

  /** UTC hour each trading session opens (VWAP / IB / session profile reset there). */
  setSessionOpenHour(hourUTC: number): void {
    if (hourUTC === this.openHourUTC) return
    this.openHourUTC = hourUTC
    this.lastSig = ''
  }

  setOptions(opts: Partial<UltraV2Options>): void {
    this.opts = { ...this.opts, ...opts }
    this.lastSig = '' // recompute now, not on the next tick
    this.lastViewSig = ''
    this.syncWidgetVisibility()
  }

  getOptions(): UltraV2Options {
    return { ...this.opts }
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
    this.syncWidgetVisibility()
    if (on) this.start()
    else this.stop()
  }

  private syncWidgetVisibility(): void {
    const show = this.enabled && this.opts.showIB && this.opts.showIBDeltaTable
    this.widgetRoot.style.display = show ? 'flex' : 'none'
    this.dock.setVisible(show)
  }

  start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      this.draw()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  reset(): void {
    this.candles = []
    this.lastSig = ''
    this.vwapSeries = []
    this.ibSessions = []
    this.svp = null
    this.svpZones = []
    this.bos = []
    this.supertrend = []
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  destroy(): void {
    this.stop()
    this.ro?.disconnect()
    this.dock.destroy()
    this.widgetRoot.remove()
    this.canvas.remove()
  }

  private recompute(): void {
    const c = this.candles
    if (c.length < 3) return
    const last = c[c.length - 1]
    const sig = `${c.length}:${last.time}:${last.close}`
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.vwapSeries = this.opts.showVwap ? computeVwap(c, this.opts, this.openHourUTC) : []
    this.ibSessions = this.opts.showIB ? computeIBSessions(c, this.opts.ibMinutes, this.openHourUTC) : []
    this.svp = this.opts.showSVP ? computeSvp(c, this.opts.svpRows, this.opts.svpValueAreaPct, this.openHourUTC) : null
    this.svpZones = this.svp && this.opts.showSvpZones ? computeSvpZones(this.svp, last.close, this.opts.svpZoneThresholdPct) : []
    this.bos = this.opts.showBOS ? computeTjrBos(c) : []
    this.supertrend = this.opts.showSupertrend ? computeSupertrend(c, this.opts.atrPeriod, this.opts.atrFactor) : []

    // Rolling 20-session delta history + the analytics widget.
    const dones = this.ibSessions.filter((s) => s.done)
    this.ibDeltaHistory = dones.slice(-20).map((s) => s.high - s.low)
    this.renderWidget()
  }

  private renderWidget(): void {
    if (!this.opts.showIB || !this.opts.showIBDeltaTable) return
    const history = this.ibDeltaHistory
    const today = this.ibSessions.length > 0 ? this.ibSessions[this.ibSessions.length - 1] : null
    const delta = today ? today.high - today.low : NaN
    const max = history.length ? Math.max(...history) : NaN
    const min = history.length ? Math.min(...history) : NaN
    const avg = history.length ? history.reduce((s, v) => s + v, 0) / history.length : NaN
    const status = isFinite(delta) ? ibSentiment(delta, history) : '—'
    const fmt = (v: number): string => (isFinite(v) ? v.toFixed(4) : '—')
    this.widgetBody.innerHTML = ''
    const rows: [string, string, string][] = [
      ['20D MAX', fmt(max), this.opts.ibHighColor],
      ['20D AVG', fmt(avg), this.opts.ibMidColor],
      ['20D MIN', fmt(min), this.opts.ibLowColor],
      ['Today', fmt(delta), '#4361ee'],
      ['Status', status, '#d1d4dc'],
    ]
    for (const [label, value, color] of rows) {
      const row = document.createElement('div')
      row.className = 'uv2-row'
      const l = document.createElement('span')
      l.className = 'uv2-label'
      l.textContent = label
      const v = document.createElement('span')
      v.className = 'uv2-value'
      v.style.color = color
      v.textContent = value
      row.append(l, v)
      this.widgetBody.appendChild(row)
    }
  }

  private draw(): void {
    this.recompute()
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    // Skip the frame when neither the data nor the view moved (pan / zoom / resize / scale).
    if (conv && rect && this.candles.length) {
      const c0 = this.candles[0].time
      const view = `${this.lastSig}|${rect.x},${rect.y},${rect.width},${rect.height}|${conv.timeToX(c0)}|${conv.timeToX(this.candles[this.candles.length - 1].time)}|${conv.priceToY(0)}|${conv.priceToY(1)}|${this.canvas.width}x${this.canvas.height}`
      if (view === this.lastViewSig) return
      this.lastViewSig = view
    } else this.lastViewSig = ''
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)
    if (!conv || !rect || this.candles.length === 0) return

    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.clip()

    if (this.opts.showSVP) this.drawSvp(conv, rect)
    if (this.opts.showIB) this.drawIB(conv, rect)
    if (this.opts.showVwap) this.drawVwap(conv, rect)
    if (this.opts.showSupertrend) this.drawSupertrend(conv, rect)
    if (this.opts.showBOS) this.drawBos(conv, rect)

    this.ctx.restore()
  }

  // ---- VWAP ----
  private drawVwap(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    const series = this.vwapSeries
    if (series.length === 0) return

    const o = this.opts
    const drawBandPair = (upperKey: keyof VwapPoint, lowerKey: keyof VwapPoint, color: string): void => {
      if (o.vwapBandFill && o.vwapBandFillOpacity > 0) this.fillSeries(conv, rect, series, upperKey, lowerKey, hexA(color, o.vwapBandFillOpacity))
      ctx.strokeStyle = color
      ctx.lineWidth = o.bandWidth
      ctx.globalAlpha = 0.85
      this.strokeSeries(conv, rect, series, upperKey)
      this.strokeSeries(conv, rect, series, lowerKey)
      ctx.globalAlpha = 1
    }
    if (o.showVwapBand3) drawBandPair('upper3', 'lower3', o.band3Color)
    if (o.showVwapBand2) drawBandPair('upper2', 'lower2', o.band2Color)
    if (o.showVwapBand1) drawBandPair('upper1', 'lower1', o.band1Color)

    if (o.showVwapLine) {
      ctx.strokeStyle = o.vwapColor
      ctx.lineWidth = o.vwapWidth
      this.strokeSeries(conv, rect, series, 'vwap')
    }
  }

  /** [from, to] indices of `series` (time-ascending) on screen, one point of margin each side. */
  private visible(conv: Converters, rect: Rect, times: { time: number }[]): [number, number] {
    const n = times.length
    if (!n) return [0, -1]
    const t0 = conv.xToTime(rect.x)
    const t1 = conv.xToTime(rect.x + rect.width)
    const lower = (t: number): number => {
      let a = 0
      let b = n
      while (a < b) {
        const m = (a + b) >> 1
        if (times[m].time < t) a = m + 1
        else b = m
      }
      return a
    }
    return [Math.max(0, lower(Math.min(t0, t1)) - 1), Math.min(n - 1, lower(Math.max(t0, t1)) + 1)]
  }

  /** Fill between two VWAP-series keys over the visible points (split at session resets). */
  private fillSeries(conv: Converters, rect: Rect, series: VwapPoint[], a: keyof VwapPoint, b: keyof VwapPoint, fill: string): void {
    const ctx = this.ctx
    const [from, to] = this.visible(conv, rect, series)
    ctx.fillStyle = fill
    let seg: VwapPoint[] = []
    const flush = (): void => {
      if (seg.length > 1) {
        ctx.beginPath()
        seg.forEach((p, k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, conv.timeToX(p.time), conv.priceToY(p[a] as number)))
        for (let k = seg.length - 1; k >= 0; k--) ctx.lineTo(conv.timeToX(seg[k].time), conv.priceToY(seg[k][b] as number))
        ctx.closePath()
        ctx.fill()
      }
      seg = []
    }
    let day = NaN
    for (let i = from; i <= to; i++) {
      const p = series[i]
      const d = sessionIndex(p.time, this.openHourUTC)
      if (d !== day) {
        flush()
        day = d
      }
      seg.push(p)
    }
    flush()
  }

  private strokeSeries(conv: Converters, rect: Rect, series: VwapPoint[], key: keyof VwapPoint): void {
    const ctx = this.ctx
    ctx.beginPath()
    let started = false
    const [from, to] = this.visible(conv, rect, series)
    for (let i = from; i <= to; i++) {
      const p = series[i]
      const x = conv.timeToX(p.time)
      const v = p[key] as number
      if (!isFinite(v)) continue
      const y = conv.priceToY(v)
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else ctx.lineTo(x, y)
    }
    if (started) ctx.stroke()
  }

  // ---- Initial Balance ----
  private drawIB(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    const sessions = this.ibSessions
    if (sessions.length === 0) return
    const lastCandleTime = this.candles[this.candles.length - 1].time

    const o = this.opts
    // Source's "Initial balance window coloration": tint the bars inside each IB window.
    if (o.ibWindowShade) {
      ctx.fillStyle = 'rgba(156, 39, 176, 0.2)'
      for (const s of sessions) {
        const x1 = conv.timeToX(s.startTime)
        const x2 = conv.timeToX(Math.min(s.windowEndTime, s.lastTime))
        if (x2 < rect.x || x1 > rect.x + rect.width) continue
        ctx.fillRect(x1, rect.y, Math.max(1, x2 - x1), rect.height)
      }
    }
    // Historical + live boxes (accumulate, matching the source's default).
    for (const s of sessions) {
      if (s.done ? !this.opts.showIBBoxes : !this.opts.showIBLiveBox) continue
      const x1 = conv.timeToX(s.startTime)
      const x2 = conv.timeToX(s.done ? s.windowEndTime : s.lastTime)
      if (x2 < rect.x || x1 > rect.x + rect.width) continue
      const y1 = conv.priceToY(s.high)
      const y2 = conv.priceToY(s.low)
      ctx.fillStyle = hexA(o.ibAreaColor, s.done ? o.ibAreaOpacity : o.ibAreaOpacity / 2)
      ctx.fillRect(Math.max(x1, rect.x), y1, Math.min(x2, rect.x + rect.width) - Math.max(x1, rect.x), y2 - y1)
    }

    // Current (most recent completed) session's levels, extended right.
    const current = [...sessions].reverse().find((s) => s.done)
    if (!current) return
    const h = current.high
    const l = current.low
    const m = (h + l) / 2
    const d = h - l
    const x1 = Math.max(conv.timeToX(current.startTime), rect.x)
    const x2 = Math.min(conv.timeToX(lastCandleTime), rect.x + rect.width)
    if (x2 < x1) return

    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textBaseline = 'bottom'
    ctx.textAlign = 'left'
    const level = (price: number, color: string, style: LineStyle, tag: string): void => {
      const y = Math.round(conv.priceToY(price)) + 0.5
      if (y < rect.y - 2 || y > rect.y + rect.height + 2) return
      ctx.strokeStyle = color
      ctx.lineWidth = o.ibLineWidth
      ctx.setLineDash(DASH[style] ?? [])
      ctx.beginPath()
      ctx.moveTo(x1, y)
      ctx.lineTo(x2, y)
      ctx.stroke()
      if (o.ibLabels) {
        ctx.fillStyle = color
        ctx.fillText(`${tag}: ${fmtLvl(price)}`, x1 + 4, y - 2)
      }
    }
    if (o.showIBHighLow) {
      level(h, o.ibHighColor, o.ibMainStyle, 'IBH 100%')
      level(l, o.ibLowColor, o.ibMainStyle, 'IBL 0%')
    }
    if (o.showIBIntermediateLevels) level(m, o.ibMidColor, o.ibIntStyle, `IBM 50% · IBΔ ${fmtLvl(d)}`)
    if (o.showIBExtraLevels) {
      level(h + d, o.ibHighColor, o.ibExtStyle, 'IBH x2')
      level(l - d, o.ibLowColor, o.ibExtStyle, 'IBL x2')
      level(h + d * 2, o.ibHighColor, o.ibExtStyle, 'IBH x3')
      level(l - d * 2, o.ibLowColor, o.ibExtStyle, 'IBL x3')
      if (o.showIBIntermediateLevels) {
        level(h + d / 2, o.ibMidColor, o.ibIntStyle, 'IBH +50%')
        level(l - d / 2, o.ibMidColor, o.ibIntStyle, 'IBL −50%')
      }
    }
    ctx.setLineDash([])
  }

  // ---- Session Volume Profile ----
  private drawSvp(conv: Converters, rect: Rect): void {
    const svp = this.svp
    if (!svp) return
    const ctx = this.ctx
    const x0 = Math.max(conv.timeToX(svp.startTime), rect.x)
    const o = this.opts
    const maxWidth = rect.width * Math.max(0.05, Math.min(0.9, o.svpWidthPct / 100))
    const maxVol = Math.max(...svp.bins, 1e-9)

    // Value-area background tint.
    const vahY = conv.priceToY(svp.loPrice + (svp.vahBin + 1) * svp.step)
    const valY = conv.priceToY(svp.loPrice + svp.valBin * svp.step)
    if (this.opts.showSvpValueAreaFill) {
      ctx.fillStyle = hexA(o.svpBackgroundColor, o.svpBackgroundOpacity)
      ctx.fillRect(x0, vahY, rect.x + rect.width - x0, valY - vahY)
    }

    if (this.opts.showSvpZones) this.drawSvpZones(conv, rect, x0)

    for (let b = 0; this.opts.showSvpHistogram && b < svp.bins.length; b++) {
      const vol = svp.bins[b]
      if (vol <= 0) continue
      const barW = (vol / maxVol) * maxWidth
      const yTop = conv.priceToY(svp.loPrice + (b + 1) * svp.step)
      const yBottom = conv.priceToY(svp.loPrice + b * svp.step)
      const inValueArea = b >= svp.valBin && b <= svp.vahBin
      ctx.fillStyle = inValueArea ? hexA(o.svpValueAreaColor, Math.min(1, o.svpBarOpacity * 1.5)) : hexA(o.svpBarColor, o.svpBarOpacity)
      const rowH = Math.abs(yBottom - yTop)
      const hh = Math.max(1, (rowH * Math.max(1, Math.min(100, o.svpRowHeightPct))) / 100)
      ctx.fillRect(x0, yTop + (rowH - hh) / 2, barW, hh)
    }

    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    const line = (price: number, color: string, width: number, tag: string): void => {
      const y = conv.priceToY(price)
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.moveTo(x0, y)
      ctx.lineTo(rect.x + rect.width, y)
      ctx.stroke()
      if (o.svpLabels && x0 - 4 > rect.x + 20) {
        ctx.fillStyle = color
        ctx.fillText(tag, x0 - 4, y)
      }
    }
    if (o.showPoc) line(svp.loPrice + (svp.pocBin + 0.5) * svp.step, o.pocColor, o.pocWidth, 'POC')
    if (o.showVahVal) {
      line(svp.loPrice + (svp.vahBin + 1) * svp.step, o.vahColor, 1, 'VAH')
      line(svp.loPrice + svp.valBin * svp.step, o.valColor, 1, 'VAL')
    }
  }

  private drawSvpZones(conv: Converters, rect: Rect, x0: number): void {
    const ctx = this.ctx
    const right = rect.x + rect.width
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const z of this.svpZones) {
      const yTop = conv.priceToY(z.hi)
      const yBot = conv.priceToY(z.lo)
      if (yBot < rect.y || yTop > rect.y + rect.height) continue
      const fill = z.kind === 'demand' ? COLORS.demandFill : z.kind === 'supply' ? COLORS.supplyFill : COLORS.inplayFill
      const edge = z.kind === 'demand' ? COLORS.demandEdge : z.kind === 'supply' ? COLORS.supplyEdge : COLORS.inplayEdge
      ctx.fillStyle = fill
      ctx.fillRect(x0, yTop, right - x0, yBot - yTop)
      ctx.strokeStyle = edge
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.moveTo(x0, Math.round(yTop) + 0.5)
      ctx.lineTo(right, Math.round(yTop) + 0.5)
      ctx.moveTo(x0, Math.round(yBot) - 0.5)
      ctx.lineTo(right, Math.round(yBot) - 0.5)
      ctx.stroke()
      ctx.globalAlpha = 1
      if (yBot - yTop >= 12) {
        ctx.fillStyle = edge
        // Top edge rather than centre, so the label clears the POC line that runs through a POC zone.
        const ly = yBot - yTop >= 20 ? yTop + 9 : (yTop + yBot) / 2
        const price = this.candles.length ? this.candles[this.candles.length - 1].close : (z.lo + z.hi) / 2
        ctx.fillText(`${zoneHeadline(z.kind, z.lo, z.hi, price, z.buyPct)}${z.hasPoc ? ' · POC' : ''}`, right - 6, ly)
      }
    }
  }

  // ---- TJR BOS 2.0 ----
  private drawBos(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    for (const b of this.bos) {
      if (b.up ? !this.opts.showBosUp : !this.opts.showBosDown) continue
      const x1 = conv.timeToX(b.x1)
      const x2 = conv.timeToX(b.x2)
      if (x2 < rect.x - 5 || x1 > rect.x + rect.width + 5) continue
      const y = conv.priceToY(b.y)
      ctx.strokeStyle = b.up ? this.opts.bosUpColor : this.opts.bosDownColor
      ctx.lineWidth = this.opts.bosWidth
      ctx.setLineDash(DASH[this.opts.bosStyle] ?? [])
      ctx.beginPath()
      ctx.moveTo(Math.max(x1, rect.x), y)
      ctx.lineTo(Math.min(x2, rect.x + rect.width), y)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  // ---- Supertrend ----
  private drawSupertrend(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    const series = this.supertrend
    if (series.length === 0) return
    const o = this.opts
    const [from, to] = this.visible(conv, rect, series)
    // Source: fill between the candle-body middle and the trend line, per trend leg.
    if (o.stFill && o.stFillOpacity > 0) {
      const candles = this.candles
      let seg: number[] = []
      let segUp = true
      const flush = (): void => {
        if (seg.length > 1 && (segUp ? o.showSupertrendUp : o.showSupertrendDown)) {
          ctx.fillStyle = hexA(segUp ? o.stUpColor : o.stDownColor, o.stFillOpacity)
          ctx.beginPath()
          seg.forEach((i, k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, conv.timeToX(series[i].time), conv.priceToY(series[i].value)))
          for (let k = seg.length - 1; k >= 0; k--) {
            const c = candles[seg[k]]
            ctx.lineTo(conv.timeToX(c.time), conv.priceToY((c.open + c.close) / 2))
          }
          ctx.closePath()
          ctx.fill()
        }
        seg = []
      }
      for (let i = from; i <= to; i++) {
        const p = series[i]
        if (!isFinite(p.value) || !candles[i] || candles[i].time !== p.time) {
          flush()
          continue
        }
        if (seg.length && p.up !== segUp) flush()
        segUp = p.up
        seg.push(i)
      }
      flush()
    }
    let started = false
    let curUp = series[from]?.up ?? true
    ctx.lineWidth = o.stWidth
    ctx.strokeStyle = curUp ? o.stUpColor : o.stDownColor
    ctx.beginPath()
    for (let i = from; i <= to; i++) {
      const p = series[i]
      if (!isFinite(p.value)) continue
      const x = conv.timeToX(p.time)
      if (p.up !== curUp) {
        if (started) ctx.stroke()
        curUp = p.up
        ctx.strokeStyle = curUp ? o.stUpColor : o.stDownColor
        ctx.beginPath()
        started = false
      }
      if (curUp ? !this.opts.showSupertrendUp : !this.opts.showSupertrendDown) continue
      const y = conv.priceToY(p.value)
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else ctx.lineTo(x, y)
    }
    if (started) ctx.stroke()
  }
}
