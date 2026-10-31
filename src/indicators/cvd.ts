import type { Candle } from '../core/types'
import type { IndicatorDef, IndicatorOutput } from './types'

/**
 * Cumulative Volume Delta (CVD) — an order-flow proxy.
 *
 * APPROXIMATION: true CVD needs trade-level (tick) data to split each trade into
 * aggressive buys vs. sells. We only have OHLCV, so we estimate the per-bar
 * delta from the candle's shape instead:
 *
 *   pos   = clamp(2 * (close - low) / (high - low) - 1, -1, 1)
 *   delta = volume * pos
 *
 * `pos` maps the close's position within the bar's range to [-1, 1]: a close at
 * the high => +1 (treat the bar's whole volume as net buying), a close at the
 * low => -1 (net selling), the midpoint => 0. When high == low (a flat bar) we
 * use 0 to avoid dividing by zero. CVD is the running cumulative sum of delta.
 *
 * The cumulative baseline is arbitrary: it starts at 0 on the first loaded bar,
 * so only the shape/slope is meaningful, not the absolute level.
 */
export const cvd: IndicatorDef = {
  id: 'cvd',
  label: 'Cumulative Volume Delta',
  shortLabel: 'CVD',
  placement: 'pane',
  params: [],
  compute(candles: Candle[], _params: Record<string, number>): IndicatorOutput[] {
    const n = candles.length
    const values: (number | null)[] = new Array(n).fill(null)
    let cum = 0
    for (let i = 0; i < n; i++) {
      const c = candles[i]
      const span = c.high - c.low
      const pos = span > 0 ? clamp((2 * (c.close - c.low)) / span - 1, -1, 1) : 0
      cum += c.volume * pos
      values[i] = cum
    }
    return [{ name: 'cvd', values, color: '#2962ff', style: 'line' }]
  },
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}
