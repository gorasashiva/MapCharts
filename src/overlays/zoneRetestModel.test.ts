import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import type { OHLCBar } from './ivWallsModel'
import { buildZrSessions, computeZoneRetest, inZrWindows, ZONE_RETEST_DEFAULTS, type ZoneRetestOptions } from './zoneRetestModel'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
// Sessions open at 00:00 UTC here (openHourUTC = 0, weekends kept) so the arithmetic stays simple.
const T0 = Date.UTC(2026, 8, 1) // the traded session
const DAYS = 40

/** Flat hourly days before T0 whose closes alternate 100 / 101 (a known return stdev), plus T0's first hour. */
function history(): OHLCBar[] {
  const out: OHLCBar[] = []
  for (let d = DAYS; d >= 1; d--) {
    const c = d % 2 === 0 ? 100 : 101
    for (let h = 0; h < 24; h++) out.push({ time: T0 - d * DAY + h * HOUR, open: c, high: c, low: c, close: c })
  }
  out.push({ time: T0, open: 101, high: 101, low: 101, close: 101 })
  return out
}

/** Filters off and no big trades: isolates the retest mechanics. */
const RAW: ZoneRetestOptions = { ...ZONE_RETEST_DEFAULTS, sessionWindows: false, skipSmallRange: false, skipAgainstOpen: false, cprFilter: false, bigTrades: 'off' }

/** 5m candles following a path given in EM units from the previous close (each candle opens at the prior point). */
function path(P: number, E: number, pts: number[], startMin = 0, vol = 10): Candle[] {
  return pts.map((x, i) => {
    const o = P + (i === 0 ? x : pts[i - 1]) * E
    const c = P + x * E
    return { time: T0 + (startMin + i * 5) * MIN, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: vol }
  })
}

function zone(): { P: number; E: number } {
  const z = buildZrSessions(history(), RAW, 0, false).get(T0 / DAY)!
  return { P: z.prevClose, E: z.em }
}

// Break the +0.618 zone (top edge 0.718), reach the next zone (1.0), swing high 1.15,
// pull back to the zone, then rally through the swing high.
const LONG_PATH = [0.1, 0.4, 0.7, 0.95, 1.15, 0.9, 0.7, 0.85, 1.0, 1.3]

describe('buildZrSessions', () => {
  it('sizes EM from the last N session-close returns × scale', () => {
    const z = buildZrSessions(history(), RAW, 0, false).get(T0 / DAY)!
    const r = Math.log(101 / 100)
    // Ten alternating ±r returns: sample stdev = r·√(10/9).
    expect(z.prevClose).toBe(101)
    expect(z.em).toBeCloseTo(101 * r * Math.sqrt(10 / 9) * 0.75, 9)
    expect(z.levels).toHaveLength(10)
    expect(z.levels[5]).toBeCloseTo(101 + 0.382 * z.em, 9)
  })
})

describe('computeZoneRetest — mechanics', () => {
  it('buys the first pullback to a broken zone and runs to the swing high', () => {
    const { P, E } = zone()
    const t = computeZoneRetest(path(P, E, LONG_PATH), history(), RAW, 0, false).trades.find((x) => x.zone === '+0.618x')!
    expect(t.side).toBe('long')
    expect(t.entryPrice).toBeCloseTo(P + 0.718 * E, 6)
    expect(t.stop).toBeCloseTo(P + (0.618 - 0.1 - 0.15) * E, 6)
    expect(t.tp1).toBeCloseTo(2 * t.entryPrice - t.stop, 6)
    expect(t.target).toBeCloseTo(P + 1.15 * E, 6) // the swing high before the pullback
    expect(t.exitReason).toBe('TP')
    expect(t.tp1Time).not.toBeNull()
    expect(t.grossR).toBeGreaterThan(0)
    expect(t.label).toBe('BUY B')
  })

  it('mirrors for shorts below the previous close', () => {
    const { P, E } = zone()
    const t = computeZoneRetest(path(P, E, LONG_PATH.map((x) => -x)), history(), RAW, 0, false).trades.find((x) => x.zone === '-0.618x')!
    expect(t.side).toBe('short')
    expect(t.entryPrice).toBeCloseTo(P - 0.718 * E, 6)
    expect(t.stop).toBeCloseTo(P - (0.618 - 0.1 - 0.15) * E, 6)
    expect(t.exitReason).toBe('TP')
    expect(t.label).toBe('SELL B')
  })

  it('counts a stop touched on the fill candle as a loss', () => {
    const { P, E } = zone()
    // The pullback candle falls straight through the zone and the stop.
    const t = computeZoneRetest(path(P, E, [0.1, 0.4, 0.7, 0.95, 1.15, 0.2, 0.3]), history(), RAW, 0, false).trades.find((x) => x.zone === '+0.618x')!
    expect(t.exitReason).toBe('SL')
    expect(t.grossR).toBeCloseTo(-1, 6)
  })

  it('skips a retest whose swing high is less than 1R away', () => {
    const { P, E } = zone()
    const c = path(P, E, [0.1, 0.4, 0.7, 0.95, 1.0, 0.9, 0.7, 0.85, 1.0, 1.3]) // swing 1.0: only 0.28 EM above the 0.718 entry vs a 0.35 EM stop
    expect(computeZoneRetest(c, history(), RAW, 0, false).trades.some((x) => x.zone === '+0.618x')).toBe(false)
  })

  it('only fills inside 03:30–09:30 / 12:30–18:30 IST when the window filter is on', () => {
    expect(inZrWindows(Date.UTC(2026, 8, 1, 22, 30))).toBe(true) // 04:00 IST
    expect(inZrWindows(Date.UTC(2026, 8, 1, 5, 0))).toBe(false) // 10:30 IST
    const { P, E } = zone()
    const pts = [0.1, 0.4, 0.7, 0.95, 1.15, 0.7, 0.9, 1.3]
    const on = { ...RAW, sessionWindows: true }
    // The session opens 00:00 UTC = 05:30 IST: the fill candle 25 min in (05:55 IST) is inside; 4h later (09:55 IST) is not.
    expect(computeZoneRetest(path(P, E, pts), history(), on, 0, false).trades.some((x) => x.zone === '+0.618x')).toBe(true)
    expect(computeZoneRetest(path(P, E, pts, 240), history(), on, 0, false).trades.some((x) => x.zone === '+0.618x')).toBe(false)
  })
})

describe('computeZoneRetest — big-trade grade', () => {
  // 4h of ±0.3 EM chop (warms up the 14-bar 15m average with ordinary candles), then the setup.
  const chop = Array.from({ length: 48 }, (_, i) => (i % 2 === 0 ? -0.3 : 0.3))
  const setup = [0.1, 0.4, 0.7, 0.95, 1.15, 1.1, 1.0, 0.9, 0.8, 0.7, 0.9, 1.3]
  const graded = { ...RAW, bigTrades: 'grade' as const }

  it('grades B when no big trade printed during the pullback', () => {
    const { P, E } = zone()
    const t = computeZoneRetest(path(P, E, [...chop, ...setup]), history(), graded, 0, false).trades.find((x) => x.zone === '+0.618x')!
    expect(t.grade).toBe('B')
  })

  it('skips the long when only a bearish big trade printed during the pullback', () => {
    const { P, E } = zone()
    const c = path(P, E, [...chop, ...setup])
    // Heavy selling inside the pullback: the 15m bar holding the 1.0 → 0.9 → 0.8 drop becomes a bearish big trade.
    const k = chop.length + 7
    c[k] = { ...c[k], volume: 50_000 }
    c[k + 1] = { ...c[k + 1], volume: 50_000 }
    expect(computeZoneRetest(c, history(), graded, 0, false).trades.some((x) => x.zone === '+0.618x')).toBe(false)
  })
})
