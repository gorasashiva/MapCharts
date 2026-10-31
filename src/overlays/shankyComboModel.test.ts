import { describe, expect, it } from 'vitest'
import {
  SHANKY_DEFAULTS,
  computeShankyCombo,
  detectShankyPatterns,
  ema,
  shankyCpr,
  shankyRainbow,
  shankyZigzag,
  sma,
  wma,
  type ShankyBar,
} from './shankyComboModel'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 5, 22, 0) // a session open (22:00 UTC) on a Sunday → Monday's session

/** Triangle wave of closes, 5m bars, amplitude `amp` around 1000 (`jitter` varies it per cycle). */
function wave(n: number, period = 40, amp = 20, jitter = 0): ShankyBar[] {
  const out: ShankyBar[] = []
  for (let i = 0; i < n; i++) {
    const ph = (i % period) / period
    const A = amp + jitter * ((Math.floor(i / period) % 3) - 1)
    const c = 1000 + A * (ph < 0.5 ? ph * 4 - 1 : 3 - ph * 4)
    out.push({ time: T0 + i * 5 * MIN, open: c, high: c + 0.5, low: c - 0.5, close: c })
  }
  return out
}

describe('ta helpers', () => {
  it('sma / wma / ema match hand values', () => {
    expect(sma([1, 2, 3, 4], 2).slice(1)).toEqual([1.5, 2.5, 3.5])
    expect(wma([1, 2, 3], 3)[2]).toBeCloseTo((1 + 4 + 9) / 6, 12)
    const e = ema([2, 4, 6, 8], 3)
    expect(e[1]).toBeNaN()
    expect(e[2]).toBe(4) // seeded with the SMA
    expect(e[3]).toBe(0.5 * 8 + 0.5 * 4)
  })
})

describe('zigzag', () => {
  const zz = shankyZigzag(wave(400), SHANKY_DEFAULTS)

  it('alternates swing highs and lows at the wave turns', () => {
    expect(zz.pivots.length).toBeGreaterThan(10)
    // The first pivot has nothing before it, so (as in Pine, price_b = na) it is styled as a low.
    const ps = zz.pivots.slice(1)
    for (let i = 1; i < ps.length; i++) expect(ps[i].high).toBe(!ps[i - 1].high)
    for (const p of ps) expect(Math.abs(p.price - (p.high ? 1020.5 : 979.5))).toBeLessThan(1.5)
  })

  it('draws one leg per pivot after the first and labels the price', () => {
    expect(zz.legs.length).toBe(zz.pivots.length - 1)
    const p = zz.pivots[zz.pivots.length - 1]
    expect(p.text).toContain(String(Number(p.price.toFixed(5))))
  })

  it('a regular wave repeats legs of equal size → Double Tap', () => {
    expect(zz.pivots.some((p) => p.text.includes('Double Tap(CBA)'))).toBe(true)
    // Constant legs never move the EW average off na (as in Pine), so there is no projection.
    expect(zz.projection).toBeNull()
  })

  it('legs of varying size project the next leg by their average', () => {
    const z = shankyZigzag(wave(600, 40, 20, 3), SHANKY_DEFAULTS)
    expect(z.projection).not.toBeNull()
    const [ta, a, tt, target] = z.projection!.mid
    expect(Math.abs(target - a)).toBeGreaterThan(30)
    expect(Math.abs(target - a)).toBeLessThan(50)
    expect(tt).toBeGreaterThan(ta)
    expect(Math.sign(target - a)).toBe(z.pivots[z.pivots.length - 1].high ? -1 : 1)
  })

  it('reverse line stays within the reversal % of the tracked extreme', () => {
    const last = zz.reverse[zz.reverse.length - 1]
    expect(last).toBeGreaterThan(979.5 - 1020.5 * 0.0026)
    expect(last).toBeLessThan(1020.5 + 1020.5 * 0.0026)
  })
})

describe('pattern detection', () => {
  const base = { gfa: 0, gda: 0, gba: 0, gfe: 0, fed: 0, feb: 0, fcb: 0, edc: 0, eda: 0, eba: 0, dcb: 0, cba: 0 }
  it('flags AB=CD and taps by their ratios', () => {
    expect(detectShankyPatterns({ ...base, cba: -1.4, dcb: -0.7 }, 0.05)).toContain('AB=CD(CBA, DCB)')
    expect(detectShankyPatterns({ ...base, cba: -1.02 }, 0.05)).toContain('Double Tap(CBA)')
    expect(detectShankyPatterns({ ...base, cba: 0.5 }, 0.05)).toEqual([])
  })
})

describe('CPR', () => {
  it('needs a fully loaded previous session and keeps the last N sessions', () => {
    const bars = wave(288 * 5) // five sessions of 5m bars
    const all = shankyCpr(bars, 10, 22, false)
    expect(all.length).toBe(4) // the first session has no previous one
    expect(shankyCpr(bars, 2, 22, false).length).toBe(2)
    for (const d of all) {
      expect(d.tc).toBeGreaterThanOrEqual(d.bc)
      expect(d.r[0]).toBeGreaterThan(d.pp)
      expect(d.s[0]).toBeLessThan(d.pp)
    }
  })
})

describe('rainbow', () => {
  it('aligns every series with the bars and classifies zones', () => {
    const bars = wave(300)
    const r = shankyRainbow(bars, SHANKY_DEFAULTS)
    for (const k of ['baseline', 'upperK', 'lowerK', 'sx', 'zone', 'sxState', 'arrow', 'diamond'] as const) expect(r[k]).toHaveLength(300)
    expect(r.zone.slice(150).some((z) => z === 1)).toBe(true)
    expect(r.zone.slice(150).some((z) => z === -1)).toBe(true)
    expect(r.arrow.some((a) => a === 1)).toBe(true)
    expect(r.arrow.some((a) => a === -1)).toBe(true)
  })

  it('every moving-average type produces finite values once warmed up', () => {
    const bars = wave(400)
    for (const t of ['SMA', 'EMA', 'DEMA', 'TEMA', 'LSMA', 'WMA', 'MF', 'VAMA', 'TMA', 'HMA', 'JMA', 'Kijun v2', 'EDSMA', 'McGinley'] as const) {
      const r = shankyRainbow(bars, { ...SHANKY_DEFAULTS, baselineType: t, sxType: t, exitType: t })
      expect(Number.isFinite(r.baseline[399]), t).toBe(true)
      if (t !== 'EDSMA') expect(Number.isFinite(r.sx[399]), t).toBe(true) // EDSMA isn't an SX choice in Pine (diverges at length 5)
    }
  })
})

describe('computeShankyCombo', () => {
  it('honours the section switches', () => {
    const bars = wave(300)
    const off = computeShankyCombo(bars, { ...SHANKY_DEFAULTS, showCPR: false, showAutoBS: false, showRainbow: false }, 22, false)
    expect(off.cpr).toEqual([])
    expect(off.zigzag).toBeNull()
    expect(off.rainbow).toBeNull()
    expect(computeShankyCombo(bars, SHANKY_DEFAULTS, 22, false).intraday).toBe(true)
  })
})
