import { describe, expect, it } from 'vitest'
import { advise, AdvisorRecord, scoreFactors, type AdvisorInput } from './domAdvisorModel'

// Price 100, a typical 1-minute move of 0.20, ten minutes of book watched, nothing happening.
const QUIET: AdvisorInput = {
  now: 1_000_000,
  price: 100,
  watchedMs: 10 * 60_000,
  stale: false,
  typicalMove: 0.2,
  absorbBuyers: 0,
  absorbSellers: 0,
  absorbUnit: 1000,
  flowBuy: 0,
  flowSell: 0,
  priceChange: 0,
  bidShare: 0.5,
  bidShareAvg: 0.5,
  sweeps: [],
  pulledBids: 0,
  pulledAsks: 0,
  supports: [],
  resistances: [],
}
// Buyers soaking up heavy selling just above a wall, with room up to a GEX level.
const BULLISH: AdvisorInput = {
  ...QUIET,
  absorbBuyers: 3000,
  flowBuy: 1000,
  flowSell: 5000,
  supports: [{ price: 99.9, label: 'REAL WALL', strength: 80 }],
  resistances: [{ price: 100.8, label: 'GEX R1', strength: 70 }],
}
const BEARISH: AdvisorInput = {
  ...QUIET,
  absorbSellers: 3000,
  flowBuy: 5000,
  flowSell: 1000,
  supports: [{ price: 99.2, label: 'GEX S1', strength: 70 }],
  resistances: [{ price: 100.1, label: 'REAL WALL', strength: 80 }],
}

describe('DOM advisor — readings', () => {
  it('buyers absorbing failed selling just above support: LOOK FOR LONGS, with a plan off the wall', () => {
    const a = advise(BULLISH)
    expect(a.headline).toBe('LOOK FOR LONGS')
    expect(a.score).toBeGreaterThan(50)
    expect(a.cautions).toEqual([])
    expect(a.factors.map((f) => f.name)).toEqual(['Absorption', 'Flow vs price', 'Location'])
    expect(a.plan).toMatchObject({ zoneFrom: 'REAL WALL', targetFrom: 'GEX R1', target: 100.8 })
    expect(a.plan!.zone[0]).toBeCloseTo(99.9)
    expect(a.plan!.stop).toBeCloseTo(99.75)
    expect(a.plan!.rr).toBeGreaterThan(3)
  })

  it('the mirror image is LOOK FOR SHORTS', () => {
    const a = advise(BEARISH)
    expect(a.headline).toBe('LOOK FOR SHORTS')
    expect(a.plan!.stop).toBeGreaterThan(100.1)
    expect(a.plan!.target).toBe(99.2)
  })

  it('nothing happening: STAND ASIDE', () => {
    const a = advise(QUIET)
    expect(a.headline).toBe('STAND ASIDE')
    expect(a.cautions).toContain('Nothing notable in the order flow yet')
    expect(a.plan).toBeNull()
  })

  it('a good reading still stands aside while warming up, on a stale feed, or without room to the target', () => {
    expect(advise({ ...BULLISH, watchedMs: 60_000 }).cautions[0]).toMatch(/Still reading the book/)
    expect(advise({ ...BULLISH, stale: true }).bias).toBe('neutral')
    const cramped = advise({ ...BULLISH, resistances: [{ price: 100.2, label: 'REAL WALL', strength: 80 }] })
    expect(cramped.bias).toBe('neutral')
    expect(cramped.cautions.join()).toMatch(/Not enough room/)
  })

  it('strong evidence both ways is conflicted', () => {
    const a = advise({ ...BULLISH, sweeps: [{ dir: 'up', price: 100.1, t: QUIET.now - 120_000, reclaimed: true }] })
    expect(a.bias).toBe('neutral')
    expect(a.cautions).toContain('Strong signals on both sides — conflicted')
  })

  it('a sweep price reclaims reads as a reversal; one it holds beyond as continuation; a fresh one says wait', () => {
    const at = (reclaimed: boolean, ago: number) => scoreFactors({ ...QUIET, sweeps: [{ dir: 'down', price: 99.8, t: QUIET.now - ago, reclaimed }] })[0]
    expect(at(true, 120_000).score).toBeGreaterThan(0)
    expect(at(false, 120_000).score).toBeLessThan(0)
    expect(advise({ ...BULLISH, sweeps: [{ dir: 'down', price: 99.8, t: QUIET.now - 5_000, reclaimed: true }] }).cautions).toContain('Stops were just swept — let it settle')
  })

  it('pulled bids count against longs; the book is judged against its own average, not 50/50', () => {
    expect(scoreFactors({ ...QUIET, pulledBids: 2 })[0].score).toBeLessThan(0)
    expect(scoreFactors({ ...QUIET, bidShare: 0.26, bidShareAvg: 0.26 })).toHaveLength(0) // a structural skew is not a signal
    expect(scoreFactors({ ...QUIET, bidShare: 0.4, bidShareAvg: 0.26 })[0]).toMatchObject({ name: 'Book shift' })
  })
})

describe('DOM advisor — trade horizon', () => {
  it('sizes the plan by the typical move, so a bigger horizon plans a bigger trade', () => {
    const wide = { ...BULLISH, typicalMove: 0.8, resistances: [{ price: 104, label: 'GEX R1', strength: 70 }] }
    const small = advise({ ...wide, typicalMove: 0.2 }).plan!
    const big = advise(wide).plan!
    // stop 0.75 typical moves beyond the wall at 99.9
    expect(small.stop).toBeCloseTo(99.75)
    expect(big.stop).toBeCloseTo(99.3)
    expect(big.target).toBe(104)
  })

  it('skips a target level inside half a typical move and aims for the next one out', () => {
    const plan = advise({ ...BULLISH, resistances: [{ price: 100.05, label: 'REAL WALL', strength: 80 }, { price: 100.8, label: 'GEX R1', strength: 70 }] }).plan!
    expect(plan.targetFrom).toBe('GEX R1')
  })

  it('warms up for as long as the input says', () => {
    expect(advise({ ...BULLISH, warmupMs: 15 * 60_000 }).cautions[0]).toMatch(/Still reading the book \(5 min to go\)/)
  })
})

describe('DOM advisor — live record', () => {
  const plan = { zone: [99.9, 100] as [number, number], stop: 99.75, target: 100.8, rr: 3.2, zoneFrom: 'REAL WALL', targetFrom: 'GEX R1' }

  it('follows each call to its target or stop; a flipped reading closes the open call', () => {
    const r = new AdvisorRecord()
    r.open(0, 'long', 100, plan)
    r.open(1000, 'long', 100.1, plan) // same reading again: not a new call
    r.update(2000, 100.5)
    r.update(3000, 100.9)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]).toMatchObject({ outcome: 'target' })
    expect(r.calls[0].best).toBeCloseTo(0.9)
    r.open(4000, 'short', 100.9, { ...plan, stop: 101.2, target: 100.2 })
    r.open(5000, 'long', 100.8, plan)
    r.update(6000, 99.7)
    expect(r.tally()).toEqual({ calls: 3, target: 1, stop: 1, expired: 1, open: 0 })
  })

  it('expires a call that resolves neither way', () => {
    const r = new AdvisorRecord(60_000)
    r.open(0, 'long', 100, plan)
    r.update(61_000, 100.1)
    expect(r.calls[0].outcome).toBe('expired')
  })
})
