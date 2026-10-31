import { describe, expect, it } from 'vitest'
import { computeSessionReversal, nyWallClock, type SrBar } from './sessionReversalModel'

const M15 = 15 * 60_000
const DAY0 = Date.UTC(2026, 9, 5) // Mon 5 Oct 2026, New York on EDT (UTC-4)
const at = (h: number, m = 0): number => DAY0 + (h * 60 + m) * 60_000
const bar = (t: number, o: number, h: number, l: number, c: number): SrBar => ({ time: t, open: o, high: h, low: l, close: c })

/**
 * 06:00-20:00 UTC on 15m bars.
 *   London (02:00-05:00 NY = 06:00-09:00Z): range 100-110.
 *   NY AM  (08:30-11:00 NY = 12:30-15:00Z): opens 108, sweeps to 112, closes 106 -> bearish reversal, swing 112.
 *   NY PM  (13:30-16:00 NY = 17:30-20:00Z): first bar closes 106 < 112 -> short at the next open (106),
 *   stop 112, target 106 - 2 × 6 = 94, then sells off through it.
 */
function scenario(): SrBar[] {
  const out: SrBar[] = []
  for (let t = at(6); t < at(20); t += M15) {
    const ny = (t - at(12, 30)) / M15 // NY AM bar index
    const pm = (t - at(17, 30)) / M15 // NY PM bar index
    if (t === at(6)) out.push(bar(t, 105, 110, 100, 105))
    else if (ny < 0) out.push(bar(t, 105, 105.5, 104.5, 105))
    else if (ny === 0) out.push(bar(t, 108, 109, 107, 108))
    else if (ny === 1) out.push(bar(t, 108, 112, 108, 111))
    else if (ny < 9) out.push(bar(t, 111 - (ny - 2) * 0.6, 111.2 - (ny - 2) * 0.6, 109.9 - (ny - 2) * 0.6, 110.4 - (ny - 2) * 0.6))
    else if (ny === 9) out.push(bar(t, 107, 107.2, 105.8, 106)) // NY AM closes 106: below London's high and its own open
    else if (pm <= 0) out.push(bar(t, 106, 106.5, 105.5, 106))
    else out.push(bar(t, 106 - (pm - 1) * 2, 106.2 - (pm - 1) * 2, 105.5 - pm * 2, 106 - pm * 2))
  }
  return out
}

describe('computeSessionReversal', () => {
  it('detects the NY AM bearish reversal and shorts NY PM to its 2R target', () => {
    const r = computeSessionReversal(scenario())
    expect(r.reversals).toEqual([{ time: at(12, 45), price: 112, dir: -1, sid: 2 }])
    expect(r.trades).toHaveLength(1)
    expect(r.trades[0]).toMatchObject({ from: 2, sid: 3, dir: -1, entryTime: at(17, 45), entry: 106, stop: 112, target: 94, exitReason: 'TP', r: 2 })
    expect(r.rows[2]).toMatchObject({ trades: 1, wins: 1, totalR: 2 })
  })

  it('needs the session to close against its own open when needBody is on', () => {
    const bars = scenario()
    const i = bars.findIndex((b) => b.time === at(12, 30))
    bars[i] = bar(at(12, 30), 104, 109, 103.9, 108) // NY AM now opens at 104, below its 106 close
    expect(computeSessionReversal(bars).reversals).toHaveLength(0)
    expect(computeSessionReversal(bars, { needBody: false }).reversals).toHaveLength(1)
  })

  it('bar replay: a clipped series shows the state at that bar, consistent with the full run', () => {
    const bars = scenario()
    // Mid NY AM: the sweep happened but the session has not closed, so no reversal yet.
    expect(computeSessionReversal(bars.filter((b) => b.time <= at(13, 30))).reversals).toHaveLength(0)
    // Two bars into the short: trade open, stop / target lines plotted up to the cursor.
    const open = computeSessionReversal(bars.filter((b) => b.time <= at(18))).trades[0]
    expect(open).toMatchObject({ entry: 106, stop: 112, target: 94, plotEndTime: at(18) })
    expect(open.exitReason).toBeUndefined()
    // Replaying further reproduces the full run's trade.
    expect(computeSessionReversal(bars).trades[0]).toMatchObject({ entry: open.entry, stop: open.stop, target: open.target })
  })

  it('closes a trade still open at the session end at the next bar open', () => {
    const bars = scenario().filter((b) => b.time <= at(18))
    bars.push(bar(at(20), 104, 104.5, 103.5, 104)) // first bar after NY PM
    const t = computeSessionReversal(bars).trades[0]
    expect(t.exitReason).toBe('Session end')
    expect(t.r).toBeCloseTo((-1 * (104 - 106)) / 6, 9)
  })
})

describe('nyWallClock', () => {
  it('follows US daylight saving', () => {
    expect(new Date(nyWallClock(Date.UTC(2026, 6, 1, 12, 30))).getUTCHours()).toBe(8) // EDT
    expect(new Date(nyWallClock(Date.UTC(2026, 0, 15, 13, 30))).getUTCHours()).toBe(8) // EST
  })
})
