import { describe, expect, it } from 'vitest'
import { DomSession, marketSetup, ADVICE_EVERY_MS, domWindows, horizonFor } from './domSession'

const SETUP = { ...marketSetup('TEST'), minWallUsd: 100, absorbUsd: 500, persistMs: 0 }

/** A deterministic little market: a $100 book with trades hitting both sides, quotes refilling. */
function run(s: DomSession, untilMs: number): string[] {
  const out: string[] = []
  const bids: [number, number][] = [], asks: [number, number][] = []
  for (let i = 0; i < 20; i++) {
    bids.push([+(99.9 - i * 0.1).toFixed(1), 10])
    asks.push([+(100.1 + i * 0.1).toFixed(1), 10])
  }
  s.onBook('snapshot', bids, asks, 0)
  for (let t = 250; t <= untilMs; t += 250) {
    if (t % 300 === 0 || t % 750 === 0) {
      const buy = Math.floor(t / 7000) % 2 === 0
      s.onTrade(buy ? 100.1 : 99.9, 2 + (t % 5), buy, t)
      // the hit quote shrinks, then refills
      s.onBook('update', buy ? [] : [[99.9, 5]], buy ? [[100.1, 5]] : [], t + 1)
      s.onBook('update', buy ? [] : [[99.9, 10]], buy ? [[100.1, 10]] : [], t + 2)
    }
    if (s.tick(t)) out.push(`${t}:${s.shownBias}:${s.advice?.score ?? 0}`)
  }
  return out
}

describe('DOM session — the replayable brain', () => {
  it('the same stream gives the same readings and markers, every time (replay = live)', () => {
    const a = new DomSession(SETUP, 0), b = new DomSession(SETUP, 0)
    expect(run(a, 6 * 60_000)).toEqual(run(b, 6 * 60_000))
    expect(a.tracker.events.map((e) => [e.t, e.kind, e.side])).toEqual(b.tracker.events.map((e) => [e.t, e.kind, e.side]))
    expect(a.tracker.events.some((e) => e.kind === 'absorb')).toBe(true)
  })

  it('re-evaluates the reading every 2 seconds and stands aside through the 3-minute warm-up', () => {
    const s = new DomSession(SETUP, 0)
    const readings = run(s, 60_000)
    expect(readings).toHaveLength(60_000 / ADVICE_EVERY_MS)
    expect(readings.every((r) => r.includes(':neutral:'))).toBe(true)
    expect(s.advice?.cautions[0]).toMatch(/Still reading the book/)
  })

  it('builds its own 1m candles from trades when none are handed in', () => {
    const s = new DomSession(SETUP, 0)
    s.onTrade(100, 1, true, 10_000)
    s.onTrade(101, 1, true, 20_000)
    s.onTrade(99, 2, false, 50_000)
    s.onTrade(100.5, 1, true, 70_000)
    expect(s.candles.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume])).toEqual([
      [0, 100, 101, 99, 99, 4],
      [60_000, 100.5, 100.5, 100.5, 100.5, 1],
    ])
    expect(s.poolCandles).toHaveLength(1)
  })

  it('uses candles handed in instead, as the live dashboard does', () => {
    const given = [{ time: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 }]
    const s = new DomSession(SETUP, 0, { candles: () => given })
    s.onTrade(100, 1, true, 10_000)
    expect(s.candles).toBe(given)
  })
})

describe('DOM session — trade horizon', () => {
  it('maps the chart timeframe to a supported horizon (1m … 1h)', () => {
    expect(horizonFor(1_000)).toBe(60_000)
    expect(horizonFor(300_000)).toBe(300_000)
    expect(horizonFor(7_200_000)).toBe(3_600_000)
  })

  it('at 1m keeps the original windows; longer horizons count the same bars, capped at the 2h of kept events', () => {
    expect(domWindows(60_000)).toMatchObject({ flowMs: 180_000, absorbMs: 600_000, sweepMs: 900_000, absorbLevelMs: 1_800_000, holdMs: 10_000, warmupMs: 180_000, expireMs: 1_800_000 })
    expect(domWindows(900_000)).toMatchObject({ flowMs: 2_700_000, absorbMs: 7_200_000, holdMs: 150_000, warmupMs: 1_800_000, expireMs: 27_000_000 })
  })

  it('reads the typical move off horizon candles, and switching horizon keeps the book', () => {
    const c = (time: number, range: number) => ({ time, open: 100, high: 100 + range / 2, low: 100 - range / 2, close: 100, volume: 1 })
    const m1 = Array.from({ length: 40 }, (_, i) => c(i * 60_000, 0.2))
    const m15 = Array.from({ length: 40 }, (_, i) => c(i * 900_000, 2))
    const s = new DomSession(SETUP, 0, { candles: () => m1, poolCandles: () => [], horizonCandles: () => m15 })
    run(s, 4000)
    expect(s.advisorInput(4000)!.typicalMove).toBeCloseTo(0.2)
    s.setHorizon(900_000)
    expect(s.advisorInput(4000)!.typicalMove).toBeCloseTo(2)
    expect(s.advisorInput(4000)!.warmupMs).toBe(1_800_000)
    expect(s.tracker.mid).toBeGreaterThan(0)
  })
})
