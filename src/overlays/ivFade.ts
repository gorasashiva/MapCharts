/**
 * IV Walls × Big Trades Fade — ported from "ivfade-strategy.pine" (v6 strategy).
 *
 *   SHORT: a big-trade candle pokes into the HOD zone but closes back below it
 *          → sell-stop at that candle's low.
 *   LONG : a big-trade candle pokes into the LOD zone but closes back above it
 *          → buy-stop at that candle's high.
 *   Stop `slAtr` × ATR(14) beyond the signal candle, target `fixedR` R (or the
 *   day open). Unfilled entries expire after `validBars`. Each trade is drawn
 *   like the position tool: green box = TP, red box = SL.
 *
 * Zones are the walk-forward HOD/LOD percentiles from the IV Walls overlay,
 * computed on daily bars exactly as the Pine `f_daily` does (Parkinson σ over
 * `hvLookback` days; each day's extension measured in the σ known the day
 * before). As with `request.security(..., lookahead_on)` + `[1]`, a session
 * uses only days that closed before it. Days are UTC (Delta's daily candles),
 * so they differ from TradingView's exchange-session days on e.g. OANDA gold.
 * Percentiles use the same linear interpolation as ivWallsModel.quantile.
 *
 * Big trades use the DeepCharts delta approximation. Their price (for the
 * "Wick big trade" mode only) comes from 1-minute bars: the hl2 of the
 * highest-volume 1m bar inside the candle, like `request.security_lower_tf`.
 *
 * Fills follow Pine's broker emulator: orders placed on a bar's close work
 * from the next bar; inside a bar price travels open→high→low→close when the
 * open is nearer the high, else open→low→high→close; gaps fill at the open;
 * the bracket can fill on the entry bar. Entries sit exactly at the signal
 * candle's low/high (the source's one-tick offset is dropped — Delta symbols
 * have no syminfo.mintick here). P&L is in price points × 1 unit, no fees.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import { quantile, type OHLCBar } from './ivWallsModel'
import { attachFloatingWidget, type FloatingWidgetHandle } from './floatingWidget'
import type { StrategyOverlay, StrategyTrade } from '../strategy/types'
import { lazyCanvas } from './lazyCanvas'

type Rect = { x: number; y: number; width: number; height: number }

const MIN_MS = 60_000
const DAY_MS = 86_400_000

export type IvFadeSignalMode = 'reject' | 'wick'
export type IvFadeTpMode = 'fixedR' | 'dayOpen'

export interface IvFadeOptions {
  // Big trades
  deltaLen: number
  bigMult: number
  // HOD/LOD zones
  hvLookback: number
  calibrationDays: number
  /** Zone start/end percentiles, 0–100. */
  zoneLo: number
  zoneHi: number
  showZones: boolean
  // Trade
  signalMode: IvFadeSignalMode
  tpMode: IvFadeTpMode
  fixedR: number
  minRR: number
  slAtr: number
  validBars: number
  maxPerSide: number
  eodExit: boolean
  useSession: boolean
  /** Session window in UTC minutes from midnight; end ≤ start wraps past midnight. */
  sessionStartMin: number
  sessionEndMin: number
  // Display
  showSignals: boolean
  showTrades: boolean
  showTradeLabels: boolean
  showStats: boolean
}

export const IV_FADE_DEFAULTS: IvFadeOptions = {
  deltaLen: 14,
  bigMult: 1.5,
  hvLookback: 20,
  calibrationDays: 250,
  zoneLo: 30,
  zoneHi: 70,
  showZones: true,
  signalMode: 'reject',
  tpMode: 'fixedR',
  fixedR: 2,
  minRR: 1,
  slAtr: 0.3,
  validBars: 3,
  maxPerSide: 1,
  eodExit: true,
  useSession: false,
  sessionStartMin: 7 * 60,
  sessionEndMin: 17 * 60,
  showSignals: true,
  showTrades: true,
  showTradeLabels: true,
  showStats: true,
}

/** Pine f_daily's values after one daily bar — they apply to the sessions after it. */
export interface DailyZoneState {
  start: number
  sigma: number // NaN until enough history
  upLo: number // NaN until ≥ 20 extension samples
  upHi: number
  dnLo: number
  dnHi: number
}

/** Port of `f_daily`: one state per daily bar, in order. */
export function computeDailyZones(daily: OHLCBar[], hvLookback: number, calibrationDays: number, zoneLo: number, zoneHi: number): DailyZoneState[] {
  const ql = Math.min(zoneLo, zoneHi) / 100
  const qh = Math.max(zoneLo, zoneHi) / 100
  const lr2: number[] = []
  const ups: number[] = []
  const dns: number[] = []
  let sigPrev = NaN
  const out: DailyZoneState[] = []
  for (const d of daily) {
    if (isFinite(sigPrev) && d.open > 0) {
      ups.push((d.high - d.open) / d.open / sigPrev)
      dns.push((d.open - d.low) / d.open / sigPrev)
      if (ups.length > calibrationDays) {
        ups.shift()
        dns.shift()
      }
    }
    if (d.low > 0) {
      lr2.push(Math.log(d.high / d.low) ** 2)
      if (lr2.length > hvLookback) lr2.shift()
    }
    const sigma = lr2.length >= Math.max(2, hvLookback / 2) ? Math.sqrt(lr2.reduce((a, b) => a + b, 0) / lr2.length / (4 * Math.LN2)) : NaN
    sigPrev = sigma
    const ok = ups.length >= 20
    const su = ok ? [...ups].sort((a, b) => a - b) : []
    const sd = ok ? [...dns].sort((a, b) => a - b) : []
    out.push({
      start: d.time,
      sigma,
      upLo: ok ? quantile(su, ql) : NaN,
      upHi: ok ? quantile(su, qh) : NaN,
      dnLo: ok ? quantile(sd, ql) : NaN,
      dnHi: ok ? quantile(sd, qh) : NaN,
    })
  }
  return out
}

export interface IvFadeDay {
  start: number
  /** First and last chart bar times of the session on the chart. */
  firstTime: number
  lastTime: number
  /** Time of the session's second bar (Pine hides plots on the new-day bar); null for one-bar days. */
  drawFrom: number | null
  open: number
  hodTop: number
  hodBot: number
  lodTop: number
  lodBot: number
}

export interface IvFadeSignal {
  side: 'long' | 'short'
  time: number
  high: number
  low: number
}

export type IvFadeExit = 'tp' | 'sl' | 'eod'

export interface IvFadeTrade {
  side: 'long' | 'short'
  signalTime: number
  entryTime: number
  entryPrice: number
  sl: number
  tp: number
  exitTime: number | null
  exitPrice: number | null
  exitReason: IvFadeExit | null
  /** Points × 1 unit; for an open trade, marked to the last close. */
  pnl: number
  /** pnl ÷ the risk |entry − stop|. */
  r: number
}

export interface IvFadeResult {
  days: IvFadeDay[]
  signals: IvFadeSignal[]
  trades: IvFadeTrade[]
}

interface PendingEntry {
  side: 'long' | 'short'
  signalTime: number
  en: number
  sl: number
  tp: number
}

/** ta.atr: RMA of true range, seeded with the SMA of the first `period` values. */
function atrSeries(candles: Candle[], period: number): number[] {
  const n = candles.length
  const out = new Array<number>(n).fill(NaN)
  let sum = 0
  let prev = NaN
  for (let i = 0; i < n; i++) {
    const c = candles[i]
    const tr = i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))
    if (i < period) {
      sum += tr
      if (i === period - 1) prev = sum / period
    } else prev = (prev * (period - 1) + tr) / period
    out[i] = prev
  }
  return out
}

/** Last daily state strictly before `dayStart` (lookahead_on + [1]). */
function zoneBefore(states: DailyZoneState[], dayStart: number): DailyZoneState | null {
  let lo = 0
  let hi = states.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (states[mid].start < dayStart) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans >= 0 ? states[ans] : null
}

function inSession(time: number, o: IvFadeOptions): boolean {
  if (!o.useSession) return true
  const m = Math.floor((time % DAY_MS) / MIN_MS)
  const s = o.sessionStartMin
  const e = o.sessionEndMin
  return e > s ? m >= s && m < e : m >= s || m < e
}

/** Big-trade price per chart bar from 1m bars: hl2 of the first max-volume 1m bar inside it, else close. */
function bigTradePrices(candles: Candle[], ltf: Candle[] | null, barMs: number): number[] {
  if (barMs <= MIN_MS) return candles.map((c) => (c.high + c.low) / 2)
  const out = candles.map((c) => c.close)
  if (!ltf || ltf.length === 0) return out
  let j = 0
  for (let i = 0; i < candles.length; i++) {
    const t0 = candles[i].time
    const t1 = i + 1 < candles.length ? Math.min(candles[i + 1].time, t0 + barMs) : t0 + barMs
    while (j < ltf.length && ltf[j].time < t0) j++
    let best = -1
    let bestVol = -Infinity
    for (let k = j; k < ltf.length && ltf[k].time < t1; k++) {
      if (ltf[k].volume > bestVol) {
        bestVol = ltf[k].volume
        best = k
      }
    }
    if (best >= 0) out[i] = (ltf[best].high + ltf[best].low) / 2
  }
  return out
}

/**
 * Pure port of the strategy over a whole candle array.
 * `daily` = ascending UTC daily bars (may include today's partial bar — it is
 * never used for today's zones). `ltf` = ascending 1m bars, only needed for
 * the "wick" signal mode.
 */
export function computeIvFade(candles: Candle[], daily: OHLCBar[], ltf: Candle[] | null, opts: IvFadeOptions, barMs = MIN_MS): IvFadeResult {
  const o = opts
  const n = candles.length
  const days: IvFadeDay[] = []
  const signals: IvFadeSignal[] = []
  const trades: IvFadeTrade[] = []
  if (n === 0) return { days, signals, trades }

  const states = computeDailyZones(daily, o.hvLookback, o.calibrationDays, o.zoneLo, o.zoneHi)
  const atr = atrSeries(candles, 14)
  const bigPrice = o.signalMode === 'wick' ? bigTradePrices(candles, ltf, barMs) : null

  const absDelta: number[] = new Array(n)
  let deltaSum = 0

  let curDay: IvFadeDay | null = null
  let nShort = 0
  let nLong = 0
  let pend: PendingEntry | null = null
  let pendBar = -1
  let pos: IvFadeTrade | null = null
  let closeAtOpen = false

  for (let i = 0; i < n; i++) {
    const c = candles[i]

    // ---------- broker: fill orders placed on the previous bar's close ----------
    const closePos = (price: number, reason: IvFadeExit): void => {
      if (!pos) return
      pos.exitTime = c.time
      pos.exitPrice = price
      pos.exitReason = reason
      pos = null
    }
    /** Bracket fill when price moves a→b (or sits at a, at the open); null if neither leg is hit. */
    const bracketFill = (a: number, b: number, atOpen: boolean): number | null => {
      if (!pos) return null
      const above = pos.side === 'long' ? pos.tp : pos.sl
      const below = pos.side === 'long' ? pos.sl : pos.tp
      if (atOpen) return a >= above || a <= below ? a : null
      if (b > a && a < above && b >= above) return above
      if (b < a && a > below && b <= below) return below
      return null
    }
    const exitReason = (price: number): IvFadeExit => {
      const t = pos!
      return t.side === 'long' ? (price >= t.tp ? 'tp' : 'sl') : price <= t.tp ? 'tp' : 'sl'
    }
    const tryBracket = (a: number, b: number, atOpen: boolean): void => {
      const f = bracketFill(a, b, atOpen)
      if (f !== null) closePos(f, exitReason(f))
    }
    const openPos = (p: PendingEntry, price: number): void => {
      pos = { side: p.side, signalTime: p.signalTime, entryTime: c.time, entryPrice: price, sl: p.sl, tp: p.tp, exitTime: null, exitPrice: null, exitReason: null, pnl: 0, r: 0 }
      trades.push(pos)
      pend = null
    }

    if (closeAtOpen) {
      closePos(c.open, 'eod')
      closeAtOpen = false
    }
    // At the open: gaps through a level fill at the open price.
    if (pos) tryBracket(c.open, c.open, true)
    else if (pend) {
      const p: PendingEntry = pend
      if ((p.side === 'long' && c.open >= p.en) || (p.side === 'short' && c.open <= p.en)) {
        openPos(p, c.open)
        tryBracket(c.open, c.open, true)
      }
    }
    // Along the intrabar path.
    const highFirst = c.high - c.open < c.open - c.low
    const path = highFirst ? [c.open, c.high, c.low, c.close] : [c.open, c.low, c.high, c.close]
    for (let s = 0; s < 3; s++) {
      let a = path[s]
      const b = path[s + 1]
      if (!pos && pend) {
        const p: PendingEntry = pend
        const hit = p.side === 'long' ? b > a && a < p.en && b >= p.en : b < a && a > p.en && b <= p.en
        if (!hit) continue
        openPos(p, p.en)
        a = p.en
      }
      if (pos) tryBracket(a, b, false)
    }

    // ---------- script, on the bar's close ----------
    const dayStart = Math.floor(c.time / DAY_MS) * DAY_MS
    const newDay = !curDay || curDay.start !== dayStart
    if (newDay) {
      const z = zoneBefore(states, dayStart)
      const d0 = c.open
      const ok = !!z && isFinite(z.sigma) && isFinite(z.upLo)
      curDay = {
        start: dayStart,
        firstTime: c.time,
        lastTime: c.time,
        drawFrom: null,
        open: d0,
        hodBot: ok ? d0 * (1 + z!.upLo * z!.sigma) : NaN,
        hodTop: ok ? d0 * (1 + z!.upHi * z!.sigma) : NaN,
        lodTop: ok ? d0 * (1 - z!.dnLo * z!.sigma) : NaN,
        lodBot: ok ? d0 * (1 - z!.dnHi * z!.sigma) : NaN,
      }
      days.push(curDay)
      nShort = 0
      nLong = 0
    } else {
      curDay!.lastTime = c.time
      if (curDay!.drawFrom === null) curDay!.drawFrom = c.time
    }
    const day = curDay!

    // Big trades: |delta| above `bigMult` × its `deltaLen`-bar SMA.
    absDelta[i] = Math.abs((c.volume * (c.close - c.open)) / (c.high - c.low + 1e-9))
    deltaSum += absDelta[i]
    if (i >= o.deltaLen) deltaSum -= absDelta[i - o.deltaLen]
    const bigTrade = i >= o.deltaLen - 1 && absDelta[i] > (deltaSum / o.deltaLen) * o.bigMult

    let shortRaw: boolean
    let longRaw: boolean
    if (o.signalMode === 'reject') {
      shortRaw = bigTrade && c.high >= day.hodBot && c.close < day.hodBot
      longRaw = bigTrade && c.low <= day.lodTop && c.close > day.lodTop
    } else {
      const bp = Math.max(c.low, Math.min(c.high, bigPrice![i]))
      const topWick = bigTrade && c.close > c.open && bp > Math.max(c.open, c.close)
      const botWick = bigTrade && c.close < c.open && bp < Math.min(c.open, c.close)
      shortRaw = topWick && c.high >= day.hodBot && c.close <= day.hodTop
      longRaw = botWick && c.low <= day.lodTop && c.close >= day.lodBot
    }
    const sess = inSession(c.time, o)
    const shortSig = sess && isFinite(day.hodBot) && shortRaw && nShort < o.maxPerSide
    const longSig = sess && isFinite(day.lodTop) && longRaw && nLong < o.maxPerSide
    if (shortSig) signals.push({ side: 'short', time: c.time, high: c.high, low: c.low })
    if (longSig) signals.push({ side: 'long', time: c.time, high: c.high, low: c.low })

    // Orders.
    const flat = pos === null
    if (o.eodExit && newDay && !flat) closeAtOpen = true
    if (pendBar >= 0 && flat && i - pendBar >= o.validBars) {
      pend = null
      pendBar = -1
    }
    if (!flat) pendBar = -1
    if (flat && pendBar < 0) {
      const a = atr[i]
      if (shortSig) {
        nShort++
        const en = c.low
        const sl = c.high + a * o.slAtr
        const tp = o.tpMode === 'dayOpen' ? day.open : en - (sl - en) * o.fixedR
        if (isFinite(sl) && tp < en && (o.tpMode === 'fixedR' || (en - tp) / (sl - en) >= o.minRR)) {
          pend = { side: 'short', signalTime: c.time, en, sl, tp }
          pendBar = i
        }
      } else if (longSig) {
        nLong++
        const en = c.high
        const sl = c.low - a * o.slAtr
        const tp = o.tpMode === 'dayOpen' ? day.open : en + (en - sl) * o.fixedR
        if (isFinite(sl) && tp > en && (o.tpMode === 'fixedR' || (tp - en) / (en - sl) >= o.minRR)) {
          pend = { side: 'long', signalTime: c.time, en, sl, tp }
          pendBar = i
        }
      }
    }
  }

  const lastClose = candles[n - 1].close
  for (const t of trades) {
    const exit = t.exitPrice ?? lastClose
    t.pnl = t.side === 'long' ? exit - t.entryPrice : t.entryPrice - exit
    const risk = Math.abs(t.entryPrice - t.sl)
    t.r = risk > 0 ? t.pnl / risk : 0
  }
  return { days, signals, trades }
}

export interface IvFadeStats {
  closed: number
  wins: number
  winRate: number
  net: number
  netR: number
  profitFactor: number
  open: IvFadeTrade | null
}

export function summarizeIvFade(trades: IvFadeTrade[]): IvFadeStats {
  const closed = trades.filter((t) => t.exitTime !== null)
  const wins = closed.filter((t) => t.pnl > 0).length
  const grossWin = closed.reduce((s, t) => s + Math.max(0, t.pnl), 0)
  const grossLoss = closed.reduce((s, t) => s + Math.max(0, -t.pnl), 0)
  const last = trades[trades.length - 1]
  return {
    closed: closed.length,
    wins,
    winRate: closed.length ? (wins / closed.length) * 100 : NaN,
    net: closed.reduce((s, t) => s + t.pnl, 0),
    netR: closed.reduce((s, t) => s + t.r, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN,
    open: last && last.exitTime === null ? last : null,
  }
}

function medianBarMs(candles: Candle[]): number {
  const diffs: number[] = []
  for (let i = Math.max(1, candles.length - 50); i < candles.length; i++) diffs.push(candles[i].time - candles[i - 1].time)
  if (diffs.length === 0) return MIN_MS
  diffs.sort((a, b) => a - b)
  return diffs[Math.floor(diffs.length / 2)]
}

// ---------------------------------------------------------------------------
// Overlay class
// ---------------------------------------------------------------------------

export interface IvFadeSources {
  /** Ascending UTC daily bars for the chart's symbol (today's partial bar may be included). */
  fetchDaily(limit: number): Promise<OHLCBar[]>
  /** The latest `limit` 1m bars for the chart's symbol, ascending. Only used in "wick" mode. */
  fetchMinute(limit: number): Promise<Candle[]>
}

const COLORS = {
  red: '#f6465d',
  green: '#0ecb81',
  redLine: 'rgba(246,70,93,0.60)',
  greenLine: 'rgba(14,203,129,0.60)',
  redFill: 'rgba(246,70,93,0.12)',
  greenFill: 'rgba(14,203,129,0.12)',
  dayOpen: 'rgba(120,123,134,0.70)',
  tpBox: 'rgba(14,203,129,0.20)',
  tpBorder: 'rgba(14,203,129,0.70)',
  slBox: 'rgba(246,70,93,0.20)',
  slBorder: 'rgba(246,70,93,0.70)',
  eod: '#787b86',
}

const MAX_LTF_BARS = 20_000
const LTF_TAIL_MS = 30_000
/** A failed (or unreachably deep) fetch is retried at most this often — never on every tick. */
const RETRY_MS = 60_000

export default class IvFadeOverlay implements StrategyOverlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly sources: IvFadeSources
  private opts: IvFadeOptions
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private ro: ResizeObserver | null = null
  private running = false
  private raf = 0
  private enabled = false

  private symbol = ''
  private candles: Candle[] = []
  private daily: OHLCBar[] = []
  private dailyKey = '' // symbol:limit:lastDay the daily bars were fetched for
  private ltf: Candle[] = []
  private ltfSymbol = ''
  private ltfTailAt = 0
  private ltfFullAt = 0
  private dailyFailedAt = 0
  private gen = 0
  private loading = false
  private status = ''

  private lastSig = ''
  private result: IvFadeResult = { days: [], signals: [], trades: [] }
  private barMs = MIN_MS
  private revision = 0

  private readonly widgetRoot: HTMLElement
  private readonly widgetBody: HTMLElement
  private readonly dock: FloatingWidgetHandle

  constructor(container: HTMLElement, engine: IChartEngine, sources: IvFadeSources, opts?: Partial<IvFadeOptions>) {
    this.container = container
    this.engine = engine
    this.sources = sources
    this.opts = { ...IV_FADE_DEFAULTS, ...opts }

    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '18' })
    container.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)

    // Reuses Ultra V2's card styling (.uv2-*); stacks with the other cards in the bottom-right slot.
    this.widgetRoot = document.createElement('div')
    this.widgetRoot.className = 'uv2-widget'
    this.widgetRoot.style.display = 'none'
    const head = document.createElement('div')
    head.className = 'uv2-head'
    head.textContent = 'IVW FADE BACKTEST'
    this.widgetBody = document.createElement('div')
    this.widgetBody.className = 'uv2-body'
    this.widgetRoot.append(head, this.widgetBody)
    container.appendChild(this.widgetRoot)
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
    this.dock.resize()
  }

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return
    this.symbol = symbol
    this.gen++
    this.loading = false
    this.daily = []
    this.dailyKey = ''
    this.ltf = []
    this.ltfSymbol = ''
    this.ltfFullAt = 0
    this.dailyFailedAt = 0
    this.lastSig = ''
    this.result = { days: [], signals: [], trades: [] }
    this.revision++
    if (this.enabled) this.ensureData()
  }

  /** Call whenever the pane's candle array changes (load, symbol/interval switch, live tick). */
  setCandles(candles: Candle[]): void {
    this.candles = candles
    if (this.enabled) this.ensureData()
  }

  setOptions(opts: Partial<IvFadeOptions>): void {
    this.opts = { ...this.opts, ...opts }
    this.lastSig = '' // every option affects the computed result
    this.syncWidgetVisibility()
    if (this.enabled) this.ensureData()
  }

  getOptions(): IvFadeOptions {
    return { ...this.opts }
  }

  /** Strategy Tester feed. */
  getStrategyTrades(): StrategyTrade[] {
    const reason = { tp: 'TP', sl: 'SL', eod: 'Day end' } as const
    return this.result.trades.map((t) => ({
      side: t.side,
      entryTime: t.entryTime,
      entryPrice: t.entryPrice,
      exitTime: t.exitTime,
      exitPrice: t.exitPrice,
      exitReason: t.exitReason ? reason[t.exitReason] : undefined,
      stop: t.sl,
    }))
  }

  getRevision(): number {
    return this.revision
  }

  /** Today's zones for the legend row, or null before they are known. */
  getToday(): IvFadeDay | null {
    const d = this.result.days[this.result.days.length - 1]
    return d && isFinite(d.hodBot) ? d : null
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
    this.syncWidgetVisibility()
    if (on) {
      this.start()
      this.ensureData()
    } else this.stop()
  }

  private syncWidgetVisibility(): void {
    const show = this.enabled && this.opts.showStats
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
    this.result = { days: [], signals: [], trades: [] }
    this.revision++
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  destroy(): void {
    this.stop()
    this.gen++
    this.ro?.disconnect()
    this.dock.destroy()
    this.widgetRoot.remove()
    this.canvas.remove()
  }

  // ---- data ----

  /** Fetch the daily bars (and, in wick mode, 1m bars) the current candles need; no-op once loaded. */
  private ensureData(): void {
    if (this.loading || !this.symbol || this.candles.length === 0) return
    const gen = this.gen
    const symbol = this.symbol
    const lastDay = Math.floor(this.candles[this.candles.length - 1].time / DAY_MS)
    const limit = this.opts.calibrationDays + this.opts.hvLookback + 10
    const key = `${symbol}:${limit}:${lastDay}`
    const now = Date.now()
    const needDaily = key !== this.dailyKey && now - this.dailyFailedAt > RETRY_MS

    const barMs = medianBarMs(this.candles)
    const wantLtf = this.opts.signalMode === 'wick' && barMs > MIN_MS
    const first = this.candles[0].time
    // The 1m window may be unable to reach the first candle at all (MAX_LTF_BARS, or the API's own
    // 1m depth) — so "not covered" alone must not trigger a full refetch on every tick.
    const covered = this.ltfSymbol === symbol && this.ltf.length > 0 && this.ltf[0].time <= first + barMs
    const needLtfFull = wantLtf && !covered && now - this.ltfFullAt > RETRY_MS
    const needLtfTail = wantLtf && !needLtfFull && this.ltfSymbol === symbol && this.ltf.length > 0 && now - this.ltfTailAt > LTF_TAIL_MS
    if (!needDaily && !needLtfFull && !needLtfTail) return

    this.loading = true
    if (needDaily) this.status = 'loading daily history…'
    void (async () => {
      try {
        if (needDaily) {
          try {
            const daily = await this.sources.fetchDaily(limit)
            if (gen !== this.gen) return
            this.daily = daily
            this.dailyKey = key
          } catch (err) {
            if (gen === this.gen) this.dailyFailedAt = Date.now()
            throw err
          }
        }
        if (needLtfFull) {
          this.ltfFullAt = now
          const n = Math.min(MAX_LTF_BARS, Math.ceil((now - first + barMs) / MIN_MS) + 5)
          const ltf = await this.sources.fetchMinute(n)
          if (gen !== this.gen) return
          this.ltf = ltf
          this.ltfSymbol = symbol
          this.ltfTailAt = Date.now()
        } else if (needLtfTail) {
          this.ltfTailAt = now
          const tail = await this.sources.fetchMinute(60)
          if (gen !== this.gen || tail.length === 0) return
          const cut = tail[0].time
          this.ltf = [...this.ltf.filter((b) => b.time < cut), ...tail]
        }
        this.status = ''
        this.lastSig = ''
      } catch {
        if (gen === this.gen) {
          // Retried after RETRY_MS (see the dailyFailedAt / ltfFullAt gates above).
          if (!this.daily.length) this.status = 'history unavailable'
          this.lastSig = ''
        }
      } finally {
        if (gen === this.gen) this.loading = false
      }
    })()
  }

  private lastStructure = ''
  private computedAt = 0

  private recompute(): void {
    const c = this.candles
    if (c.length < 2) return
    const last = c[c.length - 1]
    const sig = `${c.length}:${c[0].time}:${last.time}:${last.high}:${last.low}:${last.close}:${this.daily.length}:${this.ltf.length}:${this.status}`
    if (sig === this.lastSig) return
    // the forming bar's ticks only: at most once a second (a new bar or data recomputes at once)
    const structure = `${c.length}:${c[0].time}:${last.time}:${this.daily.length}:${this.ltf.length}:${this.status}`
    const now = performance.now()
    if (structure === this.lastStructure && now - this.computedAt < 1000) return
    this.lastStructure = structure
    this.computedAt = now
    this.lastSig = sig
    this.barMs = medianBarMs(c)
    this.result = computeIvFade(c, this.daily, this.ltf, this.opts, this.barMs)
    this.revision++
    this.renderWidget()
  }

  private renderWidget(): void {
    if (!this.opts.showStats) return
    const s = summarizeIvFade(this.result.trades)
    const num = (v: number): string => {
      if (!isFinite(v)) return '—'
      const a = Math.abs(v)
      return `${v >= 0 ? '+' : '−'}${a.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 0 : a >= 1 ? 2 : 4 })}`
    }
    const pnlColor = (v: number): string => (!isFinite(v) || v === 0 ? '#d1d4dc' : v > 0 ? COLORS.green : COLORS.red)
    const pf = isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : s.profitFactor === Infinity ? '∞' : '—'
    const rows: [string, string, string][] = []
    if (this.status) rows.push(['Status', this.status, '#787b86'])
    rows.push(
      ['Trades', String(s.closed), '#d1d4dc'],
      ['Win rate', isFinite(s.winRate) ? `${s.winRate.toFixed(0)}%` : '—', '#d1d4dc'],
      ['Net (pts)', num(s.net), pnlColor(s.net)],
      ['Net R', s.closed ? `${num(s.netR)}R` : '—', pnlColor(s.netR)],
      ['Profit factor', pf, '#d1d4dc'],
      s.open ? [`Open ${s.open.side === 'long' ? 'LONG' : 'SHORT'}`, `${num(s.open.r)}R`, pnlColor(s.open.r)] : ['Position', 'Flat', '#787b86'],
    )
    this.widgetBody.innerHTML = ''
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

  // ---- drawing ----

  private draw(): void {
    this.recompute()
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)

    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect || this.candles.length === 0) return

    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.clip()
    if (this.opts.showZones) this.drawZones(conv, rect)
    if (this.opts.showTrades) this.drawTrades(conv, rect)
    if (this.opts.showSignals) this.drawSignals(conv, rect)
    this.ctx.restore()
  }

  /** HOD (red) / LOD (green) zones and the day-open line — lines and fills only, no text. */
  private drawZones(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    const right = rect.x + rect.width
    const hline = (x1: number, x2: number, price: number, color: string): void => {
      const y = Math.round(conv.priceToY(price)) + 0.5
      ctx.strokeStyle = color
      ctx.beginPath()
      ctx.moveTo(x1, y)
      ctx.lineTo(x2, y)
      ctx.stroke()
    }
    const band = (x1: number, x2: number, a: number, b: number, color: string): void => {
      const y1 = conv.priceToY(a)
      const y2 = conv.priceToY(b)
      ctx.fillStyle = color
      ctx.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1))
    }
    ctx.lineWidth = 1
    for (const d of this.result.days) {
      if (d.drawFrom === null) continue
      const x1 = conv.timeToX(d.drawFrom)
      const x2 = conv.timeToX(d.lastTime)
      if (x2 < rect.x || x1 > right || x2 <= x1) continue
      if (isFinite(d.hodBot)) {
        band(x1, x2, d.hodTop, d.hodBot, COLORS.redFill)
        band(x1, x2, d.lodTop, d.lodBot, COLORS.greenFill)
        hline(x1, x2, d.hodTop, COLORS.redLine)
        hline(x1, x2, d.hodBot, COLORS.redLine)
        hline(x1, x2, d.lodTop, COLORS.greenLine)
        hline(x1, x2, d.lodBot, COLORS.greenLine)
      }
      hline(x1, x2, d.open, COLORS.dayOpen)
    }
  }

  private drawTrades(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    const right = rect.x + rect.width
    const last = this.candles[this.candles.length - 1].time
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    for (const t of this.result.trades) {
      const x1 = conv.timeToX(t.entryTime)
      const endTime = t.exitTime === null ? last + this.barMs : Math.max(t.exitTime, t.entryTime + this.barMs)
      const x2 = conv.timeToX(endTime)
      if (x2 < rect.x || x1 > right) continue
      const box = (a: number, b: number, fill: string, border: string): void => {
        const y1 = conv.priceToY(a)
        const y2 = conv.priceToY(b)
        const y = Math.min(y1, y2)
        const h = Math.max(1, Math.abs(y2 - y1))
        ctx.fillStyle = fill
        ctx.fillRect(x1, y, x2 - x1, h)
        ctx.strokeStyle = border
        ctx.lineWidth = 1
        ctx.strokeRect(Math.round(x1) + 0.5, Math.round(y) + 0.5, Math.round(x2 - x1), Math.round(h))
      }
      box(t.entryPrice, t.tp, COLORS.tpBox, COLORS.tpBorder)
      box(t.entryPrice, t.sl, COLORS.slBox, COLORS.slBorder)

      if (this.opts.showTradeLabels && t.exitTime !== null && t.exitPrice !== null) {
        const tag = t.exitReason === 'eod' ? 'EOD' : t.pnl > 0 ? 'TP' : 'SL'
        const text = `${tag} ${t.r >= 0 ? '+' : '−'}${Math.abs(t.r).toFixed(1)}R`
        const w = ctx.measureText(text).width + 8
        const y = conv.priceToY(t.exitPrice)
        ctx.fillStyle = t.exitReason === 'eod' ? COLORS.eod : t.pnl > 0 ? COLORS.green : COLORS.red
        ctx.beginPath()
        ctx.roundRect(x2 + 3, y - 7, w, 14, 3)
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.fillText(text, x2 + 7, y + 0.5)
      }
    }
  }

  private drawSignals(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    for (const s of this.result.signals) {
      const x = conv.timeToX(s.time)
      if (x < rect.x - 10 || x > rect.x + rect.width + 10) continue
      const up = s.side === 'long'
      const tip = up ? conv.priceToY(s.low) + 5 : conv.priceToY(s.high) - 5
      const dy = up ? 7 : -7
      ctx.fillStyle = up ? COLORS.green : COLORS.red
      ctx.beginPath()
      ctx.moveTo(x, tip)
      ctx.lineTo(x - 4, tip + dy)
      ctx.lineTo(x + 4, tip + dy)
      ctx.closePath()
      ctx.fill()
    }
  }
}
