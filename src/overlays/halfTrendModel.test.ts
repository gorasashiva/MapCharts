import { describe, expect, it } from 'vitest'
import { computeHalfTrend, HALF_TREND_DEFAULTS, type HalfTrendBar } from './halfTrendModel'

const bar = (close: number, spread = 1): HalfTrendBar => ({ high: close + spread, low: close - spread, close })

/** `n` bars rising then `n` falling, then rising again — two clear flips once ATR(100) exists. */
function zigzag(n: number, step = 2, start = 1000): HalfTrendBar[] {
  const out: HalfTrendBar[] = []
  let p = start
  for (let i = 0; i < n; i++) out.push(bar((p += step)))
  for (let i = 0; i < n; i++) out.push(bar((p -= step)))
  for (let i = 0; i < n; i++) out.push(bar((p += step)))
  return out
}

describe('computeHalfTrend', () => {
  it('returns one point per bar and handles empty input', () => {
    expect(computeHalfTrend([])).toHaveLength(0)
    expect(computeHalfTrend(zigzag(60))).toHaveLength(180)
  })

  it('has no channel and no signals before ATR(100) is available', () => {
    const pts = computeHalfTrend(zigzag(30))
    expect(pts.slice(0, 99).every((p) => isNaN(p.atrHigh) && isNaN(p.atrLow))).toBe(true)
    expect(pts.slice(0, 99).some((p) => p.buy || p.sell)).toBe(false)
  })

  it('flips down on the fall and back up on the rise, signalling once each', () => {
    const pts = computeHalfTrend(zigzag(120))
    const sells = pts.flatMap((p, i) => (p.sell ? [i] : []))
    const buys = pts.flatMap((p, i) => (p.buy ? [i] : []))
    expect(sells).toHaveLength(1)
    expect(buys).toHaveLength(1)
    expect(sells[0]).toBeGreaterThan(120)
    expect(sells[0]).toBeLessThan(130)
    expect(buys[0]).toBeGreaterThan(240)
    expect(buys[0]).toBeLessThan(250)
    expect(pts[sells[0]].trend).toBe(1)
    expect(pts[buys[0]].trend).toBe(0)
  })

  it('ratchets: never falls in an uptrend, never rises in a downtrend', () => {
    const pts = computeHalfTrend(zigzag(120))
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].trend !== pts[i - 1].trend) continue
      if (pts[i].trend === 0) expect(pts[i].ht).toBeGreaterThanOrEqual(pts[i - 1].ht)
      else expect(pts[i].ht).toBeLessThanOrEqual(pts[i - 1].ht)
    }
  })

  it('channel sits channelDeviation × ATR/2 either side of the line', () => {
    const pts = computeHalfTrend(zigzag(120), { ...HALF_TREND_DEFAULTS, channelDeviation: 3 })
    const p = pts[200]
    const half = (p.atrHigh - p.atrLow) / 2
    expect(p.atrHigh - p.ht).toBeCloseTo(half, 9)
    expect(p.ht - p.atrLow).toBeCloseTo(half, 9)
  })

  it('a flip starts the new line from the old one, like the Pine source', () => {
    const pts = computeHalfTrend(zigzag(120))
    const s = pts.findIndex((p) => p.sell)
    expect(pts[s].ht).toBe(pts[s - 1].ht)
  })
})
