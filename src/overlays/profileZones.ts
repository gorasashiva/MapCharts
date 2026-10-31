/**
 * Supply / demand zones + support/resistance strength for a volume profile.
 *
 * Zones are high-volume nodes (HVNs): runs of adjacent profile rows whose
 * volume is ≥ `thresholdPct` of the POC row's — prices the auction accepted.
 * Each is classified against the live price (below = demand/support, above =
 * supply/resistance, containing price = in play) and scored 0–100 for how
 * much it should be respected as support or resistance:
 *
 *   acceptance    0–35  zone's share of total profile volume (25%+ = max)
 *   delta         0–25  buy share for support / sell share for resistance
 *                       (40% → 0, 65%+ → max)
 *   reactions     0–25  rejections: price came back from outside and closed
 *                       back out on the side it came from (3+ = max), plus
 *                       the rejection ratio (holds vs. breaks)
 *   concentration 0–15  volume share ÷ price-width share (1× → 0, 3×+ → max)
 *
 * The score is a heuristic reading of auction-market principles, not a
 * backtested probability.
 *
 * Buy volume uses the candle's real taker `buyVolume` when the feed has it,
 * otherwise the close-location approximation (close at the high = all
 * buying, at the low = all selling).
 *
 * Low-volume nodes (LVNs) are the thin rows between zones (< `lvnPct` of the
 * POC row) where price tends to travel fast.
 */
import type { Candle } from '../core/types'

export type ZoneKind = 'demand' | 'supply' | 'inplay'
export type ZoneStrength = 'Strong' | 'Moderate' | 'Weak'

export interface ProfileZone {
  lo: number
  hi: number
  kind: ZoneKind
  hasPoc: boolean
  /** 0..1 share of the profile's total volume. */
  volShare: number
  /** 0..100 buy share of the zone's volume. */
  buyPct: number
  touches: number
  rejections: number
  score: number
  strength: ZoneStrength
}

export interface PriceBand {
  lo: number
  hi: number
}

export interface ProfileInput {
  lo: number
  hi: number
  binVolume: ArrayLike<number>
  pocBin: number
}

export function buyShare(c: Candle): number {
  if (c.buyVolume !== undefined && c.volume > 0) return Math.max(0, Math.min(1, c.buyVolume / c.volume))
  const range = c.high - c.low
  return range > 0 ? (c.close - c.low) / range : 0.5
}

/** Per-row buy and total volume from `candles`, binned like the profile — so the buy share is always self-consistent. */
function binBuy(candles: Candle[], lo: number, hi: number, bins: number): { buy: Float64Array; vol: Float64Array } {
  const buy = new Float64Array(bins)
  const vol = new Float64Array(bins)
  const range = hi - lo
  if (!(range > 0)) return { buy, vol }
  for (const c of candles) {
    const b0 = Math.max(0, Math.min(bins - 1, Math.floor(((c.low - lo) / range) * bins)))
    const b1 = Math.max(0, Math.min(bins - 1, Math.floor(((c.high - lo) / range) * bins)))
    const per = c.volume / (b1 - b0 + 1)
    const share = buyShare(c)
    for (let b = b0; b <= b1; b++) {
      vol[b] += per
      buy[b] += per * share
    }
  }
  return { buy, vol }
}

/**
 * Touches / rejections of a band across `candles`, chronologically. A touch
 * is a bar reaching into the band after the previous close was outside it; a
 * rejection is a touch that closes back out on the side it came from.
 * `role` limits which approach counts: support is tested from above,
 * resistance from below, an in-play zone from either side.
 */
export function reactions(candles: Candle[], band: PriceBand, role: ZoneKind): { touches: number; rejections: number } {
  let touches = 0
  let rejections = 0
  for (let i = 1; i < candles.length; i++) {
    const p = candles[i - 1].close
    const k = candles[i]
    const fromAbove = p > band.hi
    const fromBelow = p < band.lo
    if (!fromAbove && !fromBelow) continue
    if (role === 'demand' && !fromAbove) continue
    if (role === 'supply' && !fromBelow) continue
    const reached = fromAbove ? k.low <= band.hi : k.high >= band.lo
    if (!reached) continue
    touches++
    if (fromAbove ? k.close > band.hi : k.close < band.lo) rejections++
  }
  return { touches, rejections }
}

export type ZoneRole = 'support' | 'resistance'

/**
 * What the zone is doing for price right now. An in-play zone acts as
 * support while price holds its upper half, resistance in its lower half.
 */
export function zoneRole(kind: ZoneKind, lo: number, hi: number, price: number): ZoneRole {
  if (kind === 'demand') return 'support'
  if (kind === 'supply') return 'resistance'
  return price >= (lo + hi) / 2 ? 'support' : 'resistance'
}

/** "Buyers 60%" / "Sellers 56%" / "Balanced" (within 48–52%). */
export function dominanceText(buyPct: number): string {
  if (buyPct >= 52) return `Buyers ${buyPct.toFixed(0)}%`
  if (buyPct <= 48) return `Sellers ${(100 - buyPct).toFixed(0)}%`
  return 'Balanced'
}

/**
 * One-line zone description shared by every tool that draws zones, e.g.
 * "SUPPORT · Buyers 60% ✓" or "IN PLAY → RESISTANCE · Buyers 55% ⚠".
 * ✓ = the side that should defend the level dominates; ⚠ = the other side does.
 */
export function zoneHeadline(kind: ZoneKind, lo: number, hi: number, price: number, buyPct: number): string {
  const role = zoneRole(kind, lo, hi, price)
  const roleText = kind === 'inplay' ? `IN PLAY → ${role.toUpperCase()}` : role.toUpperCase()
  const dom = dominanceText(buyPct)
  const aligned = dom === 'Balanced' ? '' : (role === 'support') === buyPct > 50 ? ' ✓' : ' ⚠'
  return `${roleText} · ${dom}${aligned}`
}

export function strengthLabel(score: number): ZoneStrength {
  return score >= 70 ? 'Strong' : score >= 45 ? 'Moderate' : 'Weak'
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

export function scoreZone(z: Pick<ProfileZone, 'kind' | 'volShare' | 'buyPct' | 'touches' | 'rejections'>, widthShare: number): number {
  const acceptance = clamp01(z.volShare / 0.25) * 35
  const aligned = z.kind === 'demand' ? z.buyPct : z.kind === 'supply' ? 100 - z.buyPct : Math.max(z.buyPct, 100 - z.buyPct)
  const delta = clamp01((aligned - 40) / 25) * 25
  const react = clamp01(z.rejections / 3) * 20 + (z.touches > 0 ? (z.rejections / z.touches) * 5 : 0)
  const density = widthShare > 0 ? z.volShare / widthShare : 0
  const concentration = clamp01((density - 1) / 2) * 15
  return Math.round(acceptance + delta + react + concentration)
}

/**
 * Build zones from a computed profile. `profileCandles` are the bars the
 * profile was built from (for the buy/sell split); `reactionCandles` are the
 * bars to count touches/rejections over (usually the same, or prev + today
 * for a previous-session profile).
 */
export function buildProfileZones(p: ProfileInput, profileCandles: Candle[], reactionCandles: Candle[], price: number, thresholdPct: number, mergeGapRows = 0): ProfileZone[] {
  const bins = p.binVolume.length
  const range = p.hi - p.lo
  if (!bins || !(range > 0)) return []
  const pocVol = p.binVolume[p.pocBin]
  const min = pocVol * (thresholdPct / 100)
  let total = 0
  for (let b = 0; b < bins; b++) total += p.binVolume[b]
  if (!(total > 0)) return []
  const split = binBuy(profileCandles, p.lo, p.hi, bins)
  const step = range / bins
  const zones: ProfileZone[] = []
  let b = 0
  while (b < bins) {
    if (!(p.binVolume[b] > 0 && p.binVolume[b] >= min)) {
      b++
      continue
    }
    const heavy = (k: number): boolean => p.binVolume[k] > 0 && p.binVolume[k] >= min
    let e = b
    for (;;) {
      if (e + 1 < bins && heavy(e + 1)) {
        e++
        continue
      }
      // Bridge a gap of up to `mergeGapRows` thin rows when a heavy row follows.
      let thin = 0
      while (e + 1 + thin < bins && !heavy(e + 1 + thin)) thin++
      if (thin > 0 && thin <= mergeGapRows && e + 1 + thin < bins) {
        e += 1 + thin
        continue
      }
      break
    }
    let vol = 0
    let bv = 0
    let cv = 0
    for (let k = b; k <= e; k++) {
      vol += p.binVolume[k]
      bv += split.buy[k]
      cv += split.vol[k]
    }
    const lo = p.lo + b * step
    const hi = p.lo + (e + 1) * step
    const kind: ZoneKind = hi <= price ? 'demand' : lo >= price ? 'supply' : 'inplay'
    const r = reactions(reactionCandles, { lo, hi }, kind)
    const zone = { lo, hi, kind, hasPoc: p.pocBin >= b && p.pocBin <= e, volShare: vol / total, buyPct: cv > 0 ? (bv / cv) * 100 : 50, touches: r.touches, rejections: r.rejections }
    const score = scoreZone(zone, (e - b + 1) / bins)
    zones.push({ ...zone, score, strength: strengthLabel(score) })
    b = e + 1
  }
  return zones
}

/**
 * Declutter: the zone price is in, plus the `perSide` nearest zones above
 * and below it — the levels price can actually reach next.
 */
export function nearestZones<T extends { lo: number; hi: number }>(zones: T[], price: number, perSide: number): T[] {
  const inside = zones.filter((z) => z.lo <= price && z.hi >= price)
  const above = zones.filter((z) => z.lo > price).sort((a, b) => a.lo - b.lo).slice(0, perSide)
  const below = zones.filter((z) => z.hi < price).sort((a, b) => b.hi - a.hi).slice(0, perSide)
  return [...below.reverse(), ...inside, ...above]
}

/** The first thin band price would cross on each side (between price and the next zone). */
export function nextLvns(lvns: PriceBand[], price: number): PriceBand[] {
  const above = lvns.filter((l) => l.lo >= price).sort((a, b) => a.lo - b.lo)[0]
  const below = lvns.filter((l) => l.hi <= price).sort((a, b) => b.hi - a.hi)[0]
  return [below, above].filter((l): l is PriceBand => !!l)
}

/** Thin rows between zones (< lvnPct of the POC row) — fast-travel areas. */
export function findLvns(p: ProfileInput, lvnPct: number): PriceBand[] {
  const bins = p.binVolume.length
  const step = (p.hi - p.lo) / bins
  const max = p.binVolume[p.pocBin] * (lvnPct / 100)
  const out: PriceBand[] = []
  // Skip the profile's own tails: an LVN must sit between heavier rows.
  let first = 0
  while (first < bins && p.binVolume[first] < max) first++
  let last = bins - 1
  while (last >= 0 && p.binVolume[last] < max) last--
  let b = first
  while (b <= last) {
    if (p.binVolume[b] >= max) {
      b++
      continue
    }
    let e = b
    while (e + 1 <= last && p.binVolume[e + 1] < max) e++
    out.push({ lo: p.lo + b * step, hi: p.lo + (e + 1) * step })
    b = e + 1
  }
  return out
}
