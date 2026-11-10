import type { Candle } from '../core/types'

/** Wilder's Parabolic SAR. Returns the stop value per bar (null on bar 0).
 *  Uptrend: SAR sits below price and rises toward it. A bar that trades through
 *  the SAR flips the trend and the SAR jumps to the prior extreme point (EP).
 *  The acceleration factor starts at `step` and grows by `step` each time the
 *  EP makes a new extreme, capped at `maxStep`. */
export function parabolicSar(candles: Candle[], step = 0.02, maxStep = 0.2): (number | null)[] {
  const n = candles.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (n < 2) return out
  let up = candles[1].close >= candles[0].close
  let ep = up ? candles[0].high : candles[0].low
  let sar = up ? candles[0].low : candles[0].high
  let af = step
  for (let i = 1; i < n; i++) {
    const c = candles[i]
    const p1 = candles[i - 1]
    const p2 = i >= 2 ? candles[i - 2] : p1
    let next = sar + af * (ep - sar)
    if (up) {
      // SAR may not rise into the prior two bars' lows
      next = Math.min(next, p1.low, p2.low)
      if (c.low < next) {
        up = false
        next = ep
        ep = c.low
        af = step
      } else if (c.high > ep) {
        ep = c.high
        af = Math.min(af + step, maxStep)
      }
    } else {
      // SAR may not fall into the prior two bars' highs
      next = Math.max(next, p1.high, p2.high)
      if (c.high > next) {
        up = true
        next = ep
        ep = c.high
        af = step
      } else if (c.low < ep) {
        ep = c.low
        af = Math.min(af + step, maxStep)
      }
    }
    sar = next
    out[i] = sar
  }
  return out
}
