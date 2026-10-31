import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/gld-2026-10-29.json'
import { closeAt, computeMapV3Levels, MAP_V3_DEFAULTS, pickSession, scaleMapLevels, type MapV3IndexEntry, type MapV3Row } from './mapV3Model'

// GLD chain from CBOE (OI = OCC's 28 Oct figure), as the original MAP saw it on 29 Oct 2026.
const fx = fixture as unknown as { time: number; rows: MapV3Row[] }
const AT = fx.time // 12:23 UTC
const SPOT = 369.5 // gold ≈ 4031 at the update ÷ 10.91

describe('MAP V3 levels (GLD options)', () => {
  const r = computeMapV3Levels(fx.rows, null, SPOT, AT, MAP_V3_DEFAULTS, 'GLD')!
  const l = r.levels

  it('reproduces the original MAP of 29 Oct 2026 (XAUUSD = GLD × 10.91)', () => {
    expect(l.callWall).toBe(380) // 4145.8
    expect(l.hvl).toBe(380) // 4145.8 (open interest — no prior-session volume in the fixture)
    expect(l.putWall).toBe(368) // 4014.9
    expect(l.vd).toBe(366) // 3993.1
    expect(l.z.call).toBe(375) // 0DTE call 4091.2
    expect(Math.abs(l.flip - 370)).toBeLessThan(0.5) // GEX flip 4036.7
    expect(Math.abs(l.maxPain - 371)).toBeLessThanOrEqual(1) // 4047.6
    expect(r.meta.zeroDteExpiry).toBe(Date.parse('2026-10-29T20:00:00Z'))
  })

  it('HVL follows the prior session volume when it is recorded', () => {
    const volume: MapV3Row[] = [[fx.rows[0][0], 1, 372, 0, 0.2, 9_000], [fx.rows[0][0], 0, 365, 0, 0.2, 2_000]]
    expect(computeMapV3Levels(fx.rows, volume, SPOT, AT, MAP_V3_DEFAULTS, 'GLD')!.levels.hvl).toBe(372)
  })

  it('scales every price to the chart and leaves GEX values alone', () => {
    const s = scaleMapLevels(l, 10.91)
    expect(s.callWall).toBeCloseTo(4145.8, 1)
    expect(s.putWall).toBeCloseTo(4014.88, 1)
    expect(s.heat.map((h) => h.strike)).toEqual(l.heat.map((h) => h.strike * 10.91))
    expect(s.profile[10].gex).toBe(l.profile[10].gex)
    expect(s.profile[10].price).toBeCloseTo(l.profile[10].price * 10.91)
  })
})

describe('session selection', () => {
  const day = (d: string, kind: 'morning' | 'close', t: string): MapV3IndexEntry => ({ id: `${d}_${kind}`, kind, nyDate: d, time: Date.parse(`${t}Z`) })
  const ix = [day('2026-10-28', 'close', '2026-10-28T20:20:00'), day('2026-10-29', 'morning', '2026-10-29T12:15:00'), day('2026-10-29', 'close', '2026-10-29T20:20:00'), day('2026-10-30', 'morning', '2026-10-30T12:15:00')]
  it('locks one morning snapshot until the next, with the close before it', () => {
    expect(pickSession(ix, Date.parse('2026-10-29T18:00:00Z'))).toMatchObject({ morning: { id: '2026-10-29_morning' }, close: { id: '2026-10-28_close' } })
    expect(pickSession(ix, Date.parse('2026-10-30T03:00:00Z'))!.morning.id).toBe('2026-10-29_morning') // overnight: still the 29th's
    expect(pickSession(ix, Date.parse('2026-10-30T12:16:00Z'))).toMatchObject({ morning: { id: '2026-10-30_morning' }, close: { id: '2026-10-29_close' } })
    expect(pickSession(ix, Date.parse('2026-10-29T10:00:00Z'))).toBeNull()
  })
  it('closeAt finds the price at a reference time, not one from hours away', () => {
    const c = [{ time: 0, close: 1 }, { time: 60_000, close: 2 }]
    expect(closeAt(c, 90_000)).toBe(2)
    expect(closeAt(c, -1)).toBeNaN()
    expect(closeAt(c, 60_000 + 3 * 3_600_000, 2 * 3_600_000)).toBeNaN()
  })
})
