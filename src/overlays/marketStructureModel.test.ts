import { describe, expect, it } from 'vitest'
import { computeMarketStructure, structureTrades, atrSeries, MS_DEFAULTS, type MsBar } from './marketStructureModel'

const T0 = Date.UTC(2026, 9, 6, 2) // Tuesday 02:00 UTC (Asia)
const MIN = 60_000

/** Bars walking a close path; each bar spans ±0.5 around its body, opens at the previous close. */
function path(closes: number[], start = T0, step = MIN): MsBar[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c
    return { time: start + i * step, open: o, high: Math.max(o, c) + 0.5, low: Math.min(o, c) - 0.5, close: c }
  })
}
const ramp = (from: number, to: number): number[] => {
  const out: number[] = []
  const s = Math.sign(to - from)
  for (let p = from + s; s > 0 ? p <= to : p >= to; p += s) out.push(p)
  return out
}
// up 10, down 5, up 10, down 5, up 10, then a 20-point drop through the last higher low
const closes = [100, ...ramp(100, 110), ...ramp(110, 105), ...ramp(105, 115), ...ramp(115, 110), ...ramp(110, 120), ...ramp(120, 100)]
const opts = { devAtr: 2, volLen: 20 }

describe('market structure', () => {
  const r = computeMarketStructure(path(closes), opts)

  it('labels higher highs / higher lows in an uptrend, then a lower low', () => {
    expect(r.swings.map((s) => s.label)).toEqual(['H', 'L', 'HH', 'HL', 'HH']) // the first bar is not a confirmed swing
    // swings sit on the turning points
    expect(r.swings.filter((s) => s.high).map((s) => s.price)).toEqual([110.5, 115.5, 120.5])
  })

  it('BOS while the trend continues, CHoCH when the last higher low breaks on a close', () => {
    const breaks = r.events.filter((e) => e.kind !== 'SWEEP').map((e) => `${e.kind}${e.dir > 0 ? '+' : '-'}@${e.level}`)
    expect(breaks).toEqual(['BOS+@110.5', 'BOS+@115.5', 'CHoCH-@109.5'])
    const choch = r.events.find((e) => e.kind === 'CHoCH')!
    expect(closes[choch.idx]).toBeLessThan(109.5)
    expect(closes[choch.idx - 1]).toBeGreaterThanOrEqual(109.5) // first close below
    // protected level of the bearish break = highest high since that swing low
    expect(choch.protectedLevel).toBe(120.5)
    expect(r.trend[r.trend.length - 1]).toBe(-1)
  })

  it('no look-ahead: a prefix of the data gives the same swings and events up to its end', () => {
    const bars = path(closes)
    for (const k of [20, 28, 37, 45]) {
      const p = computeMarketStructure(bars.slice(0, k), opts)
      expect(p.swings).toEqual(r.swings.filter((s) => s.confirmIdx < k))
      expect(p.events.map((e) => [e.kind, e.idx, e.level])).toEqual(r.events.filter((e) => e.idx < k).map((e) => [e.kind, e.idx, e.level]))
    }
  })

  it('a wick through a swing high that closes back below is a sweep, not a break', () => {
    const bars = path([100, ...ramp(100, 110), ...ramp(110, 104)])
    const swingHigh = 110.5
    // next bar spikes 2 above the high, closes back at 105
    bars.push({ time: bars[bars.length - 1].time + MIN, open: 104, high: swingHigh + 2, low: 103.5, close: 105 })
    const out = computeMarketStructure(bars, opts)
    const last = out.events[out.events.length - 1]
    expect(last).toMatchObject({ kind: 'SWEEP', dir: -1, level: swingHigh, protectedLevel: swingHigh + 2 })
    expect(out.events.some((e) => e.kind === 'BOS' && e.level === swingHigh)).toBe(false)
    // with wick breaks it is a BOS instead
    const wick = computeMarketStructure(bars, { ...opts, closeBreaks: false })
    expect(wick.events[wick.events.length - 1]).toMatchObject({ kind: 'BOS', dir: 1, level: swingHigh })
  })

  it('score: +1 Asia, −1 New York, ±1 volatility expansion / compression; session off at 1h+', () => {
    const flat = (start: number, step = MIN): MsBar[] => path(Array.from({ length: 150 }, (_, i) => 100 + (i % 2)), start, step)
    const asia = computeMarketStructure(flat(T0), { volLen: 100 })
    expect(asia.score[149]).toBe(1) // Asia, normal vol
    const ny = computeMarketStructure(flat(Date.UTC(2026, 9, 6, 13)), { volLen: 100 })
    expect(ny.score[149]).toBe(-1)
    expect(ny.regime[149]).toBe('chop')
    // volatility expansion in Asia -> +2
    const hot = flat(T0)
    for (let i = 140; i < 150; i++) hot[i] = { ...hot[i], high: hot[i].close + 4, low: hot[i].close - 4 }
    const h = computeMarketStructure(hot, { volLen: 100 })
    expect(h.volRatio[149]).toBeGreaterThan(MS_DEFAULTS.volExpand)
    expect(h.score[149]).toBe(2)
    expect(h.regime[149]).toBe('trend')
    // hourly bars: no session part, the trade threshold drops by one
    const hourly = computeMarketStructure(flat(T0, 3_600_000), { volLen: 100 })
    expect(hourly.sessionActive).toBe(false)
    expect(hourly.minScoreEff).toBe(MS_DEFAULTS.minScore - 1)
  })
})

describe('structureTrades', () => {
  const o = { ...MS_DEFAULTS, minScore: -9, targetR: 2 }
  const bars = path([100, 100, 101, 102, 103, 104, 105, 106, 107, 108])
  const atr = atrSeries(bars, 14)
  const ev = (idx: number, protectedLevel: number, score = 0) => ({ kind: 'BOS' as const, dir: 1 as const, idx, level: 101, fromIdx: 0, protectedLevel, protectedIdx: 0, score })

  it('enters next open, exits at the target in R', () => {
    // signal at bar 1 -> entry open of bar 2 = 100, stop 99 -> risk 1, target 102
    const [t] = structureTrades(bars, [ev(1, 99)], atr, o)
    expect(t).toMatchObject({ entry: 100, stop: 99, target: 102, exitReason: 'TP', r: 2 })
  })

  it('stop wins a bar that touches both; low scores and weekends are skipped; one position at a time', () => {
    const wide = path([100, 100, 100, 100])
    wide[2] = { ...wide[2], high: 105, low: 98 } // entry bar spans stop and target
    expect(structureTrades(wide, [ev(1, 99)], atrSeries(wide, 14), o)[0]).toMatchObject({ exitReason: 'SL', r: -1 })
    expect(structureTrades(bars, [ev(1, 99, 1)], atr, { ...o, minScore: 2 })).toHaveLength(0)
    const sat = path([100, 100, 101, 102, 103, 104], Date.UTC(2026, 9, 10, 2))
    expect(structureTrades(sat, [ev(1, 99)], atrSeries(sat, 14), o)).toHaveLength(0)
    // second signal before the first exits is ignored
    expect(structureTrades(bars, [ev(1, 99), ev(2, 99.5)], atr, o)).toHaveLength(1)
  })
})
