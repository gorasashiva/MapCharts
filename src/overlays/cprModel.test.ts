import { describe, expect, it } from 'vitest'
import { DAY_MS, HOUR_MS, buildPeriods, computeLevels, isWeekendSession, periodBounds, pivotLevels, type OHLCBar } from './cprModel'

const bar = (t: number, o: number, h: number, l: number, c: number): OHLCBar => ({ time: t, open: o, high: h, low: l, close: c })

describe('periodBounds', () => {
  it('days start at the session hour', () => {
    const t = Date.UTC(2026, 9, 5, 3, 30)
    expect(periodBounds(t, 'day', 0)).toEqual([Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 6)])
    // 03:30 is before a 05:00 session start, so it belongs to the previous day's session
    expect(periodBounds(t, 'day', 5)).toEqual([Date.UTC(2026, 9, 4, 5), Date.UTC(2026, 9, 5, 5)])
  })

  it('weeks start on Monday', () => {
    const sunday = Date.UTC(2026, 9, 11, 22) // Sun 11 Oct 2026
    expect(periodBounds(sunday, 'week', 0)).toEqual([Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 12)])
    const monday = Date.UTC(2026, 9, 12)
    expect(periodBounds(monday, 'week', 0)[0]).toBe(monday)
  })

  it('a 22:00 UTC (03:30 IST) open dates the session by the next day', () => {
    // Mon 5 Oct 2026 02:00 UTC sits in the session that opened Sun 4 Oct 22:00 UTC
    const t = Date.UTC(2026, 9, 5, 2)
    expect(periodBounds(t, 'day', 22)).toEqual([Date.UTC(2026, 9, 4, 22), Date.UTC(2026, 9, 5, 22)])
    // …which is Monday's session, so it opens the week
    expect(periodBounds(t, 'week', 22)).toEqual([Date.UTC(2026, 9, 4, 22), Date.UTC(2026, 9, 11, 22)])
    // Sun 4 Oct 21:00 UTC still belongs to the previous week
    expect(periodBounds(Date.UTC(2026, 9, 4, 21), 'week', 22)[1]).toBe(Date.UTC(2026, 9, 4, 22))
    // October opens with the session dated 1 Oct, i.e. 30 Sep 22:00 UTC
    expect(periodBounds(Date.UTC(2026, 9, 15), 'month', 22)).toEqual([Date.UTC(2026, 8, 30, 22), Date.UTC(2026, 9, 31, 22)])
  })

  it('months follow the calendar, including year roll', () => {
    expect(periodBounds(Date.UTC(2026, 11, 31, 23), 'month', 0)).toEqual([Date.UTC(2026, 11, 1), Date.UTC(2027, 0, 1)])
    expect(periodBounds(Date.UTC(2026, 1, 15), 'month', 0)).toEqual([Date.UTC(2026, 1, 1), Date.UTC(2026, 2, 1)])
  })
})

describe('buildPeriods', () => {
  it('aggregates OHLC per period', () => {
    const d0 = Date.UTC(2026, 9, 5)
    const bars = [bar(d0, 10, 12, 9, 11), bar(d0 + HOUR_MS, 11, 15, 10, 14), bar(d0 + DAY_MS, 14, 16, 13, 15)]
    const ps = buildPeriods(bars, 'day', 0)
    expect(ps).toHaveLength(2)
    expect(ps[0]).toMatchObject({ start: d0, open: 10, high: 15, low: 9, close: 14 })
    expect(ps[1]).toMatchObject({ start: d0 + DAY_MS, open: 14, high: 16, low: 13, close: 15 })
  })
})

describe('pivotLevels', () => {
  const prev = { high: 110, low: 90, close: 105 }

  it('computes CPR and traditional levels', () => {
    const lv = pivotLevels(prev)
    const p = (110 + 90 + 105) / 3
    expect(lv.pivot).toBeCloseTo(p)
    expect(lv.bc).toBeCloseTo(100) // (H+L)/2 sits below P when the close is strong
    expect(lv.tc).toBeCloseTo(2 * p - 100)
    expect(lv.r[0]).toBeCloseTo(2 * p - 90)
    expect(lv.s[0]).toBeCloseTo(2 * p - 110)
    expect(lv.r[1]).toBeCloseTo(p + 20)
    expect(lv.s[1]).toBeCloseTo(p - 20)
    expect(lv.r[2]).toBeCloseTo(110 + 2 * (p - 90))
    expect(lv.s[2]).toBeCloseTo(90 - 2 * (110 - p))
    expect(lv.r[3]).toBeCloseTo(3 * p + (110 - 270))
    expect(lv.s[3]).toBeCloseTo(3 * p - (330 - 90))
    expect(lv.prevHigh).toBe(110)
    expect(lv.prevLow).toBe(90)
    expect(lv.width).toBeCloseTo((lv.tc - lv.bc) / p)
  })

  it('keeps TC above BC on a weak close', () => {
    const lv = pivotLevels({ high: 110, low: 90, close: 92 })
    expect(lv.tc).toBeGreaterThanOrEqual(lv.bc)
    expect(lv.tc).toBeCloseTo(100)
  })

  it('levels are ordered S4 < … < S1 < BC ≤ TC < R1 < … < R4', () => {
    for (const type of ['traditional', 'classic'] as const) {
      const lv = pivotLevels(prev, type)
      const seq = [...[...lv.s].reverse(), lv.bc, lv.tc, ...lv.r]
      for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1])
    }
  })

  it('classic spaces R3/R4 by whole ranges', () => {
    const lv = pivotLevels(prev, 'classic')
    expect(lv.r[2] - lv.pivot).toBeCloseTo(40)
    expect(lv.pivot - lv.s[3]).toBeCloseTo(60)
  })
})

describe('computeLevels', () => {
  const d0 = Date.UTC(2026, 9, 1)
  // 8 days of hourly bars; day k trades around 100 + k
  const bars: OHLCBar[] = []
  for (let k = 0; k < 8; k++) for (let h = 0; h < 24; h++) bars.push(bar(d0 + k * DAY_MS + h * HOUR_MS, 100 + k, 101 + k, 99 + k, 100 + k))

  it('returns the last N periods, each built from the one before', () => {
    const anchor = d0 + 7 * DAY_MS + 5 * HOUR_MS
    const out = computeLevels(bars, 'day', 0, 5, anchor)
    expect(out).toHaveLength(5)
    expect(out[4].start).toBe(d0 + 7 * DAY_MS)
    expect(out[4].prevHigh).toBe(107) // day 6's high
    expect(out[0].start).toBe(d0 + 3 * DAY_MS)
    expect(out[0].prevLow).toBe(101) // day 2's low
  })

  it('anchored in the past (replay), ignores later data', () => {
    const anchor = d0 + 3 * DAY_MS + HOUR_MS
    const out = computeLevels(bars, 'day', 0, 5, anchor)
    expect(out.map((l) => l.start)).toEqual([d0 + DAY_MS, d0 + 2 * DAY_MS, d0 + 3 * DAY_MS])
    expect(out[2].prevHigh).toBe(103)
  })

  it('skips periods with no prior data', () => {
    expect(computeLevels(bars, 'day', 0, 3, d0 + 5 * HOUR_MS)).toEqual([])
  })
})

describe('gold sessions (22:00 UTC open, closed weekends)', () => {
  // Hourly bars Thu 1 Oct 22:00 UTC → Tue 6 Oct 22:00 UTC; the session dated D trades around 100 + day-of-month.
  const bars: OHLCBar[] = []
  for (let t = Date.UTC(2026, 8, 30, 22); t < Date.UTC(2026, 9, 6, 22); t += HOUR_MS) {
    const dom = new Date(t + 2 * HOUR_MS).getUTCDate() // session date
    const weekend = dom === 3 || dom === 4
    const base = 100 + dom
    bars.push(bar(t, base, base + (weekend ? 0.1 : 2), base - (weekend ? 0.1 : 2), base))
  }

  it('dates sessions so Saturday/Sunday are the closed ones', () => {
    expect(isWeekendSession(Date.UTC(2026, 9, 2, 23), 22)).toBe(true) // Fri 22:00+ → Saturday session
    expect(isWeekendSession(Date.UTC(2026, 9, 4, 23), 22)).toBe(false) // Sun 23:00 UTC = Monday 04:30 IST
  })

  it('Monday uses Friday, not the dead Sunday session', () => {
    const monday = Date.UTC(2026, 9, 5, 6)
    const [cur] = computeLevels(bars, 'day', 22, 1, monday, 'traditional', true)
    expect(cur.start).toBe(Date.UTC(2026, 9, 4, 22))
    expect(cur.prevHigh).toBe(104) // Friday 2 Oct: 102 + 2
    expect(cur.prevLow).toBe(100)
    // without the weekend skip it would be Sunday's 0.2-wide range
    expect(computeLevels(bars, 'day', 22, 1, monday)[0].prevHigh).toBeCloseTo(104.1)
  })

  it('draws no weekend sessions and steps back over them', () => {
    const out = computeLevels(bars, 'day', 22, 3, Date.UTC(2026, 9, 6, 6), 'traditional', true)
    expect(out.map((l) => new Date(l.start + 2 * HOUR_MS).getUTCDate())).toEqual([2, 5, 6]) // Fri, Mon, Tue
  })

  it('on a weekend anchor the last drawn session is Friday', () => {
    const out = computeLevels(bars, 'day', 22, 1, Date.UTC(2026, 9, 4, 12), 'traditional', true)
    expect(out[0].start).toBe(Date.UTC(2026, 9, 1, 22))
    expect(out[0].end).toBe(Date.UTC(2026, 9, 2, 22))
  })
})
