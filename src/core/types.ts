// Core shared types. Times are epoch milliseconds (UTC) everywhere.

export interface Candle {
  time: number // candle open time, epoch ms
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** Taker BUY volume for this bar (sell volume = volume - buyVolume). Omitted
   * where the source can't provide the split (not every provider/chart-type
   * transform carries it — see chartTransforms.ts's re-binned types). */
  buyVolume?: number
  /** Number of individual trades that made up this bar. volume/tradeCount is
   * an AVERAGE trade size — used to approximate "was there a big trade here"
   * for historical bars where the individual trade tape isn't available. */
  tradeCount?: number
}

export type Interval =
  | '1s'
  | '5s'
  | '15s'
  | '30s'
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '6h'
  | '12h'
  | '1d'
  | '1w'

export const INTERVALS: Interval[] = ['1s', '5s', '15s', '30s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w']

export const INTERVAL_MS: Record<Interval, number> = {
  '1s': 1_000,
  '5s': 5_000,
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
}

/** Human-friendly timeframe labels for menus (the short code is used on chips). */
export const INTERVAL_LABELS: Record<Interval, string> = {
  '1s': '1 second',
  '5s': '5 seconds',
  '15s': '15 seconds',
  '30s': '30 seconds',
  '1m': '1 minute',
  '3m': '3 minutes',
  '5m': '5 minutes',
  '15m': '15 minutes',
  '30m': '30 minutes',
  '1h': '1 hour',
  '2h': '2 hours',
  '4h': '4 hours',
  '6h': '6 hours',
  '12h': '12 hours',
  '1d': '1 day',
  '1w': '1 week',
}

export interface SymbolInfo {
  symbol: string // e.g. "BTCUSDT"
  base: string // e.g. "BTC"
  quote: string // e.g. "USDT"
  description?: string
  pricePrecision: number // decimal places for price display
  /** Class for grouping in search, e.g. "Stocks" / "Commodities". Crypto omits it. */
  category?: string  /** Base-asset units per exchange contract (Delta derivatives); omitted means 1. */
  contractValue?: number
}

export type Theme = 'dark' | 'light'

/**
 * A named, reorderable list of symbols. Lives in core/ (not the store) so the
 * auth/sync contract can reference it without creating an auth -> store import
 * cycle. `id` is store-generated and stable across sessions.
 */
export interface NamedWatchlist {
  id: string
  name: string
  symbols: string[]
}
