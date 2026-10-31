// The demo's data provider: DeltaDataProvider plus one piece of app-level
// policy — the Options view's Mark/Last price-source toggle.
//
// On Delta, options are ordinary products: same /v2/history/candles endpoint,
// same WebSocket channels, same order book as any perpetual. So unlike a
// Binance-style setup — which needs a whole parallel options code path, a CORS
// proxy and REST polling — there is nothing to unify here. Everything is
// delegated straight to DeltaDataProvider.
//
// The ONE thing this class adds: when the price source is "Mark", an option's
// candles come from Delta's mark-price series, which lives under the same
// symbol with a "MARK:" prefix. Trades, depth and tickers always come from the
// real contract — a mark series has no tape or book of its own.
import { DeltaDataProvider, type Candle, type Interval, type SymbolInfo } from '../../src/index'
import type { BookEvent, DataProvider, TickerStat, TickerUpdate, TradeEvent, DepthSnapshot } from '../../src/data/types'
import { isOptionSymbol, getOptionMode } from './options'

export class UnifiedProvider implements DataProvider {
  readonly name = 'Delta Exchange India'

  private delta = new DeltaDataProvider()

  /** The series to chart for `symbol`: the mark-price feed for options in Mark mode. */
  private priceSeries(symbol: string): string {
    return isOptionSymbol(symbol) && getOptionMode() === 'mark' ? `MARK:${symbol}` : symbol
  }

  searchSymbols(query: string): Promise<SymbolInfo[]> {
    return this.delta.searchSymbols(query)
  }

  getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    return this.delta.getSymbolInfo(symbol)
  }

  fetchCandles(symbol: string, interval: Interval, limit = 500, endTime?: number): Promise<Candle[]> {
    return this.delta.fetchCandles(this.priceSeries(symbol), interval, limit, endTime)
  }

  subscribeCandles(symbol: string, interval: Interval, onUpdate: (candle: Candle) => void): () => void {
    return this.delta.subscribeCandles(this.priceSeries(symbol), interval, onUpdate)
  }

  subscribeTrades(symbol: string, onTrade: (trade: TradeEvent) => void): () => void {
    return this.delta.subscribeTrades(symbol, onTrade)
  }

  /** Watchlist / ticker-header feed: one shared WS stream for many symbols. */
  subscribeTickers(symbols: string[], onTick: (update: TickerUpdate) => void): () => void {
    return this.delta.subscribeTickers(symbols, onTick)
  }

  /** Order-book depth (top levels). */
  subscribeDepth(symbol: string, onDepth: (depth: DepthSnapshot) => void): () => void {
    return this.delta.subscribeDepth(symbol, onDepth)
  }

  /** Incremental order book (snapshot + per-level changes). */
  subscribeBook(symbol: string, onEvent: (e: BookEvent) => void): () => void {
    return this.delta.subscribeBook(symbol, onEvent)
  }

  /** One-shot 24h stats for all perpetuals (used to seed watchlist search). */
  getAllTickers(): Promise<TickerStat[]> {
    return this.delta.getAllTickers()
  }
}
