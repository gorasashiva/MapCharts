import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import type { OHLCBar } from './ivWallsModel'
import { computeIvFvStrategy, IV_FV_STRATEGY_DEFAULTS, zoneLevels, type IvFvStrategyOptions } from './ivFvStrategyModel'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
// Monday 2026-10-05 00:00 UTC; sessions open at 00:00 UTC in these tests.
const T0 = Date.UTC(2026, 9, 5)

/** Manual FV settings (see fvVwapEmaModel.test.ts) so the synthetic trend produces signals. */
const BASE: IvFvStrategyOptions = {
  ...IV_FV_STRATEGY_DEFAULTS,
  autoTune: false,
  entryWindowIST: null,
  maxVwapDistSigma: null,
  bandMult: 2,
  maxRiskAtr: 50,
  hvLookback: 2,
}

/** Flat prior days closing at `close`, as hourly bars. */
function priorDays(days: number, close: number): OHLCBar[] {
  const out: OHLCBar[] = []
  for (let d = days; d >= 1; d--) for (let h = 0; h < 24; h++) out.push({ time: T0 - d * DAY + h * HOUR, open: close, high: close + 0.5, low: close - 0.5, close })
  return out
}

/** Chart candles bucketed to 1h, so today's session exists in the hourly history too. */
function toHourly(c: Candle[]): OHLCBar[] {
  const out: OHLCBar[] = []
  for (const k of c) {
    const t = Math.floor(k.time / HOUR) * HOUR
    const last = out[out.length - 1]
    if (last && last.time === t) {
      last.high = Math.max(last.high, k.high)
      last.low = Math.min(last.low, k.low)
      last.close = k.close
    } else out.push({ time: t, open: k.open, high: k.high, low: k.low, close: k.close })
  }
  return out
}

/** Uptrend in legs whose deeper pullbacks flip the chart vector (as in fvVwapEmaModel.test.ts). */
function zigzag(): Candle[] {
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

describe('computeIvFvStrategy — IV-zone targets', () => {
  it('caps TP2 at the next zone when it comes before 3R, otherwise keeps 3R', () => {
    const c = zigzag()
    // Prev close 110 with a 300% IV puts zones roughly every 8.6 points through the trend.
    const hourly = [...priorDays(4, 110), ...toHourly(c)]
    const o = { ...BASE, ivOverridePct: 300, zoneMinR: 1 }
    const { trades, zones } = computeIvFvStrategy(c, hourly, o, 0, false, null, 5 * MIN)
    const fv = trades.filter((t) => t.setup !== 'fade')
    expect(fv.length).toBeGreaterThan(0)
    const today = zones[zones.length - 1]
    expect(today.em).not.toBeNull()
    for (const t of fv) {
      const s = t.side === 'long' ? 1 : -1
      const risk = Math.abs(t.entryPrice - t.stop)
      const threeR = t.entryPrice + s * 3 * risk
      if (t.zoneTarget) {
        expect(zoneLevels(today).some((lv) => Math.abs(lv - t.target!) < 1e-9)).toBe(true)
        expect((t.target! - t.entryPrice) * s).toBeGreaterThanOrEqual(risk - 1e-9)
        expect((threeR - t.target!) * s).toBeGreaterThan(0)
      } else expect(t.target).toBeCloseTo(threeR)
    }
    // Without zone targets every target is the plain 3R.
    const plain = computeIvFvStrategy(c, hourly, { ...o, zoneTargets: false }, 0, false, null, 5 * MIN)
    for (const t of plain.trades) expect(t.zoneTarget).toBe(false)
  })
})

describe('computeIvFvStrategy — ±1× fade', () => {
  it('shorts the first touch of +1× and covers at the previous close', () => {
    // Prev close 100, 20% IV on 365 days → EM ≈ 1.047; the +1× zone sits ≈ 100.99–101.10.
    const c: Candle[] = []
    const path = [...Array.from({ length: 12 }, (_, i) => 100 + i * 0.1), ...Array.from({ length: 30 }, (_, i) => 101.1 - i * 0.05)]
    path.forEach((p, i) => c.push({ time: T0 + i * 5 * MIN, open: p, high: p + 0.02, low: p - 0.02, close: p, volume: 10 }))
    const hourly = [...priorDays(4, 100), ...toHourly(c)]
    const o = { ...BASE, fadeSetup: true, flipSignals: false, pullbackSignals: false, ivOverridePct: 20 }
    const { trades, zones } = computeIvFvStrategy(c, hourly, o, 0, false, null, 5 * MIN)
    const fades = trades.filter((t) => t.setup === 'fade')
    expect(fades).toHaveLength(1)
    const f = fades[0]
    const plus1 = zones[zones.length - 1].zones.find((z) => z.tag === '+1x')!
    expect(f.side).toBe('short')
    // Limit at the zone's near edge — or the bar's open when it opens beyond it (here 101.00).
    expect(f.entryPrice).toBeGreaterThanOrEqual(plus1.bottom)
    expect(f.entryPrice).toBeLessThanOrEqual(plus1.top)
    expect(f.stop).toBeGreaterThan(plus1.top)
    expect(f.exitReason).toBe('TP')
    expect(f.exitPrice).toBe(100)
    expect(f.grossR).toBeGreaterThan(0)
  })
})
