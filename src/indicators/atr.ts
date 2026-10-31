import type { Candle } from '../core/types'
import type { IndicatorDef, IndicatorOutput } from './types'
import { intParam, wilderSeries } from './helpers'

/**
 * Average True Range (Wilder).
 * True range: max(high - low, |high - prevClose|, |low - prevClose|);
 * the very first bar uses high - low. Smoothed with Wilder's RMA, so the
 * first non-null ATR lands at index period - 1.
 */
export const atr: IndicatorDef = {
  id: 'atr',
  label: 'Average True Range',
  shortLabel: 'ATR',
  placement: 'pane',
  params: [{ key: 'period', label: 'Period', default: 14, min: 1, max: 500, step: 1 }],
  compute(candles: Candle[], params: Record<string, number>): IndicatorOutput[] {
    const period = intParam(params, 'period', 14)
    const n = candles.length

    const tr: (number | null)[] = new Array(n).fill(null)
    for (let i = 0; i < n; i++) {
      const c = candles[i]
      if (i === 0) {
        tr[i] = c.high - c.low
      } else {
        const prevClose = candles[i - 1].close
        tr[i] = Math.max(
          c.high - c.low,
          Math.abs(c.high - prevClose),
          Math.abs(c.low - prevClose),
        )
      }
    }

    return [{ name: 'atr', values: wilderSeries(tr, period), color: '#EF5350' }]
  },
}
