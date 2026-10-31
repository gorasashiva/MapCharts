// Smart (data-aware) drawing tools: ATR-sized position tools, a self-scoring
// S/R zone, a fixed-range volume profile and an anchored VWAP.

import type { ToolImpl } from '../types'
import { POSITION_IMPLS } from './position'
import { smartlevelImpl } from './smartlevel'
import { volxrayImpl } from './volxray'
import { avwapImpl } from './avwap'

/** Toolbar order: longpos, shortpos, smartlevel, volxray, avwap. */
export const SMART_IMPLS: ToolImpl[] = [
  ...POSITION_IMPLS,
  smartlevelImpl,
  volxrayImpl,
  avwapImpl,
]
