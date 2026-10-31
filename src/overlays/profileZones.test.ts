import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { buildProfileZones, dominanceText, findLvns, nearestZones, nextLvns, reactions, scoreZone, strengthLabel, zoneHeadline, zoneRole } from './profileZones'

const bar = (i: number, o: number, h: number, l: number, c: number, v = 10, buyVolume?: number): Candle => ({ time: i * 60_000, open: o, high: h, low: l, close: c, volume: v, buyVolume })

describe('reactions', () => {
  const band = { lo: 100, hi: 102 }
  it('counts a test from above that closes back above as a held support', () => {
    const c = [bar(0, 106, 107, 105, 106), bar(1, 105, 105, 101, 104), bar(2, 104, 105, 99, 99)]
    // bar1: from above, dips into band, closes 104 > 102 → rejection.
    // bar2: prev close 104 above; dips through, closes 99 → touch, no rejection.
    expect(reactions(c, band, 'demand')).toEqual({ touches: 2, rejections: 1 })
    // As resistance, only approaches from below count — none here.
    expect(reactions(c, band, 'supply')).toEqual({ touches: 0, rejections: 0 })
  })
  it('ignores bars that start inside the band', () => {
    const c = [bar(0, 101, 101.5, 100.5, 101), bar(1, 101, 103, 100, 101.5)]
    expect(reactions(c, band, 'inplay').touches).toBe(0)
  })
})

describe('zone labels', () => {
  it('names the dominant side', () => {
    expect(dominanceText(60)).toBe('Buyers 60%')
    expect(dominanceText(44)).toBe('Sellers 56%')
    expect(dominanceText(50.5)).toBe('Balanced')
  })
  it('gives in-play zones a role from where price sits inside them', () => {
    expect(zoneRole('inplay', 100, 110, 107)).toBe('support')
    expect(zoneRole('inplay', 100, 110, 102)).toBe('resistance')
    expect(zoneRole('demand', 100, 110, 200)).toBe('support')
  })
  it('flags whether the defending side dominates', () => {
    expect(zoneHeadline('demand', 100, 110, 120, 60)).toBe('SUPPORT · Buyers 60% ✓')
    expect(zoneHeadline('demand', 100, 110, 120, 40)).toBe('SUPPORT · Sellers 60% ⚠')
    expect(zoneHeadline('supply', 100, 110, 90, 35)).toBe('RESISTANCE · Sellers 65% ✓')
    expect(zoneHeadline('inplay', 100, 110, 103, 55)).toBe('IN PLAY → RESISTANCE · Buyers 55% ⚠')
    expect(zoneHeadline('supply', 100, 110, 90, 50)).toBe('RESISTANCE · Balanced')
  })
})

describe('scoreZone', () => {
  it('rewards acceptance, aligned delta, rejections and concentration', () => {
    const strong = scoreZone({ kind: 'demand', volShare: 0.3, buyPct: 70, touches: 3, rejections: 3 }, 0.1)
    const weak = scoreZone({ kind: 'demand', volShare: 0.05, buyPct: 35, touches: 3, rejections: 0 }, 0.1)
    expect(strong).toBe(100)
    expect(weak).toBeLessThan(45)
    expect(strengthLabel(strong)).toBe('Strong')
    expect(strengthLabel(weak)).toBe('Weak')
  })
  it('reads delta from the side that should defend the level', () => {
    const asSupport = scoreZone({ kind: 'demand', volShare: 0.1, buyPct: 30, touches: 0, rejections: 0 }, 0.1)
    const asResistance = scoreZone({ kind: 'supply', volShare: 0.1, buyPct: 30, touches: 0, rejections: 0 }, 0.1)
    expect(asResistance).toBeGreaterThan(asSupport)
  })
})

describe('buildProfileZones', () => {
  // 10 rows over 100–110; heavy at rows 1–2 and 7, POC row 7.
  const profile = { lo: 100, hi: 110, binVolume: [5, 80, 70, 10, 5, 5, 10, 100, 20, 5], pocBin: 7 }
  const candles = [bar(0, 101, 102.5, 101, 102.5, 50, 40), bar(1, 107, 108, 107, 107.2, 50, 10)]

  it('groups HVN rows into zones and classifies them against price', () => {
    const z = buildProfileZones(profile, candles, candles, 105, 70)
    expect(z.map((x) => [x.lo, x.hi, x.kind, x.hasPoc])).toEqual([
      [101, 103, 'demand', false],
      [107, 108, 'supply', true],
    ])
    expect(z[0].volShare).toBeCloseTo(150 / 310)
    expect(z[0].buyPct).toBeCloseTo(80) // real taker buyVolume used when present
    expect(z.every((x) => x.score >= 0 && x.score <= 100)).toBe(true)
  })

  it('merges zones split by thin rows when asked', () => {
    const gappy = { lo: 100, hi: 110, binVolume: [5, 80, 10, 75, 5, 5, 5, 100, 5, 5], pocBin: 7 }
    expect(buildProfileZones(gappy, candles, candles, 105, 70).map((z) => [z.lo, z.hi])).toEqual([[101, 102], [103, 104], [107, 108]])
    expect(buildProfileZones(gappy, candles, candles, 105, 70, 1).map((z) => [z.lo, z.hi])).toEqual([[101, 104], [107, 108]])
  })

  it('keeps only the zone price is in plus the nearest per side', () => {
    const zs = [{ lo: 90, hi: 91 }, { lo: 95, hi: 96 }, { lo: 99, hi: 101 }, { lo: 104, hi: 105 }, { lo: 108, hi: 109 }]
    expect(nearestZones(zs, 100, 1)).toEqual([{ lo: 95, hi: 96 }, { lo: 99, hi: 101 }, { lo: 104, hi: 105 }])
    expect(nextLvns([{ lo: 92, hi: 93 }, { lo: 96, hi: 97 }, { lo: 102, hi: 103 }], 100)).toEqual([{ lo: 96, hi: 97 }, { lo: 102, hi: 103 }])
  })

  it('finds thin LVN rows between heavy rows, not the tails', () => {
    expect(findLvns(profile, 25)).toEqual([{ lo: 103, hi: 107 }])
  })
})
