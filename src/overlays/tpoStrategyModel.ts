// VP/TPO strategy signals, rule-based, from the framework's setup / entry / stop / target rules.
// Built on the TPO profile model (tpoTvModel.ts): each day's profile gives its POC, value area,
// initial balance (IB) and day type; the previous day's profile gives the reference levels.
//
// Implemented (checkable from candles and the profile):
//   Open Drive             — drives 0.5× the first-30-minute range with no retest of the open
//   Confluence IB Breakout — closes beyond the IB extreme that lines up with the prior VAH/VAL, POC or day high/low
//   Open Rejection Reversal — opens outside prior value, probes beyond it, and is back inside prior value after the IB
//   Gap Fill Reversal      — opens outside the prior day's range and trades back into it after the IB
//   Trend Day              — closes 1× IB range beyond the IB extreme (one-time framing), IB narrow vs prior range
// Not implemented (need order flow, letter-by-letter overlap or multi-day profile detail):
//   Tail Reversal, LVA Fill, Double Distribution, Day Two Trend, Engulfing Value Areas, Consolidation Breakout.
//
// Causality: a signal uses only bars already closed at its time. Each signal is resolved on later bars
// of the same day: the stop is checked before the target within a bar (conservative); a trade still open
// at the day's last bar ends there.

import type { Candle } from '../core/types'
import { TPO_DEFAULTS, autoRowSize, computeTpo, dayType, inferTick, type TpoBar, type TpoProfile } from './tpoTvModel'

const MIN = 60_000
const DAY_MS = 24 * 60 * MIN
const OPEN_MS = 30 * MIN
const IB_MS = 60 * MIN

export type Side = 'long' | 'short'
export type StrategyName = 'Open Drive' | 'Confluence IB Breakout' | 'Open Rejection Reversal' | 'Gap Fill Reversal' | 'Trend Day'

export interface StrategySignal {
  t: number
  side: Side
  strategy: StrategyName
  entry: number
  stop: number
  target: number
  /** Start of the TPO day the signal belongs to. */
  day: number
  exit?: { t: number; price: number; result: 'win' | 'loss' | 'end'; r: number }
}

export type OpenType = 'Open drive up' | 'Open drive down' | 'Open rejection' | 'Open auction'

export interface DayRead {
  start: number
  open: number
  /** Open structure from the first 30 minutes (causal). */
  openType: OpenType
  /** Day type from the completed profile. */
  dayType: string
  ibLo: number
  ibHi: number
  prevVah: number
  prevVal: number
  prevPoc: number
  prevHigh: number
  prevLow: number
  prevClose: number
}

export interface StrategyOptions {
  /** Day starts at this UTC hour (crypto), or at this New York hour when set (gold: 18). */
  dayStartHourUTC: number
  dayStartNyHour: number | null
  /** How close (as a fraction of price) an IB extreme must sit to a reference level to count as confluence. */
  confluencePct: number
  /** Open drive: the first-30-minute move, as a fraction of that window's range, that counts as driving. */
  driveFrac: number
}

export const STRATEGY_DEFAULTS: StrategyOptions = { dayStartHourUTC: 0, dayStartNyHour: null, confluencePct: 0.001, driveFrac: 0.5 }

const near = (a: number, b: number, pct: number): boolean => Math.abs(a - b) <= pct * Math.max(Math.abs(b), 1e-9)

/** Open structure from the first 30 minutes only (no look-ahead). */
export function openStructure(win: Candle[], open: number, prev: { vah: number; val: number }, driveFrac: number): OpenType {
  if (win.length === 0) return 'Open auction'
  const hi = Math.max(...win.map((c) => c.high))
  const lo = Math.min(...win.map((c) => c.low))
  const r = Math.max(hi - lo, 1e-9)
  const up = hi - open
  const dn = open - lo
  const lastClose = win[win.length - 1].close
  // rejection: opened outside prior value, probed beyond it, and is back inside it
  if (open > prev.vah && hi > prev.vah && lastClose <= prev.vah) return 'Open rejection'
  if (open < prev.val && lo < prev.val && lastClose >= prev.val) return 'Open rejection'
  if (up >= driveFrac * r && up >= dn) return win.slice(1).every((c) => c.low > open) ? 'Open drive up' : 'Open auction'
  if (dn >= driveFrac * r) return win.slice(1).every((c) => c.high < open) ? 'Open drive down' : 'Open auction'
  return 'Open auction'
}

/** Resolves a signal on later bars: the stop before the target within a bar; otherwise the last close. */
export function resolveSignal(s: StrategySignal, later: Candle[]): StrategySignal['exit'] {
  const risk = Math.abs(s.entry - s.stop)
  if (!(risk > 0)) return undefined
  for (const c of later) {
    if (s.side === 'long') {
      if (c.low <= s.stop) return { t: c.time, price: s.stop, result: 'loss', r: -1 }
      if (c.high >= s.target) return { t: c.time, price: s.target, result: 'win', r: (s.target - s.entry) / risk }
    } else {
      if (c.high >= s.stop) return { t: c.time, price: s.stop, result: 'loss', r: -1 }
      if (c.low <= s.target) return { t: c.time, price: s.target, result: 'win', r: (s.entry - s.target) / risk }
    }
  }
  const last = later[later.length - 1]
  if (!last) return undefined
  const r = s.side === 'long' ? (last.close - s.entry) / risk : (s.entry - last.close) / risk
  return { t: last.time, price: last.close, result: 'end', r }
}

export interface StrategyResult {
  days: DayRead[]
  signals: StrategySignal[]
}

/** Signals for every completed TPO day in the candles (the day in progress is left out). */
export function computeTpoStrategies(candles: Candle[], o: StrategyOptions = STRATEGY_DEFAULTS, now = Date.now()): StrategyResult {
  if (candles.length < 2) return { days: [], signals: [] }
  const bars: TpoBar[] = candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
  const rowSize = autoRowSize(bars, inferTick(bars))
  const profiles: TpoProfile[] = computeTpo(bars, { ...TPO_DEFAULTS, period: 'day', blockMs: 30 * MIN, rowSize, valueAreaPct: 70, ibBlocks: 2, dayStartHourUTC: o.dayStartHourUTC, dayStartNyHour: o.dayStartNyHour }, now)
  const days: DayRead[] = []
  const signals: StrategySignal[] = []

  for (let i = 1; i < profiles.length; i++) {
    const p = profiles[i]
    const prev = profiles[i - 1]
    if (!p.complete || !prev.complete || prev.total === 0 || p.total === 0) continue
    const dayCandles = candles.filter((c) => c.time >= p.start && c.time < p.end)
    if (dayCandles.length < 2) continue
    const prevHigh = (prev.hi + 1) * prev.rowSize
    const prevLow = prev.lo * prev.rowSize
    const prevRange = prevHigh - prevLow
    const ibLo = p.ib[0]
    const ibHi = p.ib[1]
    const ibR = ibHi - ibLo
    const winBars = dayCandles.filter((c) => c.time < p.start + OPEN_MS)
    const openType = openStructure(winBars, p.open, { vah: prev.vaHi, val: prev.vaLo }, o.driveFrac)
    days.push({
      start: p.start,
      open: p.open,
      openType,
      dayType: dayType(p),
      ibLo,
      ibHi,
      prevVah: prev.vaHi,
      prevVal: prev.vaLo,
      prevPoc: prev.poc,
      prevHigh,
      prevLow,
      prevClose: prev.close,
    })
    const add = (s: Omit<StrategySignal, 'day'>): void => {
      signals.push({ ...s, day: p.start })
    }

    // Open drive: the drive is known when the first-30-minute window closes, so the signal is at that bar.
    if ((openType === 'Open drive up' || openType === 'Open drive down') && winBars.length) {
      const up = openType === 'Open drive up'
      const bar = winBars[winBars.length - 1]
      const r30 = Math.max(...winBars.map((c) => c.high)) - Math.min(...winBars.map((c) => c.low))
      const entry = bar.close
      const target = up ? (prev.vaHi > entry ? prev.vaHi : entry + 2 * r30) : prev.vaLo < entry ? prev.vaLo : entry - 2 * r30
      add({ t: bar.time, side: up ? 'long' : 'short', strategy: 'Open Drive', entry, stop: p.open, target })
    }

    // Rules after the IB closes, scanned bar by bar on closed bars only.
    const after = dayCandles.filter((c) => c.time >= p.start + IB_MS)
    const fired = new Set<string>()
    const openOutside = p.open > prev.vaHi || p.open < prev.vaLo
    const gapOpen = p.open > prevHigh || p.open < prevLow
    const probeHi = winBars.length ? Math.max(...winBars.map((c) => c.high)) : p.open
    const probeLo = winBars.length ? Math.min(...winBars.map((c) => c.low)) : p.open
    for (const c of after) {
      if (ibR > 0 && !fired.has('ibL') && c.close > ibHi && [prev.vaHi, prev.poc, prevHigh].some((lv) => near(ibHi, lv, o.confluencePct))) {
        fired.add('ibL')
        add({ t: c.time, side: 'long', strategy: 'Confluence IB Breakout', entry: c.close, stop: ibHi, target: c.close + 1.5 * ibR })
      }
      if (ibR > 0 && !fired.has('ibS') && c.close < ibLo && [prev.vaLo, prev.poc, prevLow].some((lv) => near(ibLo, lv, o.confluencePct))) {
        fired.add('ibS')
        add({ t: c.time, side: 'short', strategy: 'Confluence IB Breakout', entry: c.close, stop: ibLo, target: c.close - 1.5 * ibR })
      }
      if (ibR > 0 && !fired.has('tr') && prevRange > 0 && ibR <= 0.25 * prevRange) {
        if (c.close > ibHi + ibR) {
          fired.add('tr')
          add({ t: c.time, side: 'long', strategy: 'Trend Day', entry: c.close, stop: ibHi, target: c.close + 2 * ibR })
        } else if (c.close < ibLo - ibR) {
          fired.add('tr')
          add({ t: c.time, side: 'short', strategy: 'Trend Day', entry: c.close, stop: ibLo, target: c.close - 2 * ibR })
        }
      }
      if (!fired.has('orr') && openOutside && c.close <= prev.vaHi && c.close >= prev.vaLo) {
        if (p.open > prev.vaHi && probeHi > prev.vaHi) {
          fired.add('orr')
          add({ t: c.time, side: 'short', strategy: 'Open Rejection Reversal', entry: c.close, stop: probeHi, target: prev.poc })
        } else if (p.open < prev.vaLo && probeLo < prev.vaLo) {
          fired.add('orr')
          add({ t: c.time, side: 'long', strategy: 'Open Rejection Reversal', entry: c.close, stop: probeLo, target: prev.poc })
        }
      }
      if (!fired.has('gap') && gapOpen && c.close <= prevHigh && c.close >= prevLow) {
        fired.add('gap')
        add({ t: c.time, side: p.open < prevLow ? 'long' : 'short', strategy: 'Gap Fill Reversal', entry: c.close, stop: p.open, target: prev.close })
      }
    }
  }

  for (const s of signals) {
    const later = candles.filter((c) => c.time > s.t && c.time >= s.day && c.time < s.day + DAY_MS)
    s.exit = resolveSignal(s, later)
  }
  return { days, signals }
}
