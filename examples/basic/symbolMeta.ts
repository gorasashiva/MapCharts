// Display metadata for a symbol: a coloured coin-style logo, a friendly name,
// and the asset class the watchlist groups it under. Delta India symbols look
// like BTCUSD (USD perpetual), BTC_INR (INR spot) or C-BTC-…/P-BTC-… (options).

export type AssetGroup = 'Crypto' | 'Commodities' | 'INR spot' | 'Options'

interface BaseMeta {
  name: string
  color: string
  glyph: string
  group?: AssetGroup
}

const BASES: Record<string, BaseMeta> = {
  BTC: { name: 'Bitcoin', color: '#f7931a', glyph: '₿' },
  ETH: { name: 'Ethereum', color: '#627eea', glyph: 'Ξ' },
  SOL: { name: 'Solana', color: '#9945ff', glyph: 'S' },
  XRP: { name: 'XRP', color: '#23292f', glyph: 'X' },
  BNB: { name: 'BNB', color: '#f3ba2f', glyph: 'B' },
  DOGE: { name: 'Dogecoin', color: '#c2a633', glyph: 'Ð' },
  ADA: { name: 'Cardano', color: '#0033ad', glyph: 'A' },
  AVAX: { name: 'Avalanche', color: '#e84142', glyph: 'A' },
  LTC: { name: 'Litecoin', color: '#345d9d', glyph: 'Ł' },
  LINK: { name: 'Chainlink', color: '#2a5ada', glyph: 'L' },
  XAUT: { name: 'Tether Gold', color: '#d4af37', glyph: 'Au', group: 'Commodities' },
  PAXG: { name: 'PAX Gold', color: '#e4c560', glyph: 'Au', group: 'Commodities' },
}

const FALLBACK_COLORS = ['#2962ff', '#089981', '#f23645', '#ff9800', '#9c27b0', '#00bcd4', '#795548']

export interface SymbolMeta {
  symbol: string
  base: string
  name: string
  color: string
  glyph: string
  group: AssetGroup
}

export function symbolMeta(symbol: string): SymbolMeta {
  // Symbols can be user-typed; keep only characters a real ticker uses (the logo is HTML).
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9_.:-]/g, '')
  if (/^[CP]-/.test(sym)) {
    const base = sym.split('-')[1] ?? sym
    return { symbol: sym, base, name: `${BASES[base]?.name ?? base} option`, color: BASES[base]?.color ?? '#787b86', glyph: sym[0], group: 'Options' }
  }
  const inr = sym.endsWith('_INR')
  const base = inr ? sym.slice(0, -4) : sym.replace(/(USDT|USD)$/, '')
  const known = BASES[base]
  let hash = 0
  for (const ch of base) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return {
    symbol: sym,
    base,
    name: known ? (inr ? `${known.name} / INR` : known.name) : base,
    color: known?.color ?? FALLBACK_COLORS[hash % FALLBACK_COLORS.length],
    glyph: known?.glyph ?? base.slice(0, 1),
    group: inr ? 'INR spot' : (known?.group ?? 'Crypto'),
  }
}

/** Round coin-style logo markup (sized by the caller's CSS via `.sym-logo`). */
export function symbolLogo(symbol: string, extraClass = ''): string {
  const m = symbolMeta(symbol)
  const small = m.glyph.length > 1 ? ' sym-logo-sm' : ''
  return `<span class="sym-logo${small}${extraClass ? ' ' + extraClass : ''}" style="background:${m.color}" aria-hidden="true">${m.glyph}</span>`
}
