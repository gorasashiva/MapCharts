// Browser-local GEX per-strike snapshots, so bar replay can show the GEX bars
// that were live at a past time. Delta publishes no historical option chains,
// so this only covers times when this browser had GEX switched on: one
// snapshot every 15 minutes, kept 60 days per symbol, in IndexedDB (a day of
// snapshots is ~0.5 MB — too much for localStorage).

import type { GexResult } from './gex'

export interface GexSnapshot {
  time: number
  result: GexResult
}

const DB_NAME = 'candl-gex'
const STORE = 'snapshots'
const MIN_GAP_MS = 15 * 60_000
const KEEP_MS = 60 * 86_400_000

let dbPromise: Promise<IDBDatabase | null> | null = null
function db(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => {
          const s = req.result.createObjectStore(STORE, { keyPath: ['symbol', 'time'] })
          s.createIndex('symbol', 'symbol')
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
      } catch {
        resolve(null) // private mode / blocked storage: replay just has no GEX
      }
    })
  }
  return dbPromise
}

const lastSaved = new Map<string, number>()
const cache = new Map<string, GexSnapshot[]>()

/** Every snapshot recorded for `symbol`, oldest first. */
export async function loadGexSnapshots(symbol: string): Promise<GexSnapshot[]> {
  const hit = cache.get(symbol)
  if (hit) return hit
  const d = await db()
  if (!d) return []
  const rows = await new Promise<GexSnapshot[]>((resolve) => {
    try {
      const range = IDBKeyRange.bound([symbol, 0], [symbol, Number.MAX_SAFE_INTEGER])
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).getAll(range)
      req.onsuccess = () => resolve((req.result as (GexSnapshot & { symbol: string })[]).map(({ time, result }) => ({ time, result })))
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
  rows.sort((a, b) => a.time - b.time)
  cache.set(symbol, rows)
  if (rows.length) lastSaved.set(symbol, Math.max(lastSaved.get(symbol) ?? 0, rows[rows.length - 1].time))
  return rows
}

/** Save a live result at most once per 15 minutes per symbol; prunes snapshots older than 60 days. */
export async function recordGexSnapshot(symbol: string, result: GexResult, now = Date.now()): Promise<void> {
  if (!lastSaved.has(symbol)) await loadGexSnapshots(symbol)
  if (now - (lastSaved.get(symbol) ?? 0) < MIN_GAP_MS) return
  lastSaved.set(symbol, now)
  const snap: GexSnapshot = { time: now, result }
  cache.get(symbol)?.push(snap)
  const d = await db()
  if (!d) return
  try {
    const store = d.transaction(STORE, 'readwrite').objectStore(STORE)
    store.put({ symbol, ...snap })
    store.delete(IDBKeyRange.bound([symbol, 0], [symbol, now - KEEP_MS]))
  } catch {
    /* optional history */
  }
}

/** The snapshot live at time `t`: the latest one at or before it, if no more than 30 minutes old. */
export function snapshotAt(snaps: GexSnapshot[], t: number): GexSnapshot | null {
  let lo = 0
  let hi = snaps.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (snaps[m].time <= t) lo = m + 1
    else hi = m
  }
  const s = snaps[lo - 1]
  return s && t - s.time <= 2 * MIN_GAP_MS ? s : null
}
