import type { Candle } from '../core/types'
import type { IndicatorDef, IndicatorOutput } from './types'
import { closes, intParam, smaSeries, emaSeries } from './helpers'

/** Simple Moving Average. */
export const sma: IndicatorDef = {
  id: 'sma',
  label: 'Simple Moving Average',
  shortLabel: 'SMA',
  placement: 'overlay',
  params: [{ key: 'period', label: 'Period', default: 20, min: 1, max: 500, step: 1 }],
  compute(candles: Candle[], params: Record<string, number>): IndicatorOutput[] {
    const period = intParam(params, 'period', 20)
    return [
      {
        name: 'sma',
        values: smaSeries(closes(candles), period),
        color: '#2962FF',
      },
    ]
  },
}

/** Exponential Moving Average (SMA-seeded). */
export const ema: IndicatorDef = {
  id: 'ema',
  label: 'Exponential Moving Average',
  shortLabel: 'EMA',
  placement: 'overlay',
  params: [{ key: 'period', label: 'Period', default: 20, min: 1, max: 500, step: 1 }],
  compute(candles: Candle[], params: Record<string, number>): IndicatorOutput[] {
    const period = intParam(params, 'period', 20)
    return [
      {
        name: 'ema',
        values: emaSeries(closes(candles), period),
        color: '#FF6D00',
      },
    ]
  },
}

/** Weighted Moving Average: linear weights 1..period (most recent heaviest). */
export const wma: IndicatorDef = {
  id: 'wma',
  label: 'Weighted Moving Average',
  shortLabel: 'WMA',
  placement: 'overlay',
  params: [{ key: 'period', label: 'Period', default: 20, min: 1, max: 500, step: 1 }],
  compute(candles: Candle[], params: Record<string, number>): IndicatorOutput[] {
    const period = intParam(params, 'period', 20)
    const src = closes(candles)
    const values: (number | null)[] = new Array(src.length).fill(null)
    const weightSum = (period * (period + 1)) / 2 // 1 + 2 + ... + period
    for (let i = period - 1; i < src.length; i++) {
      let acc = 0
      for (let j = 0; j < period; j++) {
        // Oldest value in the window gets weight 1, newest gets `period`.
        acc += src[i - period + 1 + j] * (j + 1)
      }
      values[i] = acc / weightSum
    }
    return [
      {
        name: 'wma',
        values,
        color: '#9C27B0',
      },
    ]
  },
}
