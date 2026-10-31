import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { briefing, buildContext, completed, findZoneSetup, scanIbBreakout, sessionContext, timingAt, type CandlesByTf } from './analysis'
import type { ProfileZone } from '../overlays/profileZones'

const DAY = 86_400_000
const H = 3_600_000
const M5 = 300_000
// Wednesday 2026-09-23 00:00 UTC = 05:30 IST.
const D0 = Date.UTC(2026, 8, 23)

const bar = (time: number, o: number, h: number, l: number, c: number, v = 10): Candle => ({ time, open: o, high: h, low: l, close: c, volume: v })

/** 1h history: 25 prior days whose 00:00+01:00 UTC range is `ibRange` pts, flat elsewhere. */
function hourly(days = 25, ibRange = 10): Candle[] {
  const out: Candle[] = []
  for (let d = days; d >= 1; d--) {
    for (let h = 0; h < 24; h++) {
      const t = D0 - d * DAY + h * H
      const r = h < 2 ? ibRange / 2 : 2
      out.push(bar(t, 100, 100 + r, 100 - r, 100))
    }
  }
  return out
}

/** Today's 5m bars: IB 05:30–07:30 IST spans 95–110 (15 > avg 10), then `after` bars. */
function fiveMin(after: [number, number, number, number][]): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < 24; i++) {
    const t = D0 + i * M5
    out.push(i === 5 ? bar(t, 100, 110, 99, 105) : i === 10 ? bar(t, 100, 101, 95, 100) : bar(t, 100, 102, 98, 101))
  }
  after.forEach(([o, h, l, c], j) => out.push(bar(D0 + (24 + j) * M5, o, h, l, c)))
  return out
}

describe('timing', () => {
  it('flags weekend, IST hours and the historically bad hours', () => {
    expect(timingAt(D0 + 30 * 60_000)).toMatchObject({ istHour: 6, weekend: false, mainWindow: true, badHour: false })
    expect(timingAt(Date.UTC(2026, 8, 26, 12))).toMatchObject({ weekend: true, istHour: 17, badHour: true })
  })

  it('drops the still-forming last bar', () => {
    const c = [bar(0, 1, 1, 1, 1), bar(M5, 1, 1, 1, 1)]
    expect(completed(c, M5, M5 + 1000)).toHaveLength(1)
    expect(completed(c, M5, 2 * M5)).toHaveLength(2)
  })
})

describe('session / Initial Balance', () => {
  it('builds today’s IB from 5m and compares with the 20-day 1h average', () => {
    const s = sessionContext(fiveMin([]), hourly(), D0 + 2 * H + M5)!
    expect(s).toMatchObject({ ibHigh: 110, ibLow: 95, ibWidth: 15, ibAvg20: 10, ibWide: true, ibDone: true })
  })
})

describe('IB breakout scanner', () => {
  const run = (after: [number, number, number, number][], nowBars = after.length) => {
    const c5 = fiveMin(after)
    const data: CandlesByTf = { '5m': c5, '1h': hourly(), '1m': c5 }
    const now = D0 + (24 + nowBars) * M5
    const ctx = buildContext('XAUUSDT', data, now)!
    return scanIbBreakout(ctx, c5)
  }

  it('fires a fresh long on the first close above the IB with stop at the IB low', () => {
    const idea = run([[105, 109, 104, 108], [108, 112, 107, 111]])!
    expect(idea).toMatchObject({ side: 'long', status: 'fresh', entry: 111, stop: 95, targets: [125, 140] })
    expect(idea.reasons.join(' ')).toMatch(/wider than its 20-day average/)
  })

  it('stays active afterwards but disappears once stopped out', () => {
    expect(run([[108, 112, 107, 111], [111, 113, 110, 112]])!.status).toBe('active')
    expect(run([[108, 112, 107, 111], [111, 111, 94, 96]])).toBeNull()
  })

  it('ignores narrow-IB days', () => {
    const c5 = fiveMin([[108, 112, 107, 111]])
    const ctx = buildContext('X', { '5m': c5, '1h': hourly(25, 40), '1m': c5 }, D0 + 25 * M5)!
    expect(ctx.session?.ibWide).toBe(false)
    expect(scanIbBreakout(ctx, c5)).toBeNull()
  })
})

describe('zone setups', () => {
  const zone = (lo: number, hi: number, over: Partial<ProfileZone> = {}): ProfileZone => ({ lo, hi, kind: 'demand', hasPoc: false, volShare: 0.2, buyPct: 60, touches: 2, rejections: 2, score: 72, strength: 'Strong', ...over })
  const b = (i: number, o: number, h: number, l: number, c: number): Candle => bar(D0 + i * M5, o, h, l, c)
  // Support 100–102, resistance 110–112, session range 95–115.
  const zones = [zone(100, 102), zone(110, 112, { kind: 'supply', buyPct: 40 })]

  it('flags a bounce off an aligned support with stop beyond the zone and the next zone as T1', () => {
    const bars = [b(0, 106, 107, 105, 106), b(1, 105, 105, 103, 104), b(2, 104, 104.5, 101, 103.5)]
    const s = findZoneSetup(bars, zones, 115, 95)!
    expect(s).toMatchObject({ type: 'bounce', side: 1, entry: 103.5, targets: [110, 115] })
    expect(s.stop).toBeCloseTo(99.8)
    expect(s.rr).toBeCloseTo(6.5 / 3.7)
  })

  it('flags a breakout after two closes beyond a zone, stop at its midpoint', () => {
    const bars = [b(0, 109, 111, 108, 109.5), b(1, 110, 113, 110, 112.5), b(2, 112.5, 114, 112, 113)]
    const s = findZoneSetup(bars, zones, 120, 95)!
    expect(s).toMatchObject({ type: 'breakout', side: 1, entry: 113, stop: 111, targets: [120] })
  })

  it('skips bounces where the wrong side dominates, weak zones, poor R:R, and triggers already resolved', () => {
    const bars = [b(0, 106, 107, 105, 106), b(1, 105, 105, 103, 104), b(2, 104, 104.5, 101, 103.5)]
    expect(findZoneSetup(bars, [zone(100, 102, { buyPct: 40 })], 115, 95)).toBeNull()
    expect(findZoneSetup(bars, [zone(100, 102, { score: 30, strength: 'Weak' })], 115, 95)).toBeNull()
    expect(findZoneSetup(bars, [zone(100, 102)], 104, 95)).toBeNull() // T1 = session high 104 → R:R 0.1
    const stopped = [...bars, b(3, 103.5, 103.5, 99, 99.5)]
    expect(findZoneSetup(stopped, zones, 115, 95)).toBeNull()
  })
})

describe('briefing', () => {
  it('is compact JSON with the context the LLM needs', () => {
    const c5 = fiveMin([[108, 112, 107, 111]])
    const ctx = buildContext('XAUUSDT', { '5m': c5, '1h': hourly(), '1m': c5 }, D0 + 26 * M5)!
    const b = JSON.parse(briefing(ctx, []))
    expect(b.symbol).toBe('XAUUSDT')
    expect(b.initial_balance.wider_than_average).toBe(true)
    expect(Array.isArray(b.timeframes)).toBe(true)
  })
})
