import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { computeReport, tradesCsv } from './metrics'
import { DEFAULT_STRATEGY_PROPERTIES, type StrategyProperties, type StrategyTrade } from './types'

const MIN = 60_000
const T0 = Date.UTC(2026, 0, 5)

/** 100 flat 1m candles at 100 (high 101 / low 99), then one at 110 for open-trade marks. */
function candles(): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < 100; i++) out.push({ time: T0 + i * MIN, open: 100, high: 101, low: 99, close: 100, volume: 1 })
  out.push({ time: T0 + 100 * MIN, open: 100, high: 111, low: 100, close: 110, volume: 1 })
  return out
}

const at = (i: number): number => T0 + i * MIN

function trade(side: 'long' | 'short', e: number, ep: number, x: number | null, xp: number | null, stop?: number): StrategyTrade {
  return { side, entryTime: at(e), entryPrice: ep, exitTime: x === null ? null : at(x), exitPrice: xp, stop }
}

const props = (p: Partial<StrategyProperties> = {}): StrategyProperties => ({ ...DEFAULT_STRATEGY_PROPERTIES, ...p })

describe('computeReport', () => {
  const trades = [
    trade('long', 10, 100, 20, 110, 95), // +10, +2R, 10 bars
    trade('short', 30, 100, 35, 104, 102), // −4, −2R, 5 bars
    trade('long', 40, 100, 50, 106), // +6, no stop, 10 bars
    trade('short', 60, 100, 70, 97, 101), // +3, +3R, 10 bars
  ]

  it('splits All / Long / Short and computes the headline numbers', () => {
    const r = computeReport({ trades, candles: candles(), from: 0, to: Infinity, props: props() })
    expect(r.all).toMatchObject({ closed: 4, wins: 3, losses: 1, netProfit: 15, grossProfit: 19, grossLoss: -4, winRate: 75 })
    expect(r.all.profitFactor).toBeCloseTo(19 / 4, 10)
    expect(r.long).toMatchObject({ closed: 2, netProfit: 16, wins: 2 })
    expect(r.short).toMatchObject({ closed: 2, netProfit: -1, wins: 1, losses: 1 })
    expect(r.all.netPct).toBeCloseTo((15 / 10_000) * 100, 10)
    expect(r.all.largestWin).toBe(10)
    expect(r.all.largestLoss).toBe(-4)
    expect(r.all.maxConsecWins).toBe(2)
    expect(r.all.maxConsecLosses).toBe(1)
    expect(r.all.avgBars).toBeCloseTo(8.75, 10)
  })

  it('reports R only for trades with a stop', () => {
    const r = computeReport({ trades, candles: candles(), from: 0, to: Infinity, props: props() })
    expect(r.rows.map((x) => x.r)).toEqual([2, -2, null, 3])
    expect(r.all.netR).toBe(3)
    expect(r.all.avgR).toBe(1)
  })

  it('filters by entry time and keeps equity / drawdown in exit order', () => {
    const r = computeReport({ trades, candles: candles(), from: at(25), to: at(55), props: props() })
    expect(r.rows.map((x) => x.trade.entryTime)).toEqual([at(30), at(40)])
    expect(r.equity.map((p) => p.equity)).toEqual([10_000, 9_996, 10_002])
    expect(r.maxDrawdown).toBe(-4)
    expect(r.maxRunUp).toBe(6)
    expect(r.rows.map((x) => x.cumPnl)).toEqual([-4, 2])
  })

  it('applies quantity, slippage and commission to every fill', () => {
    const one = [trade('long', 10, 100, 20, 110)]
    const r = computeReport({ trades: one, candles: candles(), from: 0, to: Infinity, props: props({ qty: 2, slippage: 0.5, commissionPct: 0.1 }) })
    // fills 100.5 → 109.5, gross 9 × 2 = 18; commission (100.5 + 109.5) × 2 × 0.001 = 0.42
    expect(r.rows[0].commission).toBeCloseTo(0.42, 10)
    expect(r.rows[0].pnl).toBeCloseTo(17.58, 10)
    expect(r.all.commission).toBeCloseTo(0.42, 10)
  })

  it('marks an open trade to the last close and keeps it out of closed stats', () => {
    const r = computeReport({ trades: [trade('long', 90, 100, null, null, 95)], candles: candles(), from: 0, to: Infinity, props: props() })
    expect(r.all.closed).toBe(0)
    expect(r.all.open).toBe(1)
    expect(r.all.openPnl).toBe(10)
    expect(r.rows[0].r).toBe(2)
    expect(r.rows[0].runUp).toBe(11) // high 111 on the last candle
    expect(r.equity).toHaveLength(1)
  })

  it('computes buy & hold over the candles in range', () => {
    const r = computeReport({ trades: [], candles: candles(), from: 0, to: Infinity, props: props() })
    expect(r.buyHoldPct).toBeCloseTo(10, 10)
    expect(r.all.closed).toBe(0)
    expect(Number.isNaN(r.all.winRate)).toBe(true)
  })

  it('exports one CSV line per trade, quoting fields that need it', () => {
    const r = computeReport({ trades, candles: candles(), from: 0, to: Infinity, props: props() })
    const lines = tradesCsv(r, 'Test, "quoted"', 'BTCUSD').split('\n')
    expect(lines).toHaveLength(5)
    expect(lines[1]).toContain('"Test, ""quoted"""')
  })
})
