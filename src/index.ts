// CandL Charts — a data-agnostic canvas charting library.
//
// Bring your own data: create the engine, feed it a Candle[] (and live ticks),
// and you get a high-performance canvas chart with 19 chart types, a large
// drawing-tool registry, technical indicators, and the experimental CandLlabs
// tools. The library NEVER fetches data — your code supplies it (from any
// exchange, broker, CSV, or the optional DataProvider contract below).

// ----- chart engine -----
export { createChartEngine } from './chart/engine'
export type { IChartEngine, ChartEngineOptions, ChartType, IndicatorRenderData, PriceTag } from './chart/types'
// CHART_TYPES is the canonical id list — use it to build a chart-type picker.
export { CHART_TYPES } from './chart/types'
// Built-in candle colour templates are separate from the light/dark canvas
// themes, so hosts can apply them as workspace-wide chart settings.
export {
  CANDLE_PALETTES,
  CANDLE_PALETTE_IDS,
  getCandlePalette,
  inferCandlePalette,
  isCandlePaletteId,
} from './chart/themes'
export type { BuiltInCandlePaletteId, CandleColorPalette, CandlePaletteId } from './chart/themes'
export type { Converters, DrawEnv } from './drawings/types'

// ----- drawing tools (registry + render / hit-test) -----
export * from './drawings'

// ----- technical indicators -----
export * from './indicators'
// Indicator type surface — needed to type INDICATORS entries and build the
// IndicatorRenderData[] that engine.setIndicators() expects.
export type {
  IndicatorDef,
  IndicatorOutput,
  IndicatorParam,
  IndicatorPlacement,
  PlotStyle,
} from './indicators/types'

// ----- CandLlabs experimental tools (Echoes, Oracle, Market Clock, sonifier) -----
export * as lab from './lab'

// ----- alerts + chart settings -----
// Alerts are a data-agnostic primitive: `checkAndFireAlerts` evaluates the
// alerts for ONE symbol against its latest price. Call it per symbol you have a
// price for, so alerts fire for any number of symbols at once — there's no
// single "active" symbol baked in.
export * from './alerts/types'
export { checkAndFireAlerts, ensureNotificationPermission, type CheckAndFireOpts } from './alerts/notify'
export { playTune, ALERT_TUNES, primeAlertAudio, isAlertAudioBlocked, onAlertAudioBlocked } from './alerts/tunes'

// ----- core value types -----
export type { Candle, Interval, SymbolInfo, Theme, NamedWatchlist } from './core/types'
export { INTERVALS, INTERVAL_MS, INTERVAL_LABELS } from './core/types'

// ----- data-provider contract (optional — implement with your own feed) -----
export type {
  DataProvider,
  TradeEvent,
  TickerUpdate,
  TickerStat,
  DepthSnapshot,
} from './data/types'

// Ready-made providers for public exchange data (no API key) + a generic
// timeframe aggregator. Optional — the core never calls these; bring your own
// feed instead if you prefer.
//
// DeltaDataProvider covers Delta Exchange India (perpetuals, futures, options,
// INR spot); BinanceDataProvider covers Binance spot.
export { DeltaDataProvider } from './data/delta'
export { BinanceDataProvider } from './data/binance'
export { aggregateCandles, rollupToInterval } from './data/aggregate'
