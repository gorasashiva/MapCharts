// Options chain for Delta Exchange India (public API — no API key, CORS-open).
//
// A self-contained "Options" view: an expiry selector + a two-sided chain
// (calls │ strike │ puts) showing mark price, implied vol, delta and 24h volume,
// plus a candlestick chart of whichever option strike you click. Spot index is
// shown for ATM reference.
//
// WHY THIS MODULE IS SO MUCH SMALLER THAN A BINANCE EQUIVALENT: on Delta,
// options are ordinary products. One /v2/tickers call returns the ENTIRE chain
// with exchange-published greeks, IV and open interest on every row (no
// separate mark/ticker/openInterest calls, and no Black-Scholes reconstruction
// — the exchange publishes gamma itself). Option symbols also stream over the
// same WebSocket and serve the same /v2/history/candles endpoint as any
// perpetual, so DeltaDataProvider drives option charts, trade tape, order book
// and every overlay with no special-casing at all — which is why this file has
// no polling fallbacks.
import {
  createChartEngine,
  type IChartEngine,
  type Candle,
  type SymbolInfo,
  type Theme,
} from '../../src/index'
import { el } from './ui'

const REST = 'https://api.india.delta.exchange'

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${REST}${path}`)
  if (!res.ok) throw new Error(`Delta ${path} → HTTP ${res.status}`)
  const body = (await res.json()) as { success?: boolean; result?: T; error?: unknown }
  if (body.success === false) throw new Error(`Delta ${path} → ${JSON.stringify(body.error)}`)
  return body.result as T
}

/** 429 = rate-limited (Delta's public market-data limits are generous, but respect them). */
const isRateLimited = (err: unknown): boolean => /HTTP 429/.test(String(err))

// ---- underlyings ----

/** Underlyings Delta India lists options on (BTC, ETH and Tether Gold). */
export const SUPPORTED_OPTION_UNDERLYINGS = ['BTCUSD', 'ETHUSD', 'XAUTUSD'] as const
export type OptionUnderlying = (typeof SUPPORTED_OPTION_UNDERLYINGS)[number]

/** Display label for the underlying picker. */
export const UNDERLYING_LABEL: Record<OptionUnderlying, string> = {
  BTCUSD: 'BTC',
  ETHUSD: 'ETH',
  XAUTUSD: 'Gold',
}

// ---- symbol parsing (C-BTC-88000-280826 / P-ETH-2500-280826) ----

export interface ParsedOption {
  underlying: string // the underlying's perpetual, e.g. "BTCUSD"
  base: string // e.g. "BTC"
  expiry: number // epoch ms — see the nominal-hour note below
  strike: number
  side: 'CALL' | 'PUT'
}

// Delta option symbols are <C|P>-<ASSET>-<STRIKE>-<DDMMYY>.
const OPTION_RE = /^([CP])-([A-Z0-9]+)-(\d+(?:\.\d+)?)-(\d{6})$/

export const isOptionSymbol = (s: string): boolean => OPTION_RE.test(s)

/** Settlement hour (UTC) per underlying, as Delta's /v2/products reports it:
 *  BTC / ETH settle 12:00 UTC, Tether Gold 16:00 UTC. Fallback only —
 *  fetchOptionChain uses each product's own settlement_time when it can. */
const SETTLE_HOUR_UTC: Record<string, number> = { XAUT: 16 }
const settleHour = (base: string): number => SETTLE_HOUR_UTC[base] ?? 12

/**
 * The date in a Delta option symbol is DDMMYY; the symbol carries no
 * time-of-day, so it is stamped at the underlying's usual settlement hour.
 */
export function parseOptionSymbol(symbol: string): ParsedOption | null {
  const m = symbol.match(OPTION_RE)
  if (!m) return null
  const [, cp, base, strike, ddmmyy] = m
  const expiry = Date.UTC(2000 + +ddmmyy.slice(4, 6), +ddmmyy.slice(2, 4) - 1, +ddmmyy.slice(0, 2), settleHour(base))
  return { underlying: `${base}USD`, base, expiry, strike: +strike, side: cp === 'C' ? 'CALL' : 'PUT' }
}

// Exact settlement times (symbol -> epoch ms) from /v2/products. A contract's
// settlement time never changes, so this is fetched once and refetched only
// when the chain lists a symbol it hasn't seen (new listings), at most every 10 min.
let settleTimes = new Map<string, number>()
let settleFetchedAt = 0
let settleInflight: Promise<void> | null = null
async function ensureSettlementTimes(symbols: string[]): Promise<void> {
  const missing = symbols.some((s) => !settleTimes.has(s))
  if (!missing || Date.now() - settleFetchedAt < 10 * 60_000) return
  settleInflight ??= getJSON<{ symbol: string; settlement_time: string | null }[]>(
    '/v2/products?contract_types=call_options,put_options&states=live&page_size=3000',
  )
    .then((rows) => {
      const next = new Map<string, number>()
      for (const r of rows) {
        const t = r.settlement_time ? Date.parse(r.settlement_time) : NaN
        if (Number.isFinite(t)) next.set(r.symbol, t)
      }
      settleTimes = next
    })
    .catch((err: unknown) => console.warn('[options] settlement times', err)) // fall back to settleHour()
    .finally(() => {
      settleFetchedAt = Date.now()
      settleInflight = null
    })
  await settleInflight
}

/** A SymbolInfo for an option, for search results / the unified provider. */
export function optionSymbolInfo(symbol: string, pricePrecision = 2): SymbolInfo {
  const p = parseOptionSymbol(symbol)
  if (!p) return { symbol, base: symbol, quote: 'USD', pricePrecision, category: 'Options' }
  return {
    symbol,
    base: p.base,
    quote: 'USD',
    pricePrecision,
    category: 'Options',
    description: `${p.base} ${p.strike} ${p.side === 'CALL' ? 'Call' : 'Put'} · ${fmtExpiry(p.expiry)}`,
  }
}

// ---- chain data ----

/** One option contract's live quote — everything the chain and GEX both need. */
export interface ChainQuote {
  symbol: string
  side: 'CALL' | 'PUT'
  strike: number
  expiry: number // epoch ms (nominal — see parseOptionSymbol)
  markPrice: number
  markIV: number // decimal, e.g. 0.1272 = 12.72%
  delta: number
  gamma: number
  vega: number
  theta: number
  bid: number
  ask: number
  volume: number // 24h traded, base units
  openInterest: number // base units
  /** Underlying spot at the time of this snapshot (Delta sends it per row). */
  spot: number
  /** Base-asset units represented by one option contract. */
  contractValue: number
}

type PremiumScenario = {
  label: string
  spotMovePct: number
  ivMovePoints: number
  price: number
  change: number
  changePct: number
}

function quotePrice(q: ChainQuote): number {
  return q.bid > 0 && q.ask > 0 && q.ask >= q.bid ? (q.bid + q.ask) / 2 : q.markPrice
}

function estimatePremium(q: ChainQuote, spotMovePct: number, ivMovePoints: number, days: number): PremiumScenario {
  const base = quotePrice(q)
  const underlyingChange = q.spot * (spotMovePct / 100)
  const ivChange = ivMovePoints / 100
  // A local Greek estimate: ΔP ≈ Δ·ΔS + ½Γ·ΔS² + ν·ΔIV + Θ·Δt.
  const change = q.delta * underlyingChange
    + 0.5 * q.gamma * underlyingChange * underlyingChange
    + q.vega * ivChange
    + q.theta * days
  const price = Math.max(0, base + change)
  return {
    label: '',
    spotMovePct,
    ivMovePoints,
    price,
    change,
    changePct: base > 0 ? (change / base) * 100 : 0,
  }
}

interface RawOptionTicker {
  symbol: string
  contract_type: string
  strike_price: string | null
  contract_value: string
  underlying_asset_symbol: string
  spot_price: string | null
  mark_price: string | null
  oi_contracts: string | null
  volume: number | null
  greeks: { delta: string; gamma: string; vega: string; theta: string } | null
  quotes: { best_bid: string | null; best_ask: string | null; mark_iv: string | null } | null
}

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : v == null ? NaN : +v
  return isFinite(n) ? n : 0
}

/**
 * The whole options chain for one underlying, in ONE request.
 *
 * Delta publishes delta/gamma/vega/theta and open interest per contract, so
 * nothing here is modelled — the greeks are the exchange's own. Sizes come in
 * contracts and are converted to base units via each product's contract_value,
 * matching the volume convention in DeltaDataProvider.
 *
 * Omit `underlying` to get every supported underlying's chain at once (used by
 * the symbol search).
 */
export async function fetchOptionChain(underlying?: OptionUnderlying): Promise<ChainQuote[]> {
  const rows = await getJSON<RawOptionTicker[]>('/v2/tickers?contract_types=call_options,put_options')
  const wantBase = underlying ? underlying.replace(/USD$/, '') : null
  const mine = wantBase ? rows.filter((r) => r.underlying_asset_symbol === wantBase) : rows
  await ensureSettlementTimes(mine.map((r) => r.symbol))

  const out: ChainQuote[] = []
  for (const r of mine) {
    const p = parseOptionSymbol(r.symbol)
    if (!p) continue
    const cv = num(r.contract_value) || 1
    const g = r.greeks
    out.push({
      symbol: r.symbol,
      side: p.side,
      strike: num(r.strike_price) || p.strike,
      expiry: settleTimes.get(r.symbol) ?? p.expiry,
      markPrice: num(r.mark_price),
      markIV: num(r.quotes?.mark_iv),
      delta: num(g?.delta),
      gamma: num(g?.gamma),
      vega: num(g?.vega),
      theta: num(g?.theta),
      bid: num(r.quotes?.best_bid),
      ask: num(r.quotes?.best_ask),
      volume: num(r.volume),
      openInterest: num(r.oi_contracts) * cv,
      spot: num(r.spot_price),
      contractValue: cv,
    })
  }
  return out
}

/** Just the contract identities — for symbol search, which doesn't need quotes. */
export interface OptionSym {
  symbol: string
  side: 'CALL' | 'PUT'
  strike: number
  expiry: number
}
export async function fetchOptionSymbols(underlying?: OptionUnderlying): Promise<OptionSym[]> {
  const chain = await fetchOptionChain(underlying)
  return chain.map((q) => ({ symbol: q.symbol, side: q.side, strike: q.strike, expiry: q.expiry }))
}

/** Latest mark price for one option (used to pick a sensible price precision). */
export async function fetchOptionMark(symbol: string): Promise<number | null> {
  try {
    const t = await getJSON<RawOptionTicker>(`/v2/tickers/${symbol}`)
    const m = num(t.mark_price)
    return m > 0 ? m : null
  } catch {
    return null
  }
}

// ---- option candles ----
//
// Both modes are REAL exchange series — no reconstruction. Delta serves an
// option's traded candles under its own symbol, and its mark-price candles
// under the "MARK:" prefix.

export type OptionPriceMode = 'mark' | 'last'
let optionMode: OptionPriceMode = 'mark'
export const getOptionMode = (): OptionPriceMode => optionMode
export const setOptionMode = (m: OptionPriceMode): void => {
  optionMode = m
}

/** Delta serves options on the same resolutions as every other product. */
export const OPTION_KLINE_INTERVALS = new Set([
  '5s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w',
])

interface RawCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

const RESOLUTION_SEC: Record<string, number> = {
  '5s': 5, '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
  '1d': 86400, '1w': 604800,
}

/** Option candles for the current price mode: 'mark' (exchange mark) or 'last' (traded). */
export async function fetchOptionCandles(symbol: string, interval: string, limit = 500): Promise<Candle[]> {
  const res = OPTION_KLINE_INTERVALS.has(interval) ? interval : '1m'
  const stepSec = RESOLUTION_SEC[res] ?? 60
  const end = Math.floor(Date.now() / 1000)
  const start = end - stepSec * limit
  const sym = optionMode === 'mark' ? `MARK:${symbol}` : symbol

  const params = new URLSearchParams({ resolution: res, symbol: sym, start: String(start), end: String(end) })
  const rows = await getJSON<RawCandle[]>(`/v2/history/candles?${params}`)

  // Delta returns newest-first; charts want ascending.
  const out: Candle[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    out.push({ time: r.time * 1000, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 })
  }
  return out
}

// ---- formatting ----
const fmtPrice = (v: number | undefined): string =>
  v == null || !isFinite(v) || v === 0 ? '—' : v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(4)
const fmtIV = (v: number | undefined): string => (!v || !isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`)
const fmtDelta = (v: number | undefined): string => (v == null || !isFinite(v) || v === 0 ? '—' : v.toFixed(3))
const fmtVol = (v: number | undefined): string => (!v ? '0' : v >= 1 ? v.toFixed(1) : v.toFixed(2))
const fmtOI = (v: number | undefined): string => (!v ? '0' : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2))
const fmtExpiry = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' })

interface ChainRow {
  strike: number
  call?: ChainQuote
  put?: ChainQuote
  tr: HTMLElement
  callCells: { oi: HTMLElement; vol: HTMLElement; delta: HTMLElement; iv: HTMLElement; mark: HTMLElement }
  putCells: { mark: HTMLElement; iv: HTMLElement; delta: HTMLElement; vol: HTMLElement; oi: HTMLElement }
}

const OPT_INTERVALS = ['5m', '15m', '1h', '4h', '1d'] as const

export class OptionsView {
  readonly el: HTMLElement
  /** Fired when the user clicks "Open in Charts" for the selected option. */
  onOpenInCharts?: (symbol: string) => void
  private engine: IChartEngine
  private chartHost: HTMLElement
  private chartHead: HTMLElement
  private underlyingSelect: HTMLSelectElement
  private expirySelect: HTMLSelectElement
  private spotLabel: HTMLElement
  private statusEl: HTMLElement
  private tbody: HTMLElement
  private intervalWrap: HTMLElement
  private premiumMeta: HTMLElement
  private premiumResults: HTMLElement
  private premiumMove: HTMLInputElement
  private premiumIV: HTMLInputElement

  private underlying: OptionUnderlying = 'BTCUSD'
  private chain: ChainQuote[] = []
  private expiries: number[] = []
  private expiry = 0
  private rows: ChainRow[] = []
  private selected: string | null = null
  private interval: string = '1h'
  private index = 0
  private theme: Theme
  private active = false
  private loaded = false
  private pollTimer: number | null = null
  private retryTimer: number | null = null
  private ro: ResizeObserver

  constructor(container: HTMLElement, theme: Theme) {
    this.theme = theme
    this.el = container

    // toolbar
    const toolbar = el('div', { class: 'opt-toolbar' })
    this.underlyingSelect = el('select', { class: 'opt-select', title: 'Underlying' }) as HTMLSelectElement
    for (const u of SUPPORTED_OPTION_UNDERLYINGS) {
      this.underlyingSelect.appendChild(el('option', { value: u }, UNDERLYING_LABEL[u]))
    }
    this.underlyingSelect.addEventListener('change', () => {
      this.underlying = this.underlyingSelect.value as OptionUnderlying
      this.loaded = false
      this.selected = null
      this.chartHead.textContent = 'Select a strike to chart it'
      void this.activate()
    })
    this.expirySelect = el('select', { class: 'opt-select', title: 'Expiry' })
    this.expirySelect.addEventListener('change', () => {
      this.expiry = Number(this.expirySelect.value)
      this.renderChain()
      void this.refresh()
    })
    this.spotLabel = el('span', { class: 'opt-spot' }, '—')
    this.statusEl = el('span', { class: 'opt-status' }, '')
    toolbar.append(
      this.underlyingSelect,
      el('span', { class: 'opt-label' }, 'Expiry'),
      this.expirySelect,
      this.spotLabel,
      el('span', { class: 'foot-grow' }),
      this.statusEl,
    )

    // chain table
    const chainWrap = el('div', { class: 'opt-chain' })
    const table = el('table', { class: 'opt-table' })
    const thead = el('thead', {})
    thead.innerHTML =
      '<tr>' +
      '<th colspan="5" class="th-call">CALLS</th>' +
      '<th class="th-strike">Strike</th>' +
      '<th colspan="5" class="th-put">PUTS</th>' +
      '</tr>' +
      '<tr class="sub">' +
      '<th>OI</th><th>Vol</th><th>Δ</th><th>IV</th><th>Mark</th>' +
      '<th class="th-strike"></th>' +
      '<th>Mark</th><th>IV</th><th>Δ</th><th>Vol</th><th>OI</th>' +
      '</tr>'
    this.tbody = el('tbody', {})
    table.append(thead, this.tbody)
    chainWrap.appendChild(table)

    // option chart
    const chartWrap = el('div', { class: 'opt-chart-wrap' })
    this.chartHead = el('div', { class: 'opt-chart-head' }, 'Select a strike to chart it')
    this.intervalWrap = el('div', { class: 'opt-ivl' })
    for (const iv of OPT_INTERVALS) {
      const b = el('button', { class: `chip${iv === this.interval ? ' active' : ''}`, 'data-iv': iv }, iv)
      b.addEventListener('click', () => {
        this.interval = iv
        this.intervalWrap.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', (c as HTMLElement).getAttribute('data-iv') === iv))
        void this.loadOptionChart()
      })
      this.intervalWrap.appendChild(b)
    }
    // Both are real Delta series: mark-price candles vs traded candles.
    const priceMode = el('select', { class: 'opt-select', title: 'Price source' }) as HTMLSelectElement
    priceMode.append(el('option', { value: 'mark' }, 'Mark Price'), el('option', { value: 'last' }, 'Last Price'))
    priceMode.value = getOptionMode()
    priceMode.addEventListener('change', () => {
      setOptionMode(priceMode.value as 'mark' | 'last')
      void this.loadOptionChart()
    })

    const openBtn = el('button', { class: 'opt-open', title: 'Open this option in the Charts view (indicators, drawings, all timeframes)' }, 'Open in Charts ↗')
    openBtn.addEventListener('click', () => {
      if (this.selected) this.onOpenInCharts?.(this.selected)
    })
    const headRow = el('div', { class: 'opt-chart-bar' })
    headRow.append(this.chartHead, el('span', { class: 'foot-grow' }), priceMode, openBtn, this.intervalWrap)

    const premiumPanel = el('section', { class: 'premium-scenario' })
    const premiumTitle = el('div', { class: 'ps-title' }, 'Premium scenarios')
    this.premiumMeta = el('span', { class: 'ps-meta' }, 'Select an option')
    const controls = el('div', { class: 'ps-controls' })
    this.premiumMove = el('input', { class: 'ps-input', type: 'number', min: '0.1', max: '20', step: '0.1', value: '1.0', title: 'Absolute underlying move used for up/down scenarios' }) as HTMLInputElement
    this.premiumIV = el('input', { class: 'ps-input', type: 'number', min: '0', max: '50', step: '0.1', value: '1.0', title: 'Absolute implied-volatility change in percentage points' }) as HTMLInputElement
    for (const input of [this.premiumMove, this.premiumIV]) input.addEventListener('input', () => this.renderPremiumScenarios())
    const moveLabel = el('label', { class: 'ps-control' }, 'Move % ')
    moveLabel.appendChild(this.premiumMove)
    const ivLabel = el('label', { class: 'ps-control' }, 'IV pts ')
    ivLabel.appendChild(this.premiumIV)
    controls.append(moveLabel, ivLabel)
    this.premiumResults = el('div', { class: 'ps-results' })
    const premiumTopline = el('div', { class: 'ps-topline' })
    premiumTopline.append(premiumTitle, this.premiumMeta, el('span', { class: 'foot-grow' }), controls)
    premiumPanel.append(premiumTopline, this.premiumResults)

    this.chartHost = el('div', { class: 'opt-chart' })
    chartWrap.append(headRow, premiumPanel, this.chartHost)

    this.el.append(toolbar, chainWrap, chartWrap)

    this.engine = createChartEngine(this.chartHost, { theme, pricePrecision: 2, chartType: 'candles' })
    this.ro = new ResizeObserver(() => this.engine.resize())
    this.ro.observe(this.chartHost)
  }

  setTheme(t: Theme): void {
    this.theme = t
    this.engine.setTheme(t)
  }

  async activate(): Promise<void> {
    this.active = true
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (!this.loaded) {
      this.statusEl.textContent = 'loading chain…'
      this.statusEl.className = 'opt-status'
      try {
        this.chain = await fetchOptionChain(this.underlying)
        if (this.chain.length === 0) throw new Error('no contracts listed')
        this.expiries = [...new Set(this.chain.map((s) => s.expiry))].sort((a, b) => a - b)
        this.expirySelect.innerHTML = ''
        for (const e of this.expiries) this.expirySelect.appendChild(el('option', { value: String(e) }, fmtExpiry(e)))
        this.expiry = this.expiries[0]
        this.expirySelect.value = String(this.expiry)
        this.loaded = true
        this.renderChain()
      } catch (err) {
        console.warn('[options]', err)
        if (isRateLimited(err)) {
          this.statusEl.textContent = 'Delta rate-limited — retrying in 30s…'
          if (this.active) this.retryTimer = window.setTimeout(() => void this.activate(), 30_000)
        } else {
          this.statusEl.textContent = 'Delta options unavailable'
        }
        return
      }
    }
    await this.refresh()
    this.startPolling()
  }

  deactivate(): void {
    this.active = false
    this.stopPolling()
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private startPolling(): void {
    this.stopPolling()
    // The whole chain is one request, so a brisk refresh is cheap here.
    this.pollTimer = window.setInterval(() => void this.refresh(), 5_000)
  }
  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** Build the (empty) rows for the current expiry; values fill in on refresh. */
  private renderChain(): void {
    const forExp = this.chain.filter((s) => s.expiry === this.expiry)
    const byStrike = new Map<number, ChainRow>()
    for (const s of forExp) {
      let row = byStrike.get(s.strike)
      if (!row) {
        const cell = (cls: string): HTMLElement => el('td', { class: cls }, '—')
        const tr = el('tr', { class: 'opt-row' })
        const callCells = { oi: cell('c-oi'), vol: cell('c-vol'), delta: cell('c-delta'), iv: cell('c-iv'), mark: cell('c-mark mark') }
        const strikeTd = el('td', { class: 'strike' }, String(s.strike))
        const putCells = { mark: cell('p-mark mark'), iv: cell('p-iv'), delta: cell('p-delta'), vol: cell('p-vol'), oi: cell('p-oi') }
        tr.append(
          callCells.oi, callCells.vol, callCells.delta, callCells.iv, callCells.mark,
          strikeTd,
          putCells.mark, putCells.iv, putCells.delta, putCells.vol, putCells.oi,
        )
        row = { strike: s.strike, tr, callCells, putCells }
        byStrike.set(s.strike, row)
      }
      if (s.side === 'CALL') row.call = s
      else row.put = s
    }
    this.rows = [...byStrike.values()].sort((a, b) => a.strike - b.strike)

    // wire clicks: call side → call option, put side → put option
    for (const row of this.rows) {
      const callTds = [row.callCells.oi, row.callCells.vol, row.callCells.delta, row.callCells.iv, row.callCells.mark]
      const putTds = [row.putCells.mark, row.putCells.iv, row.putCells.delta, row.putCells.vol, row.putCells.oi]
      if (row.call) callTds.forEach((td) => { td.classList.add('clickable'); td.addEventListener('click', () => this.selectOption(row.call!)) })
      if (row.put) putTds.forEach((td) => { td.classList.add('clickable'); td.addEventListener('click', () => this.selectOption(row.put!)) })
    }

    this.tbody.innerHTML = ''
    for (const row of this.rows) this.tbody.appendChild(row.tr)
    this.highlightSelected()
  }

  /** Re-poll the chain and fill the table; refresh the open option chart. */
  private async refresh(): Promise<void> {
    try {
      this.chain = await fetchOptionChain(this.underlying)
      const quotes = new Map(this.chain.map((q) => [q.symbol, q]))
      // Every row carries the same spot snapshot — take the first that has one.
      const index = this.chain.find((q) => q.spot > 0)?.spot ?? this.index
      this.index = index
      this.spotLabel.textContent = `${UNDERLYING_LABEL[this.underlying]} ${index.toFixed(index >= 100 ? 0 : 2)}`
      this.statusEl.textContent = `● ${fmtExpiry(this.expiry)} · live`
      this.statusEl.className = 'opt-status live'

      let atm: ChainRow | null = null
      let best = Infinity
      for (const row of this.rows) {
        const c = row.call ? quotes.get(row.call.symbol) : undefined
        const p = row.put ? quotes.get(row.put.symbol) : undefined
        if (c) row.call = c
        if (p) row.put = p
        row.callCells.oi.textContent = fmtOI(c?.openInterest)
        row.callCells.vol.textContent = fmtVol(c?.volume)
        row.callCells.delta.textContent = fmtDelta(c?.delta)
        row.callCells.iv.textContent = fmtIV(c?.markIV)
        row.callCells.mark.textContent = fmtPrice(c?.markPrice)
        row.putCells.mark.textContent = fmtPrice(p?.markPrice)
        row.putCells.iv.textContent = fmtIV(p?.markIV)
        row.putCells.delta.textContent = fmtDelta(p?.delta)
        row.putCells.vol.textContent = fmtVol(p?.volume)
        row.putCells.oi.textContent = fmtOI(p?.openInterest)
        // ITM shading + ATM detection
        row.tr.classList.toggle('call-itm', row.strike < index)
        row.tr.classList.toggle('put-itm', row.strike > index)
        const d = Math.abs(row.strike - index)
        if (d < best) {
          best = d
          atm = row
        }
      }
      for (const row of this.rows) row.tr.classList.toggle('atm', row === atm)

      // first load with no selection: chart the ATM call
      if (this.selected === null && atm?.call) this.selectOption(atm.call)
      else if (this.selected) {
        this.renderPremiumScenarios()
        void this.refreshOptionChart()
      }
    } catch (err) {
      // Keep the last values shown; just flag the transient failure.
      this.statusEl.textContent = isRateLimited(err) ? 'Delta rate-limited — backing off' : 'options data error'
      this.statusEl.className = 'opt-status'
      console.warn('[options] refresh', err)
    }
  }

  private highlightSelected(): void {
    for (const row of this.rows) {
      row.tr.classList.toggle('sel-call', !!row.call && row.call.symbol === this.selected)
      row.tr.classList.toggle('sel-put', !!row.put && row.put.symbol === this.selected)
    }
  }

  private selectOption(sym: ChainQuote): void {
    this.selected = sym.symbol
    this.highlightSelected()
    const kind = sym.side === 'CALL' ? 'Call' : 'Put'
    const base = UNDERLYING_LABEL[this.underlying]
    this.chartHead.innerHTML = `<b>${sym.symbol}</b><span class="opt-sub">${base} ${kind} · strike ${sym.strike} · exp ${fmtExpiry(sym.expiry)}</span>`
    this.renderPremiumScenarios()
    void this.loadOptionChart()
  }

  private renderPremiumScenarios(): void {
    const selected = this.selected ? this.chain.find((q) => q.symbol === this.selected) : undefined
    if (!selected) {
      this.premiumMeta.textContent = 'Select an option'
      this.premiumResults.textContent = ''
      return
    }
    const move = Math.max(0, Number(this.premiumMove.value) || 0)
    const iv = Math.max(0, Number(this.premiumIV.value) || 0)
    const base = quotePrice(selected)
    const spreadPct = base > 0 && selected.ask >= selected.bid && selected.bid > 0
      ? ((selected.ask - selected.bid) / base) * 100
      : null
    const dailyMove = selected.markIV > 0 ? (selected.markIV / Math.sqrt(365)) * 100 : 0
    this.premiumMeta.textContent = `${selected.side === 'CALL' ? 'Call' : 'Put'} · mid ${fmtPrice(base)} · 1d IV move ${dailyMove.toFixed(2)}%`

    const scenarios = [
      { label: 'Underlying down', spotMovePct: -move, ivMovePoints: iv },
      { label: 'Flat / IV lower', spotMovePct: 0, ivMovePoints: -iv },
      { label: 'Underlying up', spotMovePct: move, ivMovePoints: iv },
    ].map((item) => ({ ...estimatePremium(selected, item.spotMovePct, item.ivMovePoints, 1), label: item.label }))

    this.premiumResults.innerHTML = ''
    for (const scenario of scenarios) {
      const direction = scenario.change > 0 ? 'up' : scenario.change < 0 ? 'down' : ''
      const card = el('div', { class: 'ps-card' })
      card.append(
        el('span', { class: 'ps-case' }, scenario.label),
        el('b', { class: 'ps-price' }, fmtPrice(scenario.price)),
        el('span', { class: `ps-change ${direction}` }, `${scenario.change >= 0 ? '+' : ''}${fmtPrice(scenario.change)} (${scenario.changePct >= 0 ? '+' : ''}${scenario.changePct.toFixed(1)}%)`),
      )
      this.premiumResults.appendChild(card)
    }
    const quality = spreadPct == null
      ? 'No two-sided quote — based on mark'
      : spreadPct > 8
        ? `Wide ${spreadPct.toFixed(1)}% spread — estimate may not be tradeable`
        : `Bid/ask spread ${spreadPct.toFixed(1)}%`
    this.premiumResults.appendChild(el('span', { class: 'ps-note' }, `Greek estimate · 1 day theta · ${quality} · not a forecast`))
  }

  private precisionFor(v: number): number {
    return v >= 100 ? 1 : v >= 1 ? 2 : 4
  }

  private async loadOptionChart(): Promise<void> {
    if (!this.selected) return
    const sym = this.selected
    try {
      const candles = await fetchOptionCandles(sym, this.interval, 500)
      if (sym !== this.selected) return
      if (candles.length === 0) {
        this.engine.setData([])
        return
      }
      this.engine.setPricePrecision(this.precisionFor(candles[candles.length - 1].close))
      this.engine.setData(candles)
    } catch (err) {
      console.warn('[options] candles', err)
    }
  }

  private async refreshOptionChart(): Promise<void> {
    if (!this.selected) return
    const sym = this.selected
    try {
      const last = await fetchOptionCandles(sym, this.interval, 2)
      if (sym === this.selected && last.length) this.engine.updateLast(last[last.length - 1])
    } catch {
      /* ignore transient poll error */
    }
  }

  destroy(): void {
    this.stopPolling()
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.ro.disconnect()
    this.engine.destroy()
  }
}
