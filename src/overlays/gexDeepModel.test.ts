import { describe, expect, it } from 'vitest'
import type { StrikeGex } from './gexSabersModel'
import { buildProfile, heatmapBlocks, netGexOf, pushSummarySample, regimeOf, strikeStep, visibleStrikes } from './gexDeepModel'

const row = (strike: number, callGex: number, putGex: number): StrikeGex => ({ strike, callGex, putGex, topExpiry: 0, volume: 0 })

const strikes: StrikeGex[] = [
  row(90, 0, -50),
  row(95, 10, -100),
  row(100, 300, -20),
  row(105, 40, -10),
  row(150, 999, 0), // far outside a ±10% band
]

describe('visibleStrikes', () => {
  it('keeps strikes inside the band, sorted ascending', () => {
    const v = visibleStrikes(strikes, 100, 10, 0)
    expect(v.map((s) => s.strike)).toEqual([90, 95, 100, 105])
  })

  it('caps to the nearest N strikes when numStrikes > 0', () => {
    const v = visibleStrikes(strikes, 100, 10, 2)
    expect(v.map((s) => s.strike)).toEqual([95, 100])
  })

  it('returns nothing without a valid spot', () => {
    expect(visibleStrikes(strikes, 0, 10, 0)).toEqual([])
  })
})

describe('strikeStep', () => {
  it('uses the smallest neighbouring gap', () => {
    expect(strikeStep(strikes, 100)).toBe(5)
  })
})

describe('buildProfile', () => {
  it('finds the call and put peaks and the net total', () => {
    const p = buildProfile(strikes, 100, 10, 0)
    expect(p.peakCall).toBe(100)
    expect(p.peakPut).toBe(95)
    expect(p.netTotal).toBeCloseTo(10 - 100 + 0 - 50 + 300 - 20 + 40 - 10, 6)
    expect(p.maxAbs).toBe(300)
  })

  it('reports a net value per row', () => {
    const p = buildProfile(strikes, 100, 10, 0)
    const r100 = p.rows.find((r) => r.strike === 100)
    expect(r100?.net).toBe(280)
  })
})

describe('heatmapBlocks', () => {
  it('drops strikes below the cut-off share of the largest |net|', () => {
    // nets: 90 → -50, 95 → -90, 100 → +280, 105 → +30; max = 280; 30% cut = 84
    const b = heatmapBlocks(strikes, 100, 10, 0, 30)
    expect(b.map((x) => x.strike)).toEqual([95, 100])
    expect(b.find((x) => x.strike === 100)?.side).toBe('call')
    expect(b.find((x) => x.strike === 95)?.side).toBe('put')
    expect(b.find((x) => x.strike === 100)?.intensity).toBe(1)
  })

  it('returns no blocks when every strike is zero', () => {
    expect(heatmapBlocks([row(100, 0, 0)], 100, 10, 0, 0)).toEqual([])
  })
})

describe('summary series', () => {
  it('nets calls and puts across strikes', () => {
    expect(netGexOf(strikes.slice(0, 4))).toBe(10 - 100 - 50 + 300 - 20 + 40 - 10)
  })

  it('classifies the regime by sign', () => {
    expect(regimeOf(5)).toBe('positive')
    expect(regimeOf(-5)).toBe('negative')
    expect(regimeOf(0)).toBe('flat')
    expect(regimeOf(Number.NaN)).toBe('flat')
  })

  it('ignores duplicate or older times and caps length', () => {
    let list = pushSummarySample([], { time: 1000, net: 5 })
    list = pushSummarySample(list, { time: 1000, net: 9 })
    list = pushSummarySample(list, { time: 500, net: 9 })
    expect(list).toEqual([{ time: 1000, net: 5 }])
    list = pushSummarySample(list, { time: 2000, net: -3 }, 1)
    expect(list).toEqual([{ time: 2000, net: -3 }])
  })
})
