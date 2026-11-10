import type { Candle } from '../core/types'

/** 'overlay' renders on the price pane; 'pane' gets its own sub-pane below. */
export type IndicatorPlacement = 'overlay' | 'pane'

export type PlotStyle = 'line' | 'histogram' | 'dashed' | 'dots'

export interface IndicatorOutput {
  name: string // e.g. "basis", "upper", "signal"
  values: (number | null)[] // MUST be aligned 1:1 with the input candles array
  color: string // CSS color
  style?: PlotStyle // default 'line'
  /** Extend the plot's final value this many bars right of the last candle (into blank space). */
  extendRight?: number
  /** Bar indices where a line starts afresh (not joined to the previous bar), e.g. a session-anchored VWAP reset. */
  breaks?: number[]
}

export interface IndicatorParam {
  key: string
  label: string
  default: number
  min?: number
  max?: number
  step?: number
  /** Settings show a dropdown of these values instead of a number field. */
  options?: { value: number; label: string }[]
  /** Settings show a checkbox (1 = on, 0 = off) instead of a number field. */
  toggle?: boolean
  /** Settings heading this param sits under (a new heading starts when it changes). */
  group?: string
}

export interface IndicatorDef {
  id: string // e.g. "rsi"
  label: string // e.g. "Relative Strength Index"
  shortLabel: string // e.g. "RSI"
  placement: IndicatorPlacement
  params: IndicatorParam[]
  /** Fixed y-range for pane indicators (e.g. [0, 100] for RSI). Omit for auto. */
  range?: [number, number]
  compute(candles: Candle[], params: Record<string, number>): IndicatorOutput[]
}
