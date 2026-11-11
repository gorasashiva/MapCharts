import { describe, expect, it } from 'vitest'
import { computeSessionProfiles, volumeProfileOf } from './sessionProfileModel'
import type { Candle } from '../core/types'

const candle = (time: number, low: number, high: number, volume: number): Candle =>
  ({ time, open: low, high, low, close: high, volume }) as Candle

describe('volumeProfileOf', () => {
  it('puts the POC on the heaviest price and the value area around it', () => {
    // wide, light bars across 90..110, plus one heavy bar at 100..100.5
    const bars: Candle[] = []
    for (let i = 0; i < 10; i++) bars.push(candle(i * 60_000, 90, 110, 1))
    bars.push(candle(10 * 60_000, 100, 100.5, 100))
    const p = volumeProfileOf(bars, 20, 70)!
    expect(p.poc).toBeGreaterThanOrEqual(100)
    expect(p.poc).toBeLessThanOrEqual(100.5 + p.step)
    expect(p.vah).toBeGreaterThanOrEqual(p.poc)
    expect(p.val).toBeLessThanOrEqual(p.poc)
    const inVa = p.bins.slice(p.valRow, p.vahRow + 1).reduce((a, b) => a + b, 0)
    expect(inVa / p.totalVolume).toBeGreaterThanOrEqual(0.7)
  })

  it('returns null for a flat range or no volume', () => {
    expect(volumeProfileOf([candle(0, 5, 5, 10)], 10, 70)).toBeNull()
    expect(volumeProfileOf([candle(0, 5, 6, 0)], 10, 70)).toBeNull()
  })
})

describe('computeSessionProfiles', () => {
  it('builds one profile per day and keeps every candle volume', () => {
    // hourly candles over two UTC days, one enabled all-day session
    const candles: Candle[] = []
    const day0 = Date.UTC(2026, 0, 5) // a Monday
    for (let h = 0; h < 48; h++) {
      const t = day0 + h * 3_600_000
      candles.push(candle(t, 100 + (h % 5), 102 + (h % 5), 1 + (h % 3)))
    }
    const sessions = [{ name: 'Day', tz: 'UTC' as const, start: 0, end: 1440, enabled: true }]
    const profiles = computeSessionProfiles(candles, { sessions, weekdaysOnly: false, rows: 12, valueAreaPct: 70 })
    expect(profiles.length).toBe(2)
    const total = profiles.reduce((a, p) => a + p.totalVolume, 0)
    const all = candles.reduce((a, c) => a + c.volume, 0)
    expect(total).toBeCloseTo(all, 6)
    for (const p of profiles) {
      expect(p.vah).toBeGreaterThanOrEqual(p.poc)
      expect(p.val).toBeLessThanOrEqual(p.poc)
      expect(p.barCount).toBe(24)
    }
  })
})
