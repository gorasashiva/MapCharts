import type { Candle } from '../core/types'
import type { IndicatorDef, IndicatorOutput } from './types'
import { intParam, wilderSeries } from './helpers'

/**
 * Relative Strength Index (Wilder).
 * Gains/losses are derived from close-to-close changes; both are smoothed
 * with Wilder's RMA (seeded with a simple average of the first `period`
 * changes), then RSI = 100 - 100 / (1 + avgGain / avgLoss).
 *
 * First non-null value lands at index `period` (one change needs two candles).
 */
export const rsi: IndicatorDef = {
  id: 'rsi',
  label: 'Relative Strength Index',
  shortLabel: 'RSI',
  placement: 'pane',
  params: [{ key: 'period', label: 'Period', default: 14, min: 1, max: 500, step: 1 }],
  range: [0, 100],
  compute(candles: Candle[], params: Record<string, number>): IndicatorOutput[] {
    const period = intParam(params, 'period', 14)
    const n = candles.length
    const gains: (number | null)[] = new Array(n).fill(null)
    const losses: (number | null)[] = new Array(n).fill(null)
    for (let i = 1; i < n; i++) {
      const change = candles[i].close - candles[i - 1].close
      gains[i] = change > 0 ? change : 0
      losses[i] = change < 0 ? -change : 0
    }

    const avgGain = wilderSeries(gains, period)
    const avgLoss = wilderSeries(losses, period)

    const values: (number | null)[] = new Array(n).fill(null)
    for (let i = 0; i < n; i++) {
      const g = avgGain[i]
      const l = avgLoss[i]
      if (g === null || l === null) continue
      if (l === 0) {
        // No losses in the lookback: flat market -> neutral 50, otherwise max.
        values[i] = g === 0 ? 50 : 100
      } else {
        values[i] = 100 - 100 / (1 + g / l)
      }
    }

    return [{ name: 'rsi', values, color: '#7E57C2' }]
  },
}
