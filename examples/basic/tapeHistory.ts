// Recorded trade history for Big Trades / Deep Trades, from the tape recorder
// (recorder/tapeRecorder.mjs). Delta's public API keeps only the last 50
// trades, so the recorder is the only source of real big-trade history.
//
// Same-origin `/tape/...`: Vite proxies it to the recorder in dev, nginx in
// Docker. Any failure — no recorder running, static hosting without one —
// resolves to null and the overlays simply show live trades only.
import type { ClusterMode, TradeCluster } from '../../src/overlays/takerOrders'

export interface TapeHistory {
  symbol: string
  from: number
  to: number
  /** First recorded moment inside [from, to]; null = nothing recorded there. */
  recordedFrom: number | null
  /** Days of tape actually covered (recording gaps excluded). */
  days: number
  /** Size threshold applied — the per-day auto filter result when `perDay` was asked for. */
  threshold: number
  clusters: TradeCluster[]
}

export interface TapeQuery {
  from: number
  to: number
  mode: ClusterMode
  /** Auto filter: target clusters per day. */
  perDay?: number
  /** Manual filter: minimum cluster size (base-asset qty). */
  min?: number
}

const TIMEOUT_MS = 10_000

export async function fetchTapeHistory(symbol: string, q: TapeQuery): Promise<TapeHistory | null> {
  const params = new URLSearchParams({ symbol, from: String(Math.floor(q.from)), to: String(Math.floor(q.to)), mode: q.mode })
  if (q.perDay) params.set('perDay', String(q.perDay))
  else params.set('min', String(q.min ?? 0))
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`/tape/clusters?${params}`, { signal: ctl.signal })
    if (!res.ok) return null
    const body = (await res.json()) as TapeHistory
    return Array.isArray(body?.clusters) ? body : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
