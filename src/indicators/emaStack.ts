import type { Candle } from '../core/types'
import type { IndicatorDef, IndicatorOutput } from './types'
import { closes, intParam, emaSeries } from './helpers'

/**
 * EMA Stack: three EMAs (default 9/21/50) plotted together as a "ribbon" —
 * a bullish stack (9 above 21 above 50, all rising) or bearish stack (9 below
 * 21 below 50, all falling) is a common trend-alignment filter; a tangled/
 * crossed stack reads as no clear trend.
 */
export const emaStack: IndicatorDef = {
  id: 'ema_stack',
  label: 'EMA Stack (9/21/50)',
  shortLabel: 'EMA Stack',
  placement: 'overlay',
  params: [
    { key: 'fast', label: 'Fast', default: 9, min: 1, max: 200, step: 1 },
    { key: 'mid', label: 'Mid', default: 21, min: 1, max: 500, step: 1 },
    { key: 'slow', label: 'Slow', default: 50, min: 1, max: 1000, step: 1 },
  ],
  compute(candles: Candle[], params: Record<string, number>): IndicatorOutput[] {
    const fast = intParam(params, 'fast', 9)
    const mid = intParam(params, 'mid', 21)
    const slow = intParam(params, 'slow', 50)
    const src = closes(candles)
    return [
      { name: 'EMA Fast', values: emaSeries(src, fast), color: '#2962FF' },
      { name: 'EMA Mid', values: emaSeries(src, mid), color: '#FF9800' },
      { name: 'EMA Slow', values: emaSeries(src, slow), color: '#9C27B0' },
    ]
  },
}
