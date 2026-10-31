import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  buildSessions,
  calibrate,
  continuationOdds,
  extensionSamples,
  impliedFromChain,
  ivToDaily,
  parkinsonSigma,
  quantile,
  wallsFor,
  type ChainPoint,
  type OHLCBar,
  type SessionDay,
} from './ivWallsModel'

const H = 3_600_000
const T0 = Date.UTC(2026, 0, 1)
const bar = (t: number, o: number, h: number, l: number, c: number): OHLCBar => ({ time: t, open: o, high: h, low: l, close: c })
const day = (i: number, open: number, high: number, low: number): SessionDay => ({
  start: T0 + i * DAY_MS, end: T0 + (i + 1) * DAY_MS, open, high, low, close: open, hodAt: T0 + i * DAY_MS + 3 * H, lodAt: T0 + i * DAY_MS + 10 * H, bars: 24,
})

describe('buildSessions', () => {
  it('splits on the configured UTC session hour and tracks HOD/LOD times', () => {
    const bars = [
      bar(T0 + 4 * H, 100, 101, 99, 100), // before 05:00 → previous session
      bar(T0 + 5 * H, 100, 104, 99, 103), // session opens
      bar(T0 + 6 * H, 103, 103, 95, 96),
      bar(T0 + 7 * H, 96, 98, 96, 97),
    ]
    const s = buildSessions(bars, 5)
    expect(s).toHaveLength(2)
    expect(s[1]).toMatchObject({ start: T0 + 5 * H, open: 100, high: 104, low: 95, close: 97, hodAt: T0 + 5 * H, lodAt: T0 + 6 * H, bars: 3 })
  })
})

describe('volatility', () => {
  it('Parkinson σ matches ln(H/L)/√(4 ln2) for constant ranges', () => {
    const days = [day(0, 100, 102, 98), day(1, 100, 102, 98)]
    expect(parkinsonSigma(days)!).toBeCloseTo(Math.log(102 / 98) / Math.sqrt(4 * Math.LN2), 10)
  })
  it('annualised IV converts to a daily move over 365 days', () => {
    expect(ivToDaily(0.73)).toBeCloseTo(0.73 / Math.sqrt(365), 12)
  })
  it('quantile interpolates linearly', () => {
    expect(quantile([0, 1, 2, 3, 4], 0.5)).toBe(2)
    expect(quantile([0, 10], 0.25)).toBe(2.5)
  })
})

describe('extensionSamples', () => {
  it('measures each session in the σ of the sessions BEFORE it (no lookahead)', () => {
    const quiet = Array.from({ length: 5 }, (_, i) => day(i, 100, 101, 99))
    const wild = day(5, 100, 110, 90) // its own huge range must not inflate its own σ
    const s = extensionSamples([...quiet, wild], 5)
    expect(s).toHaveLength(1)
    const sigma = parkinsonSigma(quiet)!
    expect(s[0].sigma).toBeCloseTo(sigma, 12)
    expect(s[0].up).toBeCloseTo(0.1 / sigma, 9)
    expect(s[0].hodHour).toBe(3)
    expect(s[0].lodHour).toBe(10)
  })
})

describe('calibrate', () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({ start: i, sigma: 0.01, up: (i % 20) / 10, down: ((i * 7) % 20) / 10, hodHour: i % 24, lodHour: 23 - (i % 24) }))
  it('builds zones from extension quantiles and reports touch rates', () => {
    const st = calibrate(samples, 0.5, 0.8, [1])!
    expect(st.n).toBe(100)
    expect(st.up.lo).toBeCloseTo(quantile(st.ups, 0.5), 12)
    expect(st.up.hi).toBeGreaterThan(st.up.lo)
    expect(st.touch[0].up).toBeCloseTo(0.5, 12) // values 1.0..1.9 are half of 0..1.9
    expect(st.hodSetBy[0]).toBe(0)
    expect(st.hodSetBy[24]).toBe(1)
  })
  it('walk-forward hold rate counts only sessions that reached the zone', () => {
    const st = calibrate(samples, 0.5, 0.8, [1])!
    expect(st.holdUp.reached).toBeGreaterThan(0)
    expect(st.holdUp.held).toBeLessThanOrEqual(st.holdUp.reached)
  })
  it('needs a minimum sample count', () => {
    expect(calibrate(samples.slice(0, 5), 0.5, 0.8, [1])).toBeNull()
  })
})

describe('continuationOdds', () => {
  it('is P(extends beyond current | reached current)', () => {
    const xs = [0.1, 0.2, 0.5, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5]
    expect(continuationOdds(xs, 1.0)).toBeCloseTo(4 / 5, 12) // 5 reached ≥1.0, 4 went >1.05
    expect(continuationOdds(xs, 2.4)).toBeNull() // too few sessions ever got that far
  })
})

describe('impliedFromChain', () => {
  const now = T0
  const expiry = T0 + DAY_MS // exactly one day out
  const q = (side: 'CALL' | 'PUT', strike: number, iv: number, price = 0): ChainPoint => ({ side, strike, expiry, markIV: iv, markPrice: price, bid: 0, ask: 0 })

  it('reads ATM IV and skews each side from the OTM wing of the smile', () => {
    const chain = [
      q('PUT', 90, 0.8), q('PUT', 95, 0.7), q('PUT', 100, 0.6),
      q('CALL', 100, 0.6), q('CALL', 105, 0.55), q('CALL', 110, 0.5),
    ]
    const iv = impliedFromChain(chain, 100, now)!
    expect(iv.atmIV).toBeCloseTo(0.6, 12)
    expect(iv.downIV).toBeGreaterThan(iv.atmIV)
    expect(iv.upIV).toBeLessThan(iv.atmIV)
    expect(iv.tDays).toBeCloseTo(1, 12)
  })

  it('skips expiries too close to trust and recovers σ from an ATM straddle', () => {
    const sd = 0.03 // 3% daily σ
    const leg = (100 * sd) / Math.sqrt(2 * Math.PI) // ATM leg ≈ S·σ√T/√(2π)
    const tooSoon: ChainPoint = { side: 'CALL', strike: 100, expiry: now + H, markIV: 5, markPrice: 1, bid: 0, ask: 0 }
    const chain = [tooSoon, q('CALL', 100, 0.57, leg), q('PUT', 100, 0.57, leg)]
    const iv = impliedFromChain(chain, 100, now)!
    expect(iv.expiry).toBe(expiry)
    expect(iv.straddleSigmaDay!).toBeCloseTo(sd, 10)
  })

  it('returns null without a usable expiry', () => {
    expect(impliedFromChain([], 100, now)).toBeNull()
  })
})

describe('wallsFor', () => {
  it('uses side-specific implied σ for walls and HV-scaled quantiles for zones', () => {
    const st = calibrate(Array.from({ length: 20 }, (_, i) => ({ start: i, sigma: 0.01, up: i / 10, down: i / 10, hodHour: 0, lodHour: 0 })), 0.5, 0.8, [1])!
    const implied = { expiry: 0, tDays: 1, atmIV: 0.5, upIV: 0.4, downIV: 0.6, straddleSigmaDay: null }
    const w = wallsFor({ start: 0, end: DAY_MS, open: 100 }, 0.02, st, implied, [1])
    expect(w.lines[0].up).toBeCloseTo(100 * (1 + ivToDaily(0.4)), 10)
    expect(w.lines[0].down).toBeCloseTo(100 * (1 - ivToDaily(0.6)), 10)
    expect(w.hodZone![0]).toBeCloseTo(100 * (1 + st.up.lo * 0.02), 10)
    expect(w.lodZone![1]).toBeCloseTo(100 * (1 - st.down.lo * 0.02), 10)
    expect(wallsFor({ start: 0, end: DAY_MS, open: 100 }, 0.02, null, null, [1]).lines[0].up).toBeCloseTo(102, 10)
  })
})
