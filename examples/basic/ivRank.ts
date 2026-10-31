// IV Rank/Percentile — tracks each underlying's ATM implied volatility over
// time and reports where the CURRENT reading sits against its own recent
// history. The reading itself (GexResult.atmIV) rides along on gex.ts's
// existing options-chain fetch — no extra network call.
//
// IMPORTANT CAVEAT: Delta's public options API has no historical-IV
// endpoint, so there's no way to seed this with real past data. It only
// knows what THIS APP has itself observed since first use, persisted in
// localStorage. Early readings (few samples / few days) are provisional —
// see `sufficient` below — not a true rank against a real historical range.
export interface IVRankResult {
  currentIV: number
  percentile: number // % of stored samples with IV below the current reading
  sampleCount: number
  daysCovered: number
  sufficient: boolean // enough history (>=20 samples spanning >=2 days) to trust the percentile
}

interface Sample {
  time: number
  iv: number
}

const LS_PREFIX = 'candl.ivhistory.'
const MAX_SAMPLES = 2000
const MIN_SAMPLE_GAP_MS = 30 * 60 * 1000 // at most one stored sample per 30 min, so history spans longer without bloating storage

function loadHistory(key: string): Sample[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_PREFIX + key) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function saveHistory(key: string, samples: Sample[]): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(samples))
  } catch {
    /* storage unavailable/full — ranking still works for this session, just isn't persisted */
  }
}

/** Record a new IV reading (throttled to one stored sample per 30 min) and
 *  return where it ranks against the history collected so far. */
export function recordAndRank(underlying: string, iv: number): IVRankResult {
  let hist = loadHistory(underlying)
  const now = Date.now()
  const last = hist[hist.length - 1]
  if (!last || now - last.time >= MIN_SAMPLE_GAP_MS) {
    hist = [...hist, { time: now, iv }]
    if (hist.length > MAX_SAMPLES) hist = hist.slice(-MAX_SAMPLES)
    saveHistory(underlying, hist)
  }
  const below = hist.filter((s) => s.iv < iv).length
  const percentile = hist.length > 0 ? Math.round((below / hist.length) * 100) : 50
  const daysCovered = hist.length ? (now - hist[0].time) / 86_400_000 : 0
  return { currentIV: iv, percentile, sampleCount: hist.length, daysCovered, sufficient: hist.length >= 20 && daysCovered >= 2 }
}
