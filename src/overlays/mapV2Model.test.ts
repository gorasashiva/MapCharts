import { describe, expect, it } from 'vitest'
import { zeroDteAction, type MapBar } from './mapModel'
import {
  bsGamma,
  computeMapV2LevelsFromChain,
  gexAt,
  gexProfile,
  mapV2PosGamma,
  mapV2Status,
  profileFlip,
  sessionRefPrice,
  zeroDteActionV2,
  type MapV2ChainRow,
  type MapV2Levels,
} from './mapV2Model'

const NOW = Date.UTC(2026, 9, 28, 6)
const E1 = Date.UTC(2026, 9, 28, 12) // today's expiry (0DTE)
const E2 = Date.UTC(2026, 10, 6, 12)
const row = (side: 'CALL' | 'PUT', strike: number, oi: number, expiry = E1, iv = 0.5, gamma = 0.01): MapV2ChainRow => ({ side, strike, expiry, gamma, openInterest: oi, iv })

const lv = (o: Partial<MapV2Levels>): MapV2Levels => ({
  ticker: 'T',
  vu: Number.NaN,
  callWall: Number.NaN,
  flip: Number.NaN,
  hvl: Number.NaN,
  maxPain: Number.NaN,
  putWall: Number.NaN,
  vd: Number.NaN,
  z: { call: 110, put: 90, zero: Number.NaN },
  oiCall: Number.NaN,
  oiPut: Number.NaN,
  heat: [],
  netGex: Number.NaN,
  profile: [],
  ...o,
})
const bar = (o: number, c: number, h = Math.max(o, c) + 0.3, l = Math.min(o, c) - 0.3): MapBar => ({ open: o, close: c, high: h, low: l })
const flat = (n: number, p: number): MapBar[] => Array.from({ length: n }, () => bar(p, p + 0.2))

describe('rule 1 — gamma flip from the re-priced GEX curve', () => {
  it('bsGamma peaks at the money and vanishes without IV / time', () => {
    const atm = bsGamma(100, 100, 0.5, 0.01)
    expect(atm).toBeGreaterThan(bsGamma(100, 110, 0.5, 0.01))
    expect(atm).toBeGreaterThan(bsGamma(100, 90, 0.5, 0.01))
    expect(bsGamma(100, 100, 0, 0.01)).toBe(0)
    expect(bsGamma(100, 100, 0.5, 0)).toBe(0)
  })

  it('profile crosses zero between a put block below and a call block above', () => {
    const rows = [row('PUT', 95, 100), row('CALL', 105, 100)]
    const prof = gexProfile(rows, 100, NOW)
    const f = profileFlip(prof, 100)
    expect(f).toBeGreaterThan(97)
    expect(f).toBeLessThan(103)
    expect(gexAt(prof, 90)).toBeLessThan(0)
    expect(gexAt(prof, 110)).toBeGreaterThan(0)
    expect(Number.isNaN(profileFlip(gexProfile([row('CALL', 100, 10)], 100, NOW), 100))).toBe(true)
  })

  it('regime follows GEX at price, where the clone’s cumulative crossing sits on the wrong side', () => {
    // Live BTC 28 Oct shape: sizeable puts below spot, bigger calls just above. Net GEX at spot > 0,
    // yet the cumulative-by-strike sum only turns positive above spot (the clone said NEG).
    const rows = [row('PUT', 94, 60), row('PUT', 97, 80), row('CALL', 101, 160), row('CALL', 104, 40)]
    const r = computeMapV2LevelsFromChain(rows, 100, 100, NOW, 'Every Expiry', 'T')!
    expect(r.levels.netGex).toBeGreaterThan(0)
    expect(mapV2PosGamma(r.levels, 100)).toBe(true)
    expect(r.levels.flip).toBeLessThan(100)
    expect(mapV2Status(r.levels, 100).regime).toBe('POS  PINNED')
    expect(mapV2PosGamma(r.levels, r.levels.flip - 1)).toBe(false)
  })

  it('snapshot levels (no profile) fall back to price vs flip', () => {
    expect(mapV2PosGamma(lv({ flip: 100 }), 101)).toBe(true)
    expect(mapV2PosGamma(lv({ flip: 100 }), 99)).toBe(false)
  })
})

describe('rule 4 — walls on the correct side of the session price', () => {
  // biggest call GEX sits BELOW spot, biggest put GEX ABOVE it
  const rows = [
    row('CALL', 90, 100, E1, 0, 0.05),
    row('CALL', 110, 50, E1, 0, 0.01),
    row('PUT', 105, 100, E1, 0, 0.05),
    row('PUT', 95, 50, E1, 0, 0.01),
    row('CALL', 120, 10, E2, 0, 0.01),
  ]
  it('call wall above / put wall below, 0DTE too', () => {
    const r = computeMapV2LevelsFromChain(rows, 100, 100, NOW, 'Every Expiry', 'T')!
    expect(r.levels.callWall).toBe(110)
    expect(r.levels.putWall).toBe(95)
    expect(r.levels.z.call).toBe(110)
    expect(r.levels.z.put).toBe(95)
  })
  it('sides come from the session reference, not the live spot', () => {
    // spot has rallied to 112 since the session began at 100: the 110 call wall stays (broken, retestable)
    const r = computeMapV2LevelsFromChain(rows, 112, 100, NOW, 'Every Expiry', 'T')!
    expect(r.levels.callWall).toBe(110)
  })
  it('sessionRefPrice = close at the session start (next expiry − 24h), else spot', () => {
    const start = E1 - 86_400_000
    const bars = [
      { time: start - 600_000, close: 98 },
      { time: start, close: 99 },
      { time: start + 300_000, close: 105 },
    ]
    expect(sessionRefPrice(bars, E1, 120)).toBe(99)
    expect(sessionRefPrice(bars.slice(2), E1, 120)).toBe(120)
    expect(sessionRefPrice(bars, null, 120)).toBe(120)
  })
})

describe('rule 2 — Break & Retest needs a fresh retest', () => {
  // break 110, retest straight after, then run 12 points away; last closed bar green
  const bars = [...flat(16, 105), bar(108, 111), bar(111, 110.2, 111.2, 109.9)]
  for (let i = 0; i < 10; i++) bars.push(bar(111 + i, 112 + i))
  bars.push(bar(121, 122), bar(122, 122.1))
  it('the clone still says BUY; V2 does not', () => {
    expect(zeroDteAction(bars, lv({})).kind).toBe('BUY')
    expect(zeroDteActionV2(bars, lv({})).kind).toBe('HOLD OFF')
  })
  it('a retest in the last 3 bars with a bullish candle is a BUY', () => {
    const b = [...flat(16, 105), bar(108, 111), bar(111, 112), bar(112, 110.5, 112, 109.9), bar(110.4, 111.5), bar(111.5, 111.6)]
    const a = zeroDteActionV2(b, lv({ flip: 100 }))
    expect(a.kind).toBe('BUY')
    expect(a.text).not.toContain('reduce size')
  })
})

describe('rule 3 — entries respect regime', () => {
  const bounce = [...flat(16, 93), bar(91, 90.1, 91, 89.9), bar(90.2, 91.5), bar(91.5, 91.6)]
  it('Touch & Bounce: BUY in positive gamma, WAIT in negative', () => {
    expect(zeroDteActionV2(bounce, lv({ flip: 80 })).kind).toBe('BUY')
    const neg = zeroDteActionV2(bounce, lv({ flip: 100 }))
    expect(neg.kind).toBe('WAIT')
    expect(neg.text).toContain('NEG γ')
  })
  it('Break & Retest in negative gamma still enters, with reduce size', () => {
    const b = [...flat(16, 105), bar(108, 111), bar(111, 112), bar(112, 110.5, 112, 109.9), bar(110.4, 111.5), bar(111.5, 111.6)]
    const a = zeroDteActionV2(b, lv({ flip: 200 }))
    expect(a.kind).toBe('BUY')
    expect(a.text).toContain('reduce size')
  })
})
