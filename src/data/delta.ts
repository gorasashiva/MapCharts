import type { Candle, Interval, SymbolInfo } from '../core/types'
import { INTERVAL_MS } from '../core/types'
import type {
  BookEvent,
  DataProvider,
  DepthSnapshot,
  TickerStat,
  TickerUpdate,
  TradeEvent,
} from './types'
import { aggregateCandles } from './aggregate'

// Delta Exchange INDIA public market-data endpoints. No API key is needed for
// any of these and every response carries `access-control-allow-origin: *`, so
// the provider works straight from the browser with no proxy — matching the
// DataProvider contract's "public endpoints only" requirement.
//
// (Delta's global/testnet deployments live on different hosts; this provider
// targets the India venue specifically.)
const REST = 'https://api.india.delta.exchange'
const WS = 'wss://socket.india.delta.exchange'

/** Rows a single /v2/history/candles call will return, however wide the range. */
const MAX_ROWS = 4000

/** Give up paging backward after this many empty-ish windows (illiquid symbol). */
const MAX_PAGES = 12

/**
 * CandL interval -> Delta `resolution`, for the ones Delta serves natively.
 * Delta's allowed set is 5s,1m,3m,5m,15m,30m,1h,2h,4h,6h,12h,1d,1w.
 */
const NATIVE: Partial<Record<Interval, string>> = {
  '5s': '5s',
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '2h': '2h',
  '4h': '4h',
  '6h': '6h',
  '1d': '1d',
  '1w': '1w',
}

/** The finest bar Delta publishes. 15s/30s are aggregated up from it. */
const BASE_RES = '5s'
const BASE_MS = 5_000

/**
 * Timeframes Delta doesn't serve natively, built by rolling up a finer native
 * resolution: 15s / 30s from 5s, and 12h from 6h (Delta's API rejects `12h`).
 * Delta only publishes 5s bars for BTCUSD and ETHUSD, so 15s / 30s are limited
 * to those two symbols as well.
 */
const AGGREGATED: Partial<Record<Interval, { res: string; ms: number }>> = {
  '15s': { res: BASE_RES, ms: BASE_MS },
  '30s': { res: BASE_RES, ms: BASE_MS },
  '12h': { res: '6h', ms: 6 * 3_600_000 },
}

/** One /v2/history/candles row. Prices/volume are JSON numbers; `time` is SECONDS. */
interface RawCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  /** Traded CONTRACTS in the bar — null on index/mark series. See `contractValue`. */
  volume: number | null
}

/** One /v2/tickers row, narrowed to the fields this provider reads. */
interface RawTicker {
  symbol: string
  contract_type: string
  contract_value: string
  tick_size: string
  underlying_asset_symbol: string
  turnover_symbol: string
  description?: string
  close?: number
  ltp_change_24h?: string
  turnover_usd?: number
  product_trading_status?: string
}

/** Everything the provider needs to know about one tradable Delta product. */
interface Product {
  symbol: string
  base: string
  quote: string
  /** Base-asset units per contract — Delta quotes candle/trade/book sizes in CONTRACTS. */
  contractValue: number
  pricePrecision: number
  contractType: string
  description: string
}

/**
 * Human label for a Delta `contract_type`, used as the search-result grouping.
 * Unknown/new contract types fall through to a title-cased version of the raw
 * value rather than being dropped.
 */
function categoryOf(contractType: string): string {
  switch (contractType) {
    case 'perpetual_futures':
      return 'Perpetuals'
    case 'futures':
      return 'Futures'
    case 'call_options':
    case 'put_options':
      return 'Options'
    case 'move_options':
      return 'MOVE options'
    case 'spot':
      return 'Spot'
    default:
      return contractType.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  }
}

/**
 * Tie-breaker for search results: within an equally good text match, show the
 * headline contract for an asset (its perpetual) before its option strikes.
 */
const CONTRACT_ORDER = ['perpetual_futures', 'futures', 'spot', 'move_options', 'call_options', 'put_options']
const CONTRACT_RANK = (t: string): number => {
  const i = CONTRACT_ORDER.indexOf(t)
  return i === -1 ? CONTRACT_ORDER.length : i
}

/** Decimal places implied by a Delta tick_size (e.g. "0.500000000000000000" → 1). */
function precisionFromTickSize(tickSize: string): number {
  const n = Number(tickSize)
  if (!isFinite(n) || n <= 0) return 2
  // Trailing zeros are padding: "0.01000000" → "0.01" → 2 decimals. A run of
  // zeros never crosses the "." (regex stops there), so "100.0000" → "100." → 0.
  const trimmed = tickSize.replace(/0+$/, '')
  const dot = trimmed.indexOf('.')
  return dot === -1 ? 0 : trimmed.length - dot - 1
}

/**
 * A reconnecting WebSocket for Delta's feed.
 *
 * Unlike a URL-encoded stream (Binance), Delta multiplexes every channel over
 * ONE socket and you declare what you want with a `subscribe` message. That
 * message therefore has to be re-sent on every reconnect, which is what
 * `subscribeMsg` is for.
 *
 * Liveness: a socket can go half-open (Wi-Fi switch, laptop sleep, a NAT
 * dropping idle flows) without ever firing `onclose`, which used to leave the
 * chart frozen on "stale". So the server is asked for a heartbeat (Delta sends
 * one every ~5s after `enable_heartbeat`, and answers each `ping` with `pong`),
 * and a watchdog replaces the socket if nothing at all arrives for
 * `SILENCE_MS`. Coming back online or to a visible tab re-checks immediately
 * instead of waiting out the watchdog or a backoff timer.
 *
 * JSON-parse failures are swallowed so one bad frame can't tear down the feed.
 */
const SILENCE_MS = 15_000
const PING_MS = 15_000
const MAX_BACKOFF_MS = 10_000

function openSocket(subscribeMsg: unknown, onMessage: (data: any) => void): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let retry = 0
  let lastMsgAt = Date.now()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null

  // Detach and drop the current socket without triggering the onclose retry.
  const teardown = (): void => {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = null
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    if (!ws) return
    const old = ws
    old.onopen = old.onmessage = old.onclose = old.onerror = null
    if (old.readyState === WebSocket.CONNECTING) {
      // closing mid-handshake makes the browser log an error: close it once it opens instead
      old.onopen = () => old.close()
    } else {
      try {
        old.close()
      } catch {
        /* already closing */
      }
    }
    ws = null
  }

  const send = (msg: unknown): void => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const connect = (): void => {
    if (closed) return
    lastMsgAt = Date.now() // the watchdog also covers a connect that never opens
    ws = new WebSocket(WS)
    ws.onopen = () => {
      retry = 0
      send(subscribeMsg)
      send({ type: 'enable_heartbeat' })
      pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS)
    }
    ws.onmessage = (ev) => {
      lastMsgAt = Date.now()
      try {
        const data = JSON.parse(ev.data)
        if (data?.type === 'heartbeat' || data?.type === 'pong') return
        onMessage(data)
      } catch {
        /* ignore malformed frame */
      }
    }
    ws.onclose = () => {
      teardown()
      if (closed) return
      reconnectTimer = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** retry++))
    }
    ws.onerror = () => ws?.close()
  }

  const reconnectNow = (): void => {
    if (closed) return
    teardown()
    retry = 0
    connect()
  }

  const watchdog = setInterval(() => {
    if (Date.now() - lastMsgAt > SILENCE_MS) reconnectNow()
  }, 5_000)

  // Back from sleep / offline / a background tab: the heartbeat should have
  // arrived within ~5s, so anything quieter than that is a dead socket.
  const recheck = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (Date.now() - lastMsgAt > 7_000) reconnectNow()
  }
  const hasWindow = typeof window !== 'undefined'
  if (hasWindow) {
    window.addEventListener('online', recheck)
    document.addEventListener('visibilitychange', recheck)
  }

  connect()
  return () => {
    closed = true
    clearInterval(watchdog)
    if (hasWindow) {
      window.removeEventListener('online', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
    teardown()
  }
}

/** Build the frame that subscribes one channel to one or more symbols. */
const subscription = (name: string, symbols: string[]): unknown => ({
  type: 'subscribe',
  payload: { channels: [{ name, symbols }] },
})

/** Per-bar-size taker tally kept by {@link TakerTape}. */
interface TapeBucket {
  /** Bucket start (epoch ms) currently being tallied; -1 before the first trade. */
  start: number
  /** Taker BUY volume seen in that bucket so far, base units. */
  buy: number
  /**
   * Whether we have watched this bucket from its very beginning. False for the
   * bucket that was already in flight when we subscribed — see the class doc.
   */
  complete: boolean
}

/**
 * Rebuilds the taker buy/sell split that Delta's candle feed doesn't carry.
 *
 * Delta's candles report total volume only, so `Candle.buyVolume` would always
 * be undefined — which silently disables every buy/sell-pressure tool. The live
 * trade tape DOES report the aggressor side per trade, so one tape subscription
 * per symbol is enough to tally the split for any number of bar sizes at once.
 *
 * ONE SUBSCRIPTION PER SYMBOL, SHARED: several consumers commonly watch the
 * same symbol at different intervals (a chart plus a multi-timeframe dominance
 * table, say). They all attach to the same tape and it is reference-counted, so
 * the socket is opened once and closed when the last consumer goes away.
 *
 * HONESTY RULE: a bucket we joined half-way through has only some of its
 * trades, and a partial split is indistinguishable from a real one downstream.
 * So a bucket only reports a split once we have crossed one of its boundaries —
 * i.e. from the first bar that we watched form from empty.
 */
class TakerTape {
  refs = 0
  stop: (() => void) | null = null
  private buckets = new Map<number, TapeBucket>()

  /** Start tallying for a bar size (idempotent — repeat calls for the same size are free). */
  track(bucketMs: number): void {
    if (!this.buckets.has(bucketMs)) this.buckets.set(bucketMs, { start: -1, buy: 0, complete: false })
  }

  /** Fold one live trade into every tracked bar size. */
  add(timeMs: number, qty: number, side: 'buy' | 'sell'): void {
    for (const [bucketMs, st] of this.buckets) {
      const start = Math.floor(timeMs / bucketMs) * bucketMs
      if (start !== st.start) {
        // Crossing a boundary means the NEXT bucket is watched from its start,
        // so its split can be trusted — unlike the one we joined mid-flight.
        if (st.start !== -1) st.complete = true
        st.start = start
        st.buy = 0
      }
      if (side === 'buy') st.buy += qty
    }
  }

  /** Taker-buy volume for a candle, or undefined if we can't vouch for it. */
  buyFor(bucketMs: number, candleTime: number, volume: number): number | undefined {
    const st = this.buckets.get(bucketMs)
    if (!st || !st.complete || st.start !== candleTime) return undefined
    // The tape and the exchange's own bar aggregation can disagree at the
    // margin; never let buyVolume exceed volume, or sell volume goes negative.
    return Math.min(st.buy, volume)
  }
}

/** Mark ("MARK:BTCUSD") and index (".DEXBTUSD") series are derived — they have no trade tape. */
const hasTradeTape = (symbol: string): boolean => !symbol.startsWith('MARK:') && !symbol.startsWith('.')

/**
 * A {@link DataProvider} backed by Delta Exchange India's public market data.
 *
 * - `fetchCandles` pages /v2/history/candles backward (4000 rows/call) and, for
 *   15s/30s, fetches 5s candles and aggregates them.
 * - `subscribeCandles` streams the matching `candlestick_<res>` channel; 15s/30s
 *   stream `candlestick_5s` and roll up into the in-progress bucket.
 * - tickers / trades / depth map to the contract's event shapes.
 *
 * Symbols are Delta's own: "BTCUSD" (perpetual), "C-BTC-88000-280826" (option),
 * "BTC_INR" (spot), "MARK:BTCUSD" (mark-price series). The product catalog
 * (symbol list, precision, contract size) is fetched once from /v2/tickers and
 * cached.
 *
 * TWO DIFFERENCES FROM AN EXCHANGE LIKE BINANCE ARE BAKED IN HERE:
 *
 *  1. SIZES ARE IN CONTRACTS. A BTCUSD contract is 0.001 BTC, so a raw candle
 *     volume of 23309 means 23.309 BTC. Every size this provider emits
 *     (candles, trades, depth) is multiplied by the product's `contract_value`
 *     so downstream volume is in BASE UNITS and comparable across symbols.
 *  2. NO TAKER SPLIT ON HISTORY. Delta's candles carry total volume only — no
 *     buy/sell breakdown and no trade count. `Candle.tradeCount` is therefore
 *     always undefined here (it is optional in the contract), and historical
 *     bars carry no `buyVolume`.
 *
 *     LIVE bars do get a real `buyVolume`: `subscribeCandles` rebuilds it from
 *     the trade tape, which reports the true aggressor side per trade (see
 *     TakerTape). So buy/sell-pressure tools are exact for bars watched form
 *     during the session, and simply absent for history loaded before it —
 *     never estimated.
 */
export class DeltaDataProvider implements DataProvider {
  readonly name = 'Delta Exchange India'

  private catalog: Map<string, Product> | null = null
  private catalogPromise: Promise<Map<string, Product>> | null = null

  /** One shared, reference-counted taker tape per symbol — see {@link TakerTape}. */
  private tapes = new Map<string, TakerTape>()

  // ----- REST helpers -----

  private async getJSON<T>(path: string): Promise<T> {
    const res = await fetch(`${REST}${path}`)
    if (!res.ok) {
      // Keep Delta's own explanation (e.g. "5s resolution is supported only for BTCUSD, ETHUSD").
      let detail = ''
      try {
        detail = ` ${JSON.stringify(((await res.json()) as { error?: unknown }).error ?? '')}`
      } catch {
        /* not JSON */
      }
      throw new Error(`Delta ${path} → HTTP ${res.status} ${res.statusText}${detail}`)
    }
    const body = (await res.json()) as { success?: boolean; result?: T; error?: unknown }
    if (body.success === false) {
      throw new Error(`Delta ${path} → ${JSON.stringify(body.error)}`)
    }
    return body.result as T
  }

  /**
   * Base-asset units per contract for `symbol`. Defaults to 1 for anything not
   * in the catalog — index (".DEXBTUSD") and mark ("MARK:BTCUSD") series aren't
   * products and carry no volume anyway.
   */
  private async contractValue(symbol: string): Promise<number> {
    const cat = await this.loadCatalog().catch(() => null)
    return cat?.get(symbol.toUpperCase())?.contractValue ?? 1
  }

  /**
   * Page backward through Delta candles until `limit` bars are collected.
   *
   * Delta's endpoint is RANGE-based (start/end seconds), not count-based, so we
   * ask for a window wide enough to hold `batch` bars and then walk the window
   * back to just before the oldest bar we got. Illiquid contracts have gaps —
   * hence `MAX_PAGES`, so a symbol that simply stopped trading terminates
   * instead of crawling backward forever.
   */
  private async fetchRange(
    symbol: string,
    resolution: string,
    stepMs: number,
    limit: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const cv = await this.contractValue(symbol)
    const out: Candle[] = []
    // `endTime` in our contract is exclusive; Delta's `end` is inclusive.
    let end = Math.floor(((endTime != null ? endTime : Date.now()) - 1) / 1000)
    let remaining = limit

    for (let page = 0; page < MAX_PAGES && remaining > 0; page++) {
      const batch = Math.min(remaining, MAX_ROWS)
      const start = end - Math.ceil((batch * stepMs) / 1000)
      const params = new URLSearchParams({
        resolution,
        symbol,
        start: String(start),
        end: String(end),
      })

      const rows = await this.getJSON<RawCandle[]>(`/v2/history/candles?${params}`)
      if (rows.length === 0) break

      // Delta returns newest-first; our contract is ascending by time.
      const candles: Candle[] = []
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]
        candles.push({
          time: r.time * 1000,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: (r.volume ?? 0) * cv,
        })
      }
      out.unshift(...candles) // older batch goes in front; result stays ascending
      remaining -= candles.length

      // Next window ends just before the oldest bar we already have, which both
      // guarantees forward progress and rules out duplicates across pages.
      end = Math.floor(candles[0].time / 1000) - 1
    }

    return out
  }

  // ----- DataProvider -----

  async searchSymbols(query: string): Promise<SymbolInfo[]> {
    const cat = await this.loadCatalog()
    const all = [...cat.values()]
    const q = query.trim().toLowerCase()
    if (!q) return all.slice(0, 50).map((p) => this.toSymbolInfo(p))

    // Rank, don't just filter. Delta's catalog is ~900 products dominated by
    // option strikes, and descriptions match loosely ("Tether Gold" contains
    // "eth"), so a plain substring filter buries ETHUSD under XAUTUSD and a
    // wall of P-ETH-* strikes. Score by how directly the query hits, then
    // prefer the tradable-headline contracts within each score.
    const scored: { p: Product; score: number }[] = []
    for (const p of all) {
      const sym = p.symbol.toLowerCase()
      const base = p.base.toLowerCase()
      let score: number
      if (sym === q) score = 0
      else if (base === q) score = 1
      else if (sym.startsWith(q)) score = 2
      else if (base.startsWith(q)) score = 3
      else if (sym.includes(q)) score = 4
      else if (p.description.toLowerCase().includes(q)) score = 5
      else continue
      scored.push({ p, score })
    }

    scored.sort(
      (a, b) =>
        a.score - b.score ||
        CONTRACT_RANK(a.p.contractType) - CONTRACT_RANK(b.p.contractType) ||
        a.p.symbol.localeCompare(b.p.symbol),
    )
    return scored.slice(0, 50).map((s) => this.toSymbolInfo(s.p))
  }

  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    const sym = symbol.toUpperCase()
    const cat = await this.loadCatalog().catch(() => null)
    const found = cat?.get(sym)
    if (found) return this.toSymbolInfo(found)
    // Fall back to a reasonable default for an index/mark/unlisted symbol.
    return { symbol: sym, base: sym, quote: '', pricePrecision: 2 }
  }

  async fetchCandles(
    symbol: string,
    interval: Interval,
    limit = 500,
    endTime?: number,
  ): Promise<Candle[]> {
    const native = NATIVE[interval]
    if (native) {
      return this.fetchRange(symbol, native, INTERVAL_MS[interval], limit, endTime)
    }
    // 1s: Delta's finest bar is 5s, so a 1s request is served 5s bars rather
    // than failing outright. (The Delta demo shell offers 5s, not 1s.)
    if (interval === '1s') {
      return this.fetchRange(symbol, BASE_RES, BASE_MS, limit, endTime)
    }
    // 15s / 30s / 12h: fetch the finer native candles and aggregate up.
    const src = AGGREGATED[interval] ?? { res: BASE_RES, ms: BASE_MS }
    const bucketMs = INTERVAL_MS[interval]
    const factor = bucketMs / src.ms
    const base = await this.fetchRange(symbol, src.res, src.ms, limit * factor, endTime)
    return aggregateCandles(base, bucketMs).slice(-limit)
  }

  subscribeCandles(
    symbol: string,
    interval: Interval,
    onUpdate: (candle: Candle) => void,
  ): () => void {
    const sym = symbol.toUpperCase()
    const native = NATIVE[interval] ?? (interval === '1s' ? BASE_RES : null)
    const bucketMs = INTERVAL_MS[interval]

    // Sizes arrive in contracts; the catalog lookup that converts them is async
    // while this method is not, so start at 1 and correct once it resolves.
    // Bars stream every few hundred ms, so the window of un-scaled updates is
    // a tick or two at most, and only on a cold catalog.
    let cv = 1
    void this.contractValue(sym).then((v) => {
      cv = v
    })

    // Rebuild the taker split Delta's candle feed omits (see TakerTape).
    const tape = this.acquireTape(sym, bucketMs)
    const withSplit = (c: Candle): Candle => {
      const buyVolume = tape?.buyFor(bucketMs, c.time, c.volume)
      return buyVolume === undefined ? c : { ...c, buyVolume }
    }
    const release = (): void => this.releaseTape(sym)

    if (native) {
      const stop = openSocket(subscription(`candlestick_${native}`, [sym]), (msg) => {
        if (msg?.candle_start_time == null) return
        onUpdate(
          withSplit({
            time: Math.floor(msg.candle_start_time / 1000), // microseconds → ms
            open: +msg.open,
            high: +msg.high,
            low: +msg.low,
            close: +msg.close,
            volume: (+msg.volume || 0) * cv,
          }),
        )
      })
      return () => {
        stop()
        release()
      }
    }

    // 15s / 30s: roll up the 5s stream into the current bucket, in O(1) per
    // tick. A given 5s sub-bar's event repeats (same candle_start_time, growing
    // high/low/volume) until that bucket closes, so we can't just add each
    // update's delta — we track the CURRENT in-progress sub-bar's live
    // high/low/volume separately from the COMMITTED aggregate of every
    // earlier-finalized sub-bar in this bucket, and only fold the current one
    // into "committed" once a new sub-bar supersedes it.
    let bucketStart = -1
    let subOpen = 0
    let committedHigh = -Infinity
    let committedLow = Infinity
    let committedVolume = 0
    let currentSubTime = -1
    let currentSubHigh = -Infinity
    let currentSubLow = Infinity
    let currentSubClose = 0
    let currentSubVolume = 0

    const stop = openSocket(subscription(`candlestick_${(AGGREGATED[interval] ?? { res: BASE_RES }).res}`, [sym]), (msg) => {
      if (msg?.candle_start_time == null) return
      const time = Math.floor(msg.candle_start_time / 1000)

      const start = Math.floor(time / bucketMs) * bucketMs
      if (start !== bucketStart) {
        bucketStart = start
        subOpen = +msg.open
        committedHigh = -Infinity
        committedLow = Infinity
        committedVolume = 0
        currentSubTime = -1
      }
      if (time !== currentSubTime) {
        // The previous in-progress sub-bar (if any) just closed — fold its
        // final values into the committed aggregate before tracking the new one.
        if (currentSubTime !== -1) {
          if (currentSubHigh > committedHigh) committedHigh = currentSubHigh
          if (currentSubLow < committedLow) committedLow = currentSubLow
          committedVolume += currentSubVolume
        }
        currentSubTime = time
      }
      currentSubHigh = +msg.high
      currentSubLow = +msg.low
      currentSubClose = +msg.close
      currentSubVolume = (+msg.volume || 0) * cv

      onUpdate(
        withSplit({
          time: bucketStart,
          open: subOpen,
          high: Math.max(committedHigh, currentSubHigh),
          low: Math.min(committedLow, currentSubLow),
          close: currentSubClose,
          volume: committedVolume + currentSubVolume,
        }),
      )
    })

    return () => {
      stop()
      release()
    }
  }

  subscribeTickers(symbols: string[], onTick: (update: TickerUpdate) => void): () => void {
    if (symbols.length === 0) return () => {}
    const syms = symbols.map((s) => s.toUpperCase())
    return openSocket(subscription('v2/ticker', syms), (d) => {
      if (d?.type !== 'v2/ticker' || !d.symbol) return
      // `close` is the last traded price; `ltp_change_24h` is already a percent.
      const price = +d.close || +d.mark_price || 0
      if (!price) return
      onTick({ symbol: d.symbol, price, changePct: +d.ltp_change_24h || 0 })
    })
  }

  subscribeTrades(symbol: string, onTrade: (trade: TradeEvent) => void): () => void {
    const sym = symbol.toUpperCase()
    let cv = 1
    void this.contractValue(sym).then((v) => {
      cv = v
    })

    // `buyer_role`/`seller_role` name which side was the AGGRESSOR: whichever
    // one is the taker crossed the spread. Delta sends a burst of recent trades
    // as `all_trades_snapshot` on subscribe, then one `all_trades` per trade.
    const emit = (t: any): void => {
      if (t?.price == null) return
      onTrade({
        time: Math.floor(t.timestamp / 1000), // microseconds → ms
        timeUs: +t.timestamp,
        price: +t.price,
        qty: (+t.size || 0) * cv,
        side: t.seller_role === 'taker' ? 'sell' : 'buy',
      })
    }

    return openSocket(subscription('all_trades', [sym]), (d) => {
      if (d?.type === 'all_trades') emit(d)
      else if (d?.type === 'all_trades_snapshot' && Array.isArray(d.trades)) {
        // Snapshot is newest-first; replay oldest-first so the tape reads forward.
        for (let i = d.trades.length - 1; i >= 0; i--) emit(d.trades[i])
      }
    })
  }

  async getAllTickers(): Promise<TickerStat[]> {
    const rows = await this.getJSON<RawTicker[]>('/v2/tickers?contract_types=perpetual_futures')
    return rows
      .map((r) => ({
        symbol: r.symbol,
        base: r.underlying_asset_symbol,
        lastPrice: +(r.close ?? 0),
        changePct: +(r.ltp_change_24h ?? 0),
        quoteVolume: r.turnover_usd ?? 0, // 24h USD turnover — heatmap tile size
      }))
      .filter((t) => t.quoteVolume > 0 && t.lastPrice > 0)
  }

  subscribeDepth(symbol: string, onDepth: (depth: DepthSnapshot) => void): () => void {
    const sym = symbol.toUpperCase()
    let cv = 1
    void this.contractValue(sym).then((v) => {
      cv = v
    })

    // Delta's book levels are {limit_price, size, depth}; `depth` is the running
    // cumulative total, which the contract doesn't want — take `size` only.
    const levels = (side: any[]): [number, number][] =>
      side.map((l) => [+l.limit_price, (+l.size || 0) * cv] as [number, number])

    return openSocket(subscription('l2_orderbook', [sym]), (d) => {
      if (!Array.isArray(d?.buy) || !Array.isArray(d?.sell)) return
      // Delta already sends bids descending and asks ascending.
      onDepth({ bids: levels(d.buy), asks: levels(d.sell) })
    })
  }

  /**
   * Incremental book (`l2_updates`): one snapshot, then only the levels that
   * changed, each message carrying `sequence_no`. A gap in the sequence means
   * a dropped message and a book that no longer matches the exchange, so the
   * socket is reopened to get a fresh snapshot.
   */
  subscribeBook(symbol: string, onEvent: (e: BookEvent) => void): () => void {
    const sym = symbol.toUpperCase()
    let cv = 1
    void this.contractValue(sym).then((v) => {
      cv = v
    })
    const levels = (side: unknown): [number, number][] =>
      Array.isArray(side) ? side.map((l: [string, string]) => [+l[0], (+l[1] || 0) * cv] as [number, number]) : []

    let stop: (() => void) | null = null
    let closed = false
    let seq = -1
    const open = (): void => {
      if (closed) return
      seq = -1
      stop = openSocket(subscription('l2_updates', [sym]), (d) => {
        if (d?.type !== 'l2_updates') return
        const action = d.action === 'snapshot' ? 'snapshot' : 'update'
        const s = Number(d.sequence_no)
        if (action === 'update' && (seq < 0 || (Number.isFinite(s) && s !== seq + 1))) {
          stop?.()
          stop = null
          setTimeout(open, 250) // resync from a fresh snapshot
          return
        }
        if (Number.isFinite(s)) seq = s
        onEvent({ action, time: Math.floor(+d.timestamp / 1000), bids: levels(d.bids), asks: levels(d.asks) })
      })
    }
    open()
    return () => {
      closed = true
      stop?.()
      stop = null
    }
  }

  // ----- internals -----

  /**
   * Attach to `symbol`'s taker tape, opening it if this is the first consumer,
   * and make sure it tallies the `bucketMs` bar size. Returns null for series
   * that have no tape of their own (mark/index).
   */
  private acquireTape(symbol: string, bucketMs: number): TakerTape | null {
    if (!hasTradeTape(symbol)) return null
    let tape = this.tapes.get(symbol)
    if (!tape) {
      tape = new TakerTape()
      this.tapes.set(symbol, tape)
      // Assign `stop` before subscribing would be racy only if the callback
      // fired synchronously; it can't — the socket has to connect first.
      tape.stop = this.subscribeTrades(symbol, (t) => tape!.add(t.time, t.qty, t.side))
    }
    tape.refs++
    tape.track(bucketMs)
    return tape
  }

  /** Detach from `symbol`'s tape, closing it once the last consumer is gone. */
  private releaseTape(symbol: string): void {
    const tape = this.tapes.get(symbol)
    if (!tape) return
    if (--tape.refs <= 0) {
      tape.stop?.()
      this.tapes.delete(symbol)
    }
  }

  private toSymbolInfo(p: Product): SymbolInfo {
    return {
      symbol: p.symbol,
      base: p.base,
      quote: p.quote,
      description: p.description,
      pricePrecision: p.pricePrecision,
      category: categoryOf(p.contractType),
      contractValue: p.contractValue,
    }
  }

  /**
   * Load + cache the tradable product catalog (once).
   *
   * /v2/tickers is the cheapest complete source: one unpaginated call returns
   * every live product with the symbol, tick size, contract size and asset
   * names we need. (/v2/products has the same data but is cursor-paginated
   * across several calls.)
   */
  private loadCatalog(): Promise<Map<string, Product>> {
    if (this.catalog) return Promise.resolve(this.catalog)
    if (this.catalogPromise) return this.catalogPromise

    this.catalogPromise = this.getJSON<RawTicker[]>('/v2/tickers')
      .then((rows) => {
        const map = new Map<string, Product>()
        for (const r of rows) {
          if (r.product_trading_status && r.product_trading_status !== 'operational') continue
          const cv = Number(r.contract_value)
          map.set(r.symbol, {
            symbol: r.symbol,
            base: r.underlying_asset_symbol,
            // Spot pairs are "BTC_INR"; every derivative is quoted in USD.
            quote: r.symbol.includes('_') ? r.symbol.split('_')[1] : 'USD',
            contractValue: isFinite(cv) && cv > 0 ? cv : 1,
            pricePrecision: precisionFromTickSize(r.tick_size),
            contractType: r.contract_type,
            description: r.description ?? r.symbol,
          })
        }
        this.catalog = map
        return map
      })
      .catch((err) => {
        this.catalogPromise = null // allow a later retry
        throw err
      })

    return this.catalogPromise
  }
}
