import { describe, expect, it } from 'vitest'
import { AI_TARGET_FIBS, computeAiTrades, type AiTradesBar, type AiTradesOptions } from './aiTradesModel'

const O: AiTradesOptions = { f1: 3, f2: 5, f3: 2, atrLen: 3, atrMult: 2, confirmOnClose: true }

/** Down leg, up leg, down leg — so both crosses occur. */
function series(): AiTradesBar[] {
  const closes: number[] = []
  let p = 100
  for (let i = 0; i < 20; i++) closes.push((p -= 1))
  for (let i = 0; i < 20; i++) closes.push((p += 1.5))
  for (let i = 0; i < 20; i++) closes.push((p -= 1.5))
  return closes.map((c, i) => ({ close: c, high: c + 0.5 + (i % 3) * 0.1, low: c - 0.5 - (i % 2) * 0.1 }))
}

describe('AI Trades (SUNDARI AI v5.8)', () => {
  const bars = series()
  const r = computeAiTrades(bars, O, false)
  const buy = r.signals.find((s) => s.dir > 0)!
  const sell = r.signals.find((s) => s.dir < 0 && s.index > buy.index)!

  it('BUY on the up leg with a higher high; SELL on the down leg with a lower low', () => {
    expect(buy.index).toBeGreaterThanOrEqual(20) // up leg starts at bar 20
    expect(buy.index).toBeLessThan(40)
    expect(bars[buy.index].high).toBeGreaterThan(bars[buy.index - 1].high)
    expect(sell.index).toBeGreaterThanOrEqual(40) // down leg starts at bar 40
    expect(bars[sell.index].low).toBeLessThan(bars[sell.index - 1].low)
  })

  it('a crossover without a higher high is not a BUY', () => {
    const b = bars.map((x) => ({ ...x }))
    b[buy.index].high = b[buy.index - 1].high
    expect(computeAiTrades(b, O, false).signals.some((s) => s.index === buy.index && s.dir > 0)).toBe(false)
  })

  it('T1–T4 extend the signal candle range beyond its high / low', () => {
    const c = bars[buy.index]
    AI_TARGET_FIBS.forEach((f, t) => expect(buy.targets[t]).toBeCloseTo(c.high + (c.high - c.low) * f))
    const s = bars[sell.index]
    AI_TARGET_FIBS.forEach((f, t) => expect(sell.targets[t]).toBeCloseTo(s.low - (s.high - s.low) * f))
  })

  it('each target set ends the bar before the next signal; the last runs to the last bar', () => {
    for (let k = 0; k + 1 < r.signals.length; k++) expect(r.signals[k].end).toBe(r.signals[k + 1].index - 1)
    expect(r.signals[r.signals.length - 1].end).toBe(bars.length - 1)
  })

  it('step line anchors to the signal high / low and holds until the next signal', () => {
    expect(r.step[buy.index]).toBe(bars[buy.index].high)
    expect(r.step[sell.index - 1]).toBe(bars[buy.index].high)
    expect(r.step[sell.index]).toBe(bars[sell.index].low)
  })

  it('ATR trail starts at low − mult × ATR and only tightens on a long', () => {
    expect(r.trail[buy.index]).toBeLessThan(bars[buy.index].low)
    for (let i = buy.index + 1; i < sell.index; i++) expect(r.trail[i]).toBeGreaterThanOrEqual(r.trail[i - 1])
    expect(r.trail[sell.index]).toBeGreaterThan(bars[sell.index].high)
  })

  it('confirm on close: no signal on the still-forming last bar', () => {
    const cut = bars.slice(0, buy.index + 1)
    expect(computeAiTrades(cut, O, true).signals.some((s) => s.index === buy.index)).toBe(false)
    expect(computeAiTrades(cut, { ...O, confirmOnClose: false }, true).signals.some((s) => s.index === buy.index)).toBe(true)
    expect(computeAiTrades(cut, O, false).signals.some((s) => s.index === buy.index)).toBe(true)
  })
})
