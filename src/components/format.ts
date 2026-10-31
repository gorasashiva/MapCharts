/** Adaptive price formatting for places where per-symbol precision is unknown (watchlist). */
export function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return '—'
  const abs = Math.abs(price)
  if (abs >= 1000) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  if (abs >= 1) return price.toFixed(2)
  if (abs === 0) return '0.00'
  // Sub-1 prices (e.g. DOGE, SHIB): 4 significant digits, no exponent notation.
  const s = price.toPrecision(4)
  return s.includes('e') ? price.toFixed(8) : String(parseFloat(s))
}

/** "+1.23%" / "-0.45%" with a stable sign for the 24h change column. */
export function formatPct(pct: number): string {
  if (!Number.isFinite(pct)) return '—'
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`
}

/**
 * Signed absolute price delta for the watchlist Change column: same adaptive
 * precision as formatPrice, with an explicit leading sign (the minus already
 * comes from formatPrice on a negative value; a "+" is prepended for positives).
 */
export function formatSignedPrice(delta: number): string {
  if (!Number.isFinite(delta)) return '—'
  const body = formatPrice(delta)
  return delta > 0 ? `+${body}` : body
}
