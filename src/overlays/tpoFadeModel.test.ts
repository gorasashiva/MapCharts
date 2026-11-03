import { describe, expect, it } from 'vitest'
import { autoRowSize, computeTpoFade, tpoLevels, valueArea, type TfBar } from './tpoFadeModel'

const MIN = 60_000
const HOUR = 3_600_000

/** 5m bars from `start` for `hours`, oscillating around `mid` by ±`amp`, plus per-bar overrides. */
function day(start: number, hours: number, mid: number, amp: number, over: Record<number, Partial<TfBar>> = {}): TfBar[] {
  const out: TfBar[] = []
  for (let k = 0; k < hours * 12; k++) {
    const c = mid + amp * Math.sin(k / 3)
    out.push({ time: start + k * 5 * MIN, open: c, high: c + 0.5, low: c - 0.5, close: c, ...over[k] })
  }
  return out
}

describe('tpoFadeModel', () => {
  it('value area grows from the POC toward the busier neighbour', () => {
    expect(valueArea([1, 2, 9, 3, 1], 0.7)).toEqual({ poc: 2, lo: 2, hi: 3 })
    expect(valueArea([1, 2, 9, 3, 1], 0.85)).toEqual({ poc: 2, lo: 1, hi: 3 })
  })

  it('auto row size is $1 for gold and a round step for BTC', () => {
    expect(autoRowSize(3880)).toBe(1)
    expect(autoRowSize(78000)).toBe(20)
  })

  it('TPO levels count one print per 30-min bracket per row', () => {
    const start = Date.UTC(2026, 9, 26, 22)
    // 2 brackets at 100–101, 1 bracket at 105–106
    const bars: TfBar[] = [
      { time: start, open: 100, high: 101, low: 100, close: 100 },
      { time: start + 30 * MIN, open: 100, high: 101, low: 100, close: 100 },
      { time: start + 60 * MIN, open: 105, high: 106, low: 105, close: 105 },
    ]
    const lv = tpoLevels(bars, 0, 2, start, 1, 30, 0.5)
    expect(lv.poc).toBe(100.5)
    expect([lv.val, lv.vah]).toEqual([100, 102])
  })

  it('skips Sat / Sun sessions so Monday trades off Friday', () => {
    // Fri session (opens Thu 22:00 UTC), weekend stubs, Mon session (opens Sun 22:00 UTC)
    const thu = Date.UTC(2026, 9, 22, 22)
    const bars = [...day(thu, 24, 100, 5), ...day(thu + 24 * HOUR, 48, 200, 1), ...day(thu + 72 * HOUR, 24, 100, 5)]
    const r = computeTpoFade(bars, { openHourUTC: 22, skipWeekends: true, stopMin: 0 })
    const mon = r.sessions[r.sessions.length - 1]
    expect(new Date(mon.start).getUTCDay()).toBe(0) // Sunday 22:00 UTC open = Monday's session
    expect(mon.poc).toBeGreaterThan(90)
    expect(mon.poc).toBeLessThan(110) // Friday's profile, not the weekend's (~200)
  })

  it('places a sell limit past VAH, fills on a trade-through, and hits the target', () => {
    const d0 = Date.UTC(2026, 9, 26, 22) // Mon session
    const d1 = d0 + 24 * HOUR // Tue session
    const prev = day(d0, 24, 100, 4)
    // Tue: quiet at 100 until 08:00 UTC, spike up through VAH, then fall back to 100
    const tue = day(d1, 24, 100, 0.3, {})
    const k8 = 10 * 12 // 08:00 UTC is 10h after the 22:00 open
    tue[k8] = { ...tue[k8], high: 112, close: 104 }
    for (let k = k8 + 1; k < k8 + 24; k++) tue[k] = { ...tue[k], high: 101, low: 95, close: 98 }
    const r = computeTpoFade([...prev, ...tue], { openHourUTC: 22, skipWeekends: false, stopMin: 0, minRR: 0, stopAtr: 20 })
    const sess = r.sessions[r.sessions.length - 1]
    const short = sess.orders.find((o) => o.side < 0)!
    expect(short.entry).toBeGreaterThan(sess.vah)
    expect(short.status).toBe('filled')
    expect(short.trade?.exitReason).toBe('TP')
    expect(short.trade!.r!).toBeGreaterThan(0)
  })

  it('skips a side whose R:R to the POC is under the minimum', () => {
    const d0 = Date.UTC(2026, 9, 26, 22)
    const bars = [...day(d0, 24, 100, 4), ...day(d0 + 24 * HOUR, 24, 100, 0.3)]
    const r = computeTpoFade(bars, { openHourUTC: 22, skipWeekends: false, stopMin: 50, minRR: 2 })
    const sess = r.sessions[r.sessions.length - 1]
    expect(sess.orders.every((o) => o.status === 'skipped-rr')).toBe(true)
  })
})
