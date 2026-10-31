import { describe, expect, it } from 'vitest'
import type { OHLCBar } from './ivWallsModel'
import { IV_ZONES_DEFAULTS, computeIvZones, daysPerYear, expectedMove } from './ivZonesModel'

const HOUR = 3_600_000
const DAY = 24 * HOUR
// Monday 2026-09-07 00:00 UTC.
const MON = Date.UTC(2026, 8, 7)

/** Hourly bars for whole UTC days; day d closes at closes[d]. */
function hourly(closes: number[]): OHLCBar[] {
  const out: OHLCBar[] = []
  closes.forEach((c, d) => {
    for (let h = 0; h < 24; h++) out.push({ time: MON + d * DAY + h * HOUR, open: c, high: c + 1, low: c - 1, close: c })
  })
  return out
}

describe('expectedMove', () => {
  it('matches the Pine formula', () => {
    expect(expectedMove(2000, 0.16, 1, 1, 252)).toBeCloseTo((2000 * 0.16) / Math.sqrt(252), 9)
    expect(expectedMove(2000, 0.16, 1, 4, 252)).toBeCloseTo((2 * 2000 * 0.16) / Math.sqrt(252), 9)
    expect(daysPerYear(true)).toBe(252)
    expect(daysPerYear(false)).toBe(365)
  })
})

describe('computeIvZones — auto', () => {
  it('anchors at the previous close and uses the typed IV first', () => {
    const s = computeIvZones(hourly([100, 101, 102, 103, 104]), { ...IV_ZONES_DEFAULTS, ivOverridePct: 20 }, 0, false, 0.5)
    expect(s).toHaveLength(1)
    const today = s[0]
    expect(today.prevClose).toBe(103)
    expect(today.ivSource).toBe('override')
    const em = expectedMove(103, 0.2, 1, 1, 365)
    expect(today.em).toBeCloseTo(em, 9)
    expect(today.zones).toHaveLength(6)
    const plus1 = today.zones.find((z) => z.tag === '+1x')!
    expect(plus1.mid).toBeCloseTo(103 + em, 9)
    expect(plus1.top - plus1.bottom).toBeCloseTo(em * IV_ZONES_DEFAULTS.zoneFrac, 9)
    expect(today.zones.find((z) => z.tag === '-0.5x')!.kind).toBe('sup')
  })

  it('uses the live option IV for today and HV for past sessions', () => {
    const s = computeIvZones(hourly([100, 102, 101, 103, 102, 104, 103]), { ...IV_ZONES_DEFAULTS, showHistory: true, historyDays: 2, hvLookback: 3 }, 0, false, 0.3)
    expect(s.map((x) => x.ivSource)).toEqual(['hv', 'hv', 'implied'])
    expect(s[2].iv).toBe(0.3)
  })

  it('skips weekend sessions for closed-weekend symbols, so Monday uses Friday', () => {
    // Mon..Sun then Mon: the Sat/Sun closes must not anchor Monday.
    const s = computeIvZones(hourly([100, 100, 100, 100, 110, 999, 999, 112]), { ...IV_ZONES_DEFAULTS, ivOverridePct: 15 }, 0, true, null)
    expect(s[s.length - 1].prevClose).toBe(110)
  })

  it('needs a full HV lookback before sizing zones from realized vol', () => {
    const closes = [100, 102, 101, 103, 102, 104, 103]
    expect(computeIvZones(hourly(closes), { ...IV_ZONES_DEFAULTS, hvLookback: 10 }, 0, false, null)[0].zones).toHaveLength(0)
    expect(computeIvZones(hourly(closes), { ...IV_ZONES_DEFAULTS, hvLookback: 5 }, 0, false, null)[0].ivSource).toBe('hv')
  })

  it('draws nothing for a session with no previous close', () => {
    expect(computeIvZones(hourly([100]), IV_ZONES_DEFAULTS, 0, false, 0.3)[0].zones).toHaveLength(0)
  })
})

describe('computeIvZones — manual', () => {
  it('converts typed walls and colours them against the session open', () => {
    const opts = { ...IV_ZONES_DEFAULTS, mode: 'manual' as const, manRatio: 10, manHalf: 2, walls: [9, 11, 0, 0, 0, 0] }
    const z = computeIvZones(hourly([100, 101]), opts, 0, false, null)[0].zones
    expect(z).toHaveLength(2)
    expect(z[0]).toMatchObject({ mid: 90, top: 92, bottom: 88, kind: 'sup' })
    expect(z[1]).toMatchObject({ mid: 110, kind: 'res' })
  })
})
