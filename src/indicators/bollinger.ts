import type { Candle } from '../core/types'
import type { IndicatorDef, IndicatorOutput } from './types'
import { closes, intParam, numParam, smaSeries } from './helpers'

/**
 * Bollinger Bands: basis = SMA(close, period); upper/lower = basis +/- k * sd,
 * where sd is the population standard deviation of the window (the standard
 * convention, matching most platforms).
 */
export const bollinger: IndicatorDef = {
  id: 'bollinger',
  label: 'Bollinger Bands',
  shortLabel: 'BB',
  placement: 'overlay',
  params: [
    { key: 'period', label: 'Period', default: 20, min: 1, max: 500, step: 1 },
    { key: 'stdDev', label: 'StdDev', default: 2, min: 0.1, max: 10, step: 0.1 },
  ],
  compute(candles: Candle[], params: Record<string, number>): IndicatorOutput[] {
    const period = intParam(params, 'period', 20)
    const mult = numParam(params, 'stdDev', 2, 0)
    const src = closes(candles)
    const basis = smaSeries(src, period)
    const upper: (number | null)[] = new Array(src.length).fill(null)
    const lower: (number | null)[] = new Array(src.length).fill(null)

    for (let i = period - 1; i < src.length; i++) {
      const mean = basis[i]
      if (mean === null) continue
      // Population variance of the trailing window around the SMA.
      let sumSq = 0
      for (let j = i - period + 1; j <= i; j++) {
        const d = src[j] - mean
        sumSq += d * d
      }
      const sd = Math.sqrt(sumSq / period)
      upper[i] = mean + mult * sd
      lower[i] = mean - mult * sd
    }

    return [
      { name: 'basis', values: basis, color: '#FF9800' },
      { name: 'upper', values: upper, color: '#26A69A' },
      { name: 'lower', values: lower, color: '#EF5350' },
    ]
  },
}
