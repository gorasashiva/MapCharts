// DOM liquidity levels — classifies large resting orders from the order book
// and the trade tape alone (Delta's l2_updates + all_trades).
//
// The key step is matching every drop in a level's size against the trades
// printed at that price around the same moment:
//   drop matched by trades   -> filled  (someone really traded against it)
//   drop with no trades      -> cancelled
// From that, each large level becomes:
//   real     sat a while, survived price coming close, gets traded not cancelled
//   iceberg  more traded at the price than was ever shown, or the shown size refills
//   spoof    shrinks by cancels while price is close
//   watch    too new or untested to say
// A level only counts once it is several times the market makers' usual quote
// (the size-weighted median level on its side) and has stayed that way for a while:
// market makers re-quote constantly, and those quotes are neither walls nor spoofs.
// Absorption is also watched at every price, wall or not: heavy taker flow
// into the best bid/ask while that price holds and the quote keeps refilling.
// Levels still being watched (big, but not yet held for persistMs) report
// tentative PULLED / TAKEN markers, so activity shows before confirmation.
// Stop pools are not in the book at all: likely stop clusters beyond swing
// highs/lows, the prior session's range and round numbers, confirmed as SWEPT
// when a burst of same-side market orders runs through them.
//
// Everything here is an inference from behaviour — hidden orders and stops are
// never visible directly. Sizes are in quote currency (USD notional).
import type { Candle } from '../core/types'

export type Side = 'bid' | 'ask'
export type LevelKind = 'watch' | 'real' | 'iceberg' | 'spoof'

export interface LevelRecord {
  price: number
  side: Side
  born: number
  end: number // 0 while live
  status: 'live' | 'pulled' | 'taken'
  vis: number // shown size now ($)
  maxVis: number // largest shown size ($)
  traded: number // all $ printed at this price since it appeared
  filled: number // size drops matched by trades ($)
  cancelled: number // size drops with no trades behind them ($)
  nearCancelled: number // ... of which while price was close
  refills: number // shown size topped back up right after being traded
  approaches: number
  near: boolean
  absorbed: number // $ traded into it in the current absorption window
  flagged: boolean // absorption already reported
  lastTradeAt: number
  unmatched: number // traded $ not yet matched to a size drop
  ending: number // time the size collapsed; resolved once pending drops settle
  kind?: LevelKind // frozen when the record ends
}

export interface StopPoolLevel {
  price: number
  side: 'above' | 'below'
  why: string
  trust: number
}
export interface StopPool extends StopPoolLevel {
  born: number
  status: 'waiting' | 'swept' | 'crossed'
  end: number
  swept: number // $ of same-side market orders in the burst
}

export type DomEventKind = 'pull' | 'absorb' | 'taken' | 'sweepUp' | 'sweepDn'
export interface DomEvent {
  t: number
  price: number
  kind: DomEventKind
  value: number
  /** From a level not yet confirmed as a wall — drawn faint. */
  tentative?: boolean
  /**
   * The resting side involved. For absorption, the side that soaked up the
   * flow and held: 'bid' = buyers absorbed market selling (leans bullish),
   * 'ask' = sellers absorbed market buying (leans bearish). For pulled/taken,
   * the side the order sat on. Not set on sweeps.
   */
  side?: Side
}

export interface DomLevelOptions {
  /** A level is a wall when its $ size is this many times the usual quote within 1% on its side (size-weighted median). */
  wallMult: number
  /** How long a level must stay a wall before it is tracked at all. */
  persistMs: number
  /** ... and at least this many dollars. */
  minWallUsd: number
  /** "Close" for an approach, as a fraction of price. */
  nearPct: number
  /** $ traded into one price that holds (and refills) before it is reported as absorbing. */
  absorbUsd: number
  /** The window that absorption volume is counted over. */
  absorbWindowMs: number
  /** $ of same-side market orders within a second that confirms a stop run. */
  sweepUsd: number
  /** How long a level must sit before it can be called real. */
  minRestMs: number
  /** How long ended records and events are kept. */
  keepMs: number
}

export const DOM_LEVEL_DEFAULTS: DomLevelOptions = {
  wallMult: 3,
  persistMs: 15_000,
  minWallUsd: 50_000,
  nearPct: 0.0006,
  absorbUsd: 100_000,
  absorbWindowMs: 30_000,
  sweepUsd: 75_000,
  minRestMs: 30_000,
  keepMs: 2 * 3_600_000,
}

/** Time a size drop waits for the trades behind it (they can arrive after the book update). */
export const MATCH_WINDOW_MS = 400

export function classify(r: LevelRecord, now: number, o: DomLevelOptions = DOM_LEVEL_DEFAULTS): LevelKind {
  if (r.kind) return r.kind
  if (r.status === 'pulled' || r.nearCancelled > Math.max(r.filled, 0.25 * r.maxVis)) return 'spoof'
  if (r.refills >= 2 || r.traded > r.maxVis * 1.1) return 'iceberg'
  if ((r.end || now) - r.born >= o.minRestMs && (r.approaches >= 1 || r.filled > 0.15 * r.maxVis)) return 'real'
  return 'watch'
}

/** 0–100: how much to rely on the level. */
export function trust(r: LevelRecord, kind: LevelKind, now: number): number {
  const rest = ((r.end || now) - r.born) / 1000
  if (kind === 'spoof') return Math.max(3, Math.round(25 - (20 * r.nearCancelled) / (r.nearCancelled + r.filled + 1)))
  if (kind === 'iceberg') return Math.min(99, Math.round(55 + r.refills * 7 + rest / 30))
  if (kind === 'real') return Math.min(95, Math.round(35 + rest / 20 + r.approaches * 10 + (25 * r.filled) / r.maxVis))
  return Math.min(40, Math.round(10 + rest / 6))
}

const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]
}
const median = (xs: number[]): number => quantile(xs, 0.5)
/**
 * The size at which half of all resting $ sits in levels no bigger: the typical
 * quote by dollars rather than by count. The two largest levels are left out so
 * a wall cannot raise its own bar.
 */
const weightedMedian = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b).slice(0, Math.max(1, xs.length - 2))
  const half = s.reduce((a, b) => a + b, 0) / 2
  let acc = 0
  for (const x of s) if ((acc += x) >= half) return x
  return 0
}

interface TradeMark {
  t: number
  usd: number
  buy: boolean
}
/** A level big enough to be a wall, not yet held long enough to be tracked. */
interface Candidate {
  since: number
  side: Side
  price: number
  maxVis: number
  traded: number
}
/** Taker flow into one price, for absorption anywhere. */
interface Flow {
  start: number
  usd: number
  lastTradeAt: number
  refills: number
  flagged: boolean
}
interface PendingDrop {
  rec: LevelRecord
  usd: number
  t: number
  near: boolean // price was close when the size dropped
}

export class DomLevelTracker {
  readonly bids = new Map<number, number>() // price -> qty
  readonly asks = new Map<number, number>()
  readonly live = new Map<string, LevelRecord>() // `${side}:${price}`
  readonly ended: LevelRecord[] = [] // newest first
  readonly events: DomEvent[] = []
  pools: StopPool[] = []
  readonly endedPools: StopPool[] = [] // newest first
  /** Median $ size of the levels within 1% of price — a scale for the heatmap. */
  typical = 0
  mid = 0
  private recent: TradeMark[] = []
  private pending: PendingDrop[] = []
  private candidates = new Map<string, Candidate>()
  private vanished: { c: Candidate; t: number; near: boolean }[] = [] // candidates whose size collapsed, awaiting late trades
  private flows = new Map<string, Flow>() // `${side}:${price}` of the level hit
  private lastMarkAt = new Map<string, number>() // tentative markers, at most one per price per 30s

  constructor(public o: DomLevelOptions = DOM_LEVEL_DEFAULTS) {}

  bestBid(): number {
    let b = -Infinity
    for (const p of this.bids.keys()) if (p > b) b = p
    return b
  }
  bestAsk(): number {
    let a = Infinity
    for (const p of this.asks.keys()) if (p < a) a = p
    return a
  }

  onBook(action: 'snapshot' | 'update', bids: [number, number][], asks: [number, number][], now: number): void {
    if (action === 'snapshot') {
      this.bids.clear()
      this.asks.clear()
    }
    this.apply('bid', this.bids, bids, now)
    this.apply('ask', this.asks, asks, now)
    const bb = this.bestBid(), ba = this.bestAsk()
    if (Number.isFinite(bb) && Number.isFinite(ba)) this.mid = (bb + ba) / 2
    if (action === 'snapshot') {
      // a fresh snapshot (a resync): what happened to a level now missing is unknown — forget it quietly
      for (const [key, r] of this.live) {
        if ((r.side === 'bid' ? this.bids : this.asks).has(r.price)) continue
        this.live.delete(key)
        this.pending = this.pending.filter((d) => d.rec !== r)
      }
    }
  }

  private apply(side: Side, book: Map<number, number>, levels: [number, number][], now: number): void {
    for (const [p, q] of levels) {
      const prev = book.get(p) ?? 0
      if (q > 0) book.set(p, q)
      else book.delete(p)
      const key = `${side}:${p}`
      const r = this.live.get(key)
      if (r) this.sizeChange(r, q * p, now)
      const c = this.candidates.get(key)
      if (c) c.maxVis = Math.max(c.maxVis, q * p)
      // the quote topped back up right after being hit
      const f = this.flows.get(key)
      if (f && q > prev && now - f.lastTradeAt < 3000) {
        f.refills++
        this.checkAbsorb(key, p, now)
      }
    }
  }

  /** Absorption anywhere: enough taker $ into one price within the window, refilled at least once, and the price still quoted. */
  private checkAbsorb(key: string, price: number, now: number): void {
    const f = this.flows.get(key)
    if (!f || f.flagged || f.usd < this.o.absorbUsd || f.refills < 1) return
    if (!(key.startsWith('bid') ? this.bids : this.asks).has(price)) return
    f.flagged = true
    this.events.push({ t: now, price, kind: 'absorb', value: f.usd, side: key.startsWith('bid') ? 'bid' : 'ask' })
  }

  private sizeChange(r: LevelRecord, usd: number, now: number): void {
    if (usd < r.vis) this.pending.push({ rec: r, usd: r.vis - usd, t: now, near: Math.abs(r.price - this.mid) / (this.mid || 1) < 3 * this.o.nearPct })
    // topped back up right after being traded: the mark of an iceberg
    else if (usd > r.vis && now - r.lastTradeAt < 3000 && usd - r.vis >= 0.2 * r.maxVis) r.refills++
    r.vis = usd
    r.maxVis = Math.max(r.maxVis, usd)
    if (usd < 0.15 * r.maxVis) r.ending ||= now
    else r.ending = 0
  }

  /**
   * New walls: levels within 2% of price at least `wallMult` × the usual big
   * quote on their side, tracked once they have stayed that way for `persistMs`.
   */
  private spawn(now: number): void {
    if (!this.mid) return
    const range = this.mid * 0.02
    const qualifying = new Set<string>()
    for (const [side, book] of [['bid', this.bids], ['ask', this.asks]] as const) {
      const near: number[] = []
      for (const [p, q] of book) if (Math.abs(p - this.mid) <= this.mid * 0.01) near.push(p * q)
      const bar = Math.max(this.o.minWallUsd, this.o.wallMult * weightedMedian(near))
      for (const [p, q] of book) {
        if (p * q < bar || Math.abs(p - this.mid) > range) continue
        const key = `${side}:${p}`
        qualifying.add(key)
        if (this.live.has(key)) continue
        let c = this.candidates.get(key)
        if (!c) {
          c = { since: now, side, price: p, maxVis: p * q, traded: 0 }
          this.candidates.set(key, c)
        }
        const since = c.since
        if (now - since < this.o.persistMs) continue
        this.candidates.delete(key)
        this.live.set(key, {
          price: p, side, born: since, end: 0, status: 'live', vis: p * q, maxVis: p * q, traded: 0, filled: 0, cancelled: 0, nearCancelled: 0,
          refills: 0, approaches: 0, near: Math.abs(p - this.mid) / this.mid < this.o.nearPct, absorbed: 0, flagged: false,
          lastTradeAt: 0, unmatched: 0, ending: 0,
        })
      }
    }
    for (const [key, c] of this.candidates) {
      if (qualifying.has(key)) continue
      this.candidates.delete(key)
      // collapsed (not just outgrown by the bar) after a few seconds on show: worth a faint marker
      const left = ((c.side === 'bid' ? this.bids : this.asks).get(c.price) ?? 0) * c.price
      if (left < 0.15 * c.maxVis && now - c.since >= 5000) this.vanished.push({ c, t: now, near: Math.abs(c.price - this.mid) / this.mid < 3 * this.o.nearPct })
    }
    const sizes: number[] = []
    for (const book of [this.bids, this.asks]) for (const [p, q] of book) if (Math.abs(p - this.mid) <= this.mid * 0.01) sizes.push(p * q)
    this.typical = median(sizes)
  }

  onTrade(t: number, price: number, qty: number, buy: boolean): void {
    const usd = price * qty
    this.recent.push({ t, usd, buy })
    // a taker buy trades against the ask, a taker sell against the bid
    const key = `${buy ? 'ask' : 'bid'}:${price}`
    const c = this.candidates.get(key)
    if (c) c.traded += usd
    for (const v of this.vanished) if (v.c.side === (buy ? 'ask' : 'bid') && v.c.price === price) v.c.traded += usd
    const r = this.live.get(key)
    if (!r) {
      // absorption anywhere (a tracked wall reports its own, below)
      let f = this.flows.get(key)
      if (!f || t - f.start > this.o.absorbWindowMs) {
        f = { start: t, usd: 0, lastTradeAt: t, refills: 0, flagged: false }
        this.flows.set(key, f)
      }
      f.usd += usd
      f.lastTradeAt = t
      this.checkAbsorb(key, price, t)
    }
    if (r) {
      if (t - r.lastTradeAt > 60_000) r.absorbed = 0
      r.traded += usd
      r.unmatched += usd
      r.lastTradeAt = t
      r.absorbed += usd
      if (!r.flagged && r.absorbed >= this.o.absorbUsd && r.vis >= 0.15 * r.maxVis) {
        r.flagged = true
        this.events.push({ t, price, kind: 'absorb', value: r.absorbed, side: r.side })
      }
    }
    for (const p of this.pools) {
      if (p.status !== 'waiting' || (p.side === 'above' ? price <= p.price : price >= p.price)) continue
      const up = p.side === 'above'
      const burst = this.recent.filter((m) => m.t >= t - 1000 && m.buy === up).reduce((s, m) => s + m.usd, 0)
      p.end = t
      if (burst >= this.o.sweepUsd) {
        p.status = 'swept'
        p.swept = burst
        this.events.push({ t, price: p.price, kind: up ? 'sweepUp' : 'sweepDn', value: burst })
      } else p.status = 'crossed'
      this.endedPools.unshift(p)
    }
    this.pools = this.pools.filter((p) => p.status === 'waiting')
  }

  /** Housekeeping: settle size drops, end collapsed levels, count approaches. Call every ~250ms. */
  tick(now: number): void {
    this.spawn(now)
    this.recent = this.recent.filter((m) => m.t >= now - 5000)
    const keep: PendingDrop[] = []
    for (const d of this.pending) {
      if (now - d.t < MATCH_WINDOW_MS) {
        keep.push(d)
        continue
      }
      const filled = Math.min(d.usd, d.rec.unmatched)
      d.rec.unmatched -= filled
      d.rec.filled += filled
      d.rec.cancelled += d.usd - filled
      if (d.near) d.rec.nearCancelled += d.usd - filled
    }
    this.pending = keep

    const waiting: typeof this.vanished = []
    for (const v of this.vanished) {
      if (now - v.t < MATCH_WINDOW_MS) {
        waiting.push(v)
        continue
      }
      const key = `${v.c.side}:${v.c.price}`
      if (now - (this.lastMarkAt.get(key) ?? -Infinity) < 30_000) continue
      const taken = v.c.traded >= 0.5 * v.c.maxVis
      if (!taken && !v.near) continue // withdrawn far from price: not a signal
      this.lastMarkAt.set(key, now)
      this.events.push({ t: v.t, price: v.c.price, kind: taken ? 'taken' : 'pull', value: taken ? v.c.traded : v.c.maxVis, tentative: true, side: v.c.side })
    }
    this.vanished = waiting
    for (const [key, f] of this.flows) if (now - f.lastTradeAt > this.o.absorbWindowMs * 2) this.flows.delete(key)
    for (const [key, t] of this.lastMarkAt) if (now - t > 60_000) this.lastMarkAt.delete(key)

    for (const [key, r] of this.live) {
      const dist = Math.abs(r.price - this.mid) / (this.mid || 1)
      if (dist < this.o.nearPct && !r.near) {
        r.approaches++
        r.near = true
      } else if (dist > this.o.nearPct * 2) r.near = false
      // trades long before a drop do not explain it
      if (now - r.lastTradeAt > 5000) r.unmatched = 0
      if (r.ending && !this.pending.some((d) => d.rec === r)) {
        // cancelled far from price: an order moved or withdrawn, not a spoof — forget quietly
        if (r.cancelled > r.filled && r.nearCancelled <= r.filled) {
          this.live.delete(key)
          continue
        }
        const pulled = r.cancelled > r.filled
        r.kind = pulled ? 'spoof' : classify(r, now, this.o)
        r.status = pulled ? 'pulled' : 'taken'
        r.end = now
        this.live.delete(key)
        this.ended.unshift(r)
        this.events.push({ t: now, price: r.price, kind: pulled ? 'pull' : 'taken', value: pulled ? r.maxVis : r.filled, side: r.side })
      } else if (dist > 0.03) this.live.delete(key) // drifted far from price: forget quietly
    }
    const cut = now - this.o.keepMs
    while (this.ended.length && this.ended[this.ended.length - 1].end < cut) this.ended.pop()
    while (this.endedPools.length && this.endedPools[this.endedPools.length - 1].end < cut) this.endedPools.pop()
    while (this.events.length && this.events[0].t < cut) this.events.shift()
  }

  /**
   * Replace the waiting stop pools, keeping the birth time of ones already known.
   * A price crossed or swept in the last 30 minutes is not offered again: with
   * price sitting on a round number it would otherwise flip above/below forever.
   */
  setPools(next: StopPoolLevel[], now: number): void {
    const spent = new Set(this.endedPools.filter((p) => now - p.end < 30 * 60_000).map((p) => p.price))
    this.pools = next.filter((p) => !spent.has(p.price)).map((p) => {
      const old = this.pools.find((q) => q.price === p.price && q.side === p.side)
      return { ...p, born: old?.born ?? now, status: 'waiting', end: 0, swept: 0 }
    })
  }
}

/**
 * Likely stop clusters near price, not visible in the book: swing highs/lows
 * (3 bars either side) still untouched, the prior UTC session's high/low and
 * the nearest round numbers (`step` apart) — the closest `perSide` per side.
 * Levels within 0.05% of each other merge, and the merge raises their trust.
 */
export function findStopPools(candles: Candle[], mid: number, step: number, perSide = 2): StopPoolLevel[] {
  if (candles.length < 7 || !(mid > 0)) return []
  const out: StopPoolLevel[] = []
  const tol = mid * 0.0005
  const highs: number[] = [], lows: number[] = []
  for (let i = Math.max(3, candles.length - 240); i < candles.length - 3; i++) {
    const c = candles[i]
    let hi = true, lo = true
    for (let k = 1; k <= 3; k++) {
      if (candles[i - k].high >= c.high || candles[i + k].high > c.high) hi = false
      if (candles[i - k].low <= c.low || candles[i + k].low < c.low) lo = false
    }
    // spent once a later bar has traded through it
    if (hi && candles.slice(i + 1).every((d) => d.high <= c.high)) highs.push(c.high)
    if (lo && candles.slice(i + 1).every((d) => d.low >= c.low)) lows.push(c.low)
  }
  for (const [levels, side] of [[highs, 'above'], [lows, 'below']] as const) {
    for (const p of levels) if (side === 'above' ? p > mid : p < mid) out.push({ price: p, side, why: `swing ${side === 'above' ? 'high' : 'low'}`, trust: 52 })
  }

  const DAY = 86_400_000
  const today = Math.floor(candles[candles.length - 1].time / DAY) * DAY
  const prev = candles.filter((c) => c.time >= today - DAY && c.time < today)
  if (prev.length) {
    const ph = Math.max(...prev.map((c) => c.high)), pl = Math.min(...prev.map((c) => c.low))
    if (ph > mid) out.push({ price: ph, side: 'above', why: 'prior session high', trust: 74 })
    if (pl < mid) out.push({ price: pl, side: 'below', why: 'prior session low', trust: 74 })
  }
  out.push({ price: Math.floor(mid / step) * step + step, side: 'above', why: 'round number', trust: 46 })
  out.push({ price: Math.ceil(mid / step) * step - step, side: 'below', why: 'round number', trust: 46 })

  const result: StopPoolLevel[] = []
  for (const side of ['above', 'below'] as const) {
    const merged: StopPoolLevel[] = []
    for (const p of out.filter((x) => x.side === side).sort((a, b) => Math.abs(a.price - mid) - Math.abs(b.price - mid))) {
      const same = merged.find((m) => Math.abs(m.price - p.price) <= tol)
      if (!same) merged.push({ ...p })
      else {
        if (p.why === same.why && /^swing/.test(p.why)) same.why = same.why.replace(/( ×(\d+))?$/, (_m, _a, n) => ` ×${(Number(n) || 1) + 1}`)
        else if (!same.why.includes(p.why)) same.why += ` + ${p.why}`
        same.trust = Math.min(90, Math.max(same.trust, p.trust) + 8)
      }
    }
    result.push(...merged.slice(0, perSide))
  }
  return result
}
