import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { MTF_CISD_DEFAULTS, computeMtfCisd, resample, runCisdEngine } from './mtfCisdModel'

const MIN = 60_000

/** Zigzag series: alternating legs so swings, breaks and opposite-close runs all occur. */
function series(n: number, stepMs = 5 * MIN): Candle[] {
  const out: Candle[] = []
  let p = 100
  for (let i = 0; i < n; i++) {
    const leg = Math.floor(i / 12) % 2 === 0 ? 1 : -1
    const open = p
    const close = p + leg * (1 + (i % 3) * 0.3) + (i % 48 === 0 ? 3 : 0)
    out.push({ time: i * stepMs, open, high: Math.max(open, close) + 0.4, low: Math.min(open, close) - 0.4, close, volume: 1 })
    p = close
  }
  return out
}

describe('mtfCisdModel', () => {
  it('finds MSS and CISD events with origin before the break', () => {
    const { events, state } = runCisdEngine(series(400), 300, MTF_CISD_DEFAULTS)
    expect(events.some((e) => e.kind === 'MSS')).toBe(true)
    expect(events.some((e) => e.kind === 'CISD')).toBe(true)
    for (const e of events) expect(e.originTime).toBeLessThan(e.time)
    expect(state.mDir).not.toBe(0)
  })

  it('resamples onto higher timeframes keeping OHLC', () => {
    const bars = series(24) // 2h of 5m bars
    const h = resample(bars, 3600)
    expect(h).toHaveLength(2)
    expect(h[0].open).toBe(bars[0].open)
    expect(h[0].close).toBe(bars[11].close)
    expect(h[0].high).toBe(Math.max(...bars.slice(0, 12).map((b) => b.high)))
  })

  it('marks timeframes below the chart as unavailable', () => {
    const r = computeMtfCisd(series(400), [60, 300, 3600], MTF_CISD_DEFAULTS, 300)
    expect(r.tfs.map((t) => t.available)).toEqual([false, true, true])
  })
})
