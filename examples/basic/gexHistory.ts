// Browser-local GEX snapshot history. Change metrics are descriptive (not
// trade flow): public OI cannot tell whether dealers or customers initiated
// the position, but a growing/fading level is useful context for the study.

import type { GexResult } from './gex'

interface Snapshot {
  time: number
  callOI: number
  putOI: number
  netGex: number
  atmIV: number | null
}

export interface GexChange {
  hasBaseline: boolean
  ageMins: number | null
  callOiPct: number | null
  putOiPct: number | null
  netGexPct: number | null
  atmIvPoints: number | null
}

const PREFIX = 'candl.gexSnapshots.'
const MIN_GAP_MS = 15 * 60_000
const MAX_SNAPSHOTS = 1_000

function load(symbol: string): Snapshot[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFIX + symbol) || '[]')
    return Array.isArray(raw)
      ? raw.filter((x): x is Snapshot => x && Number.isFinite(x.time) && Number.isFinite(x.callOI) && Number.isFinite(x.putOI) && Number.isFinite(x.netGex)).slice(-MAX_SNAPSHOTS)
      : []
  } catch {
    return []
  }
}
function save(symbol: string, snapshots: Snapshot[]): void {
  try { localStorage.setItem(PREFIX + symbol, JSON.stringify(snapshots)) } catch { /* optional history */ }
}
const pct = (now: number, old: number): number | null => old !== 0 ? ((now - old) / Math.abs(old)) * 100 : null

export function recordGexSnapshot(symbol: string, result: GexResult, now = Date.now()): GexChange {
  let history = load(symbol)
  const prior = history[history.length - 1]
  const change: GexChange = prior
    ? {
        hasBaseline: true,
        ageMins: (now - prior.time) / 60_000,
        callOiPct: pct(result.totals.callOI, prior.callOI),
        putOiPct: pct(result.totals.putOI, prior.putOI),
        netGexPct: pct(result.totals.netGex, prior.netGex),
        atmIvPoints: result.atmIV !== null && prior.atmIV !== null ? (result.atmIV - prior.atmIV) * 100 : null,
      }
    : { hasBaseline: false, ageMins: null, callOiPct: null, putOiPct: null, netGexPct: null, atmIvPoints: null }
  if (!prior || now - prior.time >= MIN_GAP_MS) {
    history = [...history, { time: now, callOI: result.totals.callOI, putOI: result.totals.putOI, netGex: result.totals.netGex, atmIV: result.atmIV }].slice(-MAX_SNAPSHOTS)
    save(symbol, history)
  }
  return change
}
