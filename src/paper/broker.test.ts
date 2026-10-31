import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { computeReport } from '../strategy/metrics'
import { DEFAULT_STRATEGY_PROPERTIES } from '../strategy/types'
import { PaperBroker } from './broker'
import { DELTA_INDIA_FEES } from './types'

const MIN = 60_000
const T0 = Date.UTC(2026, 0, 5)
const bar = (i: number, open: number, high: number, low: number, close: number): Candle => ({ time: T0 + i * MIN, open, high, low, close, volume: 1 })

/** BTCUSD-like: 0.001 BTC per contract, Delta India fees, 10k capital, 10× leverage. */
const broker = (o: Partial<{ balance: number; leverage: number }> = {}): PaperBroker =>
  new PaperBroker({ balance: o.balance ?? 10_000, leverage: o.leverage ?? 10, fees: DELTA_INDIA_FEES, contractValue: 0.001 })

describe('PaperBroker', () => {
  it('charges Delta India taker fee + 18% GST on contract notional', () => {
    const b = broker()
    b.onBar(bar(0, 50_000, 50_000, 50_000, 50_000))
    expect(b.market('buy', 100)).toEqual({ ok: true })
    // 100 contracts × 0.001 × 50,000 = 5,000 notional; 0.05% = 2.5; +18% GST = 2.95
    expect(b.feesPaid).toBeCloseTo(2.95, 10)
    expect(b.position).toMatchObject({ side: 'long', qty: 100, avgPrice: 50_000 })
    expect(b.usedMargin()).toBeCloseTo(500, 10)
  })

  it('books a round trip and agrees with the Strategy Tester metrics', () => {
    const b = broker()
    const candles = [bar(0, 50_000, 50_000, 50_000, 50_000), bar(1, 50_000, 51_200, 49_900, 51_000)]
    b.onBar(candles[0])
    b.market('buy', 100)
    b.onBar(candles[1])
    expect(b.unrealized()).toBeCloseTo(100, 10)
    b.closePosition()
    const exitFee = 100 * 0.001 * 51_000 * 0.0005 * 1.18
    expect(b.balance).toBeCloseTo(10_000 + 100 - 2.95 - exitFee, 8)
    expect(b.trades).toHaveLength(1)
    expect(b.trades[0].fees).toBeCloseTo(2.95 + exitFee, 10)

    const r = computeReport({ trades: b.trades, candles, from: 0, to: Infinity, props: { ...DEFAULT_STRATEGY_PROPERTIES, initialCapital: 10_000 } })
    expect(r.all.netProfit).toBeCloseTo(b.balance - 10_000, 8)
    expect(r.all.commission).toBeCloseTo(b.feesPaid, 10)
  })

  it('never fills a working order on the bar it was placed on', () => {
    const b = broker()
    b.onBar(bar(0, 100, 100, 100, 100))
    b.place('buy', 'limit', 10, 99)
    b.onBar(bar(0, 100, 100, 98, 99)) // same bar re-fed (e.g. live update) — no fill
    expect(b.position).toBeNull()
    b.onBar(bar(1, 100, 100, 98.5, 99))
    expect(b.position).toMatchObject({ side: 'long', qty: 10, avgPrice: 99 })
    expect(b.fills[0].liquidity).toBe('maker')
    expect(b.fills[0].fee).toBeCloseTo(10 * 0.001 * 99 * 0.0002 * 1.18, 12)
  })

  it('fills at the open when a bar gaps through the price', () => {
    const b = broker()
    b.onBar(bar(0, 100, 100, 100, 100))
    b.market('buy', 10, { stop: 95 })
    b.onBar(bar(1, 90, 92, 88, 91)) // gapped below the stop
    expect(b.position).toBeNull()
    expect(b.trades[0]).toMatchObject({ exitPrice: 90, exitReason: 'SL', stop: 95 })
  })

  it('takes the stop when one bar reaches both stop and target', () => {
    const b = broker()
    b.onBar(bar(0, 100, 100, 100, 100))
    b.market('sell', 10, { stop: 105, target: 95 })
    b.onBar(bar(1, 100, 106, 94, 100))
    expect(b.trades[0]).toMatchObject({ side: 'short', exitPrice: 105, exitReason: 'SL' })
  })

  it('pays maker on a target fill', () => {
    const b = broker()
    b.onBar(bar(0, 100, 100, 100, 100))
    b.market('buy', 10, { target: 110 })
    b.onBar(bar(1, 100, 111, 99, 108))
    expect(b.trades[0]).toMatchObject({ exitPrice: 110, exitReason: 'TP' })
    expect(b.fills[1].liquidity).toBe('maker')
  })

  it('rejects orders that need more margin than is free', () => {
    const b = broker({ balance: 100, leverage: 5 })
    b.onBar(bar(0, 50_000, 50_000, 50_000, 50_000))
    // 20 contracts = 1,000 notional → 200 margin at 5×, more than 100 free
    const r = b.market('buy', 20)
    expect(r.ok).toBe(false)
    expect(b.fills).toHaveLength(0)
    expect(b.market('buy', 5).ok).toBe(true)
  })

  it('splits partial closes and reversals into separate trades', () => {
    const b = broker()
    b.onBar(bar(0, 100, 100, 100, 100))
    b.market('buy', 10)
    b.onBar(bar(1, 100, 110, 100, 110))
    b.market('sell', 4) // partial close
    expect(b.position).toMatchObject({ side: 'long', qty: 6 })
    expect(b.trades[0]).toMatchObject({ qty: 4 * 0.001, exitPrice: 110 })
    b.reverse() // sell 12 → close 6, open short 6
    expect(b.trades).toHaveLength(2)
    expect(b.position).toMatchObject({ side: 'short', qty: 6, avgPrice: 110 })
    const allFees = b.trades.reduce((a, t) => a + (t.fees ?? 0), 0) + b.position!.entryFees
    expect(allFees).toBeCloseTo(b.feesPaid, 12)
  })

  it('flattens and cancels everything at session end', () => {
    const b = broker()
    b.onBar(bar(0, 100, 100, 100, 100))
    b.market('buy', 10)
    b.place('sell', 'limit', 10, 120)
    b.closeAll('Replay end')
    expect(b.position).toBeNull()
    expect(b.orders).toHaveLength(0)
    expect(b.trades[0].exitReason).toBe('Replay end')
  })
})
