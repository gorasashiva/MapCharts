import type { Candle } from '../core/types'
import type { IndicatorDef, IndicatorOutput } from './types'
import { intParam, smaSeries } from './helpers'

/**
 * Stochastic Oscillator (the common "slow" form):
 *   raw %K = 100 * (close - lowestLow(kPeriod)) / (highestHigh(kPeriod) - lowestLow(kPeriod))
 *   %K     = SMA(raw %K, smooth)
 *   %D     = SMA(%K, dPeriod)
 * When the range is zero (flat window) raw %K is pinned to 50 (neutral).
 */
export const stochastic: IndicatorDef = {
  id: 'stochastic',
  label: 'Stochastic Oscillator',
  shortLabel: 'Stoch',
  placement: 'pane',
  params: [
    { key: 'kPeriod', label: '%K Period', default: 14, min: 1, max: 500, step: 1 },
    { key: 'dPeriod', label: '%D Period', default: 3, min: 1, max: 500, step: 1 },
    { key: 'smooth', label: 'Smooth', default: 3, min: 1, max: 500, step: 1 },
  ],
  range: [0, 100],
  compute(candles: Candle[], params: Record<string, number>): IndicatorOutput[] {
    const kPeriod = intParam(params, 'kPeriod', 14)
    const dPeriod = intParam(params, 'dPeriod', 3)
    const smooth = intParam(params, 'smooth', 3)
    const n = candles.length

    const rawK: (number | null)[] = new Array(n).fill(null)
    for (let i = kPeriod - 1; i < n; i++) {
      let hh = -Infinity
      let ll = Infinity
      for (let j = i - kPeriod + 1; j <= i; j++) {
        const c = candles[j]
        if (c.high > hh) hh = c.high
        if (c.low < ll) ll = c.low
      }
      const range = hh - ll
      // Division-by-zero guard: a perfectly flat window is neutral.
      rawK[i] = range > 0 ? (100 * (candles[i].close - ll)) / range : 50
    }

    const k = smaSeries(rawK, smooth)
    const d = smaSeries(k, dPeriod)

    return [
      { name: 'k', values: k, color: '#2962FF' },
      { name: 'd', values: d, color: '#FF6D00' },
    ]
  },
}
