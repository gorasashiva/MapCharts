import type { Candle } from '../core/types'
import type { IndicatorDef, IndicatorOutput } from './types'

/**
 * On-Balance Volume: cumulative volume that adds the bar's volume when the
 * close rises, subtracts it when the close falls, and is unchanged on equal
 * closes. Starts at 0 on the first loaded candle (the absolute level is
 * arbitrary; only the shape matters).
 */
export const obv: IndicatorDef = {
  id: 'obv',
  label: 'On-Balance Volume',
  shortLabel: 'OBV',
  placement: 'pane',
  params: [],
  compute(candles: Candle[], _params: Record<string, number>): IndicatorOutput[] {
    const n = candles.length
    const values: (number | null)[] = new Array(n).fill(null)
    let cum = 0
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const diff = candles[i].close - candles[i - 1].close
        if (diff > 0) cum += candles[i].volume
        else if (diff < 0) cum -= candles[i].volume
      }
      values[i] = cum
    }
    return [{ name: 'obv', values, color: '#26A69A' }]
  },
}
