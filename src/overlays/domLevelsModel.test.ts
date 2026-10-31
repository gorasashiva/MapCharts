import { describe, expect, it } from 'vitest'
import { classify, DOM_LEVEL_DEFAULTS, DomLevelTracker, findStopPools, trust, MATCH_WINDOW_MS } from './domLevelsModel'
import type { Candle } from '../core/types'

// A $100 market, 0.1 apart, ~$1,000 per level; a wall is 3 × the usual quote and at least $5,000.
// persistMs 0: walls are tracked on the first tick (the persistence rule has its own test).
const OPTS = { ...DOM_LEVEL_DEFAULTS, persistMs: 0, minWallUsd: 5_000, absorbUsd: 8_000, sweepUsd: 6_000, minRestMs: 10_000, nearPct: 0.0025 }
function tracker(extraBid?: [number, number], extraAsk?: [number, number], opts = OPTS) {
  const bids: [number, number][] = [], asks: [number, number][] = []
  for (let i = 0; i < 20; i++) {
    bids.push([+(99.9 - i * 0.1).toFixed(1), 10])
    asks.push([+(100.1 + i * 0.1).toFixed(1), 10])
  }
  if (extraBid) bids.push(extraBid)
  if (extraAsk) asks.push(extraAsk)
  const t = new DomLevelTracker(opts)
  t.onBook('snapshot', bids, asks, 0)
  t.tick(0)
  return t
}
const settle = (t: DomLevelTracker, at: number) => t.tick(at + MATCH_WINDOW_MS + 1)

describe('DOM levels — walls', () => {
  it('a level 3× the usual quote on its side becomes a tracked wall', () => {
    const t = tracker([99.0, 100]) // $9,900 against ~$1,000 neighbours
    expect([...t.live.keys()]).toEqual(['bid:99'])
    expect(t.typical).toBeGreaterThan(900)
    expect(classify(t.live.get('bid:99')!, 0, OPTS)).toBe('watch')
  })

  it('evenly large market-maker quotes are not walls', () => {
    const t = tracker([99.0, 25], [101.0, 28]) // big, but under 3× the usual quote
    expect(t.live.size).toBe(0)
  })

  it('a wall is tracked only after it has stayed one for persistMs, dated from when it appeared', () => {
    const t = tracker([99.0, 100], undefined, { ...OPTS, persistMs: 15_000 })
    expect(t.live.size).toBe(0)
    t.tick(10_000)
    expect(t.live.size).toBe(0)
    t.tick(15_000)
    expect(t.live.get('bid:99')?.born).toBe(0)
  })

  it('cancels while price is close are spoofing, and PULLED when the level collapses', () => {
    const t = tracker([99.8, 100]) // 0.2% from price
    t.onBook('update', [[99.8, 60]], [], 1000)
    settle(t, 1000)
    const r = t.live.get('bid:99.8')!
    expect(r.nearCancelled).toBeCloseTo(40 * 99.8)
    expect(classify(r, 2000, OPTS)).toBe('spoof')
    t.onBook('update', [[99.8, 0]], [], 2000)
    settle(t, 2000)
    expect(t.live.size).toBe(0)
    expect(t.ended[0]).toMatchObject({ status: 'pulled', kind: 'spoof' })
    expect(t.events[t.events.length - 1]).toMatchObject({ kind: 'pull', price: 99.8 })
  })

  it('a resync snapshot without a tracked level forgets it quietly', () => {
    const t = tracker([99.0, 100])
    const b: [number, number][] = [[99.9, 10]], a: [number, number][] = [[100.1, 10]]
    t.onBook('snapshot', b, a, 1000)
    settle(t, 1000)
    expect(t.live.size).toBe(0)
    expect(t.ended).toHaveLength(0)
    expect(t.events).toHaveLength(0)
  })

  it('thin one-tick levels do not lower the bar: the usual quote is weighted by dollars', () => {
    // 200 thin $10 levels around big $1,000 quotes: a $2,500 level is not a wall
    const t = tracker([99.05, 25], undefined, { ...OPTS, minWallUsd: 100 })
    const thin: [number, number][] = Array.from({ length: 200 }, (_, i) => [+(99.0 + i * 0.001).toFixed(3), 0.1] as [number, number])
    t.onBook('update', thin, [], 10)
    t.tick(10)
    expect([...t.live.keys()]).toEqual([])
  })

  it('a wall cancelled far from price was moved or withdrawn: forgotten quietly, no spoof, no event', () => {
    const t = tracker([99.0, 100]) // 1% away: outside 3 × nearPct
    t.onBook('update', [[99.0, 0]], [], 1000)
    settle(t, 1000)
    expect(t.live.size).toBe(0)
    expect(t.ended).toHaveLength(0)
    expect(t.events).toHaveLength(0)
  })

  it('a drop matched by trades is a fill — even when the trade prints after the book update', () => {
    const t = tracker([99.0, 100])
    t.onBook('update', [[99.0, 70]], [], 1000)
    t.onTrade(1100, 99.0, 30, false) // taker sell into the bid, 100ms later
    settle(t, 1000)
    const r = t.live.get('bid:99')!
    expect(r.filled).toBeCloseTo(30 * 99)
    expect(r.cancelled).toBeCloseTo(0)
  })

  it('a wall that sits and is approached is real; trust grows with time', () => {
    const t = tracker([99.8, 100])
    const r = t.live.get('bid:99.8')!
    r.near = false // price arrives
    t.tick(12_000)
    expect(r.approaches).toBe(1)
    expect(classify(r, 12_000, OPTS)).toBe('real')
    expect(trust(r, 'real', 120_000)).toBeGreaterThan(trust(r, 'real', 12_000))
  })

  it('refills right after trades, and more traded than ever shown, make an iceberg', () => {
    const t = tracker([99.0, 100])
    for (let i = 0; i < 3; i++) {
      const at = 1000 + i * 1000
      t.onTrade(at, 99.0, 50, false)
      t.onBook('update', [[99.0, 50]], [], at + 10)
      t.onBook('update', [[99.0, 100]], [], at + 20) // topped straight back up
    }
    const r = t.live.get('bid:99')!
    expect(r.refills).toBe(3)
    expect(r.traded).toBeGreaterThan(r.maxVis * 1.1)
    expect(classify(r, 4000, OPTS)).toBe('iceberg')
  })

  it('heavy buying into an ask wall that holds is reported once: sellers absorbed', () => {
    const t = tracker(undefined, [101.0, 100])
    for (let i = 0; i < 10; i++) t.onTrade(1000 + i, 101.0, 10, true) // $10,100 of taker buys
    const ev = t.events.filter((e) => e.kind === 'absorb')
    expect(ev).toHaveLength(1)
    expect(ev[0].side).toBe('ask')
  })

  it('a wall traded away ends as TAKEN, not pulled', () => {
    const t = tracker([99.0, 100])
    t.onTrade(1000, 99.0, 95, false)
    t.onBook('update', [[99.0, 0]], [], 1001)
    settle(t, 1001)
    expect(t.ended[0].status).toBe('taken')
    expect(t.events[t.events.length - 1]?.kind).toBe('taken')
  })
})

describe('DOM levels — absorption anywhere and levels still being watched', () => {
  it('heavy selling into the best bid that keeps refilling and holds is absorption, with no wall needed', () => {
    const t = tracker()
    for (let i = 0; i < 9; i++) {
      const at = 1000 + i * 100
      t.onTrade(at, 99.9, 10, false) // $999 each
      t.onBook('update', [[99.9, 5]], [], at + 10)
      t.onBook('update', [[99.9, 10]], [], at + 20) // refilled
    }
    const ev = t.events.filter((e) => e.kind === 'absorb')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ price: 99.9, side: 'bid' }) // buyers absorbed the selling
    expect(ev[0].value).toBeGreaterThanOrEqual(8_000)
  })

  it('no absorption when the price gives way', () => {
    const t = tracker()
    for (let i = 0; i < 9; i++) t.onTrade(1000 + i * 100, 99.9, 10, false)
    t.onBook('update', [[99.9, 0]], [], 2000)
    expect(t.events.filter((e) => e.kind === 'absorb')).toHaveLength(0)
  })

  const WATCH = { ...OPTS, persistMs: 15_000 }

  it('a big level cancelled near price before it is confirmed: a tentative PULLED', () => {
    const t = tracker([99.8, 100], undefined, WATCH)
    t.tick(6000)
    expect(t.live.size).toBe(0) // still only being watched
    t.onBook('update', [[99.8, 0]], [], 6000)
    t.tick(6000)
    settle(t, 6000)
    expect(t.events).toEqual([expect.objectContaining({ kind: 'pull', price: 99.8, tentative: true })])
  })

  it('a big level traded away before it is confirmed: a tentative TAKEN, even far from price', () => {
    const t = tracker([99.0, 100], undefined, WATCH)
    t.tick(6000)
    t.onBook('update', [[99.0, 0]], [], 6000)
    t.tick(6000)
    t.onTrade(6100, 99.0, 60, false) // the trades arrive after the book update
    settle(t, 6000)
    expect(t.events).toEqual([expect.objectContaining({ kind: 'taken', price: 99, tentative: true })])
  })

  it('a big level withdrawn far from price, or one that flickered for under 5s, leaves no marker', () => {
    const far = tracker([99.0, 100], undefined, WATCH)
    far.tick(6000)
    far.onBook('update', [[99.0, 0]], [], 6000)
    far.tick(6000)
    settle(far, 6000)
    const flicker = tracker([99.8, 100], undefined, WATCH)
    flicker.tick(2000)
    flicker.onBook('update', [[99.8, 0]], [], 2000)
    flicker.tick(2000)
    settle(flicker, 2000)
    expect([...far.events, ...flicker.events]).toHaveLength(0)
  })
})

describe('DOM levels — stop pools', () => {
  const bar = (i: number, h: number): Candle => ({ time: Date.UTC(2026, 9, 30, 10, i), open: h - 1, high: h, low: h - 2, close: h - 1, volume: 1 })

  it('finds untouched swing highs/lows and the round numbers either side, nearest first', () => {
    const highs = [100, 101, 102, 105, 102, 101, 100, 99, 100, 101, 100, 99, 98, 99]
    const pools = findStopPools(highs.map((h, i) => bar(i, h)), 100.5, 10)
    expect(pools.filter((p) => p.side === 'above').map((p) => [p.price, p.why])).toEqual([[101, 'swing high'], [105, 'swing high']])
    // the 97 swing low (bar 7) was taken out by bar 12's low of 96, so only the round number remains
    expect(pools.filter((p) => p.side === 'below').map((p) => [p.price, p.why])).toEqual([[100, 'round number']])
  })

  it('a swing level traded through later is spent', () => {
    const highs = [100, 101, 102, 105, 102, 101, 100, 106, 100, 99, 98, 97, 96, 95]
    expect(findStopPools(highs.map((h, i) => bar(i, h)), 100.5, 10).some((p) => p.price === 105)).toBe(false)
  })

  it('crossing a pool with a burst of same-side market orders is a sweep; without one it is just crossed', () => {
    const t = tracker()
    t.setPools([{ price: 100.5, side: 'above', why: 'swing high', trust: 52 }, { price: 99.5, side: 'below', why: 'swing low', trust: 52 }], 0)
    for (let i = 0; i < 4; i++) t.onTrade(5000 + i * 100, 100.4, 20, true)
    t.onTrade(5500, 100.6, 20, true) // ~$10,000 of buys inside a second
    expect(t.endedPools[0]).toMatchObject({ status: 'swept', side: 'above' })
    expect(t.events[t.events.length - 1]?.kind).toBe('sweepUp')
    t.onTrade(9000, 99.4, 1, false)
    expect(t.endedPools[0]).toMatchObject({ status: 'crossed', side: 'below' })
    expect(t.pools).toHaveLength(0)
    // a crossed or swept price is not offered again for 30 minutes
    t.setPools([{ price: 100.5, side: 'below', why: 'round number', trust: 46 }, { price: 98, side: 'below', why: 'swing low', trust: 52 }], 10_000)
    expect(t.pools.map((p) => p.price)).toEqual([98])
  })
})
