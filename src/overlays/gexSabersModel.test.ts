import { describe, expect, it } from 'vitest'
import { buildSabers, fmtGex, selectExpiries, spreadLabels, strikeGex, SABER_DEFAULTS, type SaberContract, type StrikeGex } from './gexSabersModel'

const D = 86_400_000
const NOW = Date.UTC(2026, 9, 30, 6)
const E1 = NOW + 0.25 * D // today
const E2 = NOW + 1.25 * D
const E3 = NOW + 6.25 * D
const E4 = NOW + 20 * D
const c = (side: 'CALL' | 'PUT', strike: number, expiry: number, openInterest: number, volume = 0, gamma = 0.001): SaberContract => ({ side, strike, expiry, gamma, openInterest, volume })

describe('GEX Sabers — expiries and sizing', () => {
  const chain = [c('CALL', 105, E1, 10, 50), c('CALL', 110, E2, 30), c('PUT', 95, E3, 20, 5), c('PUT', 90, E4, 40), c('CALL', 100, NOW - D, 99)]

  it('selects expiries: nearest N, within 7 / 30 days; expired ones never', () => {
    expect(selectExpiries(chain, NOW, 'nearest')).toEqual([E1])
    expect(selectExpiries(chain, NOW, 'nearest2')).toEqual([E1, E2])
    expect(selectExpiries(chain, NOW, 'week')).toEqual([E1, E2, E3])
    expect(selectExpiries(chain, NOW, 'month')).toEqual([E1, E2, E3, E4])
    expect(selectExpiries(chain, NOW, 'nearest6')).toEqual([E1, E2, E3, E4])
  })

  it('GEX = gamma × size × spot² × 1%, calls + / puts −, by open interest or by volume', () => {
    const oi = strikeGex(chain, 100, [E1, E2, E3], 'oi')
    expect(oi.find((s) => s.strike === 105)!.callGex).toBeCloseTo(0.001 * 10 * 100 * 100 * 0.01)
    expect(oi.find((s) => s.strike === 95)!.putGex).toBeCloseTo(-0.001 * 20 * 100)
    expect(oi.some((s) => s.strike === 90)).toBe(false) // E4 not selected
    const vol = strikeGex(chain, 100, [E1, E2, E3], 'volume')
    expect(vol.map((s) => s.strike)).toEqual([95, 105]) // 110 traded nothing today
    expect(vol.find((s) => s.strike === 105)!.callGex).toBeCloseTo(0.001 * 50 * 100)
  })

  it('remembers the expiry that dominates each strike', () => {
    const two = [c('CALL', 105, E1, 10), c('CALL', 105, E3, 40)]
    expect(strikeGex(two, 100, [E1, E3], 'oi')[0].topExpiry).toBe(E3)
  })
})

describe('GEX Sabers — levels', () => {
  const k = (strike: number, callGex: number, putGex: number, volume = 0): StrikeGex => ({ strike, callGex, putGex, topExpiry: E1, volume })
  const BOOK = [k(90, 0, -50), k(95, 10, -80), k(98, 5, -20), k(100, 70, -70), k(102, 60, -5), k(105, 100, -10), k(110, 40, 0)]
  const s = buildSabers(BOOK, 101, { ...SABER_DEFAULTS, peaks: false }) // ranking tests; peaks have their own
  const ranked = (kind: string) => s.filter((x) => x.kind === kind).map((x) => [x.names[0], x.price]).sort()

  it('resistance = largest call GEX above price, support = largest put GEX below, strongest first', () => {
    expect(ranked('resistance')).toEqual([['R1', 105], ['R2', 102], ['R3', 110]])
    expect(ranked('support')).toEqual([['S1', 95], ['S2', 100], ['S3', 98]]) // 90 is 10.9% away: outside ±10%
  })

  it('one strength scale: 100 = the heaviest total gamma near price (strike 100: 70 + 70)', () => {
    expect(s.find((x) => x.names[0] === 'S1')!.strength).toBeCloseTo((80 / 140) * 100)
    expect(s.find((x) => x.names[0] === 'S1')!.gex).toBe(-80)
    // R1 (call 100) is also L2 (total 110): the stronger score wins
    expect(s.find((x) => x.names[0] === 'R1')!.strength).toBeCloseTo((110 / 140) * 100)
    expect(s.find((x) => x.names[0] === 'R1')!.gex).toBe(110)
    // S2 (put 70) is also L1 (total 140)
    expect(s.find((x) => x.names[0] === 'S2')!.strength).toBe(100)
  })

  it('liquidity = largest total gamma; on a wall it joins it, alone it scores by total', () => {
    // totals: 100 -> 140, 105 -> 110, 95 -> 90
    expect(s.find((x) => x.price === 100)!.names).toEqual(['S2', 'L1'])
    expect(s.find((x) => x.price === 105)!.names).toEqual(['R1', 'L2'])
    const lone = buildSabers(BOOK, 101, { ...SABER_DEFAULTS, perSide: 1 }).find((x) => x.kind === 'liquidity')!
    expect(lone.price).toBe(100)
    expect(lone.strength).toBe(100)
  })

  it('zero gamma from the net-GEX crossover; sorted top to bottom; far strikes excluded', () => {
    const z = buildSabers([k(90, 0, -50), k(95, 0, -40), k(105, 120, 0)], 100).find((x) => x.kind === 'zero')!
    expect(z.price).toBeGreaterThan(95)
    expect(z.price).toBeLessThanOrEqual(105)
    expect(z.strength).toBeNaN()
    expect(s.map((x) => x.price)).toEqual([...s.map((x) => x.price)].sort((a, b) => b - a))
    expect(buildSabers([...BOOK, k(150, 999, 0)], 101).some((x) => x.price === 150)).toBe(false)
  })

  it('HVL: the most-traded strike is yellow — its own saber, or it takes over the wall on its strike', () => {
    const vol = [k(95, 10, -80, 5), k(97, 1, 0, 900), k(105, 100, -10, 50)] // 97: no wall, no liquidity — HVL alone
    const noPeaks = { ...SABER_DEFAULTS, peaks: false }
    const alone = buildSabers(vol, 101, noPeaks).find((x) => x.kind === 'hvl')!
    expect(alone).toMatchObject({ price: 97, names: ['HVL'], volume: 900 })
    const onWall = buildSabers([k(95, 10, -80, 5), k(105, 100, -10, 900)], 101, noPeaks).find((x) => x.price === 105)!
    expect(onWall.kind).toBe('hvl')
    expect(onWall.names.slice(0, 2)).toEqual(['HVL', 'R1'])
    expect(buildSabers(vol, 101, { ...SABER_DEFAULTS, hvl: false }).some((x) => x.kind === 'hvl')).toBe(false)
  })

  it('peaks: most positive net gamma is bright-green MAX +Γ, most negative is yellow MAX −Γ', () => {
    // net: 95 -> -70, 100 -> 0, 105 -> +90, 102 -> +55
    const p = buildSabers(BOOK, 101)
    expect(p.find((x) => x.kind === 'peakPos')).toMatchObject({ price: 105, names: ['MAX +Γ', 'R1', 'L2'] })
    expect(p.find((x) => x.kind === 'peakNeg')).toMatchObject({ price: 95, names: ['MAX −Γ', 'S1'] })
    // a peak with no saber of its own gets one
    const lone = buildSabers([k(96, 0, -30), k(104, 50, 0), k(103, 0, -60), k(99, 80, -10)], 101, { ...SABER_DEFAULTS, perSide: 1, liquidity: 0 })
    expect(lone.find((x) => x.kind === 'peakPos')).toMatchObject({ price: 99, names: ['MAX +Γ'] })
    expect(lone.find((x) => x.kind === 'peakNeg')).toMatchObject({ price: 103, names: ['MAX −Γ'] })
    expect(buildSabers(BOOK, 101, { ...SABER_DEFAULTS, peaks: false }).some((x) => x.kind === 'peakPos' || x.kind === 'peakNeg')).toBe(false)
  })

  it('strike volume is counted whatever GEX is sized by', () => {
    const chain = [c('CALL', 105, E1, 10, 70), c('PUT', 105, E1, 0, 30)]
    expect(strikeGex(chain, 100, [E1], 'oi')[0].volume).toBe(100)
  })

  it('formats $GEX and spreads crowded labels', () => {
    expect(fmtGex(1.23e9)).toBe('$1.2B')
    expect(fmtGex(-3.4e6)).toBe('−$3.4M')
    expect(spreadLabels([10, 12, 14], 10, 0, 100)).toEqual([10, 20, 30])
    expect(spreadLabels([95, 98], 10, 0, 100)).toEqual([90, 100])
  })
})
