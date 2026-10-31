// Delta-neutral weekly options selector. This deliberately reports a model
// estimate from the CURRENT option chain, not a backtested probability.
import type { ChainQuote } from './options'

export interface NeutralIdea {
  expiry: number
  dte: number
  shortPut: ChainQuote
  longPut: ChainQuote
  shortCall: ChainQuote
  longCall: ChainQuote
  credit: number
  conservativeCredit: number
  suggestedCredit: number
  maxLoss: number
  maxProfitPerContract: number
  earlyTakeProfitPerContract: number
  returnOnRiskPct: number
  breakEvenLow: number
  breakEvenHigh: number
  impliedMovePct: number
  modeledInsidePct: number
  quality: 'candidate' | 'avoid'
  reason: string
}

const DAY = 86_400_000
const mid = (q: ChainQuote): number => q.bid > 0 && q.ask >= q.bid ? (q.bid + q.ask) / 2 : q.markPrice
const quoted = (q: ChainQuote): boolean => {
  const m = mid(q)
  return m > 0 && q.ask >= q.bid && (q.ask - q.bid) / m <= 0.35
}
const normalCdf = (x: number): number => {
  // Abramowitz-Stegun approximation; accurate enough for a UI estimate.
  const z = Math.abs(x)
  const t = 1 / (1 + 0.2316419 * z)
  const d = 0.3989423 * Math.exp(-z * z / 2)
  const p = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return x < 0 ? 1 - p : p
}
const closest = (xs: ChainQuote[], target: number): ChainQuote | null =>
  xs.length ? xs.reduce((a, b) => Math.abs(Math.abs(a.delta) - target) < Math.abs(Math.abs(b.delta) - target) ? a : b) : null

/** Choose the nearest viable weekly expiry (2–10 DTE) and construct a 16-delta iron condor. */
export function selectWeeklyIronCondor(chain: ChainQuote[], spot: number, now = Date.now()): NeutralIdea | null {
  const byExpiry = new Map<number, ChainQuote[]>()
  for (const q of chain) {
    const dte = (q.expiry - now) / DAY
    if (dte >= 2 && dte <= 10 && q.spot > 0) {
      const rows = byExpiry.get(q.expiry) ?? []
      rows.push(q)
      byExpiry.set(q.expiry, rows)
    }
  }
  const expiries = [...byExpiry.keys()].sort((a, b) => a - b)
  for (const expiry of expiries) {
    const rows = byExpiry.get(expiry)!
    const puts = rows.filter((q) => q.side === 'PUT' && q.strike < spot && quoted(q)).sort((a, b) => a.strike - b.strike)
    const calls = rows.filter((q) => q.side === 'CALL' && q.strike > spot && quoted(q)).sort((a, b) => a.strike - b.strike)
    const shortPut = closest(puts, 0.16)
    const shortCall = closest(calls, 0.16)
    if (!shortPut || !shortCall) continue
    const lowerPuts = puts.filter((q) => q.strike < shortPut.strike)
    const longPut = lowerPuts.length ? lowerPuts[lowerPuts.length - 1] : null
    const longCall = calls.find((q) => q.strike > shortCall.strike) ?? null
    if (!longPut || !longCall) continue

    const credit = mid(shortPut) + mid(shortCall) - mid(longPut) - mid(longCall)
    // A fillable credit crosses the book: sell at bid, buy at ask. The
    // suggested limit starts halfway between that conservative credit and mid.
    const conservativeCredit = shortPut.bid + shortCall.bid - longPut.ask - longCall.ask
    const suggestedCredit = Math.max(0, conservativeCredit + (credit - conservativeCredit) * 0.5)
    const width = Math.max(shortPut.strike - longPut.strike, longCall.strike - shortCall.strike)
    if (credit <= 0 || width <= credit) continue
    const dte = Math.ceil((expiry - now) / DAY)
    const iv = [shortPut.markIV, shortCall.markIV].filter((v) => v > 0).reduce((s, v, _, a) => s + v / a.length, 0)
    if (!iv) continue
    const sigma = iv * Math.sqrt(dte / 365)
    const low = shortPut.strike - suggestedCredit
    const high = shortCall.strike + suggestedCredit
    const inside = (normalCdf(Math.log(high / spot) / sigma) - normalCdf(Math.log(low / spot) / sigma)) * 100
    const favorableGamma = rows.reduce((s, q) => s + q.gamma * q.openInterest * (q.side === 'CALL' ? 1 : -1), 0) >= 0
    const quality = inside >= 60 && favorableGamma ? 'candidate' : 'avoid'
    return {
      expiry, dte, shortPut, longPut, shortCall, longCall, credit, conservativeCredit, suggestedCredit,
      maxLoss: width - suggestedCredit,
      maxProfitPerContract: suggestedCredit * shortPut.contractValue,
      // A common risk-management target for short premium is to buy it back
      // after retaining half the entry credit rather than holding to expiry.
      earlyTakeProfitPerContract: suggestedCredit * shortPut.contractValue * 0.5,
      returnOnRiskPct: ((suggestedCredit * shortPut.contractValue) / ((width - suggestedCredit) * shortPut.contractValue)) * 100,
      breakEvenLow: low, breakEvenHigh: high, impliedMovePct: sigma * 100,
      modeledInsidePct: Math.max(0, Math.min(100, inside)), quality,
      reason: favorableGamma
        ? 'Positive/neutral chain gamma and liquid 16-delta wings support a defined-risk range candidate.'
        : 'Net chain gamma is negative; movement can expand, so this is shown as avoid despite its estimated range probability.',
    }
  }
  return null
}
