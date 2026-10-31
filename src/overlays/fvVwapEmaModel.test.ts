import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import {
  FV_PRESETS,
  FV_VWAP_EMA_DEFAULTS,
  computeFvPoints,
  computeFvVwapEma,
  fractalVector,
  presetForBar,
  resolveOptions,
  summarize,
  type FvVwapEmaOptions,
} from './fvVwapEmaModel'

const MIN = 60_000
// Monday 2026-10-05 00:00 UTC (05:30 IST) — inside a weekday session for a 0h open.
const T0 = Date.UTC(2026, 9, 5, 0, 0)
/** Manual settings (no auto-tune, any time of day) so tests control every rule. */
const OPTS: FvVwapEmaOptions = {
  ...FV_VWAP_EMA_DEFAULTS,
  autoTune: false,
  entryWindowIST: null,
  maxVwapDistSigma: null,
  // The synthetic trend runs far from VWAP with deep swings — widen the band and the stop cap.
  bandMult: 2,
  maxRiskAtr: 50,
}

function bar(i: number, close: number, spread = 1, volume = 10): Candle {
  return { time: T0 + i * 5 * MIN, open: close, high: close + spread, low: close - spread, close, volume }
}

describe('fractalVector', () => {
  it('confirms fractals n bars late and flips on a close through the opposite fractal', () => {
    const closes = [10, 11, 12, 11, 10, 11, 12, 13, 14, 13, 12, 11, 9]
    const v = fractalVector(closes.map((c) => ({ high: c + 0.5, low: c - 0.5, close: c })), 2)
    // Fractal low at bar 4 (9.5) is only known at bar 6.
    expect(v[5].lvl).toBeNaN()
    expect(v[6]).toEqual({ lvl: 9.5, dir: 1 })
    // Bar 12 closes at 9 < 9.5 → flips down; the level becomes the last fractal high (bar 8, 14.5).
    expect(v[12]).toEqual({ lvl: 14.5, dir: -1 })
  })
})

describe('computeFvPoints', () => {
  it('anchors VWAP per session and only uses closed HTF bars', () => {
    const candles = Array.from({ length: 30 }, (_, i) => bar(i, 100 + i))
    const pts = computeFvPoints(candles, OPTS, 0, 5 * MIN)
    expect(pts[0].vwap).toBeCloseTo(100, 6)
    expect(pts[0].upper).toBe(pts[0].lower)
    // The first 1h bucket closes with bar 11 (55m–60m); before that there's no HTF value.
    expect(pts[10].htfDir).toBe(0)
    expect(pts[11].htfDir).not.toBe(0)
    expect(pts[29].e1).toBeGreaterThan(pts[29].e2)
  })
})

describe('computeFvVwapEma', () => {
  // Uptrend in legs; every other pullback breaks the prior swing low, so the
  // chart vector flips down and back up while the 1h vector stays up.
  function uptrendWithDip(): Candle[] {
    const c: Candle[] = []
    const legs: [number, number][] = [[12, 0.6], [4, -0.6], [16, 0.6], [14, -0.8], [24, 0.6]]
    let p = 100
    while (c.length < 240) {
      for (const [n, step] of legs) {
        for (let k = 0; k < n && c.length < 240; k++) {
          p += step
          c.push({ time: T0 + c.length * 5 * MIN, open: p - step / 2, high: p + 0.3, low: p - 0.3, close: p, volume: 10 })
        }
      }
    }
    return c
  }

  it('only takes trades in the HTF direction and never before warm-up', () => {
    const c = uptrendWithDip()
    const { trades } = computeFvVwapEma(c, OPTS, 0, 5 * MIN)
    for (const t of trades) {
      expect(t.side).toBe('long')
      expect(t.entryTime).toBeGreaterThanOrEqual(c[FV_VWAP_EMA_DEFAULTS.ema3].time)
      expect(t.stop).toBeLessThan(t.entryPrice)
    }
  })

  it('skips weekend sessions when weekdaysOnly is on', () => {
    const sat = Date.UTC(2026, 9, 10, 0, 0)
    const c = uptrendWithDip().map((k, i) => ({ ...k, time: sat + i * 5 * MIN }))
    const off = computeFvVwapEma(c, { ...OPTS, weekdaysOnly: false }, 0, 5 * MIN)
    const on = computeFvVwapEma(c, OPTS, 0, 5 * MIN)
    expect(on.trades).toHaveLength(0)
    expect(off.trades.length).toBeGreaterThanOrEqual(on.trades.length)
  })

  it('produces trades on the synthetic trend (guards the tests below)', () => {
    expect(computeFvVwapEma(uptrendWithDip(), OPTS, 0, 5 * MIN).trades.length).toBeGreaterThan(0)
  })

  it('scale-out: TP1 at 1R banks half, then the stop sits at entry', () => {
    const { trades } = computeFvVwapEma(uptrendWithDip(), { ...OPTS, exitMode: 'scale', tp1R: 1, targetR: 3 }, 0, 5 * MIN)
    for (const t of trades) {
      const risk = t.entryPrice - t.stop
      expect(t.tp1).toBeCloseTo(t.entryPrice + risk)
      expect(t.target).toBeCloseTo(t.entryPrice + 3 * risk)
      if (t.exitReason === 'SL') {
        expect(t.tp1Time).toBeNull()
        expect(t.grossR).toBeCloseTo(-1)
      }
      if (t.exitReason === 'BE') {
        expect(t.tp1Time).not.toBeNull()
        expect(t.grossR).toBeCloseTo(0.5)
      }
      if (t.exitReason === 'TP') expect(t.grossR).toBeCloseTo(2)
      if (t.exitTime !== null && t.tp1Time !== null) expect(t.avgExitPrice).toBeCloseTo((t.tp1! + t.exitPrice!) / 2)
    }
  })

  it('trail mode has no fixed levels', () => {
    const { trades } = computeFvVwapEma(uptrendWithDip(), { ...OPTS, exitMode: 'trail' }, 0, 5 * MIN)
    for (const t of trades) {
      expect(t.tp1).toBeNull()
      expect(t.target).toBeNull()
      expect(['Flip', 'SL', 'Day end', null]).toContain(t.exitReason)
    }
  })

  it('only enters within maxVwapDistSigma of VWAP', () => {
    const c = uptrendWithDip()
    const { trades, points } = computeFvVwapEma(c, { ...OPTS, maxVwapDistSigma: 0.5 }, 0, 5 * MIN)
    for (const t of trades) {
      const i = c.findIndex((k) => k.time === t.entryTime)
      expect(t.entryPrice - points[i].vwap).toBeLessThanOrEqual(0.5 * points[i].sd + 1e-9)
    }
  })

  it('does not signal on a still-forming last candle', () => {
    const c = uptrendWithDip()
    const forming = computeFvVwapEma(c, OPTS, 0, 5 * MIN, false)
    const lastT = c[c.length - 1].time
    expect(forming.trades.some((t) => t.entryTime === lastT)).toBe(false)
  })
})

describe('summarize', () => {
  it('reports net and gross averages over closed trades only', () => {
    const base = {
      setup: 'flip' as const,
      side: 'long' as const,
      entryTime: 0,
      entryPrice: 1,
      stop: 0,
      tp1: null,
      tp1Time: null,
      target: null,
      barHigh: 1,
      barLow: 1,
      exitPrice: 1,
      avgExitPrice: 1,
    }
    const s = summarize([
      { ...base, exitTime: 1, exitReason: 'Flip', r: 1.5, grossR: 2 },
      { ...base, exitTime: 2, exitReason: 'SL', r: -1.2, grossR: -1 },
      { ...base, exitTime: null, exitPrice: null, avgExitPrice: null, exitReason: null, r: 0.3, grossR: 0.4 },
    ])
    expect(s.closed).toBe(2)
    expect(s.winRate).toBe(0.5)
    expect(s.avgGrossR).toBeCloseTo(0.5)
    expect(s.profitFactor).toBeCloseTo(1.25)
    expect(s.open?.r).toBe(0.3)
  })
})

describe('auto-tune', () => {
  it('maps 1m / 3m / 5m bars to their presets and leaves other timeframes alone', () => {
    expect(presetForBar(60_000)).toBe('1m')
    expect(presetForBar(180_000)).toBe('3m')
    expect(presetForBar(300_000)).toBe('5m')
    expect(presetForBar(900_000)).toBeNull()
    const d = FV_VWAP_EMA_DEFAULTS
    expect(resolveOptions(d, 60_000)).toMatchObject({ htfMinutes: 15, htf2Minutes: 60 })
    expect(resolveOptions(d, 300_000)).toMatchObject(FV_PRESETS['5m'])
    expect(resolveOptions({ ...d, autoTune: false }, 60_000).htfMinutes).toBe(d.htfMinutes)
    expect(resolveOptions(d, 900_000)).toBe(d)
  })
})
