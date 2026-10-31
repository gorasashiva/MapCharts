// Strategy Tester — a TradingView-style dock under the chart that reports on
// whichever strategy overlays are switched on in the active pane.
//
// Strategy-agnostic by construction: it only sees StrategySource (pane.ts →
// getStrategySources) and the shared metrics in src/strategy/metrics.ts, so a
// newly ported strategy shows up here as soon as it is registered on the pane.
//
//  - Range: Visible / Today / 7D / 30D / All loaded / Custom (date inputs, or
//    drag across the equity curve). Trades count when their entry is inside.
//    The range is shaded on the chart; ranges older than the loaded candles
//    offer "Load more history".
//  - Tabs: Overview (headline numbers + equity / drawdown / buy & hold),
//    Performance Summary (All / Long / Short), List of Trades (sortable, click
//    to jump the chart), Properties (capital, qty, commission, slippage).

import type { ChartPane } from './pane'
import { el } from './ui'
import { computeReport, tradesCsv, type SideStats, type StrategyReport, type TradeRow } from '../../src/strategy/metrics'
import { DEFAULT_STRATEGY_PROPERTIES, type StrategyProperties, type StrategySource } from '../../src/strategy/types'

type Tab = 'overview' | 'performance' | 'trades' | 'properties'
type RangePreset = 'visible' | 'today' | '7d' | '30d' | 'all' | 'custom'
type SortKey = 'n' | 'side' | 'entry' | 'exit' | 'pnl' | 'r' | 'bars'

interface Persisted {
  open: boolean
  height: number
  tab: Tab
  preset: RangePreset
  customFrom: number | null
  customTo: number | null
  strategyId: string | null
  props: StrategyProperties
}

const STORE_KEY = 'strategyTester.v1'
const DAY = 86_400_000
const FAR_PAST = 0
const FAR_FUTURE = 8.64e15
const MIN_H = 180

const PRESETS: [RangePreset, string][] = [
  ['visible', 'Visible range'],
  ['today', 'Today'],
  ['7d', '7D'],
  ['30d', '30D'],
  ['all', 'All loaded'],
  ['custom', 'Custom'],
]

const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['performance', 'Performance Summary'],
  ['trades', 'List of Trades'],
  ['properties', 'Properties'],
]

function load(): Persisted {
  const base: Persisted = {
    open: false,
    height: 320,
    tab: 'overview',
    preset: 'visible',
    customFrom: null,
    customTo: null,
    strategyId: null,
    props: { ...DEFAULT_STRATEGY_PROPERTIES },
  }
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return base
    const p = JSON.parse(raw) as Partial<Persisted>
    return { ...base, ...p, props: { ...base.props, ...(p.props ?? {}) } }
  } catch {
    return base
  }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function num(v: number, signed = false): string {
  if (!isFinite(v)) return v === Infinity ? '∞' : '—'
  const a = Math.abs(v)
  const digits = a >= 1 || a === 0 ? 2 : 4
  const s = a.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  if (!signed) return v < 0 ? `−${s}` : s
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s
}
const pct = (v: number, signed = true): string => {
  if (!isFinite(v)) return '—'
  const s = Math.abs(v).toFixed(2)
  return `${signed && v > 0 ? '+' : v < 0 ? '−' : ''}${s}%`
}
const ratio = (v: number | null): string => (v === null || !isFinite(v) ? (v === Infinity ? '∞' : '—') : v.toFixed(2))
const rr = (v: number | null): string => (v === null || !isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}R`)
const tone = (v: number | null): string => (v === null || !isFinite(v) || v === 0 ? '' : v > 0 ? 'st-pos' : 'st-neg')
const count = (v: number): string => (isFinite(v) ? String(Math.round(v)) : '—')

function fmtTime(t: number): string {
  const d = new Date(t)
  const mo = d.toLocaleString('en-US', { month: 'short' })
  const yy = String(d.getFullYear() % 100).padStart(2, '0')
  return `${d.getDate()} ${mo} ${yy} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** `<input type=datetime-local>` value from epoch ms, in local time. */
function toLocalInput(t: number): string {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

export interface StrategyTesterHost {
  activePane(): ChartPane | undefined
  /** Called when the dock opens, closes or is resized (header button state, chart resize). */
  onOpenChange(open: boolean): void
}

export class StrategyTester {
  readonly root: HTMLElement
  private readonly host: StrategyTesterHost
  private st: Persisted

  private readonly stratSel: HTMLSelectElement
  private readonly presetBox: HTMLElement
  private readonly customBox: HTMLElement
  private readonly fromInput: HTMLInputElement
  private readonly toInput: HTMLInputElement
  private readonly rangeText: HTMLElement
  private readonly moreBtn: HTMLButtonElement
  private readonly tabBar: HTMLElement
  private readonly body: HTMLElement
  private readonly band: HTMLElement

  private timer: number | null = null
  private raf = 0
  private lastKey = ''
  private report: StrategyReport | null = null
  private source: StrategySource | null = null
  private pane: ChartPane | undefined
  private bandPane: ChartPane | undefined
  private sortKey: SortKey = 'n'
  private sortDir: 1 | -1 = 1
  private loadingHistory = false
  private eqCanvas: HTMLCanvasElement | null = null
  private eqDrag: { x0: number; x1: number } | null = null

  constructor(host: StrategyTesterHost) {
    this.host = host
    this.st = load()
    this.root = el('section', { id: 'strategy-tester', 'aria-label': 'Strategy Tester' })
    this.root.style.height = `${this.st.height}px`

    const grip = el('div', { class: 'st-grip', title: 'Drag to resize' })
    this.installResize(grip)

    // ---- toolbar ----
    const toolbar = el('div', { class: 'st-toolbar' })
    const stratLabel = el('label', { class: 'st-field' })
    stratLabel.append(el('span', { class: 'st-muted' }, 'Strategy'))
    this.stratSel = el('select', { class: 'st-select' })
    this.stratSel.addEventListener('change', () => {
      this.st.strategyId = this.stratSel.value
      this.save()
      this.refresh(true)
    })
    stratLabel.append(this.stratSel)

    this.presetBox = el('div', { class: 'st-chips', role: 'group', 'aria-label': 'Range' })
    for (const [id, label] of PRESETS) {
      const b = el('button', { class: 'st-chip', 'data-preset': id, type: 'button' }, label)
      b.addEventListener('click', () => this.setPreset(id))
      this.presetBox.append(b)
    }

    this.customBox = el('div', { class: 'st-custom' })
    this.fromInput = el('input', { type: 'datetime-local', class: 'st-input', 'aria-label': 'Range start' })
    this.toInput = el('input', { type: 'datetime-local', class: 'st-input', 'aria-label': 'Range end' })
    const onCustom = (): void => {
      const f = this.fromInput.value ? new Date(this.fromInput.value).getTime() : NaN
      const t = this.toInput.value ? new Date(this.toInput.value).getTime() : NaN
      if (isFinite(f)) this.st.customFrom = f
      if (isFinite(t)) this.st.customTo = t
      this.save()
      this.refresh(true)
    }
    this.fromInput.addEventListener('change', onCustom)
    this.toInput.addEventListener('change', onCustom)
    this.customBox.append(this.fromInput, el('span', { class: 'st-muted' }, '→'), this.toInput)

    this.rangeText = el('span', { class: 'st-muted st-range-text' })
    this.moreBtn = el('button', { class: 'st-btn', type: 'button' }, 'Load more history')
    this.moreBtn.addEventListener('click', () => void this.loadHistoryForRange())

    const exportBtn = el('button', { class: 'st-btn', type: 'button' }, 'Export CSV')
    exportBtn.addEventListener('click', () => this.exportCsv())
    const closeBtn = el('button', { class: 'st-icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close Strategy Tester' }, '✕')
    closeBtn.addEventListener('click', () => this.setOpen(false))

    toolbar.append(stratLabel, el('span', { class: 'st-sep' }), this.presetBox, this.customBox, this.rangeText, this.moreBtn, el('span', { class: 'st-grow' }), exportBtn, closeBtn)

    // ---- tabs ----
    this.tabBar = el('div', { class: 'st-tabs', role: 'tablist' })
    for (const [id, label] of TABS) {
      const b = el('button', { class: 'st-tab', role: 'tab', 'data-tab': id, type: 'button' }, label)
      b.addEventListener('click', () => {
        this.st.tab = id
        this.save()
        this.render()
      })
      this.tabBar.append(b)
    }

    this.body = el('div', { class: 'st-body' })
    this.root.append(grip, toolbar, this.tabBar, this.body)

    this.band = el('div', { class: 'st-band' })
    this.band.append(el('span', { class: 'st-band-tag st-band-from' }), el('span', { class: 'st-band-tag st-band-to' }))

    new ResizeObserver(() => this.drawEquity()).observe(this.body)
    this.applyOpen()
  }

  isOpen(): boolean {
    return this.st.open
  }

  toggle(): void {
    this.setOpen(!this.st.open)
  }

  /** Open on one strategy over everything loaded (used by the replay session summary). */
  showStrategy(id: string): void {
    this.st.strategyId = id
    this.st.preset = 'all'
    this.st.tab = 'overview'
    this.setOpen(true)
    this.refresh(true)
  }

  setOpen(on: boolean): void {
    this.st.open = on
    this.save()
    this.applyOpen()
  }

  private applyOpen(): void {
    this.root.style.display = this.st.open ? 'flex' : 'none'
    if (this.st.open) {
      this.refresh(true)
      if (this.timer === null) this.timer = window.setInterval(() => this.refresh(false), 400)
      if (!this.raf) this.raf = requestAnimationFrame(() => this.positionBand())
    } else {
      if (this.timer !== null) clearInterval(this.timer)
      this.timer = null
      cancelAnimationFrame(this.raf)
      this.raf = 0
      this.band.remove()
      this.bandPane = undefined
    }
    this.host.onOpenChange(this.st.open)
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.st))
    } catch {
      /* storage unavailable — settings just won't persist */
    }
  }

  private installResize(grip: HTMLElement): void {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      const y0 = e.clientY
      const h0 = this.root.getBoundingClientRect().height
      const move = (ev: PointerEvent): void => {
        const max = Math.max(MIN_H, window.innerHeight * 0.75)
        this.st.height = Math.round(Math.min(max, Math.max(MIN_H, h0 + (y0 - ev.clientY))))
        this.root.style.height = `${this.st.height}px`
        this.host.onOpenChange(true)
      }
      const up = (): void => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
        this.save()
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
    })
  }

  private setPreset(p: RangePreset): void {
    if (p === 'custom' && (this.st.customFrom === null || this.st.customTo === null)) {
      // Seed Custom with whatever is selected now.
      const r = this.range()
      const c = this.host.activePane()?.candles ?? []
      this.st.customFrom = r.from > FAR_PAST ? r.from : c.length ? c[0].time : Date.now() - DAY
      this.st.customTo = r.to < FAR_FUTURE ? r.to : Date.now()
    }
    this.st.preset = p
    this.save()
    this.refresh(true)
  }

  /** The selected [from, to] in epoch ms. */
  private range(): { from: number; to: number } {
    const now = Date.now()
    switch (this.st.preset) {
      case 'visible': {
        const pane = this.host.activePane()
        const conv = pane?.engine.getMainConverters()
        const rect = pane?.engine.getMainPaneRect()
        if (!conv || !rect) return { from: FAR_PAST, to: FAR_FUTURE }
        return { from: Math.floor(conv.xToTime(rect.x)), to: Math.ceil(conv.xToTime(rect.x + rect.width)) }
      }
      case 'today': {
        const d = new Date(now)
        d.setHours(0, 0, 0, 0)
        return { from: d.getTime(), to: FAR_FUTURE }
      }
      case '7d':
        return { from: now - 7 * DAY, to: FAR_FUTURE }
      case '30d':
        return { from: now - 30 * DAY, to: FAR_FUTURE }
      case 'all':
        return { from: FAR_PAST, to: FAR_FUTURE }
      case 'custom':
        return { from: this.st.customFrom ?? FAR_PAST, to: this.st.customTo ?? FAR_FUTURE }
    }
  }

  // ---- data refresh ----

  private refresh(force: boolean): void {
    if (!this.st.open) return
    const pane = this.host.activePane()
    this.pane = pane
    const sources = pane?.getStrategySources() ?? []
    this.syncStrategySelect(sources)
    const src = sources.find((s) => s.id === this.st.strategyId) ?? sources[0] ?? null
    this.source = src
    const r = this.range()
    // The visible range drifts with every pan; quantise so tiny moves don't rebuild the tables.
    const q = this.st.preset === 'visible' ? 60_000 : 1
    const c = pane?.candles ?? []
    const last = c[c.length - 1]
    const key = [
      src?.id ?? '-',
      src?.getRevision() ?? 0,
      Math.round(r.from / q),
      Math.round(r.to / q),
      c.length,
      c[0]?.time ?? 0,
      last?.time ?? 0,
      last?.close ?? 0,
      JSON.stringify(this.st.props),
      pane?.state.symbol ?? '',
      this.loadingHistory,
      this.st.tab,
    ].join('|')
    if (!force && key === this.lastKey) return
    // Don't rebuild a form the user is typing into.
    if (!force && this.st.tab === 'properties' && this.body.contains(document.activeElement)) return
    this.lastKey = key
    this.report = src && pane ? computeReport({ trades: src.getStrategyTrades(), candles: c, from: r.from, to: r.to, props: this.st.props }) : null
    this.render()
  }

  private syncStrategySelect(sources: StrategySource[]): void {
    const sig = sources.map((s) => s.id).join(',')
    if (this.stratSel.dataset.sig !== sig) {
      this.stratSel.dataset.sig = sig
      this.stratSel.innerHTML = ''
      for (const s of sources) this.stratSel.append(el('option', { value: s.id }, esc(s.name)))
      if (!sources.length) this.stratSel.append(el('option', { value: '' }, 'No strategy on'))
    }
    const want = sources.find((s) => s.id === this.st.strategyId)?.id ?? sources[0]?.id ?? ''
    if (this.stratSel.value !== want) this.stratSel.value = want
    this.stratSel.disabled = sources.length === 0
  }

  // ---- rendering ----

  private render(): void {
    for (const b of Array.from(this.presetBox.children) as HTMLElement[]) b.classList.toggle('on', b.dataset.preset === this.st.preset)
    for (const b of Array.from(this.tabBar.children) as HTMLElement[]) {
      const on = b.dataset.tab === this.st.tab
      b.classList.toggle('on', on)
      b.setAttribute('aria-selected', String(on))
    }
    const r = this.range()
    this.customBox.style.display = this.st.preset === 'custom' ? 'flex' : 'none'
    if (this.st.preset === 'custom') {
      if (this.st.customFrom !== null && document.activeElement !== this.fromInput) this.fromInput.value = toLocalInput(this.st.customFrom)
      if (this.st.customTo !== null && document.activeElement !== this.toInput) this.toInput.value = toLocalInput(this.st.customTo)
    }
    const c = this.pane?.candles ?? []
    const shownFrom = r.from > FAR_PAST ? r.from : c[0]?.time
    const shownTo = r.to < FAR_FUTURE ? r.to : c[c.length - 1]?.time
    this.rangeText.textContent =
      this.st.preset !== 'custom' && shownFrom !== undefined && shownTo !== undefined ? `${fmtTime(shownFrom)} → ${r.to < FAR_FUTURE ? fmtTime(shownTo) : 'now'}` : ''
    const needsOlder = c.length > 0 && r.from > FAR_PAST && r.from < c[0].time && !!this.pane?.canLoadOlderHistory()
    this.moreBtn.style.display = needsOlder || this.loadingHistory ? '' : 'none'
    this.moreBtn.disabled = this.loadingHistory
    this.moreBtn.textContent = this.loadingHistory ? 'Loading…' : 'Load more history'

    this.eqCanvas = null
    if (this.st.tab === 'properties') {
      this.renderProperties()
      return
    }
    if (!this.source || !this.report) {
      this.body.innerHTML =
        '<div class="st-empty">No strategy is on for this chart. Turn one on from <b>Power Tools</b> (FVG + Supertrend Strategy, IV Walls × Big Trades Fade) and its results appear here.</div>'
      return
    }
    if (this.st.tab === 'overview') this.renderOverview(this.report)
    else if (this.st.tab === 'performance') this.renderPerformance(this.report)
    else this.renderTrades(this.report)
  }

  private renderOverview(rep: StrategyReport): void {
    const a = rep.all
    const hasR = a.netR !== null
    const kpi = (label: string, value: string, cls: string, sub: string, subCls = 'st-muted'): string =>
      `<div class="st-kpi"><span class="st-muted">${label}</span><span class="st-kpi-v ${cls}">${value}</span><span class="st-kpi-s ${subCls}">${sub}</span></div>`
    this.body.innerHTML =
      `<div class="st-kpis">` +
      kpi('Net profit', num(a.netProfit, true), tone(a.netProfit), `${pct(a.netPct)}${hasR ? ` · ${rr(a.netR)}` : ''}`, tone(a.netProfit)) +
      kpi('Closed trades', count(a.closed), '', `${rep.long.closed} long · ${rep.short.closed} short${a.open ? ` · ${a.open} open` : ''}`) +
      kpi('Win rate', pct(a.winRate, false), '', `${a.wins} / ${a.closed}`) +
      kpi('Profit factor', ratio(a.profitFactor), '', `gross ${num(a.grossProfit, true)} / ${num(a.grossLoss, true)}`) +
      kpi('Max drawdown', num(rep.maxDrawdown, true), tone(rep.maxDrawdown), pct(rep.maxDrawdownPct), tone(rep.maxDrawdown)) +
      kpi('Avg trade', num(a.avgTrade, true), tone(a.avgTrade), hasR ? rr(a.avgR) : pct(a.avgTradePct), tone(a.avgTrade)) +
      kpi('Avg bars in trade', count(a.avgBars), '', `win ${count(a.avgBarsWin)} · loss ${count(a.avgBarsLoss)}`) +
      `</div>` +
      `<div class="st-eq-head"><span><i class="st-key st-key-eq"></i>Equity</span><span><i class="st-key st-key-dd"></i>Drawdown</span>` +
      `<span><i class="st-key st-key-bh"></i>Buy &amp; hold ${pct(rep.buyHoldPct ?? NaN)}</span><span class="st-grow"></span>` +
      `<span class="st-muted">Drag across the curve to select a range</span></div>`
    const wrap = el('div', { class: 'st-eq-wrap' })
    this.eqCanvas = el('canvas', { class: 'st-eq', role: 'img', 'aria-label': 'Equity curve with drawdown and buy & hold' })
    wrap.append(this.eqCanvas)
    this.body.append(wrap)
    this.installEquityBrush(this.eqCanvas)
    this.drawEquity()
  }

  private renderPerformance(rep: StrategyReport): void {
    const cols: SideStats[] = [rep.all, rep.long, rep.short]
    const row = (label: string, f: (s: SideStats) => string, t?: (s: SideStats) => number | null, onlyAll = false): string =>
      `<tr><td>${label}</td>${cols.map((s, i) => (onlyAll && i > 0 ? '<td></td>' : `<td class="${t ? tone(t(s)) : ''}">${f(s)}</td>`)).join('')}</tr>`
    const sec = (label: string): string => `<tr class="st-sec"><td colspan="4">${label}</td></tr>`
    const anyR = rep.all.netR !== null
    this.body.innerHTML =
      `<div class="st-scroll"><table class="st-table st-perf"><thead><tr><th>Metric</th><th>All</th><th>Long</th><th>Short</th></tr></thead><tbody>` +
      sec('Returns') +
      row('Net profit', (s) => `${num(s.netProfit, true)} <span class="st-muted">${pct(s.netPct)}</span>`, (s) => s.netProfit) +
      row('Gross profit', (s) => num(s.grossProfit, true), (s) => s.grossProfit) +
      row('Gross loss', (s) => num(s.grossLoss, true), (s) => s.grossLoss) +
      (anyR ? row('Net R', (s) => rr(s.netR), (s) => s.netR) : '') +
      row('Commission paid', (s) => num(s.commission)) +
      row('Open P&amp;L', (s) => (s.open ? num(s.openPnl, true) : '—'), (s) => (s.open ? s.openPnl : null)) +
      row('Buy &amp; hold return', () => pct(rep.buyHoldPct ?? NaN), () => rep.buyHoldPct, true) +
      sec('Risk') +
      row('Max drawdown', () => `${num(rep.maxDrawdown, true)} <span class="st-muted">${pct(rep.maxDrawdownPct)}</span>`, () => rep.maxDrawdown, true) +
      row('Max run-up', () => `${num(rep.maxRunUp, true)} <span class="st-muted">${pct(rep.maxRunUpPct)}</span>`, () => rep.maxRunUp, true) +
      row('Sharpe ratio (per trade)', () => ratio(rep.sharpe), undefined, true) +
      row('Sortino ratio (per trade)', () => ratio(rep.sortino), undefined, true) +
      row('Profit factor', (s) => ratio(s.profitFactor)) +
      sec('Trades') +
      row('Total closed trades', (s) => count(s.closed)) +
      row('Open trades', (s) => count(s.open)) +
      row('Winning / losing', (s) => `${s.wins} / ${s.losses}`) +
      row('Percent profitable', (s) => pct(s.winRate, false)) +
      row('Avg trade', (s) => `${num(s.avgTrade, true)} <span class="st-muted">${pct(s.avgTradePct)}</span>`, (s) => s.avgTrade) +
      (anyR ? row('Avg R', (s) => rr(s.avgR), (s) => s.avgR) : '') +
      row('Avg winning trade', (s) => num(s.avgWin, true), (s) => s.avgWin) +
      row('Avg losing trade', (s) => num(s.avgLoss, true), (s) => s.avgLoss) +
      row('Ratio avg win / avg loss', (s) => ratio(s.winLossRatio)) +
      row('Largest winning trade', (s) => num(s.largestWin, true), (s) => s.largestWin) +
      row('Largest losing trade', (s) => num(s.largestLoss, true), (s) => s.largestLoss) +
      row('Max consecutive wins / losses', (s) => `${s.maxConsecWins} / ${s.maxConsecLosses}`) +
      row('Avg bars in trade', (s) => count(s.avgBars)) +
      row('Avg bars in winning / losing', (s) => `${count(s.avgBarsWin)} / ${count(s.avgBarsLoss)}`) +
      `</tbody></table></div>`
  }

  private renderTrades(rep: StrategyReport): void {
    const rows = [...rep.rows]
    const key = (r: TradeRow): number | string => {
      switch (this.sortKey) {
        case 'n':
          return r.n
        case 'side':
          return r.trade.side
        case 'entry':
          return r.trade.entryTime
        case 'exit':
          return r.trade.exitTime ?? Infinity
        case 'pnl':
          return r.pnl
        case 'r':
          return r.r ?? -Infinity
        case 'bars':
          return r.bars
      }
    }
    rows.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * this.sortDir
    })
    const anyR = rows.some((r) => r.r !== null)
    const th = (k: SortKey | null, label: string, left = false): string => {
      const arrow = k && k === this.sortKey ? (this.sortDir === 1 ? ' ▲' : ' ▼') : ''
      const cls = left ? 'st-l' : ''
      return k ? `<th class="${cls}"><button type="button" class="st-sort" data-sort="${k}">${label}${arrow}</button></th>` : `<th class="${cls}">${label}</th>`
    }
    let html =
      `<div class="st-scroll"><table class="st-table st-trades"><thead><tr>` +
      th('n', '#', true) + th('side', 'Side', true) + th('entry', 'Entry time', true) + th(null, 'Entry') + th('exit', 'Exit time', true) + th(null, 'Exit') +
      th(null, 'Reason', true) + th('pnl', 'Net P&amp;L') + th(null, '%') + (anyR ? th('r', 'R') : '') + th(null, 'Cum. P&amp;L') + th(null, 'Run-up / DD') + th('bars', 'Bars') +
      `</tr></thead><tbody>`
    for (const r of rows) {
      const t = r.trade
      html +=
        `<tr class="st-row" data-time="${t.entryTime}" tabindex="0">` +
        `<td class="st-l st-muted">${r.n}</td>` +
        `<td class="st-l st-b ${t.side === 'long' ? 'st-pos' : 'st-neg'}">${t.side === 'long' ? 'LONG' : 'SHORT'}</td>` +
        `<td class="st-l">${fmtTime(t.entryTime)}</td><td>${num(t.entryPrice)}</td>` +
        `<td class="st-l">${t.exitTime === null ? '<span class="st-open">Open</span>' : fmtTime(t.exitTime)}</td>` +
        `<td>${r.open ? `<span class="st-muted">${num(r.exitFill)}</span>` : num(t.exitPrice ?? NaN)}</td>` +
        `<td class="st-l st-muted">${esc(t.exitReason ?? (r.open ? 'Mark' : ''))}</td>` +
        `<td class="${tone(r.pnl)}">${num(r.pnl, true)}</td><td class="${tone(r.pnl)}">${pct(r.pnlPct)}</td>` +
        (anyR ? `<td class="${tone(r.r)}">${rr(r.r)}</td>` : '') +
        `<td>${r.cumPnl === null ? '—' : num(r.cumPnl, true)}</td>` +
        `<td class="st-muted">${num(r.runUp, true)} / ${num(-r.drawdown, true)}</td>` +
        `<td class="st-muted">${r.bars}</td></tr>`
    }
    if (!rows.length) html += `<tr><td colspan="13" class="st-empty-row">No trades entered in this range.</td></tr>`
    html += `</tbody></table></div>`
    this.body.innerHTML = html
    for (const b of Array.from(this.body.querySelectorAll<HTMLButtonElement>('.st-sort'))) {
      b.addEventListener('click', () => {
        const k = b.dataset.sort as SortKey
        if (k === this.sortKey) this.sortDir = this.sortDir === 1 ? -1 : 1
        else {
          this.sortKey = k
          this.sortDir = k === 'pnl' || k === 'r' ? -1 : 1
        }
        this.render()
      })
    }
    const jump = (tr: HTMLElement): void => {
      for (const x of Array.from(this.body.querySelectorAll('.st-row.sel'))) x.classList.remove('sel')
      tr.classList.add('sel')
      this.pane?.engine.scrollToTime(Number(tr.dataset.time))
    }
    for (const tr of Array.from(this.body.querySelectorAll<HTMLElement>('.st-row'))) {
      tr.addEventListener('click', () => jump(tr))
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') jump(tr)
      })
    }
  }

  private renderProperties(): void {
    this.body.innerHTML = ''
    const form = el('div', { class: 'st-props' })
    form.append(
      el(
        'p',
        { class: 'st-muted st-note' },
        'Applied to every strategy so results compare. P&amp;L is in the quote currency (price × quantity). Commission is charged on entry and exit; slippage moves both fills against the trade. A strategy that sizes its own trades keeps its quantity.',
      ),
    )
    const field = (label: string, key: keyof StrategyProperties, step: number): void => {
      const id = `st-prop-${key}`
      const wrap = el('div', { class: 'st-prop' })
      const lab = el('label', { for: id }, label)
      const input = el('input', { id, type: 'number', step: String(step), min: '0', class: 'st-input' })
      input.value = String(this.st.props[key])
      input.addEventListener('change', () => {
        const v = Number(input.value)
        if (input.value === '' || !isFinite(v) || v < 0) {
          input.value = String(this.st.props[key])
          return
        }
        this.st.props = { ...this.st.props, [key]: v }
        this.save()
        this.refresh(true)
      })
      wrap.append(lab, input)
      form.append(wrap)
    }
    field('Initial capital', 'initialCapital', 100)
    field('Order size (quantity)', 'qty', 0.01)
    field('Commission (% of value)', 'commissionPct', 0.01)
    field('Slippage (price units)', 'slippage', 0.01)
    const reset = el('button', { class: 'st-btn', type: 'button' }, 'Reset to defaults')
    reset.addEventListener('click', () => {
      this.st.props = { ...DEFAULT_STRATEGY_PROPERTIES }
      this.save()
      this.refresh(true)
    })
    form.append(reset)
    this.body.append(form)
  }

  // ---- equity chart ----

  private eqScale(): { t0: number; t1: number; x: (t: number) => number; t: (x: number) => number; pad: number } | null {
    const rep = this.report
    const cv = this.eqCanvas
    if (!rep || !cv) return null
    const times = [...rep.equity.map((p) => p.time), ...rep.buyHold.map((p) => p.time)]
    if (!times.length) return null
    const t0 = Math.min(...times)
    const t1 = Math.max(t0 + 1, ...times)
    const w = cv.clientWidth
    const pad = 8
    return {
      t0,
      t1,
      pad,
      x: (t) => pad + ((t - t0) / (t1 - t0)) * (w - 2 * pad),
      t: (x) => t0 + ((x - pad) / Math.max(1, w - 2 * pad)) * (t1 - t0),
    }
  }

  private drawEquity(): void {
    const cv = this.eqCanvas
    const rep = this.report
    if (!cv || !rep || !cv.isConnected) return
    const dpr = window.devicePixelRatio || 1
    const w = cv.clientWidth
    const h = cv.clientHeight
    if (w < 10 || h < 10) return
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const css = getComputedStyle(document.documentElement)
    const color = (v: string, f: string): string => css.getPropertyValue(v).trim() || f
    const accent = color('--accent', '#2962ff')
    const down = color('--down', '#f23645')
    const muted = color('--muted', '#787b86')
    const border = color('--border', '#2a2e39')
    const sc = this.eqScale()
    if (!sc) return

    const ddH = Math.round(h * 0.28)
    const eqTop = 6
    const eqBot = h - ddH - 8
    const vals = [...rep.equity.map((p) => p.equity), ...rep.buyHold.map((p) => p.equity)]
    let vMin = Math.min(...vals)
    let vMax = Math.max(...vals)
    if (vMax - vMin < 1e-9) {
      vMin -= 1
      vMax += 1
    }
    const y = (v: number): number => eqBot - ((v - vMin) / (vMax - vMin)) * (eqBot - eqTop)

    // Baseline at initial capital.
    ctx.strokeStyle = border
    ctx.lineWidth = 1
    ctx.beginPath()
    const yb = Math.round(y(rep.initialCapital)) + 0.5
    ctx.moveTo(0, yb)
    ctx.lineTo(w, yb)
    ctx.stroke()

    // Drawdown bars (one per closed trade) along the bottom.
    const maxDd = Math.min(-1e-9, ...rep.equity.map((p) => p.drawdown))
    ctx.fillStyle = down
    ctx.globalAlpha = 0.45
    const barW = Math.max(2, Math.min(10, (w - 2 * sc.pad) / Math.max(1, rep.equity.length) - 1))
    for (const p of rep.equity) {
      if (p.drawdown >= 0) continue
      const bh = (p.drawdown / maxDd) * (ddH - 4)
      ctx.fillRect(sc.x(p.time) - barW / 2, h - bh, barW, bh)
    }
    ctx.globalAlpha = 1

    // Buy & hold (dashed).
    if (rep.buyHold.length > 1) {
      ctx.strokeStyle = muted
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1.2
      ctx.beginPath()
      rep.buyHold.forEach((p, i) => (i ? ctx.lineTo(sc.x(p.time), y(p.equity)) : ctx.moveTo(sc.x(p.time), y(p.equity))))
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Equity as steps — it only changes when a trade closes.
    ctx.strokeStyle = accent
    ctx.lineWidth = 2
    ctx.beginPath()
    rep.equity.forEach((p, i) => {
      const px = sc.x(p.time)
      if (i === 0) ctx.moveTo(px, y(p.equity))
      else {
        ctx.lineTo(px, y(rep.equity[i - 1].equity))
        ctx.lineTo(px, y(p.equity))
      }
    })
    ctx.lineTo(sc.x(sc.t1), y(rep.equity[rep.equity.length - 1].equity))
    ctx.stroke()

    // Scale labels on the right edge.
    ctx.fillStyle = muted
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText(num(vMax), w - 4, eqTop)
    ctx.textBaseline = 'bottom'
    ctx.fillText(num(vMin), w - 4, eqBot)

    if (this.eqDrag) {
      const a = Math.min(this.eqDrag.x0, this.eqDrag.x1)
      const b = Math.max(this.eqDrag.x0, this.eqDrag.x1)
      ctx.fillStyle = accent
      ctx.globalAlpha = 0.15
      ctx.fillRect(a, 0, b - a, h)
      ctx.globalAlpha = 1
    }
  }

  private installEquityBrush(cv: HTMLCanvasElement): void {
    const xOf = (e: PointerEvent): number => e.clientX - cv.getBoundingClientRect().left
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId)
      this.eqDrag = { x0: xOf(e), x1: xOf(e) }
    })
    cv.addEventListener('pointermove', (e) => {
      if (!this.eqDrag) return
      this.eqDrag.x1 = xOf(e)
      this.drawEquity()
    })
    cv.addEventListener('pointerup', () => {
      const d = this.eqDrag
      this.eqDrag = null
      const sc = this.eqScale()
      if (!d || !sc || Math.abs(d.x1 - d.x0) < 6) {
        this.drawEquity()
        return
      }
      this.st.customFrom = Math.floor(sc.t(Math.min(d.x0, d.x1)))
      this.st.customTo = Math.ceil(sc.t(Math.max(d.x0, d.x1)))
      this.st.preset = 'custom'
      this.save()
      this.refresh(true)
    })
  }

  // ---- chart range band ----

  private positionBand(): void {
    this.raf = 0
    if (!this.st.open) return
    this.raf = requestAnimationFrame(() => this.positionBand())
    const pane = this.host.activePane()
    if (!pane || !this.source || this.st.preset === 'visible' || this.st.preset === 'all') {
      this.band.style.display = 'none'
      return
    }
    if (this.bandPane !== pane) {
      pane.attachChartOverlay(this.band)
      this.bandPane = pane
    }
    const conv = pane.engine.getMainConverters()
    const rect = pane.engine.getMainPaneRect()
    if (!conv || !rect) {
      this.band.style.display = 'none'
      return
    }
    const r = this.range()
    const left = rect.x
    const right = rect.x + rect.width
    const xa = r.from > FAR_PAST ? conv.timeToX(r.from) : -Infinity
    const xb = r.to < FAR_FUTURE ? conv.timeToX(r.to) : Infinity
    const x1 = Math.max(left, xa)
    const x2 = Math.min(right, xb)
    if (x2 <= x1) {
      this.band.style.display = 'none'
      return
    }
    Object.assign(this.band.style, {
      display: 'block',
      left: `${x1}px`,
      width: `${x2 - x1}px`,
      top: `${rect.y}px`,
      height: `${rect.height}px`,
      borderLeftWidth: xa >= left ? '2px' : '0',
      borderRightWidth: xb <= right ? '2px' : '0',
    })
    const [fromTag, toTag] = Array.from(this.band.children) as HTMLElement[]
    fromTag.style.display = xa >= left ? '' : 'none'
    toTag.style.display = xb <= right ? '' : 'none'
    const ft = fmtTime(r.from)
    const tt = fmtTime(r.to)
    if (fromTag.textContent !== ft) fromTag.textContent = ft
    if (toTag.textContent !== tt) toTag.textContent = tt
  }

  // ---- actions ----

  private async loadHistoryForRange(): Promise<void> {
    const pane = this.pane
    if (!pane || this.loadingHistory) return
    const from = this.range().from
    this.loadingHistory = true
    this.render()
    try {
      // Each call pages one batch of older candles; stop once the range is covered or the feed runs dry.
      // A no-op page usually means a pan-triggered load was already in flight: wait and retry a few times.
      let stalls = 0
      for (let i = 0; i < 60 && stalls < 5; i++) {
        const first = pane.candles[0]?.time
        if (first === undefined || first <= from || !pane.canLoadOlderHistory()) break
        await pane.requestOlderHistory()
        if (pane.candles[0]?.time === first) {
          stalls++
          await new Promise((r) => setTimeout(r, 400))
        } else stalls = 0
      }
    } finally {
      this.loadingHistory = false
      this.refresh(true)
    }
  }

  private exportCsv(): void {
    const rep = this.report
    const src = this.source
    if (!rep || !src) return
    const symbol = this.pane?.state.symbol ?? ''
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([tradesCsv(rep, src.name, symbol)], { type: 'text/csv' }))
    a.download = `${src.id}-${symbol}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
}
