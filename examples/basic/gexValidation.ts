// Prospective, browser-local validation for GEX suggestions.
//
// This intentionally does not manufacture a backtest from today's option
// snapshot. A suggestion is recorded first and scored only after its horizon
// has elapsed using a later observed spot. Until enough independent outcomes
// exist, the UI must call it a setup — never an accurate prediction.

export type SignalDirection = 'up' | 'down'

interface PendingSignal {
  id: string
  symbol: string
  direction: SignalDirection
  entry: number
  score: number
  createdAt: number
  dueAt: number
}

interface MatureSignal extends PendingSignal {
  exit: number
  hit: boolean
}

interface Store {
  pending: PendingSignal[]
  mature: MatureSignal[]
}

export interface ValidationSummary {
  matured: number
  hits: number
  hitRate: number | null
  meanMovePct: number | null
  validated: boolean
}

const KEY = 'candl.gexValidation.v1'
const HORIZON_MS = 60 * 60 * 1000
const MIN_RECORD_GAP_MS = 15 * 60 * 1000
const MIN_MATURED = 100
const MAX_MATURE = 2_000

function load(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Store>
    return {
      pending: Array.isArray(raw.pending) ? raw.pending.filter(validPending) : [],
      mature: Array.isArray(raw.mature) ? raw.mature.filter(validMature).slice(-MAX_MATURE) : [],
    }
  } catch {
    return { pending: [], mature: [] }
  }
}

function validPending(v: unknown): v is PendingSignal {
  const x = v as Partial<PendingSignal>
  return !!x && typeof x.id === 'string' && typeof x.symbol === 'string' && (x.direction === 'up' || x.direction === 'down') &&
    Number.isFinite(x.entry) && Number.isFinite(x.createdAt) && Number.isFinite(x.dueAt)
}
function validMature(v: unknown): v is MatureSignal {
  const x = v as Partial<MatureSignal>
  return validPending(v) && Number.isFinite(x.exit) && typeof x.hit === 'boolean'
}
function save(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // Validation is optional telemetry; the live study still works without it.
  }
}

/** Score pending signals with the newest observed spot, then optionally add a
 * new signal. Sampling is throttled so repeated 90-second chain polls cannot
 * inflate the apparent sample size. */
export function observeGexSignal(
  symbol: string,
  spot: number,
  direction: SignalDirection | null,
  score: number,
  now = Date.now(),
): ValidationSummary {
  const store = load()
  const stillPending: PendingSignal[] = []
  for (const signal of store.pending) {
    if (signal.symbol === symbol && now >= signal.dueAt && spot > 0) {
      const move = (spot - signal.entry) / signal.entry
      const hit = signal.direction === 'up' ? move > 0 : move < 0
      store.mature.push({ ...signal, exit: spot, hit })
    } else if (now - signal.createdAt <= 7 * 86_400_000) {
      stillPending.push(signal) // discard stale signals when the app was closed for days
    }
  }
  store.pending = stillPending

  if (direction && spot > 0) {
    const keyMatch = (s: PendingSignal | MatureSignal): boolean => s.symbol === symbol && s.direction === direction
    const last = [...store.pending, ...store.mature].filter(keyMatch).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!last || now - last.createdAt >= MIN_RECORD_GAP_MS) {
      store.pending.push({
        id: `${symbol}:${direction}:${now}`,
        symbol,
        direction,
        entry: spot,
        score,
        createdAt: now,
        dueAt: now + HORIZON_MS,
      })
    }
  }
  store.mature = store.mature.slice(-MAX_MATURE)
  save(store)

  const same = store.mature.filter((s) => s.symbol === symbol)
  const hits = same.filter((s) => s.hit).length
  const meanMovePct = same.length
    ? same.reduce((sum, s) => sum + ((s.exit - s.entry) / s.entry) * 100 * (s.direction === 'up' ? 1 : -1), 0) / same.length
    : null
  const hitRate = same.length ? (hits / same.length) * 100 : null
  return { matured: same.length, hits, hitRate, meanMovePct, validated: same.length >= MIN_MATURED }
}
