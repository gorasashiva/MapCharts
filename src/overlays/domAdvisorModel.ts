// DOM advisor — turns what the DOM dashboard sees into one plain reading:
// LOOK FOR LONGS, LOOK FOR SHORTS or STAND ASIDE, with the reasons, a plan
// (zone, stop, target) and the conditions that say "no trade".
//
// Inputs are all order-flow facts the dashboard already measures: which side
// absorbed, taker flow against what price did, stop sweeps and whether price
// reclaimed them, pulled (spoofed) orders, the book's bid share against its
// own recent average, and where price sits between confirmed support and
// resistance (walls, GEX levels, prices where absorption happened).
//
// This is a reading aid, not a tested strategy: the weights are judgment, not
// fitted. The dashboard keeps a live record of every call so its hit rate can
// be seen rather than assumed.

export type Bias = 'long' | 'short' | 'neutral'

export interface AdvisorLevel {
  price: number
  label: string // e.g. 'REAL WALL', 'GEX S1', 'BUYERS ABSORB'
  strength: number // 0–100
}

export interface AdvisorInput {
  now: number
  price: number
  /** How long the book has been watched (ms). */
  watchedMs: number
  /** The feed has gone quiet. */
  stale: boolean
  /** A typical 1-minute range (price units) — the yardstick for "near" and for stops. */
  typicalMove: number
  /** Absorption $ in the recent window: buyers = bids that held against selling. */
  absorbBuyers: number
  absorbSellers: number
  /** The $ that counts as meaningful absorption. */
  absorbUnit: number
  /** Taker $ in the last few minutes. */
  flowBuy: number
  flowSell: number
  /** Price change over the same few minutes (price units). */
  priceChange: number
  /** Bid share of resting size near price now, and its own recent average (0–1). */
  bidShare: number
  bidShareAvg: number
  /** Stop runs in the recent window. `reclaimed`: price is back on the other side of the swept level. */
  sweeps: { dir: 'up' | 'down'; price: number; t: number; reclaimed: boolean }[]
  /** Big orders cancelled close to price in the recent window. */
  pulledBids: number
  pulledAsks: number
  supports: AdvisorLevel[] // below price
  resistances: AdvisorLevel[] // above price
}

export interface Factor {
  name: string
  /** −1 (bearish) … +1 (bullish). */
  score: number
  weight: number
  text: string
}

export interface Plan {
  zone: [number, number]
  stop: number
  target: number
  rr: number
  zoneFrom: string
  targetFrom: string
}

export interface Advice {
  bias: Bias
  /** −100 (strongly short) … +100 (strongly long). */
  score: number
  /** 0–100: how much the evidence agrees. */
  confidence: number
  headline: string
  factors: Factor[]
  /** Why not to trade right now (empty when a long/short is suggested). */
  cautions: string[]
  plan: Plan | null
}

export const ADVISOR_THRESHOLD = 25 // |score| needed to lean one way
export const MIN_RR = 1.5
export const WARMUP_MS = 3 * 60_000

const clamp = (x: number, lo = -1, hi = 1): number => Math.max(lo, Math.min(hi, x))

export function scoreFactors(i: AdvisorInput): Factor[] {
  const f: Factor[] = []
  const tm = i.typicalMove || i.price * 0.0005

  // 1. absorption: who is defending price
  const abs = i.absorbBuyers + i.absorbSellers
  if (abs >= i.absorbUnit) {
    const s = (i.absorbBuyers - i.absorbSellers) / abs
    const side = s > 0 ? 'Buyers' : 'Sellers'
    f.push({
      name: 'Absorption',
      score: clamp(s * Math.min(1, abs / (3 * i.absorbUnit))),
      weight: 30,
      text: Math.abs(s) < 0.2 ? 'Both sides absorbing about equally' : `${side} absorbing — ${side.toLowerCase()} are defending price`,
    })
  }

  // 2. taker flow against what price did: aggression that fails is the tell
  const flow = i.flowBuy + i.flowSell
  if (flow > 0) {
    const fs = (i.flowBuy - i.flowSell) / flow // + = buyers aggressive
    const moved = clamp(i.priceChange / tm) // + = price up
    if (Math.abs(fs) >= 0.25) {
      // aggressive selling that did not push price down is bullish, and vice versa
      const failed = fs < 0 ? moved > -0.3 : moved < 0.3
      if (failed) f.push({ name: 'Flow vs price', score: fs < 0 ? 0.8 : -0.8, weight: 20, text: fs < 0 ? 'Heavy market selling is not moving price down' : 'Heavy market buying is not moving price up' })
      else f.push({ name: 'Flow vs price', score: clamp(fs), weight: 10, text: fs > 0 ? 'Market buyers are lifting price' : 'Market sellers are pushing price down' })
    }
  }

  // 3. stop runs: a sweep that price reclaims is a reversal, one it holds beyond is continuation
  const sweep = [...i.sweeps].sort((a, b) => b.t - a.t)[0]
  if (sweep) {
    const down = sweep.dir === 'down'
    if (sweep.reclaimed) f.push({ name: 'Stop run', score: down ? 0.9 : -0.9, weight: 20, text: down ? 'Sell stops swept below and price reclaimed the level' : 'Buy stops swept above and price fell back under the level' })
    else f.push({ name: 'Stop run', score: down ? -0.5 : 0.5, weight: 12, text: down ? 'Sell stops swept and price is holding below' : 'Buy stops swept and price is holding above' })
  }

  // 4. spoofing: pulled bids were fake support, pulled asks fake resistance
  if (i.pulledBids + i.pulledAsks > 0) {
    const s = clamp((i.pulledAsks - i.pulledBids) / 2)
    const text = s < 0
      ? `${i.pulledBids} bid${i.pulledBids === 1 ? '' : 's'} pulled near price — support was not real`
      : s > 0
        ? `${i.pulledAsks} ask${i.pulledAsks === 1 ? '' : 's'} pulled near price — resistance was not real`
        : 'Orders pulled on both sides'
    f.push({ name: 'Pulled orders', score: s, weight: 10, text })
  }

  // 5. book shift: bid share against its own average (the absolute share is often structural)
  const shift = i.bidShare - i.bidShareAvg
  if (Math.abs(shift) >= 0.05) f.push({ name: 'Book shift', score: clamp(shift / 0.15), weight: 10, text: shift > 0 ? 'Bids building relative to normal' : 'Asks building relative to normal' })

  // 6. location: close to strong support with room above is good for longs, and the reverse
  const sup = nearest(i.supports, i.price, 'below')
  const res = nearest(i.resistances, i.price, 'above')
  if (sup || res) {
    const dS = sup ? (i.price - sup.price) / tm : Infinity
    const dR = res ? (res.price - i.price) / tm : Infinity
    let s = 0
    if (sup && dS <= 1.5 && dR > 2) s = 0.7 * (sup.strength / 100) + 0.3
    else if (res && dR <= 1.5 && dS > 2) s = -(0.7 * (res.strength / 100) + 0.3)
    if (s) f.push({ name: 'Location', score: clamp(s), weight: 15, text: s > 0 ? `Sitting just above support (${sup!.label})` : `Sitting just under resistance (${res!.label})` })
  }
  return f
}

function nearest(levels: AdvisorLevel[], price: number, where: 'above' | 'below'): AdvisorLevel | null {
  let best: AdvisorLevel | null = null
  for (const l of levels) {
    if (where === 'above' ? l.price <= price : l.price >= price) continue
    if (!best || Math.abs(l.price - price) < Math.abs(best.price - price)) best = l
  }
  return best
}

/** Zone, stop and target for a direction, from the nearest confirmed levels. */
export function makePlan(i: AdvisorInput, bias: 'long' | 'short'): Plan {
  const tm = i.typicalMove || i.price * 0.0005
  const long = bias === 'long'
  const zoneLevel = nearest(long ? i.supports : i.resistances, i.price, long ? 'below' : 'above')
  const targetLevel = nearest(long ? i.resistances : i.supports, i.price, long ? 'above' : 'below')
  // no confirmed level close by: work from price itself
  const useLevel = zoneLevel !== null && Math.abs(zoneLevel.price - i.price) <= 3 * tm
  const anchor = useLevel ? zoneLevel.price : i.price
  const zone: [number, number] = long ? [anchor, Math.max(anchor, Math.min(i.price, anchor + 0.5 * tm))] : [Math.min(anchor, Math.max(i.price, anchor - 0.5 * tm)), anchor]
  const stop = long ? anchor - 0.75 * tm : anchor + 0.75 * tm
  const target = targetLevel ? targetLevel.price : long ? i.price + 3 * tm : i.price - 3 * tm
  const entry = long ? zone[1] : zone[0]
  const risk = Math.abs(entry - stop)
  const rr = risk > 0 ? Math.abs(target - entry) / risk : 0
  return { zone, stop, target, rr, zoneFrom: useLevel ? zoneLevel.label : 'current price', targetFrom: targetLevel ? targetLevel.label : '3 typical moves' }
}

export function advise(i: AdvisorInput): Advice {
  const factors = scoreFactors(i)
  const wSum = factors.reduce((s, f) => s + f.weight, 0)
  // dividing by at least 50 keeps one lone factor from reading as a strong call
  const score = wSum ? Math.round((100 * factors.reduce((s, f) => s + f.score * f.weight, 0)) / Math.max(wSum, 50)) : 0
  const strongUp = factors.some((f) => f.score >= 0.6)
  const strongDown = factors.some((f) => f.score <= -0.6)
  const agree = wSum ? factors.reduce((s, f) => s + (Math.sign(f.score) === Math.sign(score) ? f.weight : 0), 0) / wSum : 0
  const confidence = Math.round(Math.min(100, Math.abs(score) * 1.2) * agree)

  const cautions: string[] = []
  if (i.stale) cautions.push('Feed is stale — wait for live data')
  if (i.watchedMs < WARMUP_MS) cautions.push(`Still reading the book (${Math.ceil((WARMUP_MS - i.watchedMs) / 60_000)} min to go)`)
  if (i.sweeps.some((s) => i.now - s.t < 30_000)) cautions.push('Stops were just swept — let it settle')
  if (strongUp && strongDown) cautions.push('Strong signals on both sides — conflicted')

  const lean: Bias = score >= ADVISOR_THRESHOLD ? 'long' : score <= -ADVISOR_THRESHOLD ? 'short' : 'neutral'
  if (lean === 'neutral') cautions.push(factors.length ? 'No clear edge from order flow' : 'Nothing notable in the order flow yet')
  const plan = lean === 'neutral' ? null : makePlan(i, lean)
  if (plan && plan.rr < MIN_RR) cautions.push(`Not enough room: reward is only ${plan.rr.toFixed(1)}× the risk`)
  const bias: Bias = cautions.length ? 'neutral' : lean
  const headline = bias === 'long' ? 'LOOK FOR LONGS' : bias === 'short' ? 'LOOK FOR SHORTS' : 'STAND ASIDE'
  return {
    bias,
    score,
    confidence: bias === 'neutral' ? 0 : confidence,
    headline,
    factors: factors.sort((a, b) => b.weight * Math.abs(b.score) - a.weight * Math.abs(a.score)),
    cautions,
    plan: bias === 'neutral' ? null : plan,
  }
}

export interface AdvisorCall {
  t: number
  bias: 'long' | 'short'
  price: number
  stop: number
  target: number
  outcome: 'open' | 'target' | 'stop' | 'expired'
  /** Best move in favour before it resolved (price units). */
  best: number
}

/**
 * Live record of the calls: each long/short is followed until its target or
 * stop trades, or it expires after `expireMs` (or when the reading flips).
 */
export class AdvisorRecord {
  readonly calls: AdvisorCall[] = []
  constructor(private expireMs = 30 * 60_000) {}

  open(t: number, bias: 'long' | 'short', price: number, plan: Plan): void {
    const last = this.calls[this.calls.length - 1]
    if (last && last.outcome === 'open' && last.bias === bias) return
    if (last && last.outcome === 'open') last.outcome = 'expired' // the reading flipped
    this.calls.push({ t, bias, price, stop: plan.stop, target: plan.target, outcome: 'open', best: 0 })
  }

  update(t: number, price: number): void {
    for (const c of this.calls) {
      if (c.outcome !== 'open') continue
      const up = c.bias === 'long'
      c.best = Math.max(c.best, up ? price - c.price : c.price - price)
      if (up ? price >= c.target : price <= c.target) c.outcome = 'target'
      else if (up ? price <= c.stop : price >= c.stop) c.outcome = 'stop'
      else if (t - c.t > this.expireMs) c.outcome = 'expired'
    }
  }

  tally(): { calls: number; target: number; stop: number; expired: number; open: number } {
    const n = (o: AdvisorCall['outcome']): number => this.calls.filter((c) => c.outcome === o).length
    return { calls: this.calls.length, target: n('target'), stop: n('stop'), expired: n('expired'), open: n('open') }
  }
}
