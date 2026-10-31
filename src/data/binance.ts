import type { Candle, Interval, SymbolInfo } from '../core/types'
import { INTERVAL_MS } from '../core/types'
import type {
  DataProvider,
  DepthSnapshot,
  TickerStat,
  TickerUpdate,
  TradeEvent,
} from './types'
import { aggregateCandles } from './aggregate'

// Binance public market-data endpoints. No API key is needed for any of these,
// so the provider works straight from the browser — matching the DataProvider
// contract's "public endpoints only" requirement.
const REST = 'https://api.binance.com'
const WS = 'wss://stream.binance.com:9443'

// Intervals Binance serves natively as klines. CandL also defines 5s/15s/30s,
// which Binance does NOT have — those are derived locally by aggregating 1s
// klines.
const NATIVE: ReadonlySet<Interval> = new Set<Interval>([
  '1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w',
])

// One Binance kline row: [openTime, O, H, L, C, volume, closeTime, quoteVolume,
// numTrades, takerBuyBaseVolume, takerBuyQuoteVolume, ignore]. Prices/volumes
// arrive as strings, so every numeric field is coerced with `+`.
type Kline = [number, string, string, string, string, string, number, string, number, string, string, string]

const toCandle = (k: Kline): Candle => ({
  time: k[0],
  open: +k[1],
  high: +k[2],
  low: +k[3],
  close: +k[4],
  volume: +k[5],
  buyVolume: +k[9],
  tradeCount: k[8],
})

/** Decimal places implied by a Binance PRICE_FILTER tickSize (e.g. "0.01" → 2). */
function precisionFromTickSize(tickSize: string): number {
  const n = Number(tickSize)
  if (!isFinite(n) || n <= 0) return 2
  // "0.00100000" → strip trailing zeros, count decimals after the point.
  const trimmed = tickSize.replace(/0+$/, '')
  const dot = trimmed.indexOf('.')
  return dot === -1 ? 0 : trimmed.length - dot - 1
}

/**
 * A reconnecting WebSocket. Calls `onMessage` with each parsed JSON frame and
 * silently reconnects (exponential backoff, capped at 30s) until the returned
 * disposer is invoked. JSON-parse failures are swallowed so one bad frame can't
 * tear down the feed.
 */
function openSocket(url: string, onMessage: (data: any) => void): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let retry = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const connect = () => {
    if (closed) return
    ws = new WebSocket(url)
    ws.onopen = () => {
      retry = 0
    }
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data))
      } catch {
        /* ignore malformed frame */
      }
    }
    ws.onclose = () => {
      if (closed) return
      const delay = Math.min(30_000, 1_000 * 2 ** retry++)
      timer = setTimeout(connect, delay)
    }
    ws.onerror = () => ws?.close()
  }

  connect()
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    ws?.close()
  }
}

/**
 * A {@link DataProvider} backed by Binance public spot market data.
 *
 * - `fetchCandles` paginates Binance klines (1000/call) and, for 15s/30s,
 *   fetches 1s klines and aggregates them.
 * - `subscribeCandles` streams native kline updates; for 15s/30s it streams 1s
 *   klines and rolls them up into the in-progress bucket.
 * - tickers / trades / depth map straight to the contract's event shapes.
 *
 * Symbols use Binance's concatenated form ("BTCUSDT"). `exchangeInfo` (symbol
 * list + precision) is fetched once and cached.
 */
export class BinanceDataProvider implements DataProvider {
  readonly name = 'Binance'

  private symbolCache: SymbolInfo[] | null = null
  private symbolCachePromise: Promise<SymbolInfo[]> | null = null

  // ----- REST helpers -----

  private async getJSON<T>(path: string): Promise<T> {
    const res = await fetch(`${REST}${path}`)
    if (!res.ok) {
      throw new Error(`Binance ${path} → HTTP ${res.status} ${res.statusText}`)
    }
    return res.json() as Promise<T>
  }

  /** Page backward through native klines until `limit` candles are collected. */
  private async fetchNative(
    symbol: string,
    interval: Interval,
    limit: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const sym = symbol.toUpperCase()
    const out: Candle[] = []
    let remaining = limit
    // `endTime` in our contract is exclusive; Binance's endTime is inclusive.
    let end = endTime != null ? endTime - 1 : undefined

    while (remaining > 0) {
      const batch = Math.min(remaining, 1000)
      const params = new URLSearchParams({ symbol: sym, interval, limit: String(batch) })
      if (end != null) params.set('endTime', String(end))

      const rows = await this.getJSON<Kline[]>(`/api/v3/klines?${params}`)
      if (rows.length === 0) break

      const candles = rows.map(toCandle)
      out.unshift(...candles) // older batch goes in front; result stays ascending
      remaining -= candles.length

      if (candles.length < batch) break // ran out of history
      end = candles[0].time - 1 // next page ends just before the oldest bar
    }

    return out
  }

  // ----- DataProvider -----

  async searchSymbols(query: string): Promise<SymbolInfo[]> {
    const all = await this.loadSymbols()
    const q = query.trim().toLowerCase()
    if (!q) return all.slice(0, 50)
    return all
      .filter(
        (s) =>
          s.symbol.toLowerCase().includes(q) ||
          s.base.toLowerCase().includes(q) ||
          s.quote.toLowerCase().includes(q),
      )
      .slice(0, 50)
  }

  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    const sym = symbol.toUpperCase()
    const all = await this.loadSymbols()
    const found = all.find((s) => s.symbol === sym)
    if (found) return found
    // Fall back to a reasonable default for an unknown/unlisted symbol.
    return { symbol: sym, base: sym, quote: '', pricePrecision: 2 }
  }

  async fetchCandles(
    symbol: string,
    interval: Interval,
    limit = 500,
    endTime?: number,
  ): Promise<Candle[]> {
    if (NATIVE.has(interval)) {
      return this.fetchNative(symbol, interval, limit, endTime)
    }
    // 15s / 30s: fetch the underlying 1s klines and aggregate up.
    const bucketMs = INTERVAL_MS[interval]
    const factor = bucketMs / 1_000
    const base = await this.fetchNative(symbol, '1s', limit * factor, endTime)
    return aggregateCandles(base, bucketMs).slice(-limit)
  }

  subscribeCandles(
    symbol: string,
    interval: Interval,
    onUpdate: (candle: Candle) => void,
  ): () => void {
    const sym = symbol.toLowerCase()

    if (NATIVE.has(interval)) {
      return openSocket(`${WS}/ws/${sym}@kline_${interval}`, (msg) => {
        const k = msg?.k
        if (k) onUpdate({ time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, buyVolume: +k.V, tradeCount: +k.n })
      })
    }

    // 15s / 30s: roll up the 1s stream into the current bucket, in O(1) per
    // tick. A given 1s sub-bar's kline event repeats (same k.t, growing
    // high/low/volume) until that second closes, so we can't just add each
    // update's delta — we track the CURRENT in-progress sub-bar's live
    // high/low/volume separately from the COMMITTED aggregate of every
    // earlier-finalized sub-bar in this bucket, and only fold the current one
    // into "committed" once a new sub-bar (a later k.t) supersedes it. This
    // replaces the previous approach of keeping every 1s bar in a Map and
    // re-sorting + re-summing all of them on every single 1s tick.
    const bucketMs = INTERVAL_MS[interval]
    let bucketStart = -1
    let subOpen = 0
    let committedHigh = -Infinity
    let committedLow = Infinity
    let committedVolume = 0
    let committedBuyVolume = 0
    let committedTradeCount = 0
    let currentSubTime = -1
    let currentSubHigh = -Infinity
    let currentSubLow = Infinity
    let currentSubClose = 0
    let currentSubVolume = 0
    let currentSubBuyVolume = 0
    let currentSubTradeCount = 0

    return openSocket(`${WS}/ws/${sym}@kline_1s`, (msg) => {
      const k = msg?.k
      if (!k) return
      const one: Candle = { time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, buyVolume: +k.V, tradeCount: +k.n }

      const start = Math.floor(one.time / bucketMs) * bucketMs
      if (start !== bucketStart) {
        bucketStart = start
        subOpen = one.open
        committedHigh = -Infinity
        committedLow = Infinity
        committedVolume = 0
        committedBuyVolume = 0
        committedTradeCount = 0
        currentSubTime = -1
      }
      if (one.time !== currentSubTime) {
        // The previous in-progress sub-bar (if any) just closed — fold its
        // final values into the committed aggregate before tracking the new one.
        if (currentSubTime !== -1) {
          if (currentSubHigh > committedHigh) committedHigh = currentSubHigh
          if (currentSubLow < committedLow) committedLow = currentSubLow
          committedVolume += currentSubVolume
          committedBuyVolume += currentSubBuyVolume
          committedTradeCount += currentSubTradeCount
        }
        currentSubTime = one.time
      }
      currentSubHigh = one.high
      currentSubLow = one.low
      currentSubClose = one.close
      currentSubVolume = one.volume
      currentSubBuyVolume = one.buyVolume ?? 0
      currentSubTradeCount = one.tradeCount ?? 0

      onUpdate({
        time: bucketStart,
        open: subOpen,
        high: Math.max(committedHigh, currentSubHigh),
        low: Math.min(committedLow, currentSubLow),
        close: currentSubClose,
        volume: committedVolume + currentSubVolume,
        buyVolume: committedBuyVolume + currentSubBuyVolume,
        tradeCount: committedTradeCount + currentSubTradeCount,
      })
    })
  }

  subscribeTickers(symbols: string[], onTick: (update: TickerUpdate) => void): () => void {
    if (symbols.length === 0) return () => {}
    const streams = symbols.map((s) => `${s.toLowerCase()}@ticker`).join('/')
    return openSocket(`${WS}/stream?streams=${streams}`, (msg) => {
      const d = msg?.data
      if (d?.s) onTick({ symbol: d.s, price: +d.c, changePct: +d.P })
    })
  }

  subscribeTrades(symbol: string, onTrade: (trade: TradeEvent) => void): () => void {
    return openSocket(`${WS}/ws/${symbol.toLowerCase()}@aggTrade`, (d) => {
      if (d?.p == null) return
      // `m` = isBuyerMaker: when true the taker (aggressor) is the seller.
      onTrade({ time: d.T, price: +d.p, qty: +d.q, side: d.m ? 'sell' : 'buy' })
    })
  }

  async getAllTickers(): Promise<TickerStat[]> {
    type Raw = { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }
    const rows = await this.getJSON<Raw[]>('/api/v3/ticker/24hr')
    return rows
      .filter((r) => r.symbol.endsWith('USDT'))
      .map((r) => ({
        symbol: r.symbol,
        base: r.symbol.slice(0, -4), // strip "USDT"
        lastPrice: +r.lastPrice,
        changePct: +r.priceChangePercent,
        quoteVolume: +r.quoteVolume,
      }))
      .filter((t) => t.quoteVolume > 0)
  }

  subscribeDepth(symbol: string, onDepth: (depth: DepthSnapshot) => void): () => void {
    const num = (lvl: [string, string]): [number, number] => [+lvl[0], +lvl[1]]
    return openSocket(`${WS}/ws/${symbol.toLowerCase()}@depth20@100ms`, (d) => {
      if (!d?.bids || !d?.asks) return
      onDepth({ bids: d.bids.map(num), asks: d.asks.map(num) })
    })
  }

  // ----- internals -----

  /** Load + cache the tradable USDT spot symbols from exchangeInfo (once). */
  private loadSymbols(): Promise<SymbolInfo[]> {
    if (this.symbolCache) return Promise.resolve(this.symbolCache)
    if (this.symbolCachePromise) return this.symbolCachePromise

    type RawFilter = { filterType: string; tickSize?: string }
    type RawSymbol = {
      symbol: string
      status: string
      baseAsset: string
      quoteAsset: string
      filters: RawFilter[]
    }

    this.symbolCachePromise = this.getJSON<{ symbols: RawSymbol[] }>('/api/v3/exchangeInfo')
      .then(({ symbols }) => {
        const list = symbols
          .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT')
          .map<SymbolInfo>((s) => {
            const tick = s.filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize
            return {
              symbol: s.symbol,
              base: s.baseAsset,
              quote: s.quoteAsset,
              pricePrecision: tick ? precisionFromTickSize(tick) : 2,
              category: 'Crypto',
            }
          })
        this.symbolCache = list
        return list
      })
      .catch((err) => {
        this.symbolCachePromise = null // allow a later retry
        throw err
      })

    return this.symbolCachePromise
  }
}
