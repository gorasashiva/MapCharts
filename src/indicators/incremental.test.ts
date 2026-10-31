import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { computeIndicatorIncremental, type IndicatorCacheEntry } from './incremental'
import { vwap, vwapPeriodKey } from './vwap'
import { obv } from './obv'
import { cvd } from './cvd'
import { ema } from './movingAverages'
import type { IndicatorDef } from './types'

const MIN = 60_000

/** Deterministic 5m candles starting at a UTC midnight, spanning two days. */
function makeCandles(n: number, start = Date.UTC(2026, 9, 14, 0, 0)): Candle[] {
  let seed = 7
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5
  let p = 100
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const o = p
    p = Math.max(1, p + rnd() * 2)
    out.push({ time: start + i * 5 * MIN, open: o, high: Math.max(o, p) + 0.3, low: Math.min(o, p) - 0.3, close: p, volume: 10 + Math.abs(rnd()) * 90 })
  }
  return out
}

/** Simulate the chart: full load, then live ticks that mutate / append in place (as onLive does). */
function liveSequence(def: IndicatorDef, params: Record<string, number>, bars = 600) {
  const candles = makeCandles(bars)
  const cache = new Map<string, IndicatorCacheEntry>()
  computeIndicatorIncremental(cache, def.id, candles, def, params)
  // tick the last bar, then append a new bar and tick it
  const last = candles[candles.length - 1]
  candles[candles.length - 1] = { ...last, close: last.close + 0.5, high: last.high + 0.5, volume: last.volume + 40 }
  computeIndicatorIncremental(cache, def.id, candles, def, params)
  candles.push({ ...candles[candles.length - 1], time: candles[candles.length - 1].time + 5 * MIN, volume: 25 })
  const out = computeIndicatorIncremental(cache, def.id, candles, def, params)
  return { out, full: def.compute(candles, params), entry: cache.get(def.id)! }
}

describe('computeIndicatorIncremental', () => {
  // [name, def, params, bars, must fall back to full recompute]
  const cases: [string, IndicatorDef, Record<string, number>, number, boolean | null][] = [
    // Current session is 24 bars, inside the 200-bar warm-up slice: the fast path is genuinely exact.
    ['VWAP (session, short session)', vwap, { anchor: 0 }, 600, null],
    // Current session is 252 bars, longer than the slice: must be recomputed in full.
    ['VWAP (session, long session)', vwap, { anchor: 0 }, 540, true],
    ['VWAP (no anchor)', vwap, { anchor: 3 }, 600, true],
    ['OBV', obv, {}, 600, true],
    ['CVD', cvd, {}, 600, true],
  ]
  for (const [name, def, params, bars, fallback] of cases) {
    it(`${name}: live ticks match a full recompute (no bend at the edge)`, () => {
      const { out, full, entry } = liveSequence(def, params, bars)
      for (let o = 0; o < full.length; o++) {
        const n = full[o].values.length
        for (let i = n - 120; i < n; i++) expect(out[o].values[i]).toBeCloseTo(full[o].values[i] as number, 9)
        expect(out[o].breaks ?? []).toEqual(full[o].breaks ?? [])
      }
      if (fallback !== null) expect(entry.nonIncremental).toBe(fallback) // running totals can't use the trailing-slice shortcut
    })
  }

  it('EMA keeps the fast path and stays accurate', () => {
    const { out, full, entry } = liveSequence(ema, { period: 20 })
    const n = full[0].values.length
    for (let i = n - 50; i < n; i++) expect(out[0].values[i]).toBeCloseTo(full[0].values[i] as number, 6)
    expect(entry.nonIncremental).toBeFalsy()
  })
})

describe('vwap anchor', () => {
  it('resets at the UTC day boundary and starts a new line segment there', () => {
    const candles = makeCandles(600) // 600 × 5m ≈ 2.08 days from 14 Oct 00:00 UTC
    const [o] = vwap.compute(candles, { anchor: 0 })
    const dayStart = candles.findIndex((c) => c.time === Date.UTC(2026, 9, 15, 0, 0))
    expect(dayStart).toBe(288)
    expect(o.breaks).toEqual([288, 576])
    const c = candles[dayStart]
    expect(o.values[dayStart]).toBeCloseTo((c.high + c.low + c.close) / 3, 9) // first bar of a session = its own typical price
  })

  it('week / month / none period keys', () => {
    const mon = Date.UTC(2026, 9, 12, 0, 0) // Monday 12 Oct 2026
    expect(vwapPeriodKey(mon - 1, 1)).not.toBe(vwapPeriodKey(mon, 1))
    expect(vwapPeriodKey(mon, 1)).toBe(vwapPeriodKey(mon + 6 * 86_400_000, 1))
    expect(vwapPeriodKey(Date.UTC(2026, 9, 31), 2)).not.toBe(vwapPeriodKey(Date.UTC(2026, 10, 1), 2))
    expect(vwapPeriodKey(0, 3)).toBe(vwapPeriodKey(Date.UTC(2030, 0, 1), 3))
  })
})
