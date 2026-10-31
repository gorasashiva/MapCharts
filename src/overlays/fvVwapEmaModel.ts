/**
 * Fractal Vector + VWAP Bands + EMA 9/21/50 — pure model behind fvVwapEma.ts,
 * a port of "test strategy.pine" plus the setups that held up when it was
 * backtested on weekday XAUTUSD 1m / 3m / 5m (Apr–Oct 2026):
 *
 *   1. Fractal vector. A fractal high/low is a bar whose high (low) is the
 *      unique extreme of the `fracLen` bars each side — known only `fracLen`
 *      bars later, like ta.pivothigh. Direction flips down when a close breaks
 *      the last fractal low and up when one breaks the last fractal high; the
 *      plotted level is the opposite fractal (the trailing stop). HTF copies
 *      run the same thing on candles bucketed to the higher timeframe, and a
 *      chart bar only sees HTF bars that have CLOSED by its own close
 *      (request.security with lookahead_off). An optional second HTF must agree
 *      too (e.g. 15m and 1h).
 *   2. Session-anchored VWAP of hlc3 with ±mult·σ bands (ta.vwap stdev).
 *      "Day" follows the symbol's trading-day open (gold 03:30 IST).
 *   3. EMA 9 / 21 / 50.
 *
 * Signals (closed bars only, one position at a time):
 *   - Aligned flip — the chart-TF vector flips in the HTF direction(s), the
 *     close is on that side of VWAP but still inside the ±σ band, and EMA 9
 *     agrees with EMA 21.
 *   - EMA 21 pullback — the HTF(s), the chart vector and the full 9 > 21 > 50
 *     stack agree, the close is on the trend side of VWAP, and a candle dips
 *     through EMA 21 and closes back beyond it in the trend direction.
 *   Both can require the close to be within `maxVwapDistSigma`·σ of VWAP — not
 *   chasing an extended move was the single biggest accuracy gain.
 *
 * Stop at the vector level (at least `minRiskAtr`·ATR(14); signals needing a
 * stop wider than `maxRiskAtr`·ATR are skipped). Exits:
 *   - 'scale'  — close half at TP1 (`tp1R`), move the stop to breakeven, the
 *                rest at TP2 (`targetR`). Highest hit rate.
 *   - 'fixed'  — all at `targetR`.
 *   - 'trail'  — all when the chart vector flips back. Highest R, lowest hit rate.
 * Anything still open is closed at the session end. Entries only inside the
 * IST entry window on weekday sessions.
 *
 * `autoTune` swaps in the tested settings for the chart's bar size — see
 * FV_PRESETS.
 */
import type { Candle } from '../core/types'
import { emaSeries } from '../indicators/helpers'
import { sessionIndex, SESSION_DAY_MS } from '../core/session'

const MIN_MS = 60_000
const HOUR_MS = 60 * MIN_MS
const IST_OFFSET_MS = 330 * MIN_MS

/** Delta Exchange India: taker 0.05%, maker 0.02%, +18% GST on the fee. */
const FEE_TAKER = 0.0005 * 1.18
const FEE_MAKER = 0.0002 * 1.18

export type FvAnchor = 'Day' | 'Week' | 'Month'
export type FvSetup = 'flip' | 'pullback'
export type FvExitMode = 'scale' | 'fixed' | 'trail'

export interface FvVwapEmaOptions {
  /** Use the tested settings for the chart's bar size (1m / 3m / 5m) instead of the fields below. */
  autoTune: boolean
  /** Higher timeframe for the HTF vector, in minutes. */
  htfMinutes: number
  /** Optional second HTF that must agree too, in minutes. */
  htf2Minutes: number | null
  fracLen: number
  vwapAnchor: FvAnchor
  bandMult: number
  ema1: number
  ema2: number
  ema3: number
  // ---- signals ----
  flipSignals: boolean
  pullbackSignals: boolean
  /** Entries must close within this many σ of VWAP. Null = off. */
  maxVwapDistSigma: number | null
  // ---- risk / exits ----
  exitMode: FvExitMode
  /** TP1 in R ('scale' only). */
  tp1R: number
  /** Final target in R ('scale' TP2, 'fixed' target). */
  targetR: number
  minRiskAtr: number
  maxRiskAtr: number
  /** Entry window in IST minutes from midnight, [start, end). Null = any time. */
  entryWindowIST: [number, number] | null
  weekdaysOnly: boolean
  allowLongs: boolean
  allowShorts: boolean
}

export const FV_VWAP_EMA_DEFAULTS: FvVwapEmaOptions = {
  autoTune: true,
  htfMinutes: 60,
  htf2Minutes: null,
  fracLen: 2,
  vwapAnchor: 'Day',
  bandMult: 1,
  ema1: 9,
  ema2: 21,
  ema3: 50,
  flipSignals: true,
  pullbackSignals: false,
  maxVwapDistSigma: 0.75,
  exitMode: 'scale',
  tp1R: 1,
  targetR: 3,
  minRiskAtr: 0.5,
  maxRiskAtr: 4,
  entryWindowIST: [210, 1080], // 03:30 – 18:00 IST: Asia + London; NY entries lost money
  weekdaysOnly: true,
  allowLongs: true,
  allowShorts: true,
}

export type FvPresetKey = '1m' | '3m' | '5m'

/**
 * Best settings per chart timeframe from the Apr–Oct 2026 XAUTUSD backtest
 * (weekdays, 03:30–18:00 IST, ≤0.75σ from VWAP, half at 1R + BE, rest at 3R):
 *   1m — aligned flip, 15m + 1h must agree:      77 trades, 65% hit, +0.27R
 *   3m — aligned flip, 1h HTF (15m made it worse): 56 trades, 64% hit, +0.33R
 *   5m — EMA21 pullback, 15m + 1h, fractal 3:    100 trades, 62% hit, +0.18R
 * (R after a $0.30 round-trip spread.)
 */
export const FV_PRESETS: Record<FvPresetKey, Partial<FvVwapEmaOptions>> = {
  '1m': { htfMinutes: 15, htf2Minutes: 60, fracLen: 2, flipSignals: true, pullbackSignals: false },
  '3m': { htfMinutes: 60, htf2Minutes: null, fracLen: 2, flipSignals: true, pullbackSignals: false },
  '5m': { htfMinutes: 15, htf2Minutes: 60, fracLen: 3, flipSignals: false, pullbackSignals: true },
}

/** Preset for a bar size, or null when the chart isn't 1m–5m. */
export function presetForBar(barMs: number): FvPresetKey | null {
  const m = Math.round(barMs / MIN_MS)
  return m === 1 ? '1m' : m === 3 ? '3m' : m === 5 ? '5m' : null
}

/** The options actually used: auto-tuned for the bar size when `autoTune` is on. */
export function resolveOptions(opts: FvVwapEmaOptions, barMs: number): FvVwapEmaOptions {
  if (!opts.autoTune) return opts
  const key = presetForBar(barMs)
  return key ? { ...opts, ...FV_PRESETS[key] } : opts
}

export interface FvPoint {
  /** Fractal vector level (chart TF), NaN before the first fractal. */
  lvl: number
  dir: 1 | -1
  htfLvl: number
  htfDir: 1 | -1 | 0
  /** Second HTF direction; 0 when unused or not yet known. */
  htf2Dir: 1 | -1 | 0
  vwap: number
  upper: number
  lower: number
  /** VWAP standard deviation (the band half-width ÷ bandMult). */
  sd: number
  e1: number
  e2: number
  e3: number
  atr: number
}

export interface FvTrade {
  setup: FvSetup
  side: 'long' | 'short'
  entryTime: number
  entryPrice: number
  /** Initial stop. */
  stop: number
  /** TP1 price ('scale' only), else null. */
  tp1: number | null
  /** When TP1 filled (half closed, stop moved to entry); null if it hasn't. */
  tp1Time: number | null
  /** Final target; null for the trailing exit. */
  target: number | null
  exitTime: number | null
  /** Price the (remaining) position closed at. */
  exitPrice: number | null
  exitReason: 'TP' | 'SL' | 'BE' | 'Flip' | 'Day end' | null
  /** Size-weighted average exit over both halves — what the Strategy Tester books. */
  avgExitPrice: number | null
  barHigh: number
  barLow: number
  /** Net of Delta fees, in units of initial risk; marked to the last close while open. */
  r: number
  /** Before fees — what a tight-spread broker would see. */
  grossR: number
}

export interface FvResult {
  points: FvPoint[]
  trades: FvTrade[]
  /** Options after auto-tuning. */
  used: FvVwapEmaOptions
}

interface Bar {
  high: number
  low: number
  close: number
}

/** Pine f_vector over a bar series. Pivots are confirmed `n` bars late. */
export function fractalVector(bars: Bar[], n: number): { lvl: number; dir: 1 | -1 }[] {
  const out: { lvl: number; dir: 1 | -1 }[] = []
  let lastH = NaN
  let lastL = NaN
  let dir: 1 | -1 = 1
  for (let i = 0; i < bars.length; i++) {
    const p = i - n
    if (p - n >= 0) {
      let isH = true
      let isL = true
      for (let k = p - n; k <= p + n && (isH || isL); k++) {
        if (k === p) continue
        if (bars[k].high >= bars[p].high) isH = false
        if (bars[k].low <= bars[p].low) isL = false
      }
      if (isH) lastH = bars[p].high
      if (isL) lastL = bars[p].low
    }
    const c = bars[i].close
    if (dir === 1 && c < lastL) dir = -1
    else if (dir === -1 && c > lastH) dir = 1
    out.push({ lvl: dir === 1 ? lastL : lastH, dir })
  }
  return out
}

/**
 * HTF vector mapped onto chart bars: HTF bars are bucketed on UTC boundaries
 * and a chart bar sees the last one that closed by its own close.
 */
function htfVector(candles: Candle[], minutes: number, n: number, barMs: number): { lvl: number; dir: 1 | -1 | 0 }[] {
  const htfMs = Math.max(1, minutes) * MIN_MS
  const bars: (Bar & { end: number })[] = []
  for (const c of candles) {
    const start = Math.floor(c.time / htfMs) * htfMs
    const last = bars[bars.length - 1]
    if (last && last.end === start + htfMs) {
      last.high = Math.max(last.high, c.high)
      last.low = Math.min(last.low, c.low)
      last.close = c.close
    } else bars.push({ high: c.high, low: c.low, close: c.close, end: start + htfMs })
  }
  const v = fractalVector(bars, n)
  const out: { lvl: number; dir: 1 | -1 | 0 }[] = []
  let h = -1
  for (const c of candles) {
    while (h + 1 < bars.length && bars[h + 1].end <= c.time + barMs) h++
    out.push(h >= 0 ? v[h] : { lvl: NaN, dir: 0 })
  }
  return out
}

/** Bucket key for the VWAP anchor; the Day anchor follows the trading-day open. */
function anchorKey(time: number, anchor: FvAnchor, openHourUTC: number): number {
  const day = sessionIndex(time, openHourUTC)
  if (anchor === 'Day') return day
  // Session days are labelled by the date they mostly cover (+2h past the open).
  const d = new Date(day * SESSION_DAY_MS + openHourUTC * HOUR_MS + 2 * HOUR_MS)
  if (anchor === 'Month') return d.getUTCFullYear() * 12 + d.getUTCMonth()
  return Math.floor((day + 3) / 7) // Monday-based weeks (epoch day 0 was a Thursday)
}

/** Weekday (0 = Sunday) of the session containing `time`. */
function sessionWeekday(time: number, openHourUTC: number): number {
  const day = sessionIndex(time, openHourUTC)
  return new Date(day * SESSION_DAY_MS + openHourUTC * HOUR_MS + 2 * HOUR_MS).getUTCDay()
}

function istMinutes(time: number): number {
  return Math.floor(((time + IST_OFFSET_MS) % SESSION_DAY_MS) / MIN_MS)
}

function nums(src: (number | null)[]): number[] {
  return src.map((v) => (v === null ? NaN : v))
}

/** Indicator values for every candle. `barMs` is the chart's bar spacing; `opts` are already resolved. */
export function computeFvPoints(candles: Candle[], opts: FvVwapEmaOptions, openHourUTC: number, barMs: number): FvPoint[] {
  const n = candles.length
  if (n === 0) return []
  const ltf = fractalVector(candles, opts.fracLen)
  const htf = htfVector(candles, opts.htfMinutes, opts.fracLen, barMs)
  const htf2 = opts.htf2Minutes ? htfVector(candles, opts.htf2Minutes, opts.fracLen, barMs) : null

  const closes = candles.map((c) => c.close)
  const e1 = nums(emaSeries(closes, opts.ema1))
  const e2 = nums(emaSeries(closes, opts.ema2))
  const e3 = nums(emaSeries(closes, opts.ema3))

  const out: FvPoint[] = []
  let key = NaN
  let sumPV = 0
  let sumV = 0
  let sumP2V = 0
  let atr = NaN
  for (let i = 0; i < n; i++) {
    const c = candles[i]
    const k = anchorKey(c.time, opts.vwapAnchor, openHourUTC)
    if (k !== key) {
      key = k
      sumPV = sumV = sumP2V = 0
    }
    const src = (c.high + c.low + c.close) / 3
    const v = c.volume > 0 ? c.volume : 1e-9
    sumPV += src * v
    sumV += v
    sumP2V += src * src * v
    const vwap = sumPV / sumV
    const sd = Math.sqrt(Math.max(sumP2V / sumV - vwap * vwap, 0))
    const prevClose = i > 0 ? candles[i - 1].close : c.close
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
    atr = Number.isNaN(atr) ? tr : atr + (tr - atr) / 14
    out.push({
      lvl: ltf[i].lvl,
      dir: ltf[i].dir,
      htfLvl: htf[i].lvl,
      htfDir: htf[i].dir,
      htf2Dir: htf2 ? htf2[i].dir : 0,
      vwap,
      upper: vwap + opts.bandMult * sd,
      lower: vwap - opts.bandMult * sd,
      sd,
      e1: e1[i],
      e2: e2[i],
      e3: e3[i],
      atr,
    })
  }
  return out
}

/** Which setup (if any) fires on bar `i`, and its side. */
function signalAt(c: Candle[], p: FvPoint[], i: number, opts: FvVwapEmaOptions): { setup: FvSetup; side: 1 | -1 } | null {
  const x = p[i]
  const prev = p[i - 1]
  const close = c[i].close
  for (const side of [1, -1] as const) {
    if (side === 1 && !opts.allowLongs) continue
    if (side === -1 && !opts.allowShorts) continue
    if (x.htfDir !== side) continue
    if (opts.htf2Minutes && x.htf2Dir !== side) continue
    const fromVwap = (close - x.vwap) * side
    if (!(fromVwap > 0)) continue
    if (opts.maxVwapDistSigma !== null && fromVwap > opts.maxVwapDistSigma * x.sd) continue
    if (opts.flipSignals) {
      const flipped = x.dir === side && prev.dir === -side
      const inBand = side === 1 ? close < x.upper : close > x.lower
      const emaOk = side === 1 ? x.e1 > x.e2 : x.e1 < x.e2
      if (flipped && inBand && emaOk) return { setup: 'flip', side }
    }
    if (opts.pullbackSignals && x.dir === side) {
      const stack = side === 1 ? x.e1 > x.e2 && x.e2 > x.e3 : x.e1 < x.e2 && x.e2 < x.e3
      const dipped = side === 1 ? c[i].low <= x.e2 && close > x.e2 : c[i].high >= x.e2 && close < x.e2
      const trendCandle = side === 1 ? close > c[i].open : close < c[i].open
      if (stack && dipped && trendCandle) return { setup: 'pullback', side }
    }
  }
  return null
}

/** Gross and fee-net R over the closed legs (price, size share, maker fill?). */
function rMultiples(side: 1 | -1, entry: number, legs: [number, number, boolean][], risk: number): { r: number; grossR: number } {
  let gross = 0
  let fees = 0
  for (const [px, w, maker] of legs) {
    gross += (px - entry) * side * w
    fees += w * (entry * FEE_TAKER + px * (maker ? FEE_MAKER : FEE_TAKER))
  }
  return { r: (gross - fees) / risk, grossR: gross / risk }
}

/** Entry context handed to a `targetCap` hook. */
export interface FvEntry {
  entryTime: number
  side: 1 | -1
  entry: number
  risk: number
  /** The target the exit plan would use on its own. */
  target: number
}

/**
 * Indicator values plus simulated trades. `lastClosed` says whether the final
 * candle has closed — a forming candle never triggers a signal. `targetCap`
 * may move the final target ('scale' TP2 / 'fixed' target) closer — e.g. to
 * the next IV zone (ivFvStrategyModel.ts); return null to keep it.
 */
export function computeFvVwapEma(
  candles: Candle[],
  options: FvVwapEmaOptions,
  openHourUTC: number,
  barMs: number,
  lastClosed = true,
  targetCap?: (e: FvEntry) => number | null,
): FvResult {
  const opts = resolveOptions(options, barMs)
  const points = computeFvPoints(candles, opts, openHourUTC, barMs)
  const trades: FvTrade[] = []
  const n = candles.length
  const lastSignalBar = lastClosed ? n - 1 : n - 2
  let i = Math.max(1, opts.ema3, 2 * opts.fracLen + 1)
  while (i <= lastSignalBar) {
    const c = candles[i]
    const sig = signalAt(candles, points, i, opts)
    const wd = sessionWeekday(c.time, openHourUTC)
    const m = istMinutes(c.time + barMs) // the bar's close
    const inWindow = !opts.entryWindowIST || (m >= opts.entryWindowIST[0] && m < opts.entryWindowIST[1])
    if (!sig || !inWindow || (opts.weekdaysOnly && (wd === 0 || wd === 6))) {
      i++
      continue
    }
    const { side, setup } = sig
    const entry = c.close
    const x = points[i]
    let risk = (entry - x.lvl) * side
    if (!(risk > 0)) {
      i++
      continue
    }
    risk = Math.max(risk, opts.minRiskAtr * x.atr)
    if (risk > opts.maxRiskAtr * x.atr) {
      i++
      continue
    }
    const scale = opts.exitMode === 'scale'
    const tp1 = scale ? entry + side * opts.tp1R * risk : null
    let target = opts.exitMode === 'trail' ? null : entry + side * opts.targetR * risk
    if (target !== null && targetCap) target = targetCap({ entryTime: c.time, side, entry, risk, target }) ?? target
    const sess = sessionIndex(c.time, openHourUTC)
    const trade: FvTrade = {
      setup,
      side: side === 1 ? 'long' : 'short',
      entryTime: c.time,
      entryPrice: entry,
      stop: entry - side * risk,
      tp1,
      tp1Time: null,
      target,
      exitTime: null,
      exitPrice: null,
      exitReason: null,
      avgExitPrice: null,
      barHigh: c.high,
      barLow: c.low,
      r: 0,
      grossR: 0,
    }
    let stop = trade.stop
    let size = 1
    const legs: [number, number, boolean][] = []
    const close = (time: number, px: number, why: FvTrade['exitReason'], maker = false): void => {
      legs.push([px, size, maker])
      Object.assign(trade, { exitTime: time, exitPrice: px, exitReason: why })
    }
    const reached = (b: Candle, px: number): boolean => (side === 1 ? b.high >= px : b.low <= px)
    let j = i + 1
    for (; j < n; j++) {
      const b = candles[j]
      // A still-forming last candle can hit levels intrabar, but can't close a flip.
      const closed = j < n - 1 || lastClosed
      if (sessionIndex(b.time, openHourUTC) !== sess) {
        close(candles[j - 1].time, candles[j - 1].close, 'Day end')
        j--
        break
      }
      // Stop first when a bar spans both levels — the conservative read of an OHLC bar.
      if (side === 1 ? b.low <= stop : b.high >= stop) {
        close(b.time, stop, trade.tp1Time !== null ? 'BE' : 'SL')
        break
      }
      if (tp1 !== null && trade.tp1Time === null && reached(b, tp1)) {
        legs.push([tp1, 0.5, true])
        size = 0.5
        trade.tp1Time = b.time
        stop = entry
      }
      if (target !== null && reached(b, target)) {
        close(b.time, target, 'TP', true)
        break
      }
      if (target === null && closed && points[j].dir !== side) {
        close(b.time, b.close, 'Flip')
        break
      }
    }
    // Still open: mark the remainder to the last close.
    const open = trade.exitTime === null
    const marked: [number, number, boolean][] = open ? [...legs, [candles[n - 1].close, size, false]] : legs
    Object.assign(trade, rMultiples(side, entry, marked, risk))
    if (!open) trade.avgExitPrice = marked.reduce((s, [px, w]) => s + px * w, 0)
    trades.push(trade)
    if (open) break
    i = j + 1
  }
  return { points, trades, used: opts }
}

/** What `summarize` reads from a trade — any strategy's trades with these fields work. */
export type FvSummaryTrade = Pick<FvTrade, 'exitTime' | 'exitReason' | 'tp1Time' | 'r' | 'grossR'>

export interface FvSummary<T extends FvSummaryTrade = FvTrade> {
  closed: number
  /** Share of closed trades that finished positive (a breakeven stop after TP1 counts — half was banked). */
  winRate: number
  /** Share of closed trades that reached TP1 ('scale') or the target ('fixed'). */
  tp1Rate: number
  /** Net of Delta fees. */
  avgR: number
  /** Before fees. */
  avgGrossR: number
  totalR: number
  profitFactor: number
  open: T | null
}

export function summarize<T extends FvSummaryTrade>(trades: T[]): FvSummary<T> {
  const closed = trades.filter((t) => t.exitTime !== null)
  const open = trades.find((t) => t.exitTime === null) ?? null
  const wins = closed.filter((t) => t.grossR > 0)
  const gain = closed.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0)
  const loss = -closed.filter((t) => t.r < 0).reduce((s, t) => s + t.r, 0)
  const totalR = closed.reduce((s, t) => s + t.r, 0)
  const hitTarget = closed.filter((t) => t.tp1Time !== null || t.exitReason === 'TP')
  return {
    closed: closed.length,
    winRate: closed.length ? wins.length / closed.length : NaN,
    tp1Rate: closed.length ? hitTarget.length / closed.length : NaN,
    avgR: closed.length ? totalR / closed.length : NaN,
    avgGrossR: closed.length ? closed.reduce((s, t) => s + t.grossR, 0) / closed.length : NaN,
    totalR,
    profitFactor: loss > 0 ? gain / loss : gain > 0 ? Infinity : NaN,
    open,
  }
}
