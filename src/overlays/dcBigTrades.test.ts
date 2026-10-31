import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { computeDcBigTrades, DC_BIG_TRADES_DEFAULTS, inferTick, type DcBigTradesOptions } from './dcBigTrades'

const MIN = 60_000
const BAR = 5 * MIN
const T0 = Date.UTC(2026, 0, 5)

const opts = (p: Partial<DcBigTradesOptions> = {}): DcBigTradesOptions => ({ ...DC_BIG_TRADES_DEFAULTS, ...p })

/** 14 quiet bars, then one big candle (o→c, range 100–110) at index 14; each extra adds 3 quiet bars + another big one. */
function series(o: number, c: number, extraBig: { o: number; c: number }[] = []): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < 14; i++) out.push({ time: T0 + i * BAR, open: 105, high: 105.5, low: 104.5, close: 105.1, volume: 1 })
  out.push({ time: T0 + 14 * BAR, open: o, high: 110, low: 100, close: c, volume: 100 })
  for (const b of extraBig) {
    for (let i = 0; i < 3; i++) out.push({ time: out[out.length - 1].time + BAR, open: 105, high: 105.5, low: 104.5, close: 105.1, volume: 1 })
    out.push({ time: out[out.length - 1].time + BAR, open: b.o, high: 110, low: 100, close: b.c, volume: 100 })
  }
  return out
}

/** 1m bars inside the candle at `idx`: the busiest one has hl2 = `price`. */
function ltfAt(c: Candle[], idx: number, price: number): Candle[] {
  const t = c[idx].time
  return [
    { time: t, open: 105, high: 105.2, low: 104.8, close: 105, volume: 5 },
    { time: t + MIN, open: price, high: price + 0.1, low: price - 0.1, close: price, volume: 50 },
    { time: t + 2 * MIN, open: 105, high: 105.2, low: 104.8, close: 105, volume: 5 },
  ]
}

function classify(o: number, c: number, price: number) {
  const candles = series(o, c)
  const r = computeDcBigTrades(candles, ltfAt(candles, 14, price), opts(), BAR)
  expect(r.marks).toHaveLength(1)
  return r.marks[0]
}

describe('computeDcBigTrades — patterns', () => {
  // Bull candle 102 → 108: body 102–108, upper wick 108–110.
  it.each([
    [102.5, 'absCont', 'magenta', 'bull'],
    [106, 'accept', 'teal', 'bull'],
    [109.5, 'absContra', 'teal', 'bear'],
    [108.5, 'reject', 'magenta', 'bear'],
  ])('bull candle, trade at %d → %s', (price, pattern, color, bias) => {
    const m = classify(102, 108, price)
    expect(m).toMatchObject({ pattern, color, bias, bull: true })
    expect(m.price).toBeCloseTo(price, 10)
  })

  // Bear candle 108 → 102: body 102–108, lower wick 100–102.
  it.each([
    [107.5, 'absCont', 'teal', 'bear'],
    [104, 'accept', 'magenta', 'bear'],
    [100.5, 'absContra', 'magenta', 'bull'],
    [101.5, 'reject', 'teal', 'bull'],
  ])('bear candle, trade at %d → %s', (price, pattern, color, bias) => {
    const m = classify(108, 102, price)
    expect(m).toMatchObject({ pattern, color, bias, bull: false })
    expect(m.price).toBeCloseTo(price, 10)
  })

  it('falls back to the close without 1m bars (a bull close sits at the body top → acceptance)', () => {
    const r = computeDcBigTrades(series(102, 108), null, opts(), BAR)
    expect(r.marks[0]).toMatchObject({ pattern: 'accept', price: 108 })
  })

  it('hides patterns that are switched off', () => {
    const candles = series(102, 108)
    expect(computeDcBigTrades(candles, ltfAt(candles, 14, 106), opts({ showAccept: false }), BAR).marks).toEqual([])
  })
})

describe('computeDcBigTrades — zones', () => {
  it('extends each zone until the next big trade; the last one runs one bar past the data', () => {
    const c = series(102, 108, [{ o: 102, c: 108 }])
    const r = computeDcBigTrades(c, null, opts(), BAR)
    expect(r.zones).toHaveLength(2)
    expect(r.zones[0].startTime).toBe(c[14].time)
    expect(r.zones[0].endTime).toBe(c[18].time)
    expect(r.zones[1].endTime).toBe(c[c.length - 1].time + BAR)
    // Thin zone: 2 ticks of 0.1 around the trade price.
    expect(r.zones[0].top - r.zones[0].bottom).toBeCloseTo(0.2, 10)
  })

  it('fixed mode caps each zone at extBars', () => {
    const c = series(102, 108, [{ o: 102, c: 108 }])
    const r = computeDcBigTrades(c, null, opts({ extMode: 'fixed', extBars: 2 }), BAR)
    expect(r.zones[0].endTime).toBe(c[16].time)
  })

  it('keeps only the latest maxZones, and biggest-only keeps one per session', () => {
    const c = series(102, 108, [{ o: 102, c: 108 }, { o: 102, c: 108 }])
    expect(computeDcBigTrades(c, null, opts(), BAR).zones).toHaveLength(3)
    expect(computeDcBigTrades(c, null, opts({ maxZones: 1 }), BAR).zones).toHaveLength(1)
    expect(computeDcBigTrades(c, null, opts({ biggestOnly: true }), BAR).zones).toHaveLength(1)
  })
})

describe('inferTick', () => {
  it('reads the price step from the decimals', () => {
    expect(inferTick(series(102, 108))).toBeCloseTo(0.1, 12)
    expect(inferTick([{ time: 0, open: 4146.53, high: 4146.6, low: 4146, close: 4146.5, volume: 1 }])).toBeCloseTo(0.01, 12)
  })
})

describe('computeBigTradeBias', () => {
  const T = Date.UTC(2026, 8, 1)
  /** 1m candles: `n` minutes of quiet ±0.1 chop around 100, volume 10. */
  function chop(n: number, start = 0): Candle[] {
    return Array.from({ length: n }, (_, i) => {
      const up = i % 2 === 0
      return { time: T + (start + i) * MIN, open: up ? 99.95 : 100.05, high: 100.1, low: 99.9, close: up ? 100.05 : 99.95, volume: 10 }
    })
  }
  /** A steady heavy-volume climb of `n` minutes from `from`. */
  function rally(n: number, start: number, from: number): Candle[] {
    return Array.from({ length: n }, (_, i) => {
      const o = from + i * 0.5
      return { time: T + (start + i) * MIN, open: o, high: o + 0.5, low: o, close: o + 0.5, volume: 5_000 }
    })
  }

  it('is neutral with no big trades', async () => {
    const { computeBigTradeBias } = await import('./dcBigTrades')
    const b = computeBigTradeBias(chop(1200), DC_BIG_TRADES_DEFAULTS)
    expect(b.rows.map((r) => r.label)).toEqual(['3m', '5m', '15m', '30m', '1h'])
    expect(b.rows.every((r) => r.status === 'none')).toBe(true)
    expect(b.suggestion).toBe('neutral')
  })

  it('turns bullish on a heavy-volume buying burst, and drops signals once price breaks back below them', async () => {
    const { computeBigTradeBias } = await import('./dcBigTrades')
    const base = chop(1200)
    const burst = rally(30, 1200, 100)
    const after = Array.from({ length: 10 }, (_, i) => ({ time: T + (1230 + i) * MIN, open: 115, high: 115.2, low: 114.8, close: 115, volume: 10 }))
    const b = computeBigTradeBias([...base, ...burst, ...after], DC_BIG_TRADES_DEFAULTS)
    const active = b.rows.filter((r) => r.status === 'active')
    expect(active.length).toBeGreaterThan(0)
    expect(active.every((r) => r.mark!.bias === 'bull')).toBe(true)
    expect(b.suggestion).toBe('bullish')
    expect(b.bullScore).toBeGreaterThan(0)
    // Price collapses back below every big-trade price: those signals are broken and stop voting.
    const crash = Array.from({ length: 5 }, (_, i) => ({ time: T + (1240 + i) * MIN, open: 99, high: 99.2, low: 98.8, close: 99, volume: 10 }))
    const b2 = computeBigTradeBias([...base, ...burst, ...after, ...crash], DC_BIG_TRADES_DEFAULTS)
    expect(b2.rows.filter((r) => r.mark?.bias === 'bull').every((r) => r.status !== 'active')).toBe(true)
    expect(b2.bullScore).toBe(0)
  })
})
