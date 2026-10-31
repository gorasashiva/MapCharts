/**
 * MAP V2 — THE MAP clone (mapModel.ts) with four rules brought in line with the SYNDICATE
 * guide. Everything else (snapshot data, max pain, OI walls, heatmap, engulfing retest) is
 * reused from mapModel unchanged.
 *
 *   1. Gamma flip = the spot price where TOTAL dealer GEX changes sign. The chain is re-priced
 *      (Black-Scholes gamma from each contract's mark IV) on a grid of hypothetical spots;
 *      the flip is the zero crossing nearest spot, and the regime is the sign of GEX at the
 *      current price. (The clone's cumulative-by-strike crossing can sit on the wrong side.)
 *   2. Break & Retest needs the retest within the last 3 closed bars — an old retest no
 *      longer turns any later green / red candle into an entry.
 *   3. Entries respect regime: in negative gamma a Touch & Bounce (fade) is downgraded to
 *      WAIT and a Break & Retest entry carries "reduce size".
 *   4. Call Wall / 0DTE Call are the biggest call GEX ABOVE the session's reference price,
 *      Put Wall / 0DTE Put the biggest put GEX BELOW it. The reference is the price when the
 *      current 0DTE session began (fixed for the day, as the guide's levels are), so a wall
 *      that price later breaks stays put and can be retested.
 *
 * Pure — no DOM / engine.
 */

import { maxPain, type MapAction, type MapBar, type MapChainRow, type MapLevels, type MapLiveMeta, type MapOiExpiry } from './mapModel'

export interface MapV2ChainRow extends MapChainRow {
  /** Mark implied volatility, decimal (0.45 = 45%). 0 / missing -> the exchange gamma is used as is. */
  iv: number
}

/** Total dealer GEX at one hypothetical spot. */
export interface GexPoint {
  price: number
  gex: number
}

export interface MapV2Levels extends MapLevels {
  /** GEX-vs-spot curve (live chain only; empty for the snapshot). */
  profile: GexPoint[]
}

const YEAR_MS = 365 * 86_400_000
const DAY_MS = 86_400_000

/** Black-Scholes gamma per unit of underlying (r = 0). */
export function bsGamma(spot: number, strike: number, iv: number, years: number): number {
  if (!(spot > 0 && strike > 0 && iv > 0 && years > 0)) return 0
  const v = iv * Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * years) / v
  return Math.exp(-0.5 * d1 * d1) / (Math.sqrt(2 * Math.PI) * spot * v)
}

/**
 * Dealer GEX (calls +, puts −; gamma × OI × S² × 1%, as gex.ts) re-priced at each of `steps`
 * spots across spot ± `range`. Contracts without an IV keep their exchange gamma.
 */
export function gexProfile(rows: MapV2ChainRow[], spot: number, now: number, range = 0.1, steps = 161): GexPoint[] {
  const out: GexPoint[] = []
  for (let i = 0; i < steps; i++) {
    const s = spot * (1 - range + (2 * range * i) / (steps - 1))
    let gex = 0
    for (const r of rows) {
      const t = (r.expiry - now) / YEAR_MS
      const gm = r.iv > 0 ? bsGamma(s, r.strike, r.iv, t) : r.gamma || 0
      gex += (r.side === 'CALL' ? 1 : -1) * gm * (r.openInterest || 0) * s * s * 0.01
    }
    out.push({ price: s, gex })
  }
  return out
}

/** GEX at `price`, linearly interpolated (clamped to the ends). NaN for an empty profile. */
export function gexAt(profile: GexPoint[], price: number): number {
  if (!profile.length) return Number.NaN
  if (price <= profile[0].price) return profile[0].gex
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]
    const b = profile[i]
    if (price <= b.price) return a.gex + ((b.gex - a.gex) * (price - a.price)) / (b.price - a.price)
  }
  return profile[profile.length - 1].gex
}

/** The zero crossing of the profile nearest `spot` (interpolated); NaN when GEX never changes sign. */
export function profileFlip(profile: GexPoint[], spot: number): number {
  let best = Number.NaN
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]
    const b = profile[i]
    if ((a.gex < 0 && b.gex >= 0) || (a.gex >= 0 && b.gex < 0)) {
      const x = a.price + ((b.price - a.price) * -a.gex) / (b.gex - a.gex)
      if (!Number.isFinite(best) || Math.abs(x - spot) < Math.abs(best - spot)) best = x
    }
  }
  return best
}

/**
 * Reference price for the wall sides (rule 4): the close of the last bar at or before the
 * start of the current 0DTE session (next expiry − 24h). Falls back to `spot` when the
 * candles don't reach back that far.
 */
export function sessionRefPrice(bars: { time: number; close: number }[], nextExpiry: number | null, spot: number): number {
  if (nextExpiry === null || !bars.length) return spot
  const start = nextExpiry - DAY_MS
  if (bars[0].time > start) return spot
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].time <= start) return bars[i].close
  return spot
}

interface StrikeAgg {
  strike: number
  callGex: number
  putGex: number
  net: number
  callOI: number
  putOI: number
}

function aggregate(rows: MapChainRow[], spot: number): StrikeAgg[] {
  const m = new Map<number, StrikeAgg>()
  for (const r of rows) {
    const a = m.get(r.strike) ?? { strike: r.strike, callGex: 0, putGex: 0, net: 0, callOI: 0, putOI: 0 }
    const gex = (r.gamma || 0) * (r.openInterest || 0) * spot * spot * 0.01
    if (r.side === 'CALL') {
      a.callGex += gex
      a.callOI += r.openInterest || 0
    } else {
      a.putGex -= gex
      a.putOI += r.openInterest || 0
    }
    a.net = a.callGex + a.putGex
    m.set(r.strike, a)
  }
  return [...m.values()].sort((x, y) => x.strike - y.strike)
}

const argmax = <T,>(xs: T[], f: (x: T) => number): T | undefined => xs.reduce<T | undefined>((b, x) => (b === undefined || f(x) > f(b) ? x : b), undefined)

/** Rule 4: biggest call GEX strictly above `ref`, biggest put GEX strictly below it. */
function sidedWalls(agg: StrikeAgg[], ref: number): { call: number; put: number } {
  const cw = argmax(agg.filter((l) => l.strike > ref), (l) => l.callGex)
  const pw = argmax(agg.filter((l) => l.strike < ref), (l) => -l.putGex)
  return { call: cw && cw.callGex > 0 ? cw.strike : Number.NaN, put: pw && pw.putGex < 0 ? pw.strike : Number.NaN }
}

/**
 * MAP V2 levels from a live chain. `spot` scales dollar gamma and centres the profile; `ref`
 * (sessionRefPrice) decides which side of price each wall must be on.
 */
export function computeMapV2LevelsFromChain(
  rows: MapV2ChainRow[],
  spot: number,
  ref: number,
  now: number,
  oiExpiry: MapOiExpiry,
  ticker: string,
): { levels: MapV2Levels; meta: MapLiveMeta } | null {
  const live = rows.filter((r) => r.expiry > now && Number.isFinite(r.strike))
  if (!live.length || !(spot > 0)) return null
  const side = ref > 0 ? ref : spot
  const expiries = [...new Set(live.map((r) => r.expiry))].sort((a, b) => a - b)
  const all = aggregate(live, spot)
  if (!all.length) return null

  const { call: callWall, put: putWall } = sidedWalls(all, side)
  const profile = gexProfile(live, spot, now)
  const flip = profileFlip(profile, spot)
  const hvl = argmax(all, (l) => l.callOI + l.putOI)!.strike
  const mp = maxPain(all)

  // VU / VD as in the clone: biggest step in net GEX beyond each wall.
  let vu = callWall
  let bestUp = 0
  let vd = putWall
  let bestDn = 0
  for (let i = 1; i < all.length; i++) {
    const step = all[i].net - all[i - 1].net
    if (Number.isFinite(callWall) && all[i].strike > callWall && step > bestUp) {
      bestUp = step
      vu = all[i].strike
    }
    if (Number.isFinite(putWall) && all[i].strike < putWall && step > bestDn) {
      bestDn = step
      vd = all[i].strike
    }
  }

  // 0DTE = nearest expiry only; its walls follow rule 4 too, its 0γ the re-priced profile.
  const z0 = expiries[0]
  const zRows = live.filter((r) => r.expiry === z0)
  const zw = sidedWalls(aggregate(zRows, spot), side)
  const z = { call: zw.call, put: zw.put, zero: profileFlip(gexProfile(zRows, spot, now), spot) }

  const k = oiExpiry === '1st Expiry' ? 0 : oiExpiry === '2nd Expiry' ? 1 : oiExpiry === '3rd Expiry' ? 2 : -1
  const oiAgg = aggregate(k < 0 ? live : live.filter((r) => r.expiry === expiries[k]), spot)
  const oc = argmax(oiAgg, (l) => l.callOI)
  const op = argmax(oiAgg, (l) => l.putOI)

  const top = [...all].filter((l) => l.net !== 0).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 12)
  const maxAbs = Math.max(...top.map((l) => Math.abs(l.net)), 0)
  const heat = top
    .map((l) => ({ strike: l.strike, len: Math.max(1, Math.round((30 * Math.abs(l.net)) / maxAbs)), sign: (l.net > 0 ? 1 : -1) as 1 | -1 }))
    .sort((a, b) => a.strike - b.strike)

  return {
    levels: {
      ticker,
      vu,
      callWall,
      flip,
      hvl,
      maxPain: mp,
      putWall,
      vd,
      z,
      oiCall: oc && oc.callOI > 0 ? oc.strike : Number.NaN,
      oiPut: op && op.putOI > 0 ? op.strike : Number.NaN,
      heat,
      netGex: gexAt(profile, spot),
      profile,
    },
    meta: { contracts: live.length, expiries, zeroDteExpiry: z0 ?? null, totalOI: live.reduce((a, r) => a + (r.openInterest || 0), 0), spot },
  }
}

/** Rule 1: positive gamma = dealer GEX at `price` > 0 (profile), else price vs flip, else total net GEX. */
export function mapV2PosGamma(l: MapV2Levels, price: number): boolean {
  if (l.profile.length) return gexAt(l.profile, price) > 0
  return Number.isFinite(l.flip) ? price >= l.flip : l.netGex > 0
}

/** Status table: same bias ladder as the clone, regime from mapV2PosGamma. */
export function mapV2Status(l: MapV2Levels, close: number): { posGamma: boolean; regime: string; bias: string; biasSide: 1 | -1 | 0 } {
  const posGamma = mapV2PosGamma(l, close)
  const bias =
    close > l.vu ? 'VU SQUEEZE ^^' : close > l.callWall ? 'ABOVE CALL +' : close < l.vd ? 'VD BREAK vv' : close < l.putWall ? 'PUT BREAK --' : posGamma ? 'RANGE DAY' : 'VOLATILE !'
  return { posGamma, regime: posGamma ? 'POS  PINNED' : 'NEG  TRENDING', bias, biasSide: close > l.callWall ? 1 : close < l.putWall ? -1 : 0 }
}

const fmtLevel = (p: number): string => (p >= 1000 ? p.toFixed(0) : p >= 10 ? p.toFixed(2) : p.toPrecision(5))

/**
 * 0DTE entry rules (the clone's zeroDteAction with rules 2 and 3). Closed bars only;
 * one rule reported, in this priority:
 *   1. broke a wall, retested it within the last 3 bars, confirmation candle → BUY / SELL
 *      breakout (negative gamma: "reduce size")
 *   2. broke a wall and still running > 1 ATR beyond → HOLD OFF; broke but no fresh
 *      retest / retest without confirmation → WAIT
 *   3. Touch & Bounce: wall touched in the last 3 bars, held, confirmation candle → BUY / SELL
 *      in positive gamma; WAIT in negative gamma (fades are not valid there)
 *   4. a wall touched without confirmation → WAIT
 *   5. otherwise NONE
 * "Touch" = within 0.25 ATR(14); a breakout is looked for in the last 20 bars.
 */
export function zeroDteActionV2(bars: MapBar[], l: MapV2Levels): MapAction {
  const closed = bars.slice(0, -1) // the last bar is still forming
  const n = closed.length
  const zc = Number.isFinite(l.z.call)
  const zp = Number.isFinite(l.z.put)
  const C = zc ? l.z.call : l.callWall
  const P = zp ? l.z.put : l.putWall
  const cName = `${zc ? '0DTE ' : ''}Call Wall ${fmtLevel(C)}`
  const pName = `${zp ? '0DTE ' : ''}Put Wall ${fmtLevel(P)}`
  if (n < 16 || (!Number.isFinite(C) && !Number.isFinite(P))) return { kind: 'NONE', text: 'No 0DTE levels yet' }

  let trSum = 0
  for (let i = n - 14; i < n; i++) {
    const b = closed[i]
    const pc = closed[i - 1].close
    trSum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc))
  }
  const atr = trSum / 14
  const last = closed[n - 1]
  const tol = Math.max(0.25 * atr, last.close * 0.0002)
  const bull = last.close > last.open
  const bear = last.close < last.open
  const recent = closed.slice(n - 3)
  const pos = mapV2PosGamma(l, last.close)
  const negNote = pos ? '' : ' · NEG γ: reduce size'

  const breakout = (lvl: number, dir: 1 | -1): MapAction | null => {
    if (!Number.isFinite(lvl)) return null
    let b = -1
    for (let i = n - 1; i >= Math.max(1, n - 20); i--) {
      if (dir * (closed[i].close - lvl) > 0 && dir * (closed[i - 1].close - lvl) <= 0) {
        b = i
        break
      }
    }
    if (b < 0) return null
    for (let i = b; i < n; i++) if (dir * (closed[i].close - lvl) < -tol) return null // closed back through: failed
    const name = dir > 0 ? cName : pName
    // Rule 2: only a retest in the last 3 closed bars counts.
    let retest = false
    for (let i = Math.max(b + 1, n - 3); i < n; i++) if (dir > 0 ? closed[i].low <= lvl + tol : closed[i].high >= lvl - tol) retest = true
    if (retest && (dir > 0 ? bull : bear) && dir * (last.close - lvl) > 0) {
      return dir > 0 ? { kind: 'BUY', text: `BUY breakout · ${name} retest held${negNote}` } : { kind: 'SELL', text: `SELL breakdown · ${name} retest held${negNote}` }
    }
    if (retest) return { kind: 'WAIT', text: `WAIT · retesting broken ${name}, needs ${dir > 0 ? 'bullish' : 'bearish'} candle` }
    if (dir * (last.close - lvl) > atr) return { kind: 'HOLD OFF', text: `Strong break ${dir > 0 ? 'above' : 'below'} ${name} · don't ${dir > 0 ? 'sell' : 'buy'} against it` }
    return { kind: 'WAIT', text: `WAIT · broke ${dir > 0 ? 'above' : 'below'} ${name}, wait for retest` }
  }
  const up = breakout(C, 1)
  const dn = breakout(P, -1)
  for (const a of [up, dn]) if (a && (a.kind === 'BUY' || a.kind === 'SELL')) return a
  if (up || dn) return (up ?? dn)!

  // Touch & Bounce — a fade, valid in positive gamma only (rule 3).
  if (Number.isFinite(P) && recent.some((b) => b.low <= P + tol) && last.close > P) {
    if (!bull) return { kind: 'WAIT', text: `WAIT · at ${pName}, no bullish confirmation yet` }
    return pos ? { kind: 'BUY', text: `BUY · ${pName} held, bullish confirmation` } : { kind: 'WAIT', text: `WAIT · ${pName} held but NEG γ · no fades, wait for break & retest` }
  }
  if (Number.isFinite(C) && recent.some((b) => b.high >= C - tol) && last.close < C) {
    if (!bear) return { kind: 'WAIT', text: `WAIT · at ${cName}, no bearish confirmation yet` }
    return pos ? { kind: 'SELL', text: `SELL · ${cName} held, bearish confirmation` } : { kind: 'WAIT', text: `WAIT · ${cName} held but NEG γ · no fades, wait for break & retest` }
  }
  return {
    kind: 'NONE',
    text: Number.isFinite(P) && Number.isFinite(C) ? `No setup · price between ${fmtLevel(P)} and ${fmtLevel(C)}` : 'No setup · no 0DTE level in play',
  }
}
