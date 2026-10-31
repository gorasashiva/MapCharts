// "GEX Sabers" — a pure GEX study: per-strike dealer gamma exposure for the chosen option
// expiries, ranked and scored for the right side of the chart. Pure math;
// examples/basic/gexSabers.ts fetches the chain and draws the light-saber bars.
//
// GEX per contract = gamma × size × spot² × 1% (calls +, puts −) — the same dollar-gamma
// convention as the GEX tool (gex.ts). `size` is open interest (standing hedging walls) or
// the last 24h traded volume (where recent flow is building hedging), per the "size by" setting.
//
//   Resistance  strikes ABOVE price with the largest call GEX (dealers sell into rallies)
//   Support     strikes BELOW price with the largest put GEX (dealers buy dips)
//   Liquidity   strikes with the largest total gamma (calls + |puts|): where hedging flow
//               concentrates and price tends to be pulled / to churn
//   HVL         the strike with the most options traded in 24h (orange) — on a wall it takes it over
//   Peaks       the most negative net gamma strike near price (yellow, MAX −Γ) and the most
//               positive (bright green, MAX +Γ); they recolour the saber on their strike
//   Zero gamma  the net-GEX crossover (gex.ts / mapModel.gexFlip), no strength
//
// Strength (0–100), one scale for every saber: 100 = the heaviest total gamma (calls + |puts|)
// at any strike near price. A wall scores its call (or put) GEX on that scale, a liquidity
// level its total; a saber that is both shows the stronger of the two.

import { gexFlip } from './mapModel'

/** One option contract, as the chain delivers it (sizes in base units). */
export interface SaberContract {
  side: 'CALL' | 'PUT'
  strike: number
  expiry: number
  gamma: number
  openInterest: number
  volume: number
}

export type ExpirySelection = 'nearest' | 'nearest2' | 'nearest3' | 'nearest6' | 'week' | 'month'
export type SizeBy = 'oi' | 'volume'

/** One strike's dealer GEX ($ per 1% move; calls +, puts −) and the expiry that contributes most. */
export interface StrikeGex {
  strike: number
  callGex: number
  putGex: number
  /** Expiry (epoch ms) with the largest |GEX| at this strike. */
  topExpiry: number
  /** Options traded at this strike (calls + puts, base units). */
  volume: number
}

/** 'hvl' = the highest-volume strike, drawn yellow (it takes over a wall / liquidity saber on its strike). */
export type SaberKind = 'resistance' | 'support' | 'liquidity' | 'hvl' | 'peakPos' | 'peakNeg' | 'zero'

export interface Saber {
  kind: SaberKind
  price: number
  /** 0–100 (NaN for zero gamma). */
  strength: number
  /** Call GEX (resistance), put GEX (support) or total |GEX| (liquidity), $ per 1% move. */
  gex: number
  /** Dominant expiry at the strike (NaN for zero gamma). */
  expiry: number
  /** Options traded at the strike (NaN for zero gamma). */
  volume: number
  /** Short names: ['R1'], ['S2', 'L1'], ['HVL', 'R1'], ['ZERO Γ']. */
  names: string[]
}

export interface SaberOptions {
  /** Resistance / support sabers per side. */
  perSide: number
  /** Liquidity sabers. */
  liquidity: number
  /** Only strikes within this fraction of price compete (0.1 = ±10%). */
  range: number
  zeroGamma: boolean
  /** Highlight the highest-volume strike (yellow). */
  hvl: boolean
  /** Colour the most positive (bright green) / most negative (yellow) net gamma strikes. */
  peaks: boolean
}

export const SABER_DEFAULTS: SaberOptions = { perSide: 3, liquidity: 2, range: 0.1, zeroGamma: true, hvl: true, peaks: true }

const DAY_MS = 86_400_000

/** The expiries the study uses, nearest first. */
export function selectExpiries(contracts: SaberContract[], now: number, sel: ExpirySelection): number[] {
  const all = [...new Set(contracts.filter((c) => c.expiry > now).map((c) => c.expiry))].sort((a, b) => a - b)
  switch (sel) {
    case 'nearest':
      return all.slice(0, 1)
    case 'nearest2':
      return all.slice(0, 2)
    case 'nearest3':
      return all.slice(0, 3)
    case 'nearest6':
      return all.slice(0, 6)
    case 'week':
      return all.filter((e) => e - now <= 7 * DAY_MS)
    case 'month':
      return all.filter((e) => e - now <= 30 * DAY_MS)
  }
}

/** Per-strike GEX over the given expiries, sized by open interest or today's volume. */
export function strikeGex(contracts: SaberContract[], spot: number, expiries: number[], sizeBy: SizeBy): StrikeGex[] {
  const want = new Set(expiries)
  const m = new Map<number, { strike: number; callGex: number; putGex: number; volume: number; byExp: Map<number, number> }>()
  for (const c of contracts) {
    if (!want.has(c.expiry) || !(c.strike > 0)) continue
    const a = m.get(c.strike) ?? { strike: c.strike, callGex: 0, putGex: 0, volume: 0, byExp: new Map<number, number>() }
    a.volume += c.volume || 0
    m.set(c.strike, a)
    const size = sizeBy === 'oi' ? c.openInterest : c.volume
    if (!c.gamma || !size) continue
    const gex = c.gamma * size * spot * spot * 0.01 * (c.side === 'CALL' ? 1 : -1)
    if (c.side === 'CALL') a.callGex += gex
    else a.putGex += gex
    a.byExp.set(c.expiry, (a.byExp.get(c.expiry) ?? 0) + Math.abs(gex))
  }
  return [...m.values()]
    .filter((a) => a.byExp.size > 0 || a.volume > 0)
    .map((a) => ({
      strike: a.strike,
      callGex: a.callGex,
      putGex: a.putGex,
      volume: a.volume,
      topExpiry: a.byExp.size ? [...a.byExp].reduce((b, x) => (x[1] > b[1] ? x : b))[0] : Number.NaN,
    }))
    .sort((x, y) => x.strike - y.strike)
}

export function buildSabers(strikes: StrikeGex[], spot: number, o: SaberOptions = SABER_DEFAULTS): Saber[] {
  if (!(spot > 0)) return []
  const near = strikes.filter((s) => Math.abs(s.strike - spot) <= spot * o.range)
  const total = (s: StrikeGex): number => s.callGex - s.putGex // calls + |puts|
  const maxTotal = Math.max(0, ...near.map(total))
  const out: Saber[] = []
  if (maxTotal <= 0) return out

  near
    .filter((s) => s.strike > spot && s.callGex > 0)
    .sort((a, b) => b.callGex - a.callGex)
    .slice(0, o.perSide)
    .forEach((s, i) => out.push({ kind: 'resistance', price: s.strike, strength: (100 * s.callGex) / maxTotal, gex: s.callGex, expiry: s.topExpiry, volume: s.volume, names: [`R${i + 1}`] }))
  near
    .filter((s) => s.strike < spot && s.putGex < 0)
    .sort((a, b) => a.putGex - b.putGex)
    .slice(0, o.perSide)
    .forEach((s, i) => out.push({ kind: 'support', price: s.strike, strength: (-100 * s.putGex) / maxTotal, gex: s.putGex, expiry: s.topExpiry, volume: s.volume, names: [`S${i + 1}`] }))

  // Liquidity: the heaviest total gamma; on a wall's strike it joins that saber ("R1 · L1")
  // and the saber shows the stronger score.
  ;[...near]
    .sort((a, b) => total(b) - total(a))
    .slice(0, o.liquidity)
    .forEach((s, i) => {
      const strength = (100 * total(s)) / maxTotal
      const same = out.find((x) => x.price === s.strike)
      if (!same) {
        out.push({ kind: 'liquidity', price: s.strike, strength, gex: total(s), expiry: s.topExpiry, volume: s.volume, names: [`L${i + 1}`] })
        return
      }
      same.names.push(`L${i + 1}`)
      if (strength > same.strength) {
        same.strength = strength
        same.gex = total(s)
      }
    })

  // HVL: the most-traded strike near price, yellow; on another saber's strike it takes it over.
  if (o.hvl) {
    const top = near.reduce<StrikeGex | null>((b, s) => (s.volume > (b ? b.volume : 0) ? s : b), null)
    if (top) {
      const same = out.find((x) => x.price === top.strike)
      if (same) {
        same.kind = 'hvl'
        same.names.unshift('HVL')
      } else {
        out.push({ kind: 'hvl', price: top.strike, strength: (100 * total(top)) / maxTotal, gex: total(top), expiry: top.topExpiry, volume: top.volume, names: ['HVL'] })
      }
    }
  }

  // Peaks: the most positive / most negative net gamma near price — recolour their saber, or add one.
  if (o.peaks) {
    const net = (s: StrikeGex): number => s.callGex + s.putGex
    const peak = (kind: 'peakPos' | 'peakNeg', name: string, s: StrikeGex | null): void => {
      if (!s) return
      const same = out.find((x) => x.price === s.strike)
      if (same) {
        same.kind = kind
        same.names.unshift(name)
      } else {
        out.push({ kind, price: s.strike, strength: (100 * total(s)) / maxTotal, gex: net(s), expiry: s.topExpiry, volume: s.volume, names: [name] })
      }
    }
    peak('peakPos', 'MAX +Γ', near.reduce<StrikeGex | null>((b, s) => (net(s) > 0 && (!b || net(s) > net(b)) ? s : b), null))
    peak('peakNeg', 'MAX −Γ', near.reduce<StrikeGex | null>((b, s) => (net(s) < 0 && (!b || net(s) < net(b)) ? s : b), null))
  }

  if (o.zeroGamma) {
    const z = gexFlip(strikes.map((s) => ({ strike: s.strike, net: s.callGex + s.putGex })))
    if (Number.isFinite(z)) out.push({ kind: 'zero', price: z, strength: Number.NaN, gex: Number.NaN, expiry: Number.NaN, volume: Number.NaN, names: ['ZERO Γ'] })
  }
  return out.sort((a, b) => b.price - a.price)
}

/** $ per 1% move, compact: 1.2B / 340M / 12K. */
export function fmtGex(v: number): string {
  if (!Number.isFinite(v)) return ''
  const a = Math.abs(v)
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : a.toFixed(0)
  return `${v < 0 ? '−' : ''}$${s}`
}

/**
 * Label y positions at least `gap` apart, each as close to its own y as possible, kept inside
 * [top, bottom]. Input order is preserved (sorted by y ascending in, same order out).
 */
export function spreadLabels(ys: number[], gap: number, top: number, bottom: number): number[] {
  const out = ys.map((y) => Math.min(Math.max(y, top), bottom))
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap)
  // pushed past the bottom: walk back up
  if (out.length && out[out.length - 1] > bottom) {
    out[out.length - 1] = bottom
    for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap)
  }
  return out
}
