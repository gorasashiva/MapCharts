import { describe, expect, it } from 'vitest'
import {
  PriceScale,
  TimeScale,
  computeTimeTicks,
  decimalsForStep,
  formatCompact,
  formatFullTime,
  formatPrice,
  formatTimeTickLabel,
  niceBarStep,
  niceStep,
} from './scales'

describe('TimeScale', () => {
  it('intervalMs is the minimum positive delta, robust to gaps', () => {
    const ts = new TimeScale()
    // A weekend gap (huge delta) must not raise intervalMs above the true
    // 1-minute cadence found elsewhere in the series.
    ts.setTimes([0, 60_000, 120_000, 120_000 + 3 * 86_400_000, 120_000 + 3 * 86_400_000 + 60_000])
    expect(ts.intervalMs).toBe(60_000)
  })

  it('appendTime folds one new delta in exactly like a full setTimes rescan', () => {
    const times = [0, 60_000, 90_000, 150_000] // includes a shorter 30s gap
    const bulk = new TimeScale()
    bulk.setTimes(times)

    const incremental = new TimeScale()
    incremental.setTimes(times.slice(0, 1))
    for (let i = 1; i < times.length; i++) incremental.appendTime(times[i])

    expect(incremental.intervalMs).toBe(bulk.intervalMs)
  })

  it('replaceLastTime overwrites only the last time, leaving intervalMs untouched', () => {
    const ts = new TimeScale()
    ts.setTimes([0, 60_000, 120_000])
    const before = ts.intervalMs
    ts.replaceLastTime(125_000) // an interim tick on the still-forming bar
    expect(ts.count).toBe(3)
    expect(ts.intervalMs).toBe(before)
  })

  it('indexToX / xToIndex are exact inverses', () => {
    const ts = new TimeScale()
    ts.plotWidth = 800
    ts.view = { start: 10, end: 90 }
    for (const index of [10, 25.5, 50, 89.9]) {
      expect(ts.xToIndex(ts.indexToX(index))).toBeCloseTo(index)
    }
  })

  it('timeToIndex / indexToTime round-trip within the loaded data', () => {
    const ts = new TimeScale()
    ts.setTimes([0, 60_000, 120_000, 180_000, 240_000])
    for (const t of [0, 30_000, 60_000, 150_000, 240_000]) {
      expect(ts.indexToTime(ts.timeToIndex(t))).toBeCloseTo(t, -1) // within a few ms (rounding)
    }
  })

  it('extrapolates uniformly outside the loaded range using intervalMs', () => {
    const ts = new TimeScale()
    ts.setTimes([0, 60_000, 120_000])
    expect(ts.timeToIndex(180_000)).toBeCloseTo(3) // one interval past the last bar
    expect(ts.timeToIndex(-60_000)).toBeCloseTo(-1) // one interval before the first bar
    expect(ts.indexToTime(3)).toBe(180_000)
    expect(ts.indexToTime(-1)).toBe(-60_000)
  })

  it('timeToX / xToTime are inverses (bar-center anchored)', () => {
    const ts = new TimeScale()
    ts.plotWidth = 500
    ts.setTimes([0, 60_000, 120_000, 180_000])
    ts.view = { start: 0, end: 4 }
    for (const t of [0, 60_000, 90_000, 180_000]) {
      expect(ts.xToTime(ts.timeToX(t))).toBeCloseTo(t, -1)
    }
  })

  it('visibleRange clamps to [0, count-1] and floors/ceils the viewport', () => {
    const ts = new TimeScale()
    ts.setTimes([0, 60_000, 120_000, 180_000, 240_000]) // count = 5, valid indices 0..4
    ts.view = { start: -10, end: 2.5 }
    expect(ts.visibleRange()).toEqual({ from: 0, to: 3 })
    ts.view = { start: 1.5, end: 100 }
    expect(ts.visibleRange()).toEqual({ from: 1, to: 4 })
  })
})

describe('PriceScale', () => {
  it('priceToY / yToPrice are inverses in linear mode', () => {
    const scale = new PriceScale(0, 400, 100, 200)
    for (const p of [100, 125, 150, 199.5, 200]) {
      expect(scale.yToPrice(scale.priceToY(p))).toBeCloseTo(p)
    }
    expect(scale.priceToY(100)).toBeCloseTo(scale.bottom) // min price -> bottom of pane
    expect(scale.priceToY(200)).toBeCloseTo(scale.top) // max price -> top of pane
  })

  it('priceToY / yToPrice are inverses in log mode', () => {
    const scale = new PriceScale(0, 400, 10, 1000, true)
    for (const p of [10, 31.6, 100, 316, 1000]) {
      expect(scale.yToPrice(scale.priceToY(p))).toBeCloseTo(p, 1)
    }
  })

  it('equal ON-SCREEN distances mean equal PERCENT moves in log mode', () => {
    const scale = new PriceScale(0, 400, 10, 1000, true)
    const y100 = scale.priceToY(100)
    const y200 = scale.priceToY(200) // a 2x move from 100
    const y10 = scale.priceToY(10)
    const y20 = scale.priceToY(20) // also a 2x move, from 10
    expect(y100 - y200).toBeCloseTo(y10 - y20)
  })

  it('ticks() stays within [min, max] and respects the edge margin', () => {
    const scale = new PriceScale(0, 300, 10, 20)
    const ticks = scale.ticks()
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(10)
      expect(t).toBeLessThanOrEqual(20)
      const y = scale.priceToY(t)
      expect(y).toBeGreaterThanOrEqual(scale.top + 8)
      expect(y).toBeLessThanOrEqual(scale.bottom - 8)
    }
  })

  it('ticks() never returns a step finer than minStep', () => {
    const scale = new PriceScale(0, 300, 0, 1)
    const ticks = scale.ticks(0.5)
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i] - ticks[i - 1]).toBeGreaterThanOrEqual(0.5 - 1e-9)
    }
  })

  it('ticks() returns [] for a zero-height pane', () => {
    expect(new PriceScale(0, 0, 10, 20).ticks()).toEqual([])
  })
})

describe('niceStep', () => {
  it('rounds up to 1/2/5 x a power of ten', () => {
    expect(niceStep(0.03)).toBeCloseTo(0.05)
    expect(niceStep(3)).toBe(5)
    expect(niceStep(6)).toBe(10)
    expect(niceStep(120)).toBe(200)
  })

  it('falls back to 1 for a non-positive or non-finite input', () => {
    expect(niceStep(0)).toBe(1)
    expect(niceStep(-5)).toBe(1)
    expect(niceStep(Infinity)).toBe(1)
    expect(niceStep(NaN)).toBe(1)
  })
})

describe('decimalsForStep', () => {
  it('matches the number of decimals a 1/2/5-step grid needs', () => {
    expect(decimalsForStep(1)).toBe(0)
    expect(decimalsForStep(0.1)).toBe(1)
    expect(decimalsForStep(0.05)).toBe(2)
    expect(decimalsForStep(0.001)).toBe(3)
  })

  it('clamps to [0, 8] and falls back to 2 for a bad input', () => {
    expect(decimalsForStep(0)).toBe(2)
    expect(decimalsForStep(-1)).toBe(2)
    expect(decimalsForStep(1e-12)).toBeLessThanOrEqual(8)
  })
})

describe('formatPrice', () => {
  it('fixes the precision and adds thousands separators', () => {
    expect(formatPrice(1234.5, 2)).toBe('1,234.50')
    expect(formatPrice(0, 0)).toBe('0')
  })

  it('returns an em dash for non-finite values', () => {
    expect(formatPrice(NaN, 2)).toBe('—')
    expect(formatPrice(Infinity, 2)).toBe('—')
  })
})

describe('formatCompact', () => {
  it('scales through K/M/B/T at the right thresholds', () => {
    expect(formatCompact(500)).toBe('500')
    expect(formatCompact(1_500)).toBe('1.50K')
    expect(formatCompact(2_500_000)).toBe('2.50M')
    expect(formatCompact(3_500_000_000)).toBe('3.50B')
    expect(formatCompact(4_500_000_000_000)).toBe('4.50T')
  })

  it('shows more precision below 100', () => {
    expect(formatCompact(0.5)).toBe('0.5000')
    expect(formatCompact(5)).toBe('5.00')
  })

  it('returns an em dash for non-finite values', () => {
    expect(formatCompact(NaN)).toBe('—')
  })
})

describe('niceBarStep', () => {
  it('returns the smallest 1/2/5 x 10^k integer >= minBars', () => {
    expect(niceBarStep(1)).toBe(1)
    expect(niceBarStep(3)).toBe(5)
    expect(niceBarStep(7)).toBe(10)
    expect(niceBarStep(45)).toBe(50)
  })
})

describe('computeTimeTicks', () => {
  it('returns [] when there is no usable bar spacing or plot width', () => {
    const ts = new TimeScale()
    ts.plotWidth = 0
    expect(computeTimeTicks(ts)).toEqual([])
  })

  it('places ticks on a nice bar-index grid, all inside the plot area', () => {
    const ts = new TimeScale()
    ts.plotWidth = 900
    ts.setTimes(Array.from({ length: 200 }, (_, i) => i * 60_000))
    ts.view = { start: 0, end: 200 }
    const ticks = computeTimeTicks(ts)
    expect(ticks.length).toBeGreaterThan(0)
    for (const t of ticks) {
      expect(t.x).toBeGreaterThanOrEqual(-1)
      expect(t.x).toBeLessThanOrEqual(ts.plotWidth + 1)
      expect(t.time).toBe(ts.indexToTime(t.index))
    }
    // Evenly spaced on a nice bar step (constant gap between consecutive indices).
    const gaps = new Set(ticks.slice(1).map((t, i) => t.index - ticks[i].index))
    expect(gaps.size).toBe(1)
  })
})

// formatTimeTickLabel / formatFullTime are fixed to IST (UTC+5:30) regardless
// of the host machine's timezone — 2024-01-01T00:00:00Z is 2024-01-01 05:30 IST.
describe('formatTimeTickLabel / formatFullTime (fixed IST)', () => {
  const jan1_0000Z = Date.UTC(2024, 0, 1, 0, 0, 0) // -> 05:30 IST
  const jan1_1830Z = Date.UTC(2024, 0, 1, 18, 30, 0) // -> Jan 2, 00:00 IST
  const dayMs = 86_400_000

  it('intraday: shows HH:MM in IST, unless the IST calendar day just changed', () => {
    expect(formatTimeTickLabel(jan1_0000Z, jan1_0000Z - 60_000, 60_000)).toBe('05:30')
    // Crossing into the next IST day prints "<date> <month>" instead of a bare time.
    expect(formatTimeTickLabel(jan1_1830Z, jan1_0000Z, 60_000)).toBe('2 Jan')
  })

  it('intraday with no previous tick always shows "<date> <month>"', () => {
    expect(formatTimeTickLabel(jan1_0000Z, null, 60_000)).toBe('1 Jan')
  })

  it('daily+ intervals show day, then month at month boundaries, then year at year boundaries', () => {
    const day1 = Date.UTC(2024, 0, 1)
    const day2 = Date.UTC(2024, 0, 2)
    const nextMonth = Date.UTC(2024, 1, 1)
    const nextYear = Date.UTC(2025, 0, 1)
    expect(formatTimeTickLabel(day2, day1, dayMs)).toBe('2')
    expect(formatTimeTickLabel(nextMonth, day1, dayMs)).toBe('Feb')
    expect(formatTimeTickLabel(nextYear, day1, dayMs)).toBe('2025')
  })

  it('formatFullTime includes time only for intraday intervals', () => {
    expect(formatFullTime(jan1_0000Z, 60_000)).toBe("Mon 1 Jan '24  05:30")
    expect(formatFullTime(jan1_0000Z, dayMs)).toBe("Mon 1 Jan '24")
  })
})
