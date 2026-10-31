import { describe, expect, it } from 'vitest'
import { computeMapLevelsFromChain, engulfingRetest, gexFlip, gexLevels, mapStatus, mapTickerFor, maxPain, parseMapRow, zeroDteAction, type MapBar, type MapChainRow, type MapLevels } from './mapModel'

describe('live levels from an option chain', () => {
  const NOW = Date.UTC(2026, 9, 12, 10)
  const E1 = Date.UTC(2026, 9, 12, 16) // today's expiry (0DTE)
  const E2 = Date.UTC(2026, 9, 16, 16)
  const row = (side: 'CALL' | 'PUT', strike: number, oi: number, expiry = E1, gamma = 0.01): MapChainRow => ({ side, strike, expiry, gamma, openInterest: oi })
  // spot 100: puts heavy below, calls heavy above
  const chain: MapChainRow[] = [
    row('PUT', 90, 50),
    row('PUT', 95, 300), // biggest put GEX -> put wall
    row('CALL', 95, 10),
    row('PUT', 100, 40),
    row('CALL', 100, 60),
    row('CALL', 105, 400), // biggest call GEX -> call wall
    row('CALL', 110, 900, E2, 0.001), // biggest call OI (far expiry, low gamma) -> call OI wall, not the call wall
    row('CALL', 1, 5, Date.UTC(2026, 9, 1)), // expired -> ignored
  ]
  const r = computeMapLevelsFromChain(chain, 100, NOW, 'Every Expiry', 'XAUT')!

  it('walls by GEX, OI walls by raw OI, expired contracts ignored', () => {
    expect(r.levels.callWall).toBe(105)
    expect(r.levels.putWall).toBe(95)
    expect(r.levels.oiCall).toBe(110)
    expect(r.levels.oiPut).toBe(95)
    expect(r.meta.contracts).toBe(7)
    expect(r.meta.expiries).toEqual([E1, E2])
  })

  it('HVL = most combined OI, max pain minimises holder payout', () => {
    expect(r.levels.hvl).toBe(110)
    // payout at K: calls below K pay (K−k)·OI, puts above K pay (k−K)·OI
    expect(maxPain([
      { strike: 90, callOI: 0, putOI: 50 },
      { strike: 95, callOI: 10, putOI: 300 },
      { strike: 100, callOI: 60, putOI: 40 },
      { strike: 105, callOI: 400, putOI: 0 },
    ])).toBe(100)
  })

  it('GEX flip: cumulative net GEX crosses negative -> positive (interpolated)', () => {
    // nets −5, −10, +5, +20: cumulative −5, −15, −10, +10 -> crosses between 102 and 103 halfway
    expect(gexFlip([{ strike: 100, net: -5 }, { strike: 101, net: -10 }, { strike: 102, net: 5 }, { strike: 103, net: 20 }])).toBeCloseTo(102.5, 9)
    expect(Number.isNaN(gexFlip([{ strike: 1, net: 1 }, { strike: 2, net: 2 }]))).toBe(true)
    expect(r.levels.flip).toBeGreaterThan(95)
    expect(r.levels.flip).toBeLessThan(105)
  })

  it('GEX flip ignores a ~$0 far-OTM strike and is NaN when the book never turns positive', () => {
    // shape of live BTC on 14 Oct 2026: 52000 holds ~+$0, then puts dominate and the cumulative
    // never recovers above zero. The old first-sign-change fallback reported 52002 here.
    const btc = [
      { strike: 52000, net: 0.00001 },
      { strike: 53000, net: -9.9 },
      { strike: 83400, net: -24_000 },
      { strike: 84000, net: 6974 },
      { strike: 86400, net: 336 },
    ]
    expect(Number.isNaN(gexFlip(btc))).toBe(true)
    // a negligible dip (< 1% of the largest |cumulative|) is not a negative-gamma region
    expect(Number.isNaN(gexFlip([{ strike: 1, net: -0.5 }, { strike: 2, net: 100 }, { strike: 3, net: 50 }]))).toBe(true)
  })

  it('regime with no flip comes from total net GEX', () => {
    const neg = computeMapLevelsFromChain([row('PUT', 100, 500), row('CALL', 105, 10)], 100, NOW, 'Every Expiry', 'BTC')!.levels
    expect(Number.isNaN(neg.flip)).toBe(true)
    expect(neg.netGex).toBeLessThan(0)
    expect(mapStatus(neg, 101)).toMatchObject({ posGamma: false, regime: 'NEG  TRENDING' })
    const pos = computeMapLevelsFromChain([row('CALL', 100, 500), row('PUT', 95, 10)], 100, NOW, 'Every Expiry', 'BTC')!.levels
    expect(mapStatus(pos, 101)).toMatchObject({ posGamma: true, regime: 'POS  PINNED' })
  })

  it('VD mirrors VU: below the put wall, the strike where net GEX drops most going down', () => {
    // GLD snapshot (map.pine): PW 378, VD 376 — net GEX taken from its heatmap row
    const nets: [number, number][] = [[365, -6], [368, -8], [370, -5], [371, -5], [374, -7], [375, -18], [376, -7], [377, -8], [378, -27], [380, 21], [382, 30], [383, 9]]
    const chain = nets.map(([k, n]) => row(n > 0 ? 'CALL' : 'PUT', k, Math.abs(n)))
    const l = computeMapLevelsFromChain(chain, 379, NOW, 'Every Expiry', 'GLD')!.levels
    expect(l.putWall).toBe(378)
    expect(l.vd).toBe(376)
    expect(l.callWall).toBe(382)
    expect(l.vu).toBe(382) // no strike above the wall steps up -> VU defaults to the call wall
  })

  it('0DTE uses only the nearest expiry; 2nd-expiry OI walls follow the setting', () => {
    expect(r.levels.z.call).toBe(105)
    expect(r.levels.z.put).toBe(95)
    const second = computeMapLevelsFromChain(chain, 100, NOW, '2nd Expiry', 'XAUT')!
    expect(second.levels.oiCall).toBe(110)
    expect(Number.isNaN(second.levels.oiPut)).toBe(true) // no puts in the 2nd expiry
  })

  it('heatmap: biggest |net GEX| strikes, longest bar = 30, sign = side', () => {
    const h = r.levels.heat
    expect(Math.max(...h.map((x) => x.len))).toBe(30)
    expect(h.find((x) => x.strike === 105)!.sign).toBe(1)
    expect(h.find((x) => x.strike === 95)!.sign).toBe(-1)
  })

  it('no live contracts -> null', () => {
    expect(computeMapLevelsFromChain([row('CALL', 1, 5, Date.UTC(2026, 9, 1))], 100, NOW, 'Every Expiry', 'XAUT')).toBeNull()
  })
})

describe('mapModel', () => {
  it('maps Delta gold / BTC symbols onto the snapshot rows', () => {
    expect(mapTickerFor('PAXGUSD')).toBe('XAUUSD')
    expect(mapTickerFor('XAUTUSD')).toBe('XAUUSD')
    expect(mapTickerFor('OANDA:XAUUSD')).toBe('XAUUSD')
    expect(mapTickerFor('BTCUSD')).toBe('BTCUSDT.P')
    expect(mapTickerFor('SPY')).toBe('SPY')
    expect(mapTickerFor('ETHUSD')).toBe('')
  })

  it('parses the XAUUSD row like map.pine', () => {
    const l = parseMapRow('XAUUSD', 'Every Expiry')!
    expect(gexLevels(l).map((x) => x.price)).toEqual([4167.6, 4145.8, 4156.7, 4167.6, 4156.7, 4124, 4102.2])
    expect(l.z).toEqual({ call: 4167.6, put: 4124, zero: 4157.1 })
    expect([l.oiCall, l.oiPut]).toEqual([4364, 3818.5])
    expect(l.heat).toHaveLength(12)
    expect(l.heat[0]).toEqual({ strike: 3982.2, len: 6, sign: -1 })
    const second = parseMapRow('XAUUSD', '2nd Expiry')!
    expect([second.oiCall, second.oiPut]).toEqual([4265.8, 3873.1])
  })

  it('status: regime from the GEX flip, bias from the walls / triggers', () => {
    const l = parseMapRow('XAUUSD', 'Every Expiry')!
    expect(mapStatus(l, 4170)).toMatchObject({ posGamma: true, bias: 'VU SQUEEZE ^^' })
    expect(mapStatus(l, 4150)).toMatchObject({ posGamma: false, regime: 'NEG  TRENDING', bias: 'ABOVE CALL +' })
    expect(mapStatus(l, 4140)).toMatchObject({ bias: 'VOLATILE !' })
    expect(mapStatus(l, 4110)).toMatchObject({ bias: 'PUT BREAK --', biasSide: -1 })
    expect(mapStatus(l, 4100)).toMatchObject({ bias: 'VD BREAK vv' })
  })

  it('flags a bullish engulfing retest of the put wall (4124)', () => {
    const l = parseMapRow('XAUUSD', 'Every Expiry')!
    const bars = [
      { open: 4127, high: 4128, low: 4124.5, close: 4125 }, // closes just above the put wall
      { open: 4125, high: 4130, low: 4123, close: 4129 }, // dips through it, closes above both bodies
      { open: 4129, high: 4131, low: 4128, close: 4130 },
    ]
    expect(engulfingRetest(bars, l)).toEqual([0, 1, 0])
  })
})

describe('0DTE entry rules (zeroDteAction)', () => {
  // 0DTE put wall 100, call wall 110; bars ~1 wide so ATR ≈ 1 and the touch band ≈ 0.25.
  const L: MapLevels = {
    ticker: 'T', vu: 112, callWall: 110, flip: 105, hvl: 105, maxPain: 105, putWall: 100, vd: 98,
    z: { call: 110, put: 100, zero: 105 }, oiCall: 110, oiPut: 100, heat: [], netGex: 1,
  }
  const bar = (o: number, c: number, lo = Math.min(o, c) - 0.3, hi = Math.max(o, c) + 0.3): MapBar => ({ open: o, high: hi, low: lo, close: c })
  /** 18 quiet bars around `mid`, then `tail`, then a forming bar (ignored by the rules). */
  const series = (mid: number, tail: MapBar[]): MapBar[] => [...Array.from({ length: 18 }, (_, i) => bar(mid + (i % 2 ? 0.5 : -0.5), mid + (i % 2 ? -0.5 : 0.5))), ...tail, bar(0, 0)]

  it('Put Wall holds with a bullish candle → BUY', () => {
    const a = zeroDteAction(series(102, [bar(101, 100.4, 99.9), bar(100.4, 101.2)]), L)
    expect(a.kind).toBe('BUY')
    expect(a.text).toContain('0DTE Put Wall 100.00')
  })
  it('Put Wall touched without a bullish candle → WAIT', () => {
    expect(zeroDteAction(series(102, [bar(101, 100.6, 99.9), bar(100.6, 100.3)]), L).kind).toBe('WAIT')
  })
  it('Call Wall holds with a bearish candle → SELL', () => {
    expect(zeroDteAction(series(108, [bar(109, 109.6, 109, 110.1), bar(109.6, 108.8)]), L).kind).toBe('SELL')
  })
  it('break above the Call Wall, retest, bullish candle → BUY breakout', () => {
    const a = zeroDteAction(series(109, [bar(109.4, 110.8), bar(110.8, 110.3, 110.1), bar(110.3, 111)]), L)
    expect(a).toMatchObject({ kind: 'BUY' })
    expect(a.text).toContain('breakout')
  })
  it('break below the Put Wall, retest, bearish candle → SELL breakdown', () => {
    const a = zeroDteAction(series(101, [bar(100.6, 99.2), bar(99.2, 99.7, 99.5, 99.9), bar(99.7, 99)]), L)
    expect(a).toMatchObject({ kind: 'SELL' })
    expect(a.text).toContain('breakdown')
  })
  it('strong break without retest → HOLD OFF (don\'t trade against it)', () => {
    const a = zeroDteAction(series(109, [bar(109.4, 111), bar(111, 112.5, 110.9), bar(112.5, 113.5, 112.4)]), L)
    expect(a.kind).toBe('HOLD OFF')
    expect(a.text).toContain("don't sell")
  })
  it('price between the walls → NONE', () => {
    expect(zeroDteAction(series(105, []), L).kind).toBe('NONE')
  })
  it('falls back to the all-expiry walls when 0DTE levels are missing', () => {
    const a = zeroDteAction(series(102, [bar(101, 100.4, 99.9), bar(100.4, 101.2)]), { ...L, z: { call: NaN, put: NaN, zero: NaN } })
    expect(a.text).toContain('Put Wall 100.00')
    expect(a.text).not.toContain('0DTE')
  })
})
