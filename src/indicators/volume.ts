import type { Candle } from '../core/types'
import type { IndicatorDef, IndicatorOutput } from './types'

/**
 * Volume: a per-bar histogram colored by candle direction.
 *
 * Emitted as two histogram series so the engine can paint each bar in a single
 * color without per-bar color support:
 *   - "up"   holds the volume on bars where close >= open (else null), green.
 *   - "down" holds the volume on bars where close <  open (else null), red.
 * Exactly one of the two is non-null per bar, so they never overlap.
 *
 * Integrator note: this sub-pane should fit [0, maxVolume] (bars grow up from a
 * zero baseline). We deliberately do NOT declare a fixed `range` here, because
 * the max volume is data-dependent and the engine's pane auto-fit already
 * anchors histogram baselines at 0 (computePaneScale: `if (min > 0) min = 0`).
 * Since volume is always >= 0, that yields exactly [0, maxVolume]. If that
 * zero-anchoring is ever removed and the fit centers on min..max instead, the
 * bars will be offset/clipped — re-anchor the floor at 0.
 */
export const volume: IndicatorDef = {
  id: 'volume',
  label: 'Volume',
  shortLabel: 'Vol',
  placement: 'pane',
  params: [],
  compute(candles: Candle[], _params: Record<string, number>): IndicatorOutput[] {
    const n = candles.length
    const up: (number | null)[] = new Array(n).fill(null)
    const down: (number | null)[] = new Array(n).fill(null)
    for (let i = 0; i < n; i++) {
      const c = candles[i]
      if (c.close >= c.open) up[i] = c.volume
      else down[i] = c.volume
    }
    return [
      { name: 'up', values: up, color: '#089981', style: 'histogram' },
      { name: 'down', values: down, color: '#f23645', style: 'histogram' },
    ]
  },
}
