import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { computeDailyZones, computeIvFade, IV_FADE_DEFAULTS, summarizeIvFade, type IvFadeOptions } from './ivFade'

const DAY = 86_400_000
const BAR = 3 * 60_000
const D0 = Date.UTC(2026, 0, 1)
const N_DAYS = 40
/** The intraday session under test: the day after the last complete daily bar. */
const TODAY = D0 + N_DAYS * DAY

/** Identical days (open 100, ±1%) → σ and the zone percentiles are constant: HOD zone = open +1%, LOD zone = open −1%. */
function dailyBars(extraToday?: Candle): Candle[] {
  const out: Candle[] = []
  for (let k = 0; k < N_DAYS; k++) out.push({ time: D0 + k * DAY, open: 100, high: 101, low: 99, close: 100, volume: 1 })
  if (extraToday) out.push(extraToday)
  return out
}

function opts(patch: Partial<IvFadeOptions> = {}): IvFadeOptions {
  return { ...IV_FADE_DEFAULTS, ...patch }
}

/** 15 quiet bars around 100, then a big-trade candle poking into the HOD zone (101) and closing back below it. */
function shortSetup(day = TODAY): Candle[] {
  const c: Candle[] = []
  for (let i = 0; i < 15; i++) c.push({ time: day + i * BAR, open: 100, high: 100.15, low: 99.95, close: 100.1, volume: 1 })
  c.push({ time: day + 15 * BAR, open: 100.5, high: 101.5, low: 100.2, close: 100.6, volume: 100 })
  return c
}

/** The next bar after the last one in `c`. */
const next = (c: Candle[], o: number, h: number, l: number, cl: number): Candle => ({
  time: c[c.length - 1].time + BAR,
  open: o,
  high: h,
  low: l,
  close: cl,
  volume: 1,
})

describe('computeDailyZones — f_daily port', () => {
  it('needs 20 extension samples before zones exist, then matches the constant-day extension', () => {
    const z = computeDailyZones(dailyBars(), 20, 250, 30, 70)
    expect(z).toHaveLength(N_DAYS)
    expect(isFinite(z[20].upLo)).toBe(false)
    const last = z[N_DAYS - 1]
    // Every day extends exactly 1% → upLo·σ = upHi·σ = 0.01.
    expect(last.upLo * last.sigma).toBeCloseTo(0.01, 10)
    expect(last.upHi * last.sigma).toBeCloseTo(0.01, 10)
    expect(last.dnLo * last.sigma).toBeCloseTo(0.01, 10)
  })

  it("never uses the current day (no lookahead): today's partial daily bar does not move today's zones", () => {
    const c = shortSetup()
    const a = computeIvFade(c, dailyBars(), null, opts(), BAR).days[0]
    const wild: Candle = { time: TODAY, open: 100, high: 150, low: 60, close: 120, volume: 1 }
    const b = computeIvFade(c, dailyBars(wild), null, opts(), BAR).days[0]
    expect(b).toEqual(a)
    expect(a.hodBot).toBeCloseTo(101, 8)
    expect(a.lodTop).toBeCloseTo(99, 8)
  })
})

describe('computeIvFade — trades', () => {
  it('reject short: sell-stop at the signal low fills next bar and hits the 2R target', () => {
    const c = shortSetup()
    c.push(next(c, 100.4, 100.45, 97, 97.5)) // open nearer the high → o→h→l→c: falls through entry, then target
    const r = computeIvFade(c, dailyBars(), null, opts(), BAR)
    expect(r.signals).toEqual([{ side: 'short', time: c[15].time, high: 101.5, low: 100.2 }])
    expect(r.trades).toHaveLength(1)
    const t = r.trades[0]
    expect(t.side).toBe('short')
    expect(t.entryTime).toBe(c[16].time)
    expect(t.entryPrice).toBe(100.2)
    expect(t.sl).toBeGreaterThan(101.5)
    expect(t.exitReason).toBe('tp')
    expect(t.exitPrice).toBeCloseTo(t.tp, 10)
    expect(t.r).toBeCloseTo(2, 10)
    expect(summarizeIvFade(r.trades)).toMatchObject({ closed: 1, wins: 1, winRate: 100 })
  })

  it('a gap below the sell-stop fills at the open', () => {
    const c = shortSetup()
    c.push(next(c, 100.0, 100.05, 99.9, 99.95))
    const t = computeIvFade(c, dailyBars(), null, opts(), BAR).trades[0]
    expect(t.entryPrice).toBe(100.0)
    expect(t.exitTime).toBeNull()
  })

  it('cancels the entry after validBars unfilled bars', () => {
    const c = shortSetup()
    for (let i = 0; i < 3; i++) c.push(next(c, 100.4, 100.5, 100.3, 100.4))
    c.push(next(c, 100.4, 100.45, 97, 97.5)) // would have filled — but the order is gone
    expect(computeIvFade(c, dailyBars(), null, opts({ validBars: 3 }), BAR).trades).toEqual([])
    expect(computeIvFade(c, dailyBars(), null, opts({ validBars: 4 }), BAR).trades).toHaveLength(1)
  })

  it('closes an open trade at the open of the bar after the day change', () => {
    const c = shortSetup()
    c.push(next(c, 100.4, 100.45, 100.1, 100.15)) // fills at 100.2, no exit
    const tomorrow = TODAY + DAY
    c.push({ time: tomorrow, open: 100.1, high: 100.2, low: 100.0, close: 100.1, volume: 1 })
    c.push({ time: tomorrow + BAR, open: 100.05, high: 100.1, low: 100.0, close: 100.05, volume: 1 })
    const t = computeIvFade(c, dailyBars(), null, opts(), BAR).trades[0]
    expect(t.exitReason).toBe('eod')
    expect(t.exitTime).toBe(tomorrow + BAR)
    expect(t.exitPrice).toBe(100.05)
    expect(t.pnl).toBeCloseTo(0.15, 10)
  })

  it('allows only maxPerSide signals per side per day', () => {
    const c = shortSetup()
    for (let i = 0; i < 15; i++) c.push(next(c, 100.6, 100.7, 100.5, 100.6)) // entry never fills, then expires
    c.push({ ...next(c, 100.5, 101.5, 100.2, 100.6), volume: 100 }) // a second reject candle
    expect(computeIvFade(c, dailyBars(), null, opts(), BAR).signals).toHaveLength(1)
    expect(computeIvFade(c, dailyBars(), null, opts({ maxPerSide: 2 }), BAR).signals).toHaveLength(2)
  })

  it('no zones (not enough daily history) → no signals', () => {
    expect(computeIvFade(shortSetup(), dailyBars().slice(0, 15), null, opts(), BAR).signals).toEqual([])
  })
})
