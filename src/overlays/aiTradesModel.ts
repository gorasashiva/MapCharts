// "AI Trades" — port of "AI trades.pine" (SUNDARI AI v5.8 - ATR Trailing SL). Pure OHLC math, no drawing.
//
// gamma = EMA(close, f1) − EMA(close, f2); delta = EMA(gamma, f3).
// BUY  (CE): gamma crosses over delta and high > previous high.
// SELL (PE): gamma crosses under delta and low < previous low.
// On each signal: a step line anchored to the signal candle's high (BUY) / low (SELL),
// four extension targets off the candle's range, and an ATR trailing stop that only
// tightens until the next signal.

import { ema, rma } from './shankyComboModel'

export interface AiTradesBar {
  high: number
  low: number
  close: number
}

export interface AiTradesOptions {
  f1: number
  f2: number
  f3: number
  atrLen: number
  atrMult: number
  /** Pine confirmOnClose: no signal on the still-forming last bar. */
  confirmOnClose: boolean
}

export const AI_TRADES_DEFAULTS: AiTradesOptions = { f1: 34, f2: 55, f3: 13, atrLen: 14, atrMult: 2, confirmOnClose: true }

/** Target extensions, in multiples of the signal candle's range, beyond its high (BUY) / low (SELL). */
export const AI_TARGET_FIBS = [0.786, 1.272, 1.886, 2.414]

export interface AiSignal {
  index: number
  dir: 1 | -1
  /** T1..T4 prices. */
  targets: number[]
  /** Last bar the target lines reach: the bar before the next signal, or the last bar. */
  end: number
}

export interface AiTradesResult {
  fast: number[]
  slow: number[]
  /** Step line value per bar (NaN before the first signal). */
  step: number[]
  /** ATR trailing stop per bar (NaN before the first signal). */
  trail: number[]
  signals: AiSignal[]
}

export function computeAiTrades(bars: AiTradesBar[], o: AiTradesOptions = AI_TRADES_DEFAULTS, lastBarOpen = true): AiTradesResult {
  const n = bars.length
  const close = bars.map((b) => b.close)
  const fast = ema(close, o.f1)
  const slow = ema(close, o.f2)
  const gamma = fast.map((v, i) => v - slow[i])
  const delta = ema(gamma, o.f3)
  const tr = bars.map((b, i) => (i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low))
  const atr = rma(tr, Math.max(1, o.atrLen))

  const step = new Array<number>(n).fill(NaN)
  const trail = new Array<number>(n).fill(NaN)
  const signals: AiSignal[] = []
  let stepV = NaN
  let sl = NaN
  let dir = 0

  for (let i = 0; i < n; i++) {
    const b = bars[i]
    let ce = false
    let pe = false
    if (i > 0 && !(o.confirmOnClose && lastBarOpen && i === n - 1)) {
      // Pine ta.crossover / crossunder (false while either series is na)
      ce = gamma[i] > delta[i] && gamma[i - 1] <= delta[i - 1] && b.high > bars[i - 1].high
      pe = gamma[i] < delta[i] && gamma[i - 1] >= delta[i - 1] && b.low < bars[i - 1].low
    }
    if (pe) stepV = b.low
    if (ce) stepV = b.high
    step[i] = stepV

    if (ce || pe) {
      const d = b.high - b.low
      if (signals.length) signals[signals.length - 1].end = i - 1
      signals.push({ index: i, dir: ce ? 1 : -1, targets: AI_TARGET_FIBS.map((f) => (ce ? b.high + d * f : b.low - d * f)), end: n - 1 })
    }

    const off = atr[i] * o.atrMult
    if (ce) {
      dir = 1
      sl = b.low - off
    } else if (pe) {
      dir = -1
      sl = b.high + off
    } else if (dir === 1) sl = Math.max(Number.isNaN(sl) ? 0 : sl, b.low - off)
    else if (dir === -1) sl = Math.min(Number.isNaN(sl) ? 999999.9 : sl, b.high + off)
    trail[i] = sl
  }
  return { fast, slow, step, trail, signals }
}
