// Watchlist sidebar (Vela / TradingView style): a persisted symbol list with
// logo + name, last price + absolute change, and 24h %change, grouped by asset
// class (collapsible), with All / Gainers / Losers tabs and a filter box that
// doubles as "add symbol" (Enter). Fed by ONE shared provider.subscribeTickers()
// call for the whole list (not one WS subscription per row). Click a row to
// load that symbol into the caller's active pane.
import type { TickerUpdate } from '../../src/data/types'
import { el, ICONS } from './ui'
import { symbolLogo, symbolMeta, type AssetGroup } from './symbolMeta'

export interface WatchlistProvider {
  subscribeTickers(symbols: string[], onTick: (update: TickerUpdate) => void): () => void
  /** Optional: hourly candles for the row sparklines. */
  fetchCandles?(symbol: string, interval: '1h', limit?: number): Promise<{ close: number }[]>
}

/** SVG path for a 24-point sparkline in a 44×18 box. */
function sparkPath(values: number[]): string {
  if (values.length < 2) return ''
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  return values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 44).toFixed(1)} ${(16 - ((v - lo) / span) * 14).toFixed(1)}`).join('')
}

const LS_KEY = 'candl.watchlist'
const COLLAPSED_KEY = 'candl.watchlistCollapsed'
const DEFAULT_SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'XAUTUSD', 'BTC_INR']
const GROUP_ORDER: AssetGroup[] = ['Crypto', 'Commodities', 'INR spot', 'Options']

type Tab = 'all' | 'gainers' | 'losers'

function readList(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULT_SYMBOLS.slice()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) return DEFAULT_SYMBOLS.slice()
    // The Binance build of this demo saved the same key on the same origin with
    // symbols like BTCUSDT. Delta India lists no …USDT products — its perps are
    // …USD — so those rows never got a tick and showed "—". Map them across.
    return [...new Set(parsed.map((s) => s.replace(/USDT$/, 'USD')))]
  } catch {
    return DEFAULT_SYMBOLS.slice()
  }
}

function readCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v : [])
  } catch {
    return new Set()
  }
}

interface Row {
  root: HTMLElement
  spark: SVGPathElement
  priceEl: HTMLElement
  absEl: HTMLElement
  changeEl: HTMLElement
}

export class Watchlist {
  readonly root: HTMLElement
  /** Called when the user clicks a row to load it into the active pane. */
  onSelect: ((symbol: string) => void) | null = null
  /** Called by the header's close button. */
  onClose: (() => void) | null = null

  private readonly provider: WatchlistProvider
  private readonly listEl: HTMLElement
  private readonly countEl: HTMLElement
  private readonly input: HTMLInputElement
  private symbols: string[]
  private rows = new Map<string, Row>()
  private ticks = new Map<string, TickerUpdate>()
  private activeSymbol: string | null = null
  private unsub: (() => void) | null = null
  private tab: Tab = 'all'
  private filter = ''
  private collapsed = readCollapsed()
  private readonly tabButtons = new Map<Tab, HTMLElement>()
  private sparks = new Map<string, number[]>()
  private sparkTimer: number | null = null

  constructor(provider: WatchlistProvider) {
    this.provider = provider
    this.symbols = readList()

    const head = el('div', { class: 'watchlist-head' })
    const addBtn = el('button', { class: 'mi-icon', title: 'Add symbol', 'aria-label': 'Add symbol to watchlist' }, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>')
    addBtn.addEventListener('click', () => this.input.focus())
    const closeBtn = el('button', { class: 'mi-icon', title: 'Close watchlist', 'aria-label': 'Close watchlist' }, ICONS.close)
    closeBtn.addEventListener('click', () => this.onClose?.())
    head.append(el('span', { class: 'watchlist-title' }, 'Watchlist'), addBtn, closeBtn)

    const searchRow = el('div', { class: 'watchlist-add' })
    const wrap = el('label', { class: 'wl-search' })
    this.input = el('input', { placeholder: 'Filter, or add a symbol + Enter', spellcheck: 'false', 'aria-label': 'Filter or add symbol' }) as HTMLInputElement
    wrap.append(el('span', { class: 'wl-search-icon' }, ICONS.search), this.input)
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation() // don't let global keyboard shortcuts fire while typing
      if (e.key === 'Enter') {
        const v = this.input.value.trim()
        if (v) {
          this.input.value = ''
          this.filter = ''
          this.add(v)
          this.renderRows()
        }
      } else if (e.key === 'Escape') {
        this.input.value = ''
        this.filter = ''
        this.renderRows()
        this.input.blur()
      }
    })
    this.input.addEventListener('input', () => {
      this.filter = this.input.value.trim().toUpperCase()
      this.renderRows()
    })
    searchRow.append(wrap)

    const tabs = el('div', { class: 'wl-tabs', role: 'tablist', 'aria-label': 'Filter watchlist' })
    for (const [t, label] of [['all', 'All'], ['gainers', 'Gainers'], ['losers', 'Losers']] as const) {
      const b = el('button', { class: `wl-tab${t === this.tab ? ' active' : ''}`, role: 'tab', 'aria-selected': String(t === this.tab) }, label)
      b.addEventListener('click', () => {
        this.tab = t
        for (const [k, btn] of this.tabButtons) {
          btn.classList.toggle('active', k === t)
          btn.setAttribute('aria-selected', String(k === t))
        }
        this.renderRows()
      })
      this.tabButtons.set(t, b)
      tabs.append(b)
    }

    const cols = el('div', { class: 'wl-cols' })
    cols.append(el('span', {}, 'Symbol / name'), el('span', {}, 'Last'), el('span', {}, 'Day %'))

    this.listEl = el('div', { class: 'watchlist-list' })
    const foot = el('div', { class: 'wl-foot' })
    this.countEl = el('span', {})
    foot.append(el('span', {}, 'Prices · Live'), this.countEl)

    this.root = el('div', { class: 'watchlist' })
    this.root.append(head, searchRow, tabs, cols, this.listEl, foot)

    this.renderRows()
    this.resubscribe()
    void this.loadSparks()
    this.sparkTimer = window.setInterval(() => void this.loadSparks(), 5 * 60_000)
  }

  /** Last 24 hourly closes per symbol for the sparklines (refreshed every 5 minutes). */
  private async loadSparks(only?: string): Promise<void> {
    const fetchCandles = this.provider.fetchCandles?.bind(this.provider)
    if (!fetchCandles) return
    const syms = only ? [only] : this.symbols.slice()
    await Promise.all(
      syms.map(async (sym) => {
        try {
          const c = await fetchCandles(sym, '1h', 24)
          this.sparks.set(sym, c.map((k) => k.close))
          const row = this.rows.get(sym)
          if (row) row.spark.setAttribute('d', sparkPath(this.sparks.get(sym)!))
        } catch {
          /* no history — the row just has no sparkline */
        }
      }),
    )
  }

  setActiveSymbol(symbol: string): void {
    this.activeSymbol = symbol.toUpperCase()
    for (const [sym, row] of this.rows) {
      row.root.classList.toggle('active', sym === this.activeSymbol)
    }
  }

  add(symbol: string): void {
    const sym = symbol.trim().toUpperCase()
    if (!sym || this.symbols.includes(sym)) return
    this.symbols.push(sym)
    this.save()
    this.renderRows()
    this.resubscribe()
    void this.loadSparks(sym)
  }

  remove(symbol: string): void {
    this.symbols = this.symbols.filter((s) => s !== symbol)
    this.save()
    this.renderRows()
    this.resubscribe()
  }

  destroy(): void {
    this.unsub?.()
    this.unsub = null
    if (this.sparkTimer !== null) clearInterval(this.sparkTimer)
  }

  private save(): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.symbols))
    } catch {
      /* storage unavailable/full — the list still works for this session */
    }
  }

  private saveCollapsed(): void {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...this.collapsed]))
    } catch {
      /* storage unavailable */
    }
  }

  /** Symbols to show for the current tab + filter (gainers / losers sorted by move). */
  private visibleSymbols(): string[] {
    let syms = this.symbols.filter((s) => !this.filter || s.includes(this.filter) || symbolMeta(s).name.toUpperCase().includes(this.filter))
    const pct = (s: string): number => this.ticks.get(s)?.changePct ?? 0
    if (this.tab === 'gainers') syms = syms.filter((s) => pct(s) > 0).sort((a, b) => pct(b) - pct(a))
    if (this.tab === 'losers') syms = syms.filter((s) => pct(s) < 0).sort((a, b) => pct(a) - pct(b))
    return syms
  }

  private renderRows(): void {
    this.listEl.innerHTML = ''
    this.rows.clear()
    this.countEl.textContent = `${this.symbols.length} symbol${this.symbols.length === 1 ? '' : 's'}`
    if (this.symbols.length === 0) {
      this.listEl.appendChild(el('div', { class: 'watchlist-empty' }, 'No symbols — type one above and press Enter.'))
      return
    }
    const syms = this.visibleSymbols()
    if (syms.length === 0) {
      const msg = this.filter ? 'No match — press Enter to add it.' : this.tab === 'gainers' ? 'Nothing is up on the day.' : 'Nothing is down on the day.'
      this.listEl.appendChild(el('div', { class: 'watchlist-empty' }, msg))
      return
    }
    // Gainers / losers is one ranked list; "All" groups by asset class.
    if (this.tab !== 'all') {
      for (const s of syms) this.listEl.appendChild(this.buildRow(s))
      return
    }
    for (const group of GROUP_ORDER) {
      const inGroup = syms.filter((s) => symbolMeta(s).group === group)
      if (!inGroup.length) continue
      const isCollapsed = this.collapsed.has(group)
      const gh = el('button', { class: `wl-group${isCollapsed ? ' collapsed' : ''}`, 'aria-expanded': String(!isCollapsed) })
      gh.append(el('span', { class: 'wl-caret' }, ICONS.chevron), el('span', { class: 'wl-group-name' }, group), el('span', { class: 'wl-group-count' }, String(inGroup.length)))
      gh.addEventListener('click', () => {
        if (this.collapsed.has(group)) this.collapsed.delete(group)
        else this.collapsed.add(group)
        this.saveCollapsed()
        this.renderRows()
      })
      this.listEl.appendChild(gh)
      if (!isCollapsed) for (const s of inGroup) this.listEl.appendChild(this.buildRow(s))
    }
  }

  private buildRow(sym: string): HTMLElement {
    const meta = symbolMeta(sym)
    const priceEl = el('span', { class: 'watchlist-price' }, '—')
    const absEl = el('span', { class: 'wl-abs' }, '')
    const changeEl = el('span', { class: 'watchlist-change' }, '—')
    const removeBtn = el('button', { class: 'watchlist-remove', title: `Remove ${sym}`, 'aria-label': `Remove ${sym}` }, ICONS.close)
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.remove(sym)
    })
    const row = el('div', { class: 'watchlist-row', role: 'button', tabindex: '0', title: `Show ${sym} on chart` })
    const name = el('span', { class: 'wl-name-col' })
    const symEl = el('span', { class: 'watchlist-sym' })
    symEl.textContent = sym
    const nameEl = el('span', { class: 'wl-name' })
    nameEl.textContent = meta.name
    name.append(symEl, nameEl)
    const last = el('span', { class: 'wl-last-col' })
    last.append(priceEl, absEl)
    const svgNS = 'http://www.w3.org/2000/svg'
    const sparkSvg = document.createElementNS(svgNS, 'svg')
    sparkSvg.setAttribute('viewBox', '0 0 44 18')
    sparkSvg.setAttribute('class', 'wl-spark')
    sparkSvg.setAttribute('aria-hidden', 'true')
    const spark = document.createElementNS(svgNS, 'path')
    spark.setAttribute('d', sparkPath(this.sparks.get(sym) ?? []))
    sparkSvg.appendChild(spark)
    row.append(el('span', { class: 'wl-logo' }, symbolLogo(sym)), name, sparkSvg, last, changeEl, removeBtn)
    row.addEventListener('click', () => this.onSelect?.(sym))
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        this.onSelect?.(sym)
      }
    })
    row.classList.toggle('active', sym === this.activeSymbol)
    const r: Row = { root: row, spark, priceEl, absEl, changeEl }
    this.rows.set(sym, r)
    const t = this.ticks.get(sym)
    if (t) this.paint(r, t)
    return row
  }

  private resubscribe(): void {
    this.unsub?.()
    this.unsub = this.symbols.length ? this.provider.subscribeTickers(this.symbols, (u) => this.onTick(u)) : null
  }

  private onTick(u: TickerUpdate): void {
    const prev = this.ticks.get(u.symbol)
    this.ticks.set(u.symbol, u)
    // A symbol crossing zero changes the gainers / losers membership.
    if (this.tab !== 'all' && (!prev || Math.sign(prev.changePct) !== Math.sign(u.changePct))) {
      this.renderRows()
      return
    }
    const row = this.rows.get(u.symbol)
    if (row) this.paint(row, u)
  }

  private paint(row: Row, u: TickerUpdate): void {
    row.priceEl.textContent = formatCompactPrice(u.price)
    // Absolute 24h change from the % move: price − price / (1 + pct).
    const abs = u.price - u.price / (1 + u.changePct / 100)
    row.absEl.textContent = isFinite(abs) ? `${abs >= 0 ? '+' : '−'}${formatCompactPrice(Math.abs(abs))}` : ''
    row.changeEl.textContent = formatSignedPercent(u.changePct)
    row.root.classList.toggle('wl-up', u.changePct > 0)
    row.root.classList.toggle('wl-down', u.changePct < 0)
    for (const e of [row.changeEl, row.absEl]) {
      e.classList.toggle('up', u.changePct > 0)
      e.classList.toggle('down', u.changePct < 0)
    }
  }
}

export function formatCompactPrice(v: number): string {
  if (!isFinite(v)) return '—'
  const digits = v >= 100 ? 2 : v >= 1 ? 4 : 6
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits })
}

export function formatSignedPercent(pct: number): string {
  if (!isFinite(pct)) return '—'
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}
