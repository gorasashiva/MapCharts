/**
 * CPR two-mode playbook — the setup backtested on XAUTUSD 5m (Apr–Oct 2026):
 *
 *   Narrow CPR day (width in the narrowest 30% of the last 20 sessions)
 *     → BREAKOUT: first candle that closes beyond R1 (buy) / S1 (sell);
 *       stop = level ∓ 0.1·ATR, target = 3R.
 *   Any other day
 *     → RECLAIM: after the first close outside the CPR, the first close back
 *       inside trades back through it (back below TC = sell, above BC = buy);
 *       stop = 0.3·ATR, target = 1R.
 *
 * One trade per session; a trade still open at the session's end exits on
 * its last close. ATR is the mean true range of the 14 sessions before the
 * day; levels, ATR and width class only use sessions before the day, so the
 * result is the same live, in replay and in backtest. Pure — no DOM/engine.
 */
import { periodBounds, isWeekendSession, pivotLevels, type OHLCBar, type PivotLevels } from './cprModel'

export interface CprStrategyOptions {
  breakoutTargetR: number
  breakoutStopAtr: number // stop distance beyond R1/S1, in ATRs
  reclaimStopAtr: number
  reclaimTargetR: number
  narrowPct: number // width percentile (0–1) at or below which a day counts as narrow
  /** No new entries from this IST time of day (minutes after IST midnight); null = any time. */
  entryCutoffIST: number | null
  allowLongs: boolean
  allowShorts: boolean
}

export const CPR_STRATEGY_DEFAULTS: CprStrategyOptions = {
  breakoutTargetR: 3,
  breakoutStopAtr: 0.1,
  reclaimStopAtr: 0.3,
  reclaimTargetR: 1,
  narrowPct: 0.3,
  entryCutoffIST: 18 * 60,
  allowLongs: true,
  allowShorts: true,
}

/** Delta Exchange India: taker 0.05%, maker 0.02%, +18% GST on the fee. */
const FEE_TAKER = 0.0005 * 1.18
const FEE_MAKER = 0.0002 * 1.18
const ATR_LEN = 14
const WIDTH_LEN = 20
const MIN_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const IST_OFFSET_MIN = 330

export type CprMode = 'breakout' | 'reclaim'

export interface CprSession {
  start: number
  end: number
  high: number
  low: number
  close: number
}

export interface CprDay {
  start: number
  end: number
  levels: PivotLevels
  atr: number
  mode: CprMode
  widthPctile: number // share of the last 20 sessions with a narrower CPR
}

export interface CprStrategyTrade {
  side: 'long' | 'short'
  mode: CprMode
  entryTime: number
  entryPrice: number
  stop: number
  target: number
  exitTime: number | null
  exitPrice: number | null
  exitReason: 'TP' | 'SL' | 'Day end' | null
  /** Net of Delta fees, in units of initial risk; marked to the last close while open. */
  r: number
  /** Signal candle's extremes, for placing the label. */
  barHigh: number
  barLow: number
}

export interface CprStrategyResult {
  days: CprDay[]
  trades: CprStrategyTrade[]
}

/** Session OHLC from 1h bars (weekend sessions dropped when the market is shut then). */
export function buildSessions(hourly: OHLCBar[], openHourUTC: number, skipWeekends: boolean): CprSession[] {
  const out: CprSession[] = []
  let cur: CprSession | null = null
  for (const b of hourly) {
    if (skipWeekends && isWeekendSession(b.time, openHourUTC)) continue
    if (!cur || b.time >= cur.end) {
      const [start, end] = periodBounds(b.time, 'day', openHourUTC)
      cur = { start, end, high: b.high, low: b.low, close: b.close }
      out.push(cur)
      continue
    }
    if (b.high > cur.high) cur.high = b.high
    if (b.low < cur.low) cur.low = b.low
    cur.close = b.close
  }
  return out
}

/**
 * Per-session levels, ATR and mode. A day needs ≥6 prior sessions for its ATR
 * and ≥10 for its width class (without it the day is treated as non-narrow).
 */
export function buildDays(sessions: CprSession[], narrowPct: number): CprDay[] {
  const days: CprDay[] = []
  const widths: number[] = []
  for (let j = 1; j < sessions.length; j++) {
    const prev = sessions[j - 1]
    const s = sessions[j]
    if (s.start - prev.end > 4 * DAY_MS) continue // data gap: yesterday unknown
    const levels = pivotLevels(prev)
    const w = levels.width
    const hist = widths.slice(-WIDTH_LEN)
    widths.push(w)
    if (j < 6) continue
    let tr = 0
    let n = 0
    for (let k = Math.max(1, j - ATR_LEN); k < j; k++) {
      const pc = sessions[k - 1].close
      tr += Math.max(sessions[k].high, pc) - Math.min(sessions[k].low, pc)
      n++
    }
    const pctile = hist.length >= 10 ? hist.filter((x) => x < w).length / hist.length : 1
    days.push({ start: s.start, end: s.end, levels, atr: tr / n, mode: pctile <= narrowPct ? 'breakout' : 'reclaim', widthPctile: pctile })
  }
  return days
}

/**
 * 1h history with the chart's own candles folded in from the first chart bar
 * on — fresher than the hourly feed, and in replay it stops at the cursor.
 */
export function mergeHourly(hourly: OHLCBar[], candles: OHLCBar[], barMs: number): OHLCBar[] {
  if (candles.length === 0 || barMs > HOUR_MS) return hourly
  const from = Math.floor(candles[0].time / HOUR_MS) * HOUR_MS
  const out = hourly.filter((b) => b.time < from)
  let cur: OHLCBar | null = null
  for (const c of candles) {
    const t = Math.floor(c.time / HOUR_MS) * HOUR_MS
    if (!cur || cur.time !== t) {
      cur = { time: t, open: c.open, high: c.high, low: c.low, close: c.close }
      out.push(cur)
      continue
    }
    if (c.high > cur.high) cur.high = c.high
    if (c.low < cur.low) cur.low = c.low
    cur.close = c.close
  }
  return out
}

function netR(side: 1 | -1, entry: number, exit: number, risk: number, makerExit: boolean): number {
  const gross = (exit - entry) * side
  const fees = entry * FEE_TAKER + exit * (makerExit ? FEE_MAKER : FEE_TAKER)
  return (gross - fees) / risk
}

/**
 * Run the playbook over the chart candles.
 * `lastClosed` — false while the newest candle is still forming (live): it is
 * then never used for a signal, so labels don't repaint.
 */
export function computeCprStrategy(
  candles: OHLCBar[],
  hourly: OHLCBar[],
  opts: CprStrategyOptions,
  openHourUTC: number,
  skipWeekends: boolean,
  barMs: number,
  lastClosed: boolean,
): CprStrategyResult {
  const sessions = buildSessions(mergeHourly(hourly, candles, barMs), openHourUTC, skipWeekends)
  const days = buildDays(sessions, opts.narrowPct)
  const byStart = new Map(days.map((d) => [d.start, d]))
  const trades: CprStrategyTrade[] = []
  const usable = lastClosed ? candles.length : candles.length - 1
  // Cutoff as minutes after the session open.
  const cutoff = opts.entryCutoffIST === null ? null : (((opts.entryCutoffIST - IST_OFFSET_MIN - openHourUTC * 60) % 1440) + 1440) % 1440

  let i = 0
  while (i < usable) {
    const [start, end] = periodBounds(candles[i].time, 'day', openHourUTC)
    let j = i
    while (j < candles.length && candles[j].time < end) j++
    const day = byStart.get(start)
    if (day) {
      const t = runDay(candles, i, Math.min(j, usable), j, day, opts, cutoff)
      if (t) trades.push(t)
    }
    i = j
  }
  return { days, trades }
}

/** Candles [from, to) may signal and fill; `sessionEnd` is the index just past the session's last loaded candle. */
function runDay(c: OHLCBar[], from: number, to: number, sessionEnd: number, day: CprDay, o: CprStrategyOptions, cutoff: number | null): CprStrategyTrade | null {
  const lv = day.levels
  const a = day.atr
  const allowed = (side: 1 | -1): boolean => (side > 0 ? o.allowLongs : o.allowShorts)
  const beforeCutoff = (k: number): boolean => cutoff === null || (c[k].time - day.start) / MIN_MS < cutoff

  let entryIdx = -1
  let side: 1 | -1 = 1
  let stop = 0
  let risk = 0
  if (day.mode === 'breakout') {
    for (let k = from + 1; k < to && entryIdx < 0; k++) {
      if (!beforeCutoff(k)) break
      const b = c[k]
      const p = c[k - 1]
      for (const [px, s] of [
        [lv.r[0], 1],
        [lv.s[0], -1],
      ] as const) {
        const crossed = s > 0 ? b.close > px && p.close <= px : b.close < px && p.close >= px
        if (!crossed || !allowed(s)) continue
        entryIdx = k
        side = s
        stop = px - s * o.breakoutStopAtr * a
        risk = Math.abs(b.close - stop)
        break
      }
    }
  } else {
    let outside: 0 | 1 | -1 = 0
    for (let k = from; k < to && entryIdx < 0; k++) {
      const b = c[k]
      if (outside === 0) {
        outside = b.close > lv.tc ? 1 : b.close < lv.bc ? -1 : 0
        continue
      }
      const backIn = outside > 0 ? b.close < lv.tc : b.close > lv.bc
      if (!backIn) continue
      const s: 1 | -1 = outside > 0 ? -1 : 1
      if (!beforeCutoff(k) || !allowed(s)) break // the day's one reclaim is spent
      entryIdx = k
      side = s
      risk = o.reclaimStopAtr * a
      stop = b.close - s * risk
    }
  }
  if (entryIdx < 0 || risk <= 0) return null

  const e = c[entryIdx]
  const entry = e.close
  const targetR = day.mode === 'breakout' ? o.breakoutTargetR : o.reclaimTargetR
  const target = entry + side * targetR * risk
  const trade: CprStrategyTrade = {
    side: side > 0 ? 'long' : 'short',
    mode: day.mode,
    entryTime: e.time,
    entryPrice: entry,
    stop,
    target,
    exitTime: null,
    exitPrice: null,
    exitReason: null,
    r: 0,
    barHigh: e.high,
    barLow: e.low,
  }
  for (let k = entryIdx + 1; k < to; k++) {
    const b = c[k]
    // Stop first when both sit inside one bar — the conservative fill.
    if (side > 0 ? b.low <= stop : b.high >= stop) return close(trade, b.time, stop, 'SL', side, risk)
    if (side > 0 ? b.high >= target : b.low <= target) return close(trade, b.time, target, 'TP', side, risk)
  }
  const last = c[to - 1]
  // Session over: the next loaded candle already belongs to a later session.
  if (to === sessionEnd && sessionEnd < c.length) return close(trade, last.time, last.close, 'Day end', side, risk)
  trade.r = netR(side, entry, last.close, risk, false)
  return trade
}

function close(t: CprStrategyTrade, time: number, price: number, reason: 'TP' | 'SL' | 'Day end', side: 1 | -1, risk: number): CprStrategyTrade {
  t.exitTime = time
  t.exitPrice = price
  t.exitReason = reason
  t.r = netR(side, t.entryPrice, price, risk, reason === 'TP')
  return t
}

export interface CprStrategySummary {
  closed: number
  winRate: number
  avgR: number
  totalR: number
  profitFactor: number
  open: CprStrategyTrade | null
}

export function summarize(trades: CprStrategyTrade[]): CprStrategySummary {
  const done = trades.filter((t) => t.exitTime !== null)
  const wins = done.filter((t) => t.r > 0)
  const gp = wins.reduce((s, t) => s + t.r, 0)
  const gl = -done.filter((t) => t.r <= 0).reduce((s, t) => s + t.r, 0)
  const total = done.reduce((s, t) => s + t.r, 0)
  const last = trades[trades.length - 1]
  return {
    closed: done.length,
    winRate: done.length ? wins.length / done.length : NaN,
    avgR: done.length ? total / done.length : NaN,
    totalR: total,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : NaN,
    open: last && last.exitTime === null ? last : null,
  }
}
