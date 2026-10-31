import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { computeFvgStrategy, FVG_STRATEGY_DEFAULTS, summarizeTrades, type FvgStrategyOptions, type FvgTrade } from './fvgStrategy'

const MIN = 60_000
const T0 = Date.UTC(2026, 0, 5) // a Monday, 00:00 UTC

function bar(i: number, open: number, high: number, low: number, close: number, step = MIN): Candle {
  return { time: T0 + i * step, open, high, low, close, volume: 1 }
}

function opts(patch: Partial<FvgStrategyOptions> = {}): FvgStrategyOptions {
  return { ...FVG_STRATEGY_DEFAULTS, ...patch }
}

describe('computeFvgStrategy — gap detection (source naming)', () => {
  it('creates a "bull" gap on a gap down after a bearish middle candle', () => {
    const c = [bar(0, 110, 112, 108, 109), bar(1, 108, 108, 100, 101), bar(2, 100, 104, 99, 103)]
    const r = computeFvgStrategy(c, opts())
    expect(r.gaps).toEqual([{ kind: 'bull', htf: false, top: 108, bottom: 104, mid: 106, startTime: c[2].time, endTime: null }])
  })

  it('creates a "bear" gap on a gap up after a non-bearish middle candle', () => {
    const c = [bar(0, 100, 102, 98, 101), bar(1, 101, 110, 101, 109), bar(2, 109, 112, 105, 111)]
    const r = computeFvgStrategy(c, opts())
    expect(r.gaps).toEqual([{ kind: 'bear', htf: false, top: 105, bottom: 102, mid: 103.5, startTime: c[2].time, endTime: null }])
  })

  it('removes a gap once fully filled, or freezes it when deleteOnFill is off', () => {
    const c = [bar(0, 110, 112, 108, 109), bar(1, 108, 108, 100, 101), bar(2, 100, 104, 99, 103), bar(3, 103, 109, 103, 108)]
    expect(computeFvgStrategy(c, opts()).gaps).toEqual([])
    const kept = computeFvgStrategy(c, opts({ deleteOnFill: false })).gaps
    expect(kept).toHaveLength(1)
    expect(kept[0].endTime).toBe(c[3].time)
  })

  it('HTF mode builds gaps from aggregated bars on the first bar of each new HTF bar', () => {
    const H = 3_600_000
    // Hourly HTF from 15m candles: HTF bar 0 = high 120/low 110, HTF bar 1 bearish, HTF bar 2 opens at 100 (< 110).
    const c: Candle[] = [
      bar(0, 115, 120, 110, 116, H / 4), bar(1, 116, 118, 112, 114, H / 4), bar(2, 114, 117, 111, 115, H / 4), bar(3, 115, 116, 111, 112, H / 4),
      bar(4, 112, 113, 104, 105, H / 4), bar(5, 105, 106, 102, 103, H / 4), bar(6, 103, 104, 101, 102, H / 4), bar(7, 102, 103, 100, 101, H / 4),
      bar(8, 100, 101, 99, 100, H / 4),
    ]
    const r = computeFvgStrategy(c, opts({ mtfMode: 'htf', htfTimeframe: '1h' }))
    expect(r.gaps).toEqual([{ kind: 'bull', htf: true, top: 110, bottom: 100, mid: 105, startTime: c[8].time, endTime: null }])
  })
})

describe('computeFvgStrategy — entries and exits', () => {
  it('only enters when flat, with Supertrend on the right side of close', () => {
    // Choppy synthetic series with gaps in both directions.
    const c: Candle[] = []
    let p = 100
    for (let i = 0; i < 400; i++) {
      const drift = Math.sin(i / 7) * 3 + Math.cos(i / 3) * 2
      const o = p
      p = Math.max(10, p + drift)
      c.push(bar(i, o, Math.max(o, p) + 1, Math.min(o, p) - 1, p))
    }
    const r = computeFvgStrategy(c, opts())
    expect(r.signals.length).toBeGreaterThan(0)
    // Signals alternate entry → exit, never two entries in a row (pyramiding=0).
    let inPos = false
    for (const s of r.signals) {
      const isEntry = s.type === 'buy' || s.type === 'sell'
      expect(isEntry).toBe(!inPos)
      inPos = isEntry
    }
    for (const t of r.trades) {
      const i = c.findIndex((k) => k.time === t.entryTime)
      const st = r.supertrend[i]
      if (t.side === 'long') expect(st.up && c[i].close > st.value).toBe(true)
      else expect(!st.up && c[i].close < st.value).toBe(true)
    }
  })
})

describe('summarizeTrades', () => {
  it('computes win rate, net % and profit factor over closed trades only', () => {
    const t = (pnlPct: number, closed = true): FvgTrade => ({ side: 'long', entryTime: 0, entryPrice: 1, exitTime: closed ? 1 : null, exitPrice: closed ? 1 : null, pnlPct })
    const s = summarizeTrades([t(2), t(-1), t(3), t(5, false)])
    expect(s.closed).toBe(3)
    expect(s.wins).toBe(2)
    expect(s.winRate).toBeCloseTo(66.67, 1)
    expect(s.netPct).toBe(4)
    expect(s.profitFactor).toBe(5)
    expect(s.open?.pnlPct).toBe(5)
  })
})
