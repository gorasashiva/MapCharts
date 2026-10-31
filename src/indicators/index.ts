import type { IndicatorDef } from './types'
import { sma, ema, wma } from './movingAverages'
import { emaStack } from './emaStack'
import { bollinger } from './bollinger'
import { vwap } from './vwap'
import { rsi } from './rsi'
import { macd } from './macd'
import { stochastic } from './stochastic'
import { atr } from './atr'
import { obv } from './obv'
import { volume } from './volume'
import { cvd } from './cvd'

/** All built-in indicators, in menu display order (overlays first, then panes). */
export const INDICATORS: IndicatorDef[] = [
  volume,
  sma,
  ema,
  wma,
  emaStack,
  bollinger,
  vwap,
  rsi,
  macd,
  stochastic,
  atr,
  obv,
  cvd,
]

const byId = new Map<string, IndicatorDef>(INDICATORS.map((def) => [def.id, def]))

/** Look up an indicator definition by its id (e.g. "rsi"). */
export function getIndicator(id: string): IndicatorDef | undefined {
  return byId.get(id)
}
