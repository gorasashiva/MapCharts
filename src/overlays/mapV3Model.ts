// "MAP V3" — THE MAP's gold levels rebuilt the way the original builds them: from GLD (US gold
// ETF) options, computed once per session and locked, then scaled to the gold chart.
//
// Data: recorder/mapRecorder.mjs saves the CBOE delayed GLD chain (open interest = OCC's
// official figure; volume consolidated across exchanges) twice per US trading day, on New
// York time (see nyClock.ts): after the 16:00 ET close (the day's full volume) and at
// 08:15 ET (fresh open interest). One session = one morning snapshot, valid until the next.
//
// Levels (in GLD terms; scaled to the chart by scaleMapLevels):
//   gamma        Black-Scholes at the session's pricing spot (the chart's gold price at the
//                morning snapshot ÷ ratio), from each contract's IV — not the feed's live greeks
//   Call / Put   strike with the largest positive net GEX above spot / most negative below
//   GEX Flip     zero crossing of the GEX-vs-spot curve nearest spot (mapV2Model)
//   HVL          strike with the most volume in the prior session (falls back to open interest)
//   Max Pain     over the GEX window
//   VU / VD      the largest net-GEX step beyond the call / put wall (mapModel's rule)
//   0DTE         the nearest expiry only: largest call GEX above / put GEX below, and its flip
//   OI walls     largest call / put open interest for the chosen expiry set
// GEX levels use expiries within `windowDays` (14): on 29 Oct 2026 this reproduced the
// original's Call Wall, HVL, 0DTE Call, Flip, Put Wall and VD Trigger.

import { maxPain, type MapLiveMeta, type MapOiExpiry } from './mapModel'
import { bsGamma, gexAt, gexProfile, profileFlip, type MapV2ChainRow, type MapV2Levels } from './mapV2Model'

/** One recorded contract: [expiry ms, 1 = call / 0 = put, strike, open interest, IV (decimal), volume]. */
export type MapV3Row = [number, 0 | 1, number, number, number, number]

export interface MapV3Snapshot {
  u: string
  kind: 'morning' | 'close'
  /** NY trading date it belongs to. */
  nyDate: string
  time: number
  late?: boolean
  underlying: { price: number; prevClose: number }
  /** Delta India gold marks at the snapshot time (fallback for the chart scaling). */
  delta: Record<string, number>
  rows: MapV3Row[]
}

export interface MapV3IndexEntry {
  id: string
  kind: 'morning' | 'close'
  nyDate: string
  time: number
  late?: boolean
}

export interface MapV3Options {
  windowDays: number
  oiExpiry: MapOiExpiry
}

export const MAP_V3_DEFAULTS: MapV3Options = { windowDays: 14, oiExpiry: 'Every Expiry' }

const DAY_MS = 86_400_000
const YEAR_MS = 365 * DAY_MS
/** A prior-session close older than this isn't used for volume. */
const MAX_CLOSE_AGE_MS = 5 * DAY_MS

/** The session live at `at`: the latest morning snapshot at or before it, and the close before that. */
export function pickSession(index: MapV3IndexEntry[], at: number): { morning: MapV3IndexEntry; close: MapV3IndexEntry | null } | null {
  let morning: MapV3IndexEntry | null = null
  for (const e of index) if (e.kind === 'morning' && e.time <= at && (!morning || e.time > morning.time)) morning = e
  if (!morning) return null
  let close: MapV3IndexEntry | null = null
  for (const e of index) {
    if (e.kind === 'close' && e.time < morning.time && morning.time - e.time <= MAX_CLOSE_AGE_MS && (!close || e.time > close.time)) close = e
  }
  return { morning, close }
}

interface Agg {
  strike: number
  callGex: number
  putGex: number
  net: number
  callOI: number
  putOI: number
}

function aggregate(chain: MapV2ChainRow[], spot: number): Agg[] {
  const m = new Map<number, Agg>()
  for (const r of chain) {
    const a = m.get(r.strike) ?? { strike: r.strike, callGex: 0, putGex: 0, net: 0, callOI: 0, putOI: 0 }
    const gex = r.gamma * r.openInterest * spot * spot * 0.01
    if (r.side === 'CALL') {
      a.callGex += gex
      a.callOI += r.openInterest
    } else {
      a.putGex -= gex
      a.putOI += r.openInterest
    }
    a.net = a.callGex + a.putGex
    m.set(r.strike, a)
  }
  return [...m.values()].sort((x, y) => x.strike - y.strike)
}

const toChain = (rows: MapV3Row[], spot: number, at: number): MapV2ChainRow[] =>
  rows.map(([expiry, call, strike, oi, iv]) => ({
    side: call ? 'CALL' : 'PUT',
    strike,
    expiry,
    iv,
    openInterest: oi,
    gamma: bsGamma(spot, strike, iv, (expiry - at) / YEAR_MS),
  }))

function best<T>(xs: T[], score: (x: T) => number): T | null {
  let b: T | null = null
  let s = -Infinity
  for (const x of xs) {
    const v = score(x)
    if (v > s) {
      s = v
      b = x
    }
  }
  return b
}

/**
 * Locked session levels in GLD terms. `rows` = the morning chain, `volume` = the prior
 * session's close chain (for HVL), `spot` = the GLD pricing spot, `at` = the snapshot time.
 */
export function computeMapV3Levels(
  rows: MapV3Row[],
  volume: MapV3Row[] | null,
  spot: number,
  at: number,
  o: MapV3Options,
  ticker: string,
): { levels: MapV2Levels; meta: MapLiveMeta } | null {
  const live = rows.filter((r) => r[0] > at && r[2] > 0)
  if (!live.length || !(spot > 0)) return null
  const expiries = [...new Set(live.map((r) => r[0]))].sort((a, b) => a - b)
  const win = live.filter((r) => r[0] - at <= o.windowDays * DAY_MS)
  const chain = toChain(win, spot, at)
  const all = aggregate(chain, spot)
  if (!all.length) return null

  const cw = best(all.filter((a) => a.strike > spot && a.net > 0), (a) => a.net)
  const pw = best(all.filter((a) => a.strike < spot && a.net < 0), (a) => -a.net)
  const callWall = cw ? cw.strike : Number.NaN
  const putWall = pw ? pw.strike : Number.NaN
  const profile = gexProfile(chain, spot, at)

  // HVL: prior-session volume over the same window; open interest when no volume was recorded
  const vol = new Map<number, number>()
  for (const r of volume ?? []) if (r[0] > at && r[0] - at <= o.windowDays * DAY_MS) vol.set(r[2], (vol.get(r[2]) ?? 0) + r[5])
  const byVol = best([...vol], ([, v]) => v)
  const hvl = byVol && byVol[1] > 0 ? byVol[0] : best(all, (a) => a.callOI + a.putOI)!.strike

  let vu = callWall
  let vd = putWall
  let up = 0
  let dn = 0
  for (let i = 1; i < all.length; i++) {
    const step = all[i].net - all[i - 1].net
    if (Number.isFinite(callWall) && all[i].strike > callWall && step > up) {
      up = step
      vu = all[i].strike
    }
    if (Number.isFinite(putWall) && all[i].strike < putWall && step > dn) {
      dn = step
      vd = all[i].strike
    }
  }

  const z0 = expiries[0]
  const zChain = toChain(live.filter((r) => r[0] === z0), spot, at)
  const zAll = aggregate(zChain, spot)
  const zc = best(zAll.filter((a) => a.strike >= spot && a.callGex > 0), (a) => a.callGex)
  const zp = best(zAll.filter((a) => a.strike <= spot && a.putGex < 0), (a) => -a.putGex)

  const k = o.oiExpiry === '1st Expiry' ? 0 : o.oiExpiry === '2nd Expiry' ? 1 : o.oiExpiry === '3rd Expiry' ? 2 : -1
  const oiAgg = aggregate(toChain(k < 0 ? live : live.filter((r) => r[0] === expiries[k]), spot, at), spot)
  const oc = best(oiAgg, (a) => a.callOI)
  const op = best(oiAgg, (a) => a.putOI)

  const top = all.filter((a) => a.net !== 0).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 12)
  const maxAbs = Math.max(...top.map((a) => Math.abs(a.net)), 0)

  return {
    levels: {
      ticker,
      vu,
      callWall,
      flip: profileFlip(profile, spot),
      hvl,
      maxPain: maxPain(all),
      putWall,
      vd,
      z: { call: zc ? zc.strike : Number.NaN, put: zp ? zp.strike : Number.NaN, zero: profileFlip(gexProfile(zChain, spot, at), spot) },
      oiCall: oc && oc.callOI > 0 ? oc.strike : Number.NaN,
      oiPut: op && op.putOI > 0 ? op.strike : Number.NaN,
      heat: top
        .map((a) => ({ strike: a.strike, len: Math.max(1, Math.round((30 * Math.abs(a.net)) / maxAbs)), sign: (a.net > 0 ? 1 : -1) as 1 | -1 }))
        .sort((a, b) => a.strike - b.strike),
      netGex: gexAt(profile, spot),
      profile,
    },
    meta: { contracts: win.length, expiries, zeroDteExpiry: z0 ?? null, totalOI: live.reduce((s, r) => s + r[3], 0), spot },
  }
}

/** GLD-terms levels -> chart prices (×ratio). GEX values are unchanged; only prices move. */
export function scaleMapLevels(l: MapV2Levels, ratio: number): MapV2Levels {
  const s = (v: number): number => v * ratio
  return {
    ...l,
    vu: s(l.vu),
    callWall: s(l.callWall),
    flip: s(l.flip),
    hvl: s(l.hvl),
    maxPain: s(l.maxPain),
    putWall: s(l.putWall),
    vd: s(l.vd),
    z: { call: s(l.z.call), put: s(l.z.put), zero: s(l.z.zero) },
    oiCall: s(l.oiCall),
    oiPut: s(l.oiPut),
    heat: l.heat.map((h) => ({ ...h, strike: s(h.strike) })),
    profile: l.profile.map((p) => ({ price: s(p.price), gex: p.gex })),
  }
}

/** Close of the last candle at or before `t` (NaN when the candles start after it or end long before). */
export function closeAt(candles: { time: number; close: number }[], t: number, maxGapMs = 6 * 3_600_000): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (candles[m].time <= t) lo = m + 1
    else hi = m
  }
  const c = candles[lo - 1]
  return c && t - c.time <= maxGapMs ? c.close : Number.NaN
}
