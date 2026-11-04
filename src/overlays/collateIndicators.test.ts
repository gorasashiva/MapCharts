import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { computePeriodKeys, weekdayOf } from './periodKeys'
import { VEA_DEFAULTS, computeVwapEmaAngle } from './vwapEmaAngleModel'
import { DC_CPR_BB_DEFAULTS, computeDcCprBb, cprFrom } from './dcCprBbModel'

const H = 3_600_000
const DAY = 24 * H

/** Deterministic pseudo-random walk of 15m candles starting on a Monday 00:00 UTC. */
function walk(n: number, start = Date.UTC(2026, 0, 5), step = 15 * 60_000): Candle[] {
  let seed = 7
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const out: Candle[] = []
  let p = 100
  for (let i = 0; i < n; i++) {
    const o = p
    const c = o + (rnd() - 0.5) * 2
    const h = Math.max(o, c) + rnd()
    const l = Math.min(o, c) - rnd()
    out.push({ time: start + i * step, open: o, high: h, low: l, close: c, volume: 1 + rnd() * 10 })
    p = c
  }
  return out
}

describe('periodKeys', () => {
  it('weekday and Monday-start weeks', () => {
    const mon = Date.UTC(2026, 0, 5) / DAY
    expect(weekdayOf(mon)).toBe(0)
    expect(weekdayOf(mon + 6)).toBe(6)
    const k = computePeriodKeys([Date.UTC(2026, 0, 4, 12), Date.UTC(2026, 0, 5, 1), Date.UTC(2026, 0, 11, 23)], 'BTCUSD')
    expect(k.week[0]).not.toBe(k.week[1]) // Sunday → Monday is a new week
    expect(k.week[1]).toBe(k.week[2]) // Monday … Sunday
  })

  it('gold day opens at 18:00 New York and follows daylight saving', () => {
    // summer (EDT): 22:00 UTC; winter (EST): 23:00 UTC
    const s = computePeriodKeys([Date.UTC(2026, 6, 6, 21, 59), Date.UTC(2026, 6, 6, 22, 0)], 'XAUTUSD')
    expect(s.day[1]).toBe(s.day[0] + 1)
    const w = computePeriodKeys([Date.UTC(2026, 0, 6, 22, 30), Date.UTC(2026, 0, 6, 23, 0)], 'XAUTUSD')
    expect(w.day[1]).toBe(w.day[0] + 1)
    // the session opening Sunday evening is Monday's
    const sun = computePeriodKeys([Date.UTC(2026, 0, 4, 23, 30)], 'XAUTUSD')
    expect(weekdayOf(sun.day[0])).toBe(0)
  })
})

describe('VWAP Angle model', () => {
  const candles = walk(400)

  it('EMA is Pine ta.ema (SMA seed) and VWAP resets each session', () => {
    const r = computeVwapEmaAngle(candles, 'BTCUSD', VEA_DEFAULTS)
    const len = VEA_DEFAULTS.emaLength
    expect(Number.isNaN(r.ema[len - 2])).toBe(true)
    let e = candles.slice(0, len).reduce((s, c) => s + c.close, 0) / len
    expect(r.ema[len - 1]).toBeCloseTo(e, 10)
    for (let i = len; i < candles.length; i++) e = (2 / (len + 1)) * candles[i].close + (1 - 2 / (len + 1)) * e
    expect(r.ema[candles.length - 1]).toBeCloseTo(e, 8)

    // brute-force VWAP of the last session
    const last = candles.length - 1
    let s = last
    while (s > 0 && !r.newPeriod[s]) s--
    let pv = 0
    let v = 0
    for (let i = s; i <= last; i++) {
      const c = candles[i]
      pv += ((c.high + c.low + c.close) / 3) * c.volume
      v += c.volume
    }
    expect(r.vwap[last]).toBeCloseTo(pv / v, 8)
    expect(r.newPeriod.reduce((a, b) => a + b, 0)).toBe(Math.ceil((400 * 15) / 1440))
  })

  it('signal follows the angle threshold; confluence matches the script', () => {
    const r = computeVwapEmaAngle(candles, 'BTCUSD', { ...VEA_DEFAULTS, angleThreshold: 5 })
    for (let i = 30; i < candles.length; i++) {
      const a = r.angle[i]
      expect(r.signal[i]).toBe(a > 5 ? 1 : a < -5 ? -1 : 0)
      const c = candles[i].close
      if (r.signal[i] === 1 && c > r.vwap[i]) expect([1, 2]).toContain(r.setup[i])
      if (r.signal[i] === -1 && c < r.vwap[i]) expect([5, 6]).toContain(r.setup[i])
    }
  })
})

describe('DC CPR BB model', () => {
  const candles = walk(96 * 20) // 20 days of 15m

  it('rolling windows match brute force (Donchian, BB stdev, WMA, SMA)', () => {
    for (const bbMa of ['sma', 'wma', 'ema', 'vwma'] as const) {
      const o = { ...DC_CPR_BB_DEFAULTS, bbMa }
      const r = computeDcCprBb(candles, 'BTCUSD', o)
      for (const i of [19, 20, 500, candles.length - 1]) {
        const win = candles.slice(i - 19, i + 1)
        expect(r.dcUp[i]).toBe(Math.max(...win.map((c) => c.high)))
        expect(r.dcLo[i]).toBe(Math.min(...win.map((c) => c.low)))
        const xs = win.map((c) => c.close)
        const mean = xs.reduce((a, b) => a + b, 0) / 20
        const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / 20)
        expect(r.bbUp[i] - r.bbBasis[i]).toBeCloseTo(2 * sd, 6)
        if (bbMa === 'sma') expect(r.bbBasis[i]).toBeCloseTo(mean, 8)
        if (bbMa === 'wma') expect(r.bbBasis[i]).toBeCloseTo(xs.reduce((a, b, k) => a + b * (k + 1), 0) / 210, 8)
      }
    }
  })

  it('daily CPR uses the previous complete day; the first, partial day is skipped', () => {
    const cs = candles.slice(10) // day 1 starts mid-day
    const r = computeDcCprBb(cs, 'BTCUSD', DC_CPR_BB_DEFAULTS)
    const first = r.cprD[0]
    // day 1 partial → day 2 gets no CPR; day 2 complete → day 3's CPR
    expect(cs[first.from].time).toBe(Date.UTC(2026, 0, 7))
    const day2 = cs.filter((c) => c.time >= Date.UTC(2026, 0, 6) && c.time < Date.UTC(2026, 0, 7))
    const want = cprFrom(Math.max(...day2.map((c) => c.high)), Math.min(...day2.map((c) => c.low)), day2[day2.length - 1].close)
    expect(first.lv.p).toBeCloseTo(want.p, 10)
    expect(first.lv.tc).toBeGreaterThanOrEqual(first.lv.bc)
    expect(r.cprD.length).toBe(18)
    expect(r.cprW.length).toBe(1) // weeks: partial wk1, full wk2 → CPR on wk3
  })

  it('BUY / SELL only on a candle that crosses every line in its body', () => {
    const r = computeDcCprBb(candles, 'BTCUSD', DC_CPR_BB_DEFAULTS)
    for (let i = 0; i < candles.length; i++) {
      if (!r.signal[i]) continue
      const c = candles[i]
      const ls = [r.dcMid[i], r.bbBasis[i], r.sma1[i], r.sma2[i]]
      if (r.signal[i] === 1) {
        expect(c.open).toBeLessThan(Math.min(...ls))
        expect(c.close).toBeGreaterThan(Math.max(...ls))
        expect(c.close).toBeGreaterThan(r.dayOpen[i])
      } else {
        expect(c.open).toBeGreaterThan(Math.max(...ls))
        expect(c.close).toBeLessThan(Math.min(...ls))
      }
    }
  })

  it('computes 20k bars fast', () => {
    const big = walk(20_000, Date.UTC(2026, 0, 5), 60_000)
    const run = (): void => {
      computeDcCprBb(big, 'XAUTUSD', DC_CPR_BB_DEFAULTS)
      computeVwapEmaAngle(big, 'XAUTUSD', { ...VEA_DEFAULTS, angleBasis: 'atr' })
    }
    run() // warm-up (JIT)
    let best = Infinity
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now()
      run()
      best = Math.min(best, performance.now() - t0)
    }
    expect(best).toBeLessThan(80) // ~15 ms on a laptop; generous for parallel test runs
  })
})
