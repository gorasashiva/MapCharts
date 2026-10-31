import type { Candle } from '../core/types'
import type { IndicatorDef, IndicatorOutput } from './types'

/** VWAP anchor periods (the `anchor` param). Session = the UTC day, as TradingView anchors crypto. */
export const VWAP_ANCHORS = ['Session (day, UTC)', 'Week', 'Month', 'None (all loaded bars)'] as const

const DAY_MS = 86_400_000

/** Period key for a candle time: VWAP restarts whenever this changes. */
export function vwapPeriodKey(time: number, anchor: number): number {
  if (anchor === 1) return Math.floor((Math.floor(time / DAY_MS) + 3) / 7) // ISO week (Monday 00:00 UTC)
  if (anchor === 2) {
    const d = new Date(time)
    return d.getUTCFullYear() * 12 + d.getUTCMonth()
  }
  if (anchor === 3) return 0 // never resets
  return Math.floor(time / DAY_MS)
}

/**
 * Anchored Volume Weighted Average Price:
 * vwap[i] = sum(typicalPrice * volume) / sum(volume) since the start of the
 * current anchor period (typical = (H+L+C)/3). The default anchor is the
 * session (UTC day), matching TradingView's VWAP; "None" accumulates over all
 * loaded candles (the old behaviour). Each new period starts a fresh line
 * segment (`breaks`) instead of joining the previous session's last value.
 */
export const vwap: IndicatorDef = {
  id: 'vwap',
  label: 'Volume Weighted Average Price',
  shortLabel: 'VWAP',
  placement: 'overlay',
  params: [
    {
      key: 'anchor',
      label: 'Anchor period',
      default: 0,
      options: VWAP_ANCHORS.map((label, value) => ({ value, label })),
    },
  ],
  compute(candles: Candle[], params: Record<string, number>): IndicatorOutput[] {
    const anchor = Number.isFinite(params.anchor) ? Math.round(params.anchor) : 0
    const values: (number | null)[] = new Array(candles.length).fill(null)
    const breaks: number[] = []
    let cumPV = 0
    let cumVol = 0
    let period = Number.NaN
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i]
      const key = vwapPeriodKey(c.time, anchor)
      if (key !== period) {
        if (i > 0) breaks.push(i)
        period = key
        cumPV = 0
        cumVol = 0
      }
      const typical = (c.high + c.low + c.close) / 3
      cumPV += typical * c.volume
      cumVol += c.volume
      // Guard zero cumulative volume (e.g. synthetic/illiquid data).
      values[i] = cumVol > 0 ? cumPV / cumVol : null
    }
    return [{ name: 'vwap', values, color: '#E91E63', breaks }]
  },
}
