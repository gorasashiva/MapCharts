// DOM session — the DOM dashboard's brain without the screen: the book and
// trade feeds go in, and out come the liquidity levels (DomLevelTracker), the
// Read card's reading with its hysteresis, and the record of its calls.
//
// The live dashboard (examples/basic/domDashboard.ts) and the offline replay
// (recorder/replayDom.ts) both drive this same class, and every method takes
// the time explicitly — so a replayed day produces exactly the readings the
// live screen would have shown.
//
// Candles: live, the dashboard hands in Delta's 1m / 15m candles; in a replay
// there are none, so the session builds them from the trades it is fed.
import type { Candle } from '../core/types'
import { classify, DOM_LEVEL_DEFAULTS, DomLevelTracker, findStopPools, trust } from './domLevelsModel'
import { advise, AdvisorRecord, WARMUP_MS, type Advice, type AdvisorInput, type AdvisorLevel, type Bias } from './domAdvisorModel'

export interface DomMarketSetup {
  symbol: string
  label: string
  /** Market orders at or above this are drawn as big trades ($). */
  bigUsd: number
  minWallUsd: number
  roundStep: number
  /** Wall = this many × the usual quote, held for persistMs. */
  wallMult: number
  persistMs: number
  /** $ into one price that holds before ABSORB. */
  absorbUsd: number
}

export const DOM_MARKETS: DomMarketSetup[] = [
  // gold's book is evenly market-made: a lower bar, so walls and markers can show at all
  { symbol: 'XAUTUSD', label: 'Gold (XAUT)', bigUsd: 25_000, minWallUsd: 25_000, roundStep: 10, wallMult: 2, persistMs: 10_000, absorbUsd: 40_000 },
  { symbol: 'BTCUSD', label: 'Bitcoin', bigUsd: 50_000, minWallUsd: 150_000, roundStep: 1000, wallMult: 3, persistMs: 15_000, absorbUsd: 200_000 },
  { symbol: 'ETHUSD', label: 'Ether', bigUsd: 25_000, minWallUsd: 75_000, roundStep: 50, wallMult: 3, persistMs: 15_000, absorbUsd: 100_000 },
  { symbol: 'SOLUSD', label: 'Solana', bigUsd: 10_000, minWallUsd: 25_000, roundStep: 5, wallMult: 3, persistMs: 15_000, absorbUsd: 40_000 },
]

export const marketSetup = (symbol: string): DomMarketSetup => DOM_MARKETS.find((m) => m.symbol === symbol) ?? { ...DOM_MARKETS[0], symbol, label: symbol }

/** The reading must hold this long before it is shown (no flicker). */
export const READ_HOLD_MS = 10_000
export const ADVICE_EVERY_MS = 2000
export const POOLS_EVERY_MS = 15_000
const ABSORB_WINDOW_MS = 10 * 60_000
const FLOW_WINDOW_MS = 3 * 60_000
const LEVEL_LABEL = { real: 'REAL WALL', iceberg: 'ICEBERG' } as const

export interface DomSessionSources {
  /** 1-minute candles (typical move); omitted = built from the trades fed in. */
  candles?: () => Candle[]
  /** 15-minute candles (stop pools); omitted = built from the trades fed in. */
  poolCandles?: () => Candle[]
}

/** Fold a trade into time-bucketed candles, keeping the newest `keep`. */
function addToCandles(cs: Candle[], bucketMs: number, t: number, price: number, qty: number, keep: number): void {
  const time = Math.floor(t / bucketMs) * bucketMs
  const last = cs[cs.length - 1]
  if (last && last.time === time) {
    last.high = Math.max(last.high, price)
    last.low = Math.min(last.low, price)
    last.close = price
    last.volume += qty
  } else if (!last || time > last.time) {
    cs.push({ time, open: price, high: price, low: price, close: price, volume: qty })
    if (cs.length > keep) cs.shift()
  }
}

export class DomSession {
  readonly tracker: DomLevelTracker
  readonly record = new AdvisorRecord()
  /** Other support/resistance to weigh (GEX levels live; none in a replay). */
  extraLevels: AdvisorLevel[] = []
  lastPrice = 0
  bookAt = 0
  advice: Advice | null = null
  shownBias: Bias = 'neutral'
  pendingBias: { bias: Bias; since: number } | null = null
  /** The input behind the latest reading (for the replay's study log). */
  lastInput: AdvisorInput | null = null
  private flowLog: { t: number; usd: number; buy: boolean }[] = []
  private priceLog: { t: number; p: number }[] = []
  private bidShareAvg = NaN
  private adviceAt = -Infinity
  private poolsAt = -Infinity
  private built1m: Candle[] = []
  private built15m: Candle[] = []

  constructor(
    readonly setup: DomMarketSetup,
    readonly openedAt: number,
    private readonly sources: DomSessionSources = {},
  ) {
    this.tracker = new DomLevelTracker({
      ...DOM_LEVEL_DEFAULTS,
      minWallUsd: setup.minWallUsd,
      wallMult: setup.wallMult,
      persistMs: setup.persistMs,
      absorbUsd: setup.absorbUsd,
      sweepUsd: setup.bigUsd * 3,
    })
  }

  get candles(): Candle[] {
    return this.sources.candles?.() ?? this.built1m
  }
  get poolCandles(): Candle[] {
    return this.sources.poolCandles?.() ?? this.built15m
  }

  onBook(action: 'snapshot' | 'update', bids: [number, number][], asks: [number, number][], now: number): void {
    this.tracker.onBook(action, bids, asks, now)
    this.bookAt = now
  }

  /** A trade as it arrives (not the subscribe-time backlog). */
  onTrade(price: number, qty: number, buy: boolean, now: number): void {
    this.tracker.onTrade(now, price, qty, buy)
    this.lastPrice = price
    this.flowLog.push({ t: now, usd: price * qty, buy })
    if (!this.sources.candles) addToCandles(this.built1m, 60_000, now, price, qty, 600)
    if (!this.sources.poolCandles) addToCandles(this.built15m, 900_000, now, price, qty, 300)
  }

  /** Housekeeping; call about every 250ms. Returns true when the reading was re-evaluated. */
  tick(now: number): boolean {
    this.tracker.tick(now)
    if (now - this.poolsAt >= POOLS_EVERY_MS) this.refreshPools(now)
    if (now - this.adviceAt < ADVICE_EVERY_MS) return false
    this.adviceAt = now
    this.updateAdvice(now)
    return true
  }

  private refreshPools(now: number): void {
    const mid = this.tracker.mid || this.lastPrice
    if (!mid || this.poolCandles.length < 7) return
    this.tracker.setPools(findStopPools(this.poolCandles, mid, this.setup.roundStep), now)
    this.poolsAt = now
  }

  advisorInput(now: number): AdvisorInput | null {
    const tr = this.tracker, price = this.lastPrice
    if (!price || !tr.mid) return null
    const closed = this.candles.slice(-31, -1)
    const typicalMove = closed.length ? closed.reduce((s, c) => s + (c.high - c.low), 0) / closed.length : price * 0.0005

    let absorbBuyers = 0, absorbSellers = 0, pulledBids = 0, pulledAsks = 0
    for (const e of tr.events) {
      if (e.kind === 'absorb' && now - e.t <= ABSORB_WINDOW_MS) {
        if (e.side === 'bid') absorbBuyers += e.value
        else if (e.side === 'ask') absorbSellers += e.value
      } else if (e.kind === 'pull' && now - e.t <= ABSORB_WINDOW_MS && Math.abs(e.price - price) <= 4 * typicalMove) {
        if (e.side === 'bid') pulledBids++
        else if (e.side === 'ask') pulledAsks++
      }
    }
    this.flowLog = this.flowLog.filter((f) => now - f.t <= FLOW_WINDOW_MS)
    let flowBuy = 0, flowSell = 0
    for (const f of this.flowLog) f.buy ? (flowBuy += f.usd) : (flowSell += f.usd)
    this.priceLog.push({ t: now, p: price })
    this.priceLog = this.priceLog.filter((x) => now - x.t <= 20 * 60_000)
    const then = this.priceLog.find((x) => x.t >= now - FLOW_WINDOW_MS) ?? this.priceLog[0]

    // bid share within 0.15% of price, against its own ~15-minute average
    let b = 0, a = 0
    const band = tr.mid * 0.0015
    for (const [p, q] of tr.bids) if (tr.mid - p <= band) b += p * q
    for (const [p, q] of tr.asks) if (p - tr.mid <= band) a += p * q
    const bidShare = b + a ? b / (b + a) : 0.5
    this.bidShareAvg = Number.isFinite(this.bidShareAvg) ? this.bidShareAvg + (bidShare - this.bidShareAvg) * (2 / 451) : bidShare

    const sweeps = tr.endedPools
      .filter((p) => p.status === 'swept' && now - p.end <= 15 * 60_000)
      .map((p) => ({ dir: p.side === 'above' ? ('up' as const) : ('down' as const), price: p.price, t: p.end, reclaimed: p.side === 'above' ? price < p.price : price > p.price }))

    const levels: AdvisorLevel[] = [...this.extraLevels]
    for (const r of tr.live.values()) {
      const k = classify(r, now, tr.o)
      if (k === 'real' || k === 'iceberg') levels.push({ price: r.price, label: LEVEL_LABEL[k], strength: trust(r, k, now) })
    }
    for (const e of tr.events) {
      if (e.kind !== 'absorb' || now - e.t > 30 * 60_000) continue
      // a price where one side held is a level for that side
      if (e.side === 'bid' && e.price < price) levels.push({ price: e.price, label: 'BUYERS ABSORBED', strength: 60 })
      if (e.side === 'ask' && e.price > price) levels.push({ price: e.price, label: 'SELLERS ABSORBED', strength: 60 })
    }
    return {
      now,
      price,
      watchedMs: now - this.openedAt,
      stale: now - this.bookAt > 5000,
      typicalMove,
      absorbBuyers,
      absorbSellers,
      absorbUnit: this.setup.absorbUsd,
      flowBuy,
      flowSell,
      priceChange: price - then.p,
      bidShare,
      bidShareAvg: this.bidShareAvg,
      sweeps,
      pulledBids,
      pulledAsks,
      supports: levels.filter((l) => l.price < price),
      resistances: levels.filter((l) => l.price > price),
    }
  }

  private updateAdvice(now: number): void {
    const input = this.advisorInput(now)
    if (!input) return
    this.lastInput = input
    this.record.update(now, input.price)
    const next = advise(input)
    // switch only once a new reading has held for READ_HOLD_MS; stale data or warm-up stands aside at once
    const urgent = next.bias === 'neutral' && (input.stale || input.watchedMs < WARMUP_MS)
    if (next.bias === this.shownBias || urgent) {
      this.pendingBias = null
      this.shownBias = next.bias
      this.advice = next
    } else {
      if (!this.pendingBias || this.pendingBias.bias !== next.bias) this.pendingBias = { bias: next.bias, since: now }
      if (now - this.pendingBias.since >= READ_HOLD_MS) {
        this.shownBias = next.bias
        this.advice = next
        this.pendingBias = null
      }
    }
    if (this.advice && this.advice.bias !== 'neutral' && this.advice.plan) this.record.open(now, this.advice.bias, input.price, this.advice.plan)
  }
}
