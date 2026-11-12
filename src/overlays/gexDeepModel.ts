// Pure maths for the three GEX views modelled on DeepCharts' Option GEX Profile, Option GEX
// Heatmap and Option Summary GEX — rebuilt on Delta's public option chain (BTC, ETH, gold),
// because DeepCharts' source is CBOE participant data for SPX, which this platform doesn't have.
// Per-strike GEX comes from gexSabersModel.strikeGex (same formula as GEX Sabers):
//   gamma × size × spot² × 1% × sign (calls +, puts −).
// The DeepCharts articles give no formulas, so every threshold here is a documented choice.

import type { StrikeGex } from './gexSabersModel'

/** Strikes within ±rangePct of spot, nearest-first capped at numStrikes (0 = no cap), ascending by strike. */
export function visibleStrikes(strikes: StrikeGex[], spot: number, rangePct: number, numStrikes: number): StrikeGex[] {
  if (!(spot > 0)) return []
  const band = spot * (rangePct / 100)
  let rows = strikes.filter((s) => Math.abs(s.strike - spot) <= band)
  if (numStrikes > 0 && rows.length > numStrikes) {
    rows = [...rows].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, numStrikes)
  }
  return rows.sort((a, b) => a.strike - b.strike)
}

/** Smallest gap between neighbouring strikes — the height of one strike row on the chart. */
export function strikeStep(strikes: StrikeGex[], spot: number): number {
  let step = Number.POSITIVE_INFINITY
  for (let i = 1; i < strikes.length; i++) {
    const d = strikes[i].strike - strikes[i - 1].strike
    if (d > 0 && d < step) step = d
  }
  return Number.isFinite(step) ? step : spot * 0.001
}

// ---------------------------------------------------------------------------
// Profile (split or net)
// ---------------------------------------------------------------------------
export interface ProfileRow {
  strike: number
  callGex: number
  putGex: number
  net: number
}

export interface ProfileModel {
  rows: ProfileRow[]
  /** Largest |value| across the rows, in split or net mode — bars scale to it. */
  maxAbs: number
  /** Strike with the largest call GEX (positive), and with the most negative put GEX. */
  peakCall: number | null
  peakPut: number | null
  netTotal: number
}

export function buildProfile(strikes: StrikeGex[], spot: number, rangePct: number, numStrikes: number): ProfileModel {
  const rows = visibleStrikes(strikes, spot, rangePct, numStrikes).map((s) => ({
    strike: s.strike,
    callGex: s.callGex,
    putGex: s.putGex,
    net: s.callGex + s.putGex,
  }))
  let maxAbs = 0
  let peakCall: number | null = null
  let peakPut: number | null = null
  let maxCall = 0
  let minPut = 0
  let netTotal = 0
  for (const r of rows) {
    maxAbs = Math.max(maxAbs, Math.abs(r.callGex), Math.abs(r.putGex), Math.abs(r.net))
    netTotal += r.net
    if (r.callGex > maxCall) {
      maxCall = r.callGex
      peakCall = r.strike
    }
    if (r.putGex < minPut) {
      minPut = r.putGex
      peakPut = r.strike
    }
  }
  return { rows, maxAbs: maxAbs || 1, peakCall, peakPut, netTotal }
}

// ---------------------------------------------------------------------------
// Heatmap blocks
// ---------------------------------------------------------------------------
export interface HeatBlock {
  strike: number
  /** Net sign of the strike: calls dominate (positive) or puts dominate (negative). */
  side: 'call' | 'put'
  /** |net GEX| as a fraction of the largest strike in view, 0..1. */
  intensity: number
}

/** One block per strike whose |net GEX| is at least cutoffPct of the largest strike in view. */
export function heatmapBlocks(strikes: StrikeGex[], spot: number, rangePct: number, numStrikes: number, cutoffPct: number): HeatBlock[] {
  const rows = visibleStrikes(strikes, spot, rangePct, numStrikes)
  const nets = rows.map((s) => ({ strike: s.strike, net: s.callGex + s.putGex }))
  const max = nets.reduce((m, r) => Math.max(m, Math.abs(r.net)), 0)
  if (!(max > 0)) return []
  const floor = (cutoffPct / 100) * max
  return nets
    .filter((r) => Math.abs(r.net) >= floor && r.net !== 0)
    .map((r) => ({ strike: r.strike, side: r.net > 0 ? 'call' : 'put', intensity: Math.abs(r.net) / max }))
}

// ---------------------------------------------------------------------------
// Summary: net GEX over time (this session's samples)
// ---------------------------------------------------------------------------
export interface SummarySample {
  time: number
  net: number
}

export type Regime = 'positive' | 'negative' | 'flat'

export function netGexOf(strikes: StrikeGex[]): number {
  return strikes.reduce((s, k) => s + k.callGex + k.putGex, 0)
}

export function regimeOf(net: number): Regime {
  if (!Number.isFinite(net) || net === 0) return 'flat'
  return net > 0 ? 'positive' : 'negative'
}

/** Appends a sample unless one already exists at that time; keeps the newest `cap` samples. */
export function pushSummarySample(list: SummarySample[], sample: SummarySample, cap = 2000): SummarySample[] {
  if (!Number.isFinite(sample.net)) return list
  const last = list[list.length - 1]
  if (last && last.time >= sample.time) return list
  const next = [...list, sample]
  return next.length > cap ? next.slice(next.length - cap) : next
}
