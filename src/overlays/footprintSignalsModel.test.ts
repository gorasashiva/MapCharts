import { describe, expect, it } from 'vitest'
import { computeFootprintSignals, fpBarStat, fpStats, gexConfluence, type FpBar, type FpSignalOptions } from './footprintSignalsModel'

const ROW = 1
/** A bar with evenly traded rows from low to high (1 buy + 1 sell each), plus extras per row. */
function bar(time: number, o: number, h: number, l: number, c: number, extra: Record<number, [number, number]> = {}): FpBar {
  const rows = new Map<number, [number, number]>()
  for (let r = Math.floor(l); r <= Math.floor(h); r++) rows.set(r, [1, 1])
  for (const [r, [b, s]] of Object.entries(extra)) {
    const e = rows.get(Number(r)) ?? [0, 0]
    rows.set(Number(r), [e[0] + b, e[1] + s])
  }
  return { time, open: o, high: h, low: l, close: c, rows }
}

/** A slow decline from 130 (stretched under its EMA), then whatever follows. */
function decline(n = 20): FpBar[] {
  const out: FpBar[] = []
  for (let i = 0; i < n; i++) {
    const top = 130 - i
    // some delta each bar, alternating, so a "normal" |delta| exists
    out.push(bar(i, top, top + 1, top - 3, top - 2, { [top - 2]: i % 2 ? [5, 0] : [0, 5] }))
  }
  return out
}
const ONLY = (k: keyof FpSignalOptions['setups']): Partial<FpSignalOptions> => ({
  setups: { stack: k === 'stack', absorb: k === 'absorb', trap: k === 'trap', diverge: k === 'diverge' },
})

describe('footprintSignalsModel', () => {
  it('finds stacked diagonal imbalances', () => {
    // buys at rows 101..103 each ≥ 3× the sells one row lower
    const rows = new Map<number, [number, number]>([
      [100, [1, 1]],
      [101, [9, 1]],
      [102, [9, 1]],
      [103, [9, 1]],
      [104, [1, 1]],
    ])
    expect(fpBarStat(rows, { imbalance: 3, imbalanceMinVol: 0.25, minStack: 3 }).stacks).toEqual([[101, 103, 1]])
  })

  it('absorption at a stretched swing low: long at the next open, stop under the low, target at 2R', () => {
    const bars = decline()
    // new low 105, heavy selling in its bottom rows, closes near the high
    bars.push(bar(20, 108, 110, 105, 109.5, { 105: [0, 40], 106: [0, 20] }))
    bars.push(bar(21, 109.5, 116, 109, 115))
    const { trades } = computeFootprintSignals(bars, ROW, ONLY('absorb'))
    expect(trades).toHaveLength(1)
    const t = trades[0]
    expect(t).toMatchObject({ setup: 'absorb', side: 1, signalIndex: 20, entryIndex: 21, entry: 109.5, stop: 104 })
    expect(t.target).toBeCloseTo(109.5 + 2 * 5.5)
    expect(t.outcome).toBe('open')
  })

  it('ignores the same absorption when price is not stretched from the EMA', () => {
    const flat: FpBar[] = []
    for (let i = 0; i < 20; i++) flat.push(bar(i, 110, 112, 107, 110))
    flat.push(bar(20, 108, 110, 105, 109.5, { 105: [0, 40], 106: [0, 20] }))
    flat.push(bar(21, 109.5, 116, 109, 115))
    expect(computeFootprintSignals(flat, ROW, { ...ONLY('absorb'), maxRiskAtr: 5 }).trades).toHaveLength(0)
    expect(computeFootprintSignals(flat, ROW, { ...ONLY('absorb'), maxRiskAtr: 5, stretchAtr: 0 }).trades).toHaveLength(1)
  })

  it('trapped sellers: heavy negative delta at a swing low that closes high', () => {
    const bars = decline()
    // selling spread over the bar (not at the low, so not absorption), closes high
    bars.push(bar(20, 108, 110, 105, 109.5, { 107: [0, 30], 108: [0, 30], 109: [0, 30] }))
    const { trades } = computeFootprintSignals(bars, ROW, ONLY('trap'))
    expect(trades.map((t) => [t.setup, t.side, t.outcome])).toEqual([['trap', 1, 'pending']])
  })

  it('follows a trade to its target or stop (stop first when a bar touches both)', () => {
    const base = decline()
    base.push(bar(20, 108, 110, 105, 109.5, { 105: [0, 40], 106: [0, 20] }))
    const win = [...base, bar(21, 109.5, 112, 109, 111), bar(22, 111, 121, 110, 120)]
    expect(computeFootprintSignals(win, ROW, ONLY('absorb')).trades[0]).toMatchObject({ outcome: 'target', exitIndex: 22, r: 2 })
    const both = [...base, bar(21, 109.5, 125, 100, 110)]
    expect(computeFootprintSignals(both, ROW, ONLY('absorb')).trades[0]).toMatchObject({ outcome: 'stop', r: -1 })
  })

  it('never looks ahead: a prefix of the bars gives the same signals', () => {
    const bars = decline(40)
    bars.splice(25, 1, bar(25, 105, 106, 100, 105.5, { 100: [0, 50] }))
    const full = computeFootprintSignals(bars, ROW, ONLY('absorb')).trades
    for (let n = 22; n < bars.length; n++) {
      const pre = computeFootprintSignals(bars.slice(0, n), ROW, ONLY('absorb')).trades.filter((t) => t.signalIndex < n - 1)
      expect(pre.map((t) => [t.signalIndex, t.side])).toEqual(full.filter((t) => t.signalIndex < n - 1).map((t) => [t.signalIndex, t.side]))
    }
  })

  it('scores win rate, expectancy and drawdown in R', () => {
    const t = (r: number | null) => ({ r }) as Parameters<typeof fpStats>[0][number]
    expect(fpStats([t(2), t(-1), t(-1), t(2), t(null)])).toMatchObject({ trades: 4, wins: 2, winRate: 0.5, avgR: 0.5, totalR: 2, maxDdR: 2, profitFactor: 2 })
  })
})

describe('footprint signals × GEX', () => {
  const levels = [
    { price: 100, label: 'S1', strength: 80 },
    { price: 104, label: 'HVL', strength: 50 },
    { price: 112, label: 'R1', strength: 90 },
  ]
  it('matches a long whose low tested a GEX level, with the next level ≥ 1R away as a second target', () => {
    const m = gexConfluence({ side: 1, zone: [100.3, 103], entry: 102, stop: 99.8 }, levels, 2)
    expect(m?.at.label).toBe('S1')
    // HVL at 104 is under 1R (risk 2.2) from 102? 2.0 < 2.2 → skip; R1 at 112
    expect(m?.next?.label).toBe('R1')
  })
  it('no match when the extreme is not near a level', () => {
    expect(gexConfluence({ side: 1, zone: [102, 103], entry: 103, stop: 101.8 }, levels, 2)).toBeNull()
    // a short tests its high
    expect(gexConfluence({ side: -1, zone: [109, 111.6], entry: 110, stop: 112 }, levels, 2)?.at.label).toBe('R1')
  })
})
