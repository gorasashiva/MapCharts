/**
 * HalfTrend — port of "halftrend.pine" (Alex Orekhov / everget, GPL-3.0).
 *
 * Over `amplitude` bars it tracks the highest high / lowest low and their SMAs.
 * In an uptrend the line ratchets up with the highest recent low and flips
 * down once the high SMA falls below it and price closes under the prior low;
 * the downtrend is the mirror. The channel is the line ± `channelDeviation` ×
 * ATR(100)/2, and a flip with ATR available is a Buy / Sell signal.
 *
 * Bars are evaluated like Pine: every bar, including the one still forming,
 * so the latest value can change until that bar closes. Pure — no DOM/engine.
 */

export interface HalfTrendBar {
  high: number
  low: number
  close: number
}

export interface HalfTrendOptions {
  amplitude: number
  channelDeviation: number
}

export const HALF_TREND_DEFAULTS: HalfTrendOptions = { amplitude: 2, channelDeviation: 2 }

const ATR_LEN = 100

export interface HalfTrendPoint {
  /** The HalfTrend line. */
  ht: number
  /** 0 = uptrend (blue), 1 = downtrend (red) — Pine's `trend`. */
  trend: 0 | 1
  /** Channel edges; NaN until ATR(100) is available. */
  atrHigh: number
  atrLow: number
  buy: boolean
  sell: boolean
}

/** Pine ta.atr: RMA of true range, NaN until `len` bars exist. */
function atrSeries(bars: HalfTrendBar[], len: number): number[] {
  const out = new Array<number>(bars.length).fill(NaN)
  let sum = 0
  let prev = NaN
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))
    if (i < len) {
      sum += tr
      if (i === len - 1) prev = sum / len
    } else prev = (prev * (len - 1) + tr) / len
    out[i] = prev
  }
  return out
}

export function computeHalfTrend(bars: HalfTrendBar[], opts: HalfTrendOptions = HALF_TREND_DEFAULTS): HalfTrendPoint[] {
  const n = bars.length
  const amp = Math.max(1, Math.round(opts.amplitude))
  const out: HalfTrendPoint[] = new Array(n)
  if (n === 0) return out
  const atr = atrSeries(bars, ATR_LEN)

  let trend: 0 | 1 = 0
  let nextTrend = 0
  let maxLowPrice = bars[0].low
  let minHighPrice = bars[0].high
  let up = NaN // NaN = Pine's na before the first bar
  let down = NaN
  let prevTrend: 0 | 1 | null = null

  for (let i = 0; i < n; i++) {
    const b = bars[i]
    const prevLow = i > 0 ? bars[i - 1].low : b.low
    const prevHigh = i > 0 ? bars[i - 1].high : b.high
    // highest high / lowest low and SMAs over the last `amp` bars (fewer at the start, like Pine's partial window).
    const from = Math.max(0, i - amp + 1)
    let hp = -Infinity
    let lp = Infinity
    let hs = 0
    let ls = 0
    for (let k = from; k <= i; k++) {
      if (bars[k].high > hp) hp = bars[k].high
      if (bars[k].low < lp) lp = bars[k].low
      hs += bars[k].high
      ls += bars[k].low
    }
    const full = i - from + 1 === amp
    const highma = full ? hs / amp : NaN
    const lowma = full ? ls / amp : NaN

    if (nextTrend === 1) {
      maxLowPrice = Math.max(lp, maxLowPrice)
      if (highma < maxLowPrice && b.close < prevLow) {
        trend = 1
        nextTrend = 0
        minHighPrice = hp
      }
    } else {
      minHighPrice = Math.min(hp, minHighPrice)
      if (lowma > minHighPrice && b.close > prevHigh) {
        trend = 0
        nextTrend = 1
        maxLowPrice = lp
      }
    }

    const atr2 = atr[i] / 2
    const dev = opts.channelDeviation * atr2
    let atrHigh: number
    let atrLow: number
    let arrowUp = NaN
    let arrowDown = NaN
    if (trend === 0) {
      if (prevTrend !== null && prevTrend !== 0) {
        up = down
        arrowUp = up - atr2
      } else up = isNaN(up) ? maxLowPrice : Math.max(maxLowPrice, up)
      atrHigh = up + dev
      atrLow = up - dev
    } else {
      if (prevTrend !== null && prevTrend !== 1) {
        down = up
        arrowDown = down + atr2
      } else down = isNaN(down) ? minHighPrice : Math.min(minHighPrice, down)
      atrHigh = down + dev
      atrLow = down - dev
    }

    out[i] = {
      ht: trend === 0 ? up : down,
      trend,
      atrHigh,
      atrLow,
      buy: !isNaN(arrowUp) && trend === 0 && prevTrend === 1,
      sell: !isNaN(arrowDown) && trend === 1 && prevTrend === 0,
    }
    prevTrend = trend
  }
  return out
}
