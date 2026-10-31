/**
 * IV Expected-Move Zones — pure model behind ivZones.ts, a port of
 * "IV walls modified V2.pine".
 *
 * Auto mode: each session gets zones at prevClose ± m·EM for three multiples,
 *   EM = prevClose · IV · ivScale / √(days per year) · √(daysAhead)
 * with each zone `zoneFrac`·EM thick. The Pine script reads IV from a CBOE
 * index (VIX / VXN / GVZ); here it comes from, in order:
 *   1. a typed IV % (e.g. today's GVZ) when set,
 *   2. the live ATM IV of the symbol's nearest Delta options expiry (today's
 *      session only — Delta publishes no historical IV),
 *   3. realized close-to-close volatility of the `hvLookback` sessions before
 *      that session, annualised (HV — also what past sessions use). Sessions
 *      without a full lookback behind them get no zones.
 * Days per year: 252 for markets shut at weekends (gold), else 365, matching
 * how each market's IV is quoted.
 *
 * Manual mode: the typed wall levels × `manRatio`, each ±`manHalf` thick,
 * coloured as resistance above the session open and support below it.
 *
 * Sessions follow the symbol's trading-day open (gold 03:30 IST); with closed
 * weekends, Saturday/Sunday sessions are dropped so Monday uses Friday's close.
 */
import { SESSION_DAY_MS } from '../core/session'
import { buildSessions, closeToCloseSigma, type OHLCBar, type SessionDay } from './ivWallsModel'

const HOUR_MS = 3_600_000

export type IvZonesMode = 'auto' | 'manual'
export type IvSource = 'override' | 'implied' | 'hv'

export interface IvZonesOptions {
  enabled: boolean
  mode: IvZonesMode
  /** Keep zones for past sessions (Pine "Keep previous sessions' zones"). */
  showHistory: boolean
  /** How many past sessions to draw when `showHistory` is on. */
  historyDays: number
  resColor: string
  supColor: string
  /** Text inside each zone (+0.5x / price). Off by default — lines and fills only. */
  showLabels: boolean
  // ---- auto ----
  /** Annualised IV in %, e.g. today's GVZ. Null = use the options chain / HV. */
  ivOverridePct: number | null
  ivScale: number
  daysAhead: number
  m1: number
  m2: number
  m3: number
  zoneFrac: number
  /** Sessions of closes behind the HV fallback. */
  hvLookback: number
  // ---- manual ----
  manRatio: number
  manHalf: number
  /** Up to six wall levels; 0 = off. */
  walls: number[]
}

export const IV_ZONES_DEFAULTS: IvZonesOptions = {
  enabled: false,
  mode: 'auto',
  showHistory: false,
  historyDays: 5,
  resColor: '#f23645',
  supColor: '#089981',
  showLabels: false,
  ivOverridePct: null,
  ivScale: 1,
  daysAhead: 1,
  m1: 0.5,
  m2: 1,
  m3: 1.5,
  zoneFrac: 0.1,
  hvLookback: 20,
  manRatio: 1,
  manHalf: 2,
  walls: [0, 0, 0, 0, 0, 0],
}

export interface IvZone {
  kind: 'res' | 'sup'
  top: number
  bottom: number
  mid: number
  /** "+0.5x" in auto mode, the level's price in manual mode. */
  tag: string
}

export interface IvZoneSession {
  start: number
  end: number
  /** Previous session's close (auto) — the zones' anchor. */
  prevClose: number | null
  /** Annualised IV (decimal) behind the zones, and where it came from. */
  iv: number | null
  ivSource: IvSource | null
  /** Expected move in price for `daysAhead` days. */
  em: number | null
  zones: IvZone[]
}

/** Weekday (0 = Sunday) a session mostly covers. */
function sessionWeekday(start: number): number {
  return new Date(start + 2 * HOUR_MS).getUTCDay()
}

export function daysPerYear(closedWeekends: boolean): number {
  return closedWeekends ? 252 : 365
}

/** EM = prevClose · IV · scale / √(days per year) · √(daysAhead). */
export function expectedMove(prevClose: number, ivAnnual: number, scale: number, daysAhead: number, perYear: number): number {
  return (prevClose * ivAnnual * scale * Math.sqrt(daysAhead)) / Math.sqrt(perYear)
}

function fmtMult(m: number): string {
  return `${Number(m.toFixed(2))}x`
}

/**
 * Zones for the latest session and, with `showHistory`, the `historyDays`
 * before it. `liveIV` is today's ATM IV from the options chain (decimal), or
 * null when the symbol has no chain.
 */
export function computeIvZones(
  hourly: OHLCBar[],
  opts: IvZonesOptions,
  openHourUTC: number,
  closedWeekends: boolean,
  liveIV: number | null,
): IvZoneSession[] {
  let sessions: SessionDay[] = buildSessions(hourly, openHourUTC)
  if (closedWeekends) {
    sessions = sessions.filter((s) => {
      const wd = sessionWeekday(s.start)
      return wd !== 0 && wd !== 6
    })
  }
  if (sessions.length === 0) return []
  const perYear = daysPerYear(closedWeekends)
  const first = opts.showHistory ? Math.max(0, sessions.length - 1 - opts.historyDays) : sessions.length - 1
  const out: IvZoneSession[] = []
  for (let i = first; i < sessions.length; i++) {
    const s = sessions[i]
    const isToday = i === sessions.length - 1
    const base: IvZoneSession = { start: s.start, end: s.start + SESSION_DAY_MS, prevClose: null, iv: null, ivSource: null, em: null, zones: [] }
    if (opts.mode === 'manual') {
      for (const lv of opts.walls) {
        if (!(lv > 0)) continue
        const mid = lv * opts.manRatio
        base.zones.push({ kind: mid > s.open ? 'res' : 'sup', top: mid + opts.manHalf, bottom: mid - opts.manHalf, mid, tag: String(mid) })
      }
      out.push(base)
      continue
    }
    const prev = sessions[i - 1]
    if (!prev) {
      out.push(base)
      continue
    }
    base.prevClose = prev.close
    if (opts.ivOverridePct !== null && opts.ivOverridePct > 0) {
      base.iv = opts.ivOverridePct / 100
      base.ivSource = 'override'
    } else if (isToday && liveIV !== null && liveIV > 0) {
      base.iv = liveIV
      base.ivSource = 'implied'
    } else {
      // A full lookback only — a σ from a handful of sessions is too noisy to size zones with.
      const hvDaily = i > opts.hvLookback ? closeToCloseSigma(sessions.slice(i - opts.hvLookback - 1, i)) : null
      if (hvDaily !== null) {
        base.iv = hvDaily * Math.sqrt(perYear)
        base.ivSource = 'hv'
      }
    }
    if (base.iv !== null) {
      const em = expectedMove(prev.close, base.iv, opts.ivScale, opts.daysAhead, perYear)
      base.em = em
      const half = (em * opts.zoneFrac) / 2
      for (const m of [opts.m1, opts.m2, opts.m3]) {
        const up = prev.close + em * m
        const dn = prev.close - em * m
        base.zones.push({ kind: 'res', top: up + half, bottom: up - half, mid: up, tag: `+${fmtMult(m)}` })
        base.zones.push({ kind: 'sup', top: dn + half, bottom: dn - half, mid: dn, tag: `-${fmtMult(m)}` })
      }
    }
    out.push(base)
  }
  return out
}
