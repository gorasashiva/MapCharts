import { describe, expect, it } from 'vitest'
import { CPR_STRATEGY_DEFAULTS, buildDays, computeCprStrategy, summarize, type CprSession } from './cprStrategyModel'
import type { OHLCBar } from './cprModel'

const H = 3_600_000
const D = 86_400_000
const M5 = 300_000
const T0 = Date.UTC(2026, 5, 1) // sessions open 00:00 UTC in these tests
const opts = { ...CPR_STRATEGY_DEFAULTS, entryCutoffIST: null }

/** Hourly sessions with H 102 / L 98; `close(k)` sets session k's close (and so its CPR width). */
function history(days: number, close = (k: number) => 100.5 + (k % 3) * 0.3): OHLCBar[] {
  const out: OHLCBar[] = []
  for (let k = 0; k < days; k++)
    for (let h = 0; h < 24; h++) {
      const t = T0 + k * D + h * H
      out.push({ time: t, open: 100, high: h === 5 ? 102 : 100.5, low: h === 9 ? 98 : 99.5, close: h === 23 ? close(k) : 100 })
    }
  return out
}

/** 5m candles for one session from a list of closes; highs/lows hug the close. */
function session(start: number, closes: number[], wick = 0.05): OHLCBar[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c
    return { time: start + i * M5, open: o, high: Math.max(c, o) + wick, low: Math.min(c, o) - wick, close: c }
  })
}

describe('buildDays', () => {
  it('classifies a day narrow when its CPR is among the narrowest 30% of the last 20', () => {
    const sessions: CprSession[] = []
    // closes cycle 100.5 / 101 / 101.5 → three different CPR widths; session 22's is the middle one
    const close = (k: number): number => (k === 23 ? 100 : 100.5 + (k % 3) * 0.5)
    for (let k = 0; k < 25; k++) sessions.push({ start: T0 + k * D, end: T0 + (k + 1) * D, high: 102, low: 98, close: close(k) })
    const days = buildDays(sessions, 0.3)
    expect(days[days.length - 1].mode).toBe('breakout') // levels from session 23, whose midpoint close makes TC = BC
    expect(days[days.length - 2].mode).toBe('reclaim')
    expect(days[days.length - 1].atr).toBeCloseTo(4)
  })
})

describe('computeCprStrategy', () => {
  // Session 24's levels come from session 23: H 102, L 98, C = 100.5 + (23 % 3)·0.3 = 101.1
  const hist = history(24)
  const p = (102 + 98 + 101.1) / 3
  const tc = Math.max((102 + 98) / 2, 2 * p - 100)
  const day24 = T0 + 24 * D

  it('reclaim: close outside the CPR, then back inside → trade through it, 0.3 ATR stop, 1R target', () => {
    const c = session(day24, [100.2, tc + 0.5, tc + 0.6, tc - 0.05, tc - 0.6, tc - 1.4, tc - 1.5, tc - 1.6])
    const { trades } = computeCprStrategy([...c, ...session(day24 + D, [100])], hist, opts, 0, false, M5, true)
    expect(trades).toHaveLength(1)
    const t = trades[0]
    expect(t).toMatchObject({ side: 'short', mode: 'reclaim', entryTime: c[3].time, exitReason: 'TP' })
    expect(t.stop - t.entryPrice).toBeCloseTo(0.3 * 4)
    expect(t.entryPrice - t.target).toBeCloseTo(0.3 * 4)
    expect(t.r).toBeLessThan(1) // fees come off the 1R
    expect(t.r).toBeGreaterThan(0.9)
  })

  it('never signals on the candle that is still forming', () => {
    const c = session(day24, [100.2, tc + 0.5, tc - 0.05])
    expect(computeCprStrategy(c, hist, opts, 0, false, M5, false).trades).toHaveLength(0)
    expect(computeCprStrategy(c, hist, opts, 0, false, M5, true).trades).toHaveLength(1)
  })

  it('a trade still open when the session ends exits on its last close', () => {
    const c = session(day24, [100.2, tc + 0.5, tc - 0.05, tc - 0.1])
    const t = computeCprStrategy([...c, ...session(day24 + D, [99])], hist, opts, 0, false, M5, true).trades[0]
    expect(t).toMatchObject({ exitReason: 'Day end', exitTime: c[3].time, exitPrice: c[3].close })
  })

  it('respects the entry cutoff and side filters', () => {
    const late = session(day24 + 13 * H, [tc + 0.5, tc + 0.6, tc - 0.05]) // 13:00 UTC = 18:30 IST
    expect(computeCprStrategy(late, hist, { ...opts, entryCutoffIST: 18 * 60 }, 0, false, M5, true).trades).toHaveLength(0)
    expect(computeCprStrategy(late, hist, opts, 0, false, M5, true).trades).toHaveLength(1)
    const c = session(day24, [100.2, tc + 0.5, tc - 0.05])
    expect(computeCprStrategy(c, hist, { ...opts, allowShorts: false }, 0, false, M5, true).trades).toHaveLength(0)
  })

  it('breakout on a narrow day: close beyond R1, stop 0.1 ATR under R1, target 3R', () => {
    const h = history(24, (k) => (k === 23 ? 100 : 101.5)) // session 23 closes at its midpoint → narrowest CPR
    const r1 = 2 * 100 - 98 // P = 100
    const c = session(day24, [100, 101, r1 + 0.2, r1 + 0.5, r1 + 2.5])
    const { trades, days } = computeCprStrategy(c, h, opts, 0, false, M5, true)
    expect(days[days.length - 1].mode).toBe('breakout')
    expect(trades[0]).toMatchObject({ side: 'long', mode: 'breakout', entryPrice: r1 + 0.2, exitReason: 'TP' })
    expect(trades[0].stop).toBeCloseTo(r1 - 0.1 * 4)
    expect(trades[0].target - trades[0].entryPrice).toBeCloseTo(3 * (trades[0].entryPrice - trades[0].stop))
  })

  it('summarize counts only closed trades and reports the open one', () => {
    const c = session(day24, [100.2, tc + 0.5, tc - 0.05, tc - 0.1])
    const s = summarize(computeCprStrategy(c, hist, opts, 0, false, M5, true).trades)
    expect(s.closed).toBe(0)
    expect(s.open?.side).toBe('short')
  })
})
