// "GEX Sabers" — a pure GEX study drawn as glowing light-saber bars on the right of the chart:
// red = resistance (largest call GEX above price), green = support (largest put GEX below),
// purple = liquidity (largest total gamma), white = zero gamma; bright green / yellow = the most
// positive / most negative net gamma strike, orange = the highest-volume strike (HVL). Blade length and the number =
// strength (0–100); the $ figure is dealer hedging per 1% move; the date is the expiry that
// dominates that strike. Math: src/overlays/gexSabersModel.ts.
//
// Data: Delta India's option chain (BTC, ETH, gold via XAUT) — the GEX tool's source and
// formula (gex.ts), for the expiries chosen in the settings, sized by open interest or by
// the last 24h traded volume. Refreshed each minute.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import {
  SABER_DEFAULTS,
  buildSabers,
  fmtGex,
  selectExpiries,
  spreadLabels,
  strikeGex,
  type ExpirySelection,
  type Saber,
  type SaberKind,
  type SizeBy,
} from '../../src/overlays/gexSabersModel'
import { fetchOptionChain, type ChainQuote, type OptionUnderlying } from './options'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const REFRESH_MS = 60_000

// ---- Delta option chain (one fetch per underlying per minute, shared by all panes) ----
const live = new Map<OptionUnderlying, { rows: ChainQuote[]; fetchedAt: number; triedAt: number; inflight: boolean; error: string | null }>()
function liveChain(u: OptionUnderlying) {
  let e = live.get(u)
  if (!e) {
    e = { rows: [], fetchedAt: 0, triedAt: 0, inflight: false, error: null }
    live.set(u, e)
  }
  if (!e.inflight && Date.now() - e.triedAt > REFRESH_MS) {
    const entry = e
    entry.inflight = true
    fetchOptionChain(u)
      .then((rows) => {
        entry.rows = rows
        entry.fetchedAt = Date.now()
        entry.error = null
      })
      .catch((err: unknown) => {
        entry.error = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        entry.triedAt = Date.now()
        entry.inflight = false
      })
  }
  return e
}

/** Chart symbol -> Delta options underlying (gold charts use the XAUT chain). */
function underlyingFor(symbol: string): OptionUnderlying | null {
  const s = symbol.toUpperCase().replace(/^.*:/, '')
  if (s.startsWith('BTC')) return 'BTCUSD'
  if (s.startsWith('ETH')) return 'ETHUSD'
  if (/XAU|PAXG|GOLD/.test(s)) return 'XAUTUSD'
  return null
}

const EXPIRIES: { value: ExpirySelection; label: string }[] = [
  { value: 'nearest6', label: 'Nearest 6 expiries (as the GEX tool)' },
  { value: 'nearest', label: 'Nearest expiry only (0DTE / 1DTE)' },
  { value: 'nearest2', label: 'Nearest 2 expiries' },
  { value: 'nearest3', label: 'Nearest 3 expiries' },
  { value: 'week', label: 'Expiring within 7 days' },
  { value: 'month', label: 'Expiring within 30 days' },
]
const SIZE_BY: { value: SizeBy; label: string }[] = [
  { value: 'oi', label: 'Open interest (standing walls)' },
  { value: 'volume', label: 'Last 24h volume (where flow is building)' },
]

const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min: number, max: number, step: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })

export const gexSabers: IndicatorDef = {
  id: 'gex_sabers',
  label: 'GEX Sabers — support / resistance / liquidity by option expiry',
  shortLabel: 'GEX Sabers',
  placement: 'overlay',
  params: [
    { key: 'expiries', label: 'Option expiries', default: 0, group: 'GEX', options: EXPIRIES.map((e, i) => ({ value: i, label: e.label })) },
    { key: 'sizeBy', label: 'GEX sized by', default: 0, group: 'GEX', options: SIZE_BY.map((e, i) => ({ value: i, label: e.label })) },
    num('perSide', 'Support / resistance sabers per side', SABER_DEFAULTS.perSide, 'Levels', 1, 6, 1),
    num('liquidity', 'Liquidity sabers', SABER_DEFAULTS.liquidity, 'Levels', 0, 4, 1),
    toggle('peaks', 'Most positive γ (bright green) / most negative γ (yellow)', SABER_DEFAULTS.peaks, 'Levels'),
    toggle('hvl', 'Highest volume level (HVL) in orange', SABER_DEFAULTS.hvl, 'Levels'),
    toggle('zeroGamma', 'Zero gamma (net GEX crossover)', SABER_DEFAULTS.zeroGamma, 'Levels'),
    num('range', 'Strikes considered (± % of price)', SABER_DEFAULTS.range * 100, 'Levels', 2, 30, 1),
    num('bladeMax', 'Longest blade (px)', 200, 'Display', 80, 400, 10),
    toggle('extend', 'Faint level line across the chart', true, 'Display'),
  ],
  compute: () => [],
}

export interface GexSabersModel {
  sabers: Saber[]
  /** Net GEX (calls + puts) across the chosen expiries — the regime when there is no zero gamma. */
  netGex: number
  stamp: string
  waiting: string
  bladeMax: number
  extend: boolean
}

export function computeGexSabersModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): GexSabersModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const base: GexSabersModel = { sabers: [], netGex: Number.NaN, stamp: '', waiting: '', bladeMax: Math.max(80, n('bladeMax', 200)), extend: b('extend', true) }
  const u = underlyingFor(ctx.symbol)
  if (!u) return { ...base, waiting: `GEX Sabers: no Delta options for ${ctx.symbol} (BTC, ETH, gold)` }
  const e = liveChain(u)
  const asset = u.replace(/USD$/, '')
  if (!e.fetchedAt) return { ...base, waiting: e.error ? `⚠ Delta options unavailable: ${e.error}` : `⏳ Loading Delta ${asset} options...` }

  const last = candles[candles.length - 1]
  const spot = last ? last.close : 0
  const sel = EXPIRIES[Math.round(n('expiries', 0))] ?? EXPIRIES[0]
  const size = SIZE_BY[Math.round(n('sizeBy', 0))] ?? SIZE_BY[0]
  const now = Date.now()
  const expiries = selectExpiries(e.rows, now, sel.value)
  const strikes = strikeGex(e.rows, spot, expiries, size.value)
  if (!strikes.length || !(spot > 0)) return { ...base, waiting: `⚠ No ${asset} option ${size.value === 'oi' ? 'open interest' : 'volume today'} for the chosen expiries` }

  const opts = {
    perSide: Math.max(1, Math.round(n('perSide', SABER_DEFAULTS.perSide))),
    liquidity: Math.max(0, Math.round(n('liquidity', SABER_DEFAULTS.liquidity))),
    range: n('range', SABER_DEFAULTS.range * 100) / 100,
    zeroGamma: b('zeroGamma', SABER_DEFAULTS.zeroGamma),
    hvl: b('hvl', SABER_DEFAULTS.hvl),
    peaks: b('peaks', SABER_DEFAULTS.peaks),
  }
  const ist = new Date(e.fetchedAt + 5.5 * 3_600_000).toISOString().slice(11, 16)
  const span = expiries.length === 1 ? `expiry ${istDay(expiries[0])}` : `${expiries.length} expiries ${istDay(expiries[0])}–${istDay(expiries[expiries.length - 1])}`
  return {
    ...base,
    sabers: buildSabers(strikes, spot, opts),
    netGex: strikes.reduce((s, k) => s + k.callGex + k.putGex, 0),
    stamp: `${e.error ? '⚠ STALE · ' : ''}Delta ${asset} options · ${span} · by ${size.value === 'oi' ? 'OI' : 'volume'} · ${ist} IST`,
  }
}

const istDay = (t: number): string => new Date(t + 5.5 * 3_600_000).toUTCString().slice(5, 11).replace(/^0/, '')

// ---------------------------------------------------------------------------
// Drawing — glowing lines: coloured glow and a white-hot core, ending at the right edge
// ---------------------------------------------------------------------------
const COLOR: Record<SaberKind, string> = {
  resistance: '#ff2d3d',
  support: '#25f06b',
  liquidity: '#c45cff',
  hvl: '#FF9100',
  peakPos: '#39ff14',
  peakNeg: '#FFD600',
  zero: '#dff4ff',
}
const LABEL_GAP = 15
const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const FONT_SMALL = "500 9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

/** Contracts traded, compact: 1.2K / 3.4M (base units: BTC, ETH, XAUT). */
const fmtVol = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v >= 10 ? v.toFixed(0) : v.toFixed(2))

const fmtPrice = (v: number): string => (v >= 1000 ? v.toFixed(1) : v >= 10 ? v.toFixed(2) : v.toPrecision(5))

function blade(g: CanvasRenderingContext2D, x1: number, x2: number, y: number, color: string, s: number): void {
  g.save()
  g.lineCap = 'round'
  // outer glow
  g.shadowColor = color
  g.shadowBlur = 8 + 14 * s
  g.strokeStyle = color
  g.globalAlpha = 0.55 + 0.4 * s
  g.lineWidth = 3 + 4 * s
  g.beginPath()
  g.moveTo(x1, y)
  g.lineTo(x2, y)
  g.stroke()
  // white-hot core
  g.shadowBlur = 4
  g.globalAlpha = 1
  g.strokeStyle = 'rgba(255, 255, 255, 0.95)'
  g.lineWidth = 1.2 + 0.8 * s
  g.beginPath()
  g.moveTo(x1 + 1, y)
  g.lineTo(x2, y)
  g.stroke()
  g.restore()
}

function pill(g: CanvasRenderingContext2D, xRight: number, y: number, text: string, color: string): void {
  const w = g.measureText(text).width + 10
  g.fillStyle = 'rgba(8, 10, 16, 0.82)'
  g.fillRect(xRight - w, y - 7, w, 14)
  g.fillStyle = color
  g.fillText(text, xRight - 5, y + 0.5)
}

export function drawGexSabers(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: GexSabersModel, ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  g.textBaseline = 'middle'
  g.textAlign = 'right'

  if (m.waiting) {
    g.font = FONT
    pill(g, rect.x + rect.width - 8, rect.y + rect.height - 40, m.waiting, '#9aa3b2')
    g.restore()
    return
  }

  // Keep the blades in empty space right of the last bar.
  ctx.ensureRightGutter?.(Math.ceil(Math.max(m.bladeMax, 190) + 16))
  const xR = rect.x + rect.width - 6
  const xEnd = xR - 4 // blades end here (round cap)
  // Regime, key and source sit at the top of the saber column; labels go below them.
  const top = rect.y + 62
  const bottom = rect.y + rect.height - 10
  const close = candles[candles.length - 1].close

  // Faint full-width level lines first, under everything.
  if (m.extend) {
    g.save()
    g.setLineDash([2, 4])
    g.lineWidth = 1
    for (const s of m.sabers) {
      const y = Math.round(conv.priceToY(s.price)) + 0.5
      if (y < rect.y || y > rect.y + rect.height) continue
      g.strokeStyle = COLOR[s.kind]
      g.globalAlpha = s.kind === 'zero' ? 0.35 : 0.12 + 0.25 * (Number.isFinite(s.strength) ? s.strength / 100 : 0.4)
      g.beginPath()
      g.moveTo(rect.x, y)
      g.lineTo(xEnd - m.bladeMax - 4, y)
      g.stroke()
    }
    g.restore()
  }

  // Glowing blades for the sabers on screen.
  for (const s of m.sabers) {
    const y = conv.priceToY(s.price)
    if (y < rect.y || y > rect.y + rect.height) continue
    const st = Number.isFinite(s.strength) ? s.strength / 100 : 0.4
    const len = s.kind === 'zero' ? m.bladeMax * 0.45 : 26 + (m.bladeMax - 26) * st
    blade(g, xEnd - len, xEnd, y, COLOR[s.kind], st)
  }

  // Labels above each blade, spread apart; off-screen sabers pin to the top / bottom edge.
  g.font = FONT
  const items = m.sabers.map((s) => ({ s, y: conv.priceToY(s.price) })).sort((a, b) => a.y - b.y)
  const ys = spreadLabels(items.map((i) => i.y - 9), LABEL_GAP, top, bottom)
  items.forEach(({ s, y }, i) => {
    const off = y < rect.y ? '▲ ' : y > rect.y + rect.height ? '▼ ' : ''
    const strength = Number.isFinite(s.strength) ? `  str ${Math.round(s.strength)}` : ''
    const usd = Number.isFinite(s.gex) ? `  ${fmtGex(s.gex)}` : ''
    const exp = Number.isFinite(s.expiry) ? `  ${istDay(s.expiry)}` : ''
    const vol = s.names.includes('HVL') && s.volume > 0 ? `  vol ${fmtVol(s.volume)}` : ''
    pill(g, xEnd - 2, ys[i], `${off}${s.names.join(' · ')}  ${fmtPrice(s.price)}${strength}${usd}${vol}${exp}`, COLOR[s.kind])
  })

  // Regime (price vs zero gamma; else the sign of net GEX), key and source above the sabers.
  const zero = m.sabers.find((s) => s.kind === 'zero')
  const pos = zero ? close >= zero.price : m.netGex >= 0
  g.font = FONT
  pill(g, xR, rect.y + 12, `GEX ${pos ? 'POSITIVE ▲ pinned / mean-revert' : 'NEGATIVE ▼ trending / volatile'}`, pos ? COLOR.support : '#ffb74d')
  g.font = FONT_SMALL
  pill(g, xR, rect.y + 27, 'str = strength 0–100 · $ = dealer GEX per 1% move · date = main expiry · green = max +γ · yellow = max −γ · orange = HVL', '#8b93a1')
  pill(g, xR, rect.y + 41, m.stamp, '#8b93a1')
  g.restore()
}
