import type { Candle } from '../core/types'
import type { IndicatorDef, IndicatorOutput } from './types'
import { closes, intParam, emaSeries } from './helpers'

/**
 * Moving Average Convergence Divergence:
 *   macd     = EMA(close, fast) - EMA(close, slow)
 *   signal   = EMA(macd, signal)
 *   histogram = macd - signal
 *
 * `emaSeries` skips leading nulls, so the signal EMA correctly seeds on the
 * first `signal` valid MACD values (i.e. histogram starts at index
 * slow - 1 + signal - 1 with default params).
 */
export const macd: IndicatorDef = {
  id: 'macd',
  label: 'MACD',
  shortLabel: 'MACD',
  placement: 'pane',
  params: [
    { key: 'fast', label: 'Fast', default: 12, min: 1, max: 500, step: 1 },
    { key: 'slow', label: 'Slow', default: 26, min: 1, max: 500, step: 1 },
    { key: 'signal', label: 'Signal', default: 9, min: 1, max: 500, step: 1 },
  ],
  compute(candles: Candle[], params: Record<string, number>): IndicatorOutput[] {
    const fast = intParam(params, 'fast', 12)
    const slow = intParam(params, 'slow', 26)
    const signalPeriod = intParam(params, 'signal', 9)
    const src = closes(candles)
    const n = src.length

    const fastEma = emaSeries(src, fast)
    const slowEma = emaSeries(src, slow)

    const macdLine: (number | null)[] = new Array(n).fill(null)
    for (let i = 0; i < n; i++) {
      const f = fastEma[i]
      const s = slowEma[i]
      if (f !== null && s !== null) macdLine[i] = f - s
    }

    const signalLine = emaSeries(macdLine, signalPeriod)

    const histogram: (number | null)[] = new Array(n).fill(null)
    for (let i = 0; i < n; i++) {
      const m = macdLine[i]
      const s = signalLine[i]
      if (m !== null && s !== null) histogram[i] = m - s
    }

    // Histogram listed first so lines render on top of the bars.
    return [
      { name: 'histogram', values: histogram, color: '#26A69A', style: 'histogram' },
      { name: 'macd', values: macdLine, color: '#2962FF' },
      { name: 'signal', values: signalLine, color: '#FF6D00' },
    ]
  },
}
