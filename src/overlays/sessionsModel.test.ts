import { describe, expect, it } from 'vitest'
import { computeSessions, tzOffsetMin, type SessBar } from './sessionsModel'

const M15 = 15 * 60_000
const H = 3_600_000
/** 15m bars across one UTC day with a gentle up-drift, high = low + 1. */
function day(d0: number): SessBar[] {
  return Array.from({ length: 96 }, (_, k) => ({ time: d0 + k * M15, high: 101 + k * 0.1, low: 100 + k * 0.1 }))
}

describe('daylight saving', () => {
  it('London follows BST, New York follows EDT, Tokyo has none', () => {
    expect(tzOffsetMin('Europe/London', Date.UTC(2026, 6, 1))).toBe(60)
    expect(tzOffsetMin('Europe/London', Date.UTC(2026, 0, 15))).toBe(0)
    // 2026 BST ends Sun 25 Oct 01:00 UTC
    expect(tzOffsetMin('Europe/London', Date.UTC(2026, 9, 25, 0, 59))).toBe(60)
    expect(tzOffsetMin('Europe/London', Date.UTC(2026, 9, 25, 1, 0))).toBe(0)
    expect(tzOffsetMin('America/New_York', Date.UTC(2026, 6, 1))).toBe(-240)
    expect(tzOffsetMin('America/New_York', Date.UTC(2026, 0, 15))).toBe(-300)
    expect(tzOffsetMin('Asia/Tokyo', Date.UTC(2026, 6, 1))).toBe(540)
  })

  it('sessions shift by an hour in UTC between summer and winter', () => {
    const summer = computeSessions(day(Date.UTC(2026, 6, 1))) // Wed 1 Jul 2026
    const winter = computeSessions(day(Date.UTC(2026, 0, 14))) // Wed 14 Jan 2026
    const at = (r: ReturnType<typeof computeSessions>, name: string) => r.boxes.find((b) => b.name === name)!
    expect(new Date(at(summer, 'London').start).getUTCHours()).toBe(7) // 08:00 BST
    expect(new Date(at(winter, 'London').start).getUTCHours()).toBe(8) // 08:00 GMT
    expect(new Date(at(summer, 'New York').start).getUTCHours()).toBe(12) // 08:00 EDT
    expect(new Date(at(winter, 'New York').start).getUTCHours()).toBe(13) // 08:00 EST
    expect(new Date(at(summer, 'Asia').start).getUTCHours()).toBe(0) // 09:00 JST
    expect(new Date(at(winter, 'Asia').start).getUTCHours()).toBe(0)
  })
})

describe('computeSessions', () => {
  it('session box spans only its own bars and holds their high / low', () => {
    const d0 = Date.UTC(2026, 6, 1)
    const london = computeSessions(day(d0)).boxes.find((b) => b.name === 'London')!
    expect(london.start).toBe(d0 + 7 * H)
    expect(london.end).toBe(d0 + 16 * H - M15) // 08:00–17:00 BST = 07:00–16:00 UTC
    expect(london.low).toBeCloseTo(100 + 28 * 0.1, 9)
    expect(london.high).toBeCloseTo(101 + 63 * 0.1, 9)
    expect(london.scheduledEnd).toBe(d0 + 16 * H)
  })

  it('a session still open on the last bar is live and keeps growing', () => {
    const d0 = Date.UTC(2026, 6, 1)
    const bars = day(d0).slice(0, 7 * 4 + 6) // up to 08:15 UTC (London open since 07:00)
    const london = computeSessions(bars).boxes.find((b) => b.name === 'London')!
    expect(london.live).toBe(true)
    expect(london.end).toBe(bars[bars.length - 1].time)
  })

  it('skips weekend sessions by default', () => {
    const sat = Date.UTC(2026, 6, 4)
    expect(computeSessions(day(sat)).boxes).toHaveLength(0)
    expect(computeSessions(day(sat), { weekdaysOnly: false }).boxes.length).toBeGreaterThan(0)
  })

  it('previous 1H / 4H high & low come from the last completed period only', () => {
    const d0 = Date.UTC(2026, 6, 1)
    const r = computeSessions(day(d0))
    const seg = r.prev1h.find((s) => s.from === d0 + 5 * H)! // during 05:00–06:00 UTC: previous hour 04:00–05:00
    expect(seg.low).toBeCloseTo(100 + 16 * 0.1, 9)
    expect(seg.high).toBeCloseTo(101 + 19 * 0.1, 9)
    expect(seg.to).toBe(d0 + 6 * H - M15)
    const s4 = r.prev4h.find((s) => s.from === d0 + 8 * H)! // 08:00–12:00 uses 04:00–08:00
    expect(s4.low).toBeCloseTo(100 + 16 * 0.1, 9)
    expect(s4.high).toBeCloseTo(101 + 31 * 0.1, 9)
    expect(r.prev1h[0].from).toBe(d0 + H) // the first hour has no previous hour
  })

  it('no 1H levels on a 4H chart, none at all above 4H', () => {
    const four = Array.from({ length: 12 }, (_, k) => ({ time: Date.UTC(2026, 6, 1) + k * 4 * H, high: 2, low: 1 }))
    const r = computeSessions(four)
    expect(r.prev1h).toHaveLength(0)
    expect(r.prev4h.length).toBeGreaterThan(0)
  })
})
