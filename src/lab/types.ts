// Types for "The Lab" — CandL's experimental features
// (Echoes pattern matching, Sketch Search, Market Clock).

/** One historical window that resembles the query pattern. */
export interface SimilarityMatch {
  startIndex: number // window start, index into the searched candle/closes array
  endIndex: number // window end, inclusive
  distance: number // z-normalized euclidean distance; lower = more similar
}

export interface EchoResult {
  match: SimilarityMatch
  matchTime: number // open time (epoch ms) of the window's last candle
  /**
   * What happened after the matched window: percent change from the window's
   * last close, per bar offset 1..horizon. Null if history ends too soon.
   */
  aftermathPct: number[] | null
}

/** Aggregate outcome statistics over all echoes with a full aftermath. */
export interface EchoStats {
  count: number
  upCount: number // aftermath ended above 0%
  medianEndPct: number
  bestEndPct: number
  worstEndPct: number
  horizon: number // bars
}

export interface EchoScan {
  windowLen: number
  horizon: number
  results: EchoResult[] // sorted by distance, best first
  stats: EchoStats
  queryClosePct: number[] // the query window, as % change from its first close (for sparklines)
}

/**
 * Oracle: an ensemble of simulated futures, block-bootstrap-resampled from the
 * asset's own historical log returns (preserves fat tails + volatility
 * clustering, assumes nothing about distributions). All values are percent
 * change from the last close.
 */
export interface OracleResult {
  horizon: number // bars simulated
  nPaths: number
  /**
   * Cumulative %-change paths, row-major: pathsPct[p * horizon + t] is path p
   * at bar offset t+1. Kept flat (Float32Array) so odds queries scan fast.
   */
  pathsPct: Float32Array
  /** Per bar offset 1..horizon, percentile envelope of the ensemble. */
  bandsPct: { p5: number; p25: number; p50: number; p75: number; p95: number }[]
  medianEndPct: number
  /** Subsample of full paths for animation (~120 rows, same layout semantics). */
  samplePathsPct: number[][]
}

/** Empirical odds for a price target, computed over the full ensemble. */
export interface TargetOdds {
  endAbovePct: number // % of paths ending above the target
  touchPct: number // % of paths that touch the target at ANY bar of the horizon
}

/** One bucket of the Market Clock (an hour-of-day or day-of-week slice). */
export interface ClockBucket {
  meanAbsReturnPct: number // mean |close/open - 1| * 100  (volatility)
  meanReturnPct: number // signed mean return % (direction)
  meanVolume: number
  samples: number
}

export interface MarketClockStats {
  byHourUtc: ClockBucket[] // length 24, indexed by UTC hour of candle open
  byWeekdayUtc: ClockBucket[] // length 7, 0 = Sunday (UTC)
  candleCount: number
  fromTime: number
  toTime: number
}

// === Order Flow Analysis Types ===

/** Absorption detection types */
export type AbsorptionStrength = 'weak' | 'moderate' | 'strong'

export interface AbsorptionEvent {
  timestamp: number
  priceLevel: number
  buyVolume: number
  sellVolume: number
  ratio: number
  strength: AbsorptionStrength
  absorbed: 'buy' | 'sell'
}

/** Institutional footprint types */
export type FootprintMarker = 'large_block' | 'unusual_size' | 'momentum' | 'absorption' | 'reversal'

export interface Footprint {
  timestamp: number
  price: number
  volume: number
  side: 'buy' | 'sell'
  confidence: number
  markers: FootprintMarker[]
  zscore?: number
}

/** Level detection types */
export type LevelType = 'support' | 'resistance'

export interface KeyLevel {
  price: number
  type: LevelType
  strength: number
  touchCount: number
  lastTouch: number
  totalVolume: number
  absorptionEvents: number
  breakOutCount: number
}
