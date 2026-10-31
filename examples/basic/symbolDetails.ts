// Symbol details card (Vela-style), docked under the watchlist: logo + name,
// big last price and 24h change, the latest daily candle as a low → high
// range bar (open and current marked), and a market-sessions timeline with
// which session is open and when the next one starts. Times on the timeline
// follow the chart's display time zone.
import type { Candle, Interval } from '../../src/index'
import type { TickerUpdate } from '../../src/data/types'
import { displayZoneOffset, getDisplayTimeZone } from '../../src/chart/scales'
import { el } from './ui'
import { symbolLogo, symbolMeta } from './symbolMeta'
import { formatCompactPrice, formatSignedPercent } from './watchlist'

export interface SymbolDetailsProvider {
  fetchCandles(symbol: string, interval: Interval, limit?: number): Promise<Candle[]>
  subscribeTickers(symbols: string[], onTick: (update: TickerUpdate) => void): () => void
}

/** Delta India public REST (24h stats, funding, open interest). */
const DELTA_REST = 'https://api.india.delta.exchange'

interface TickerStats {
  high: number
  low: number
  funding: number | null
  oiUsd: number | null
  turnoverUsd: number | null
}

const DAY_MS = 86_400_000
const MIN_MS = 60_000
const COLLAPSED_KEY = 'candl.detailsCollapsed'

/** Major FX sessions in each city's local time, so daylight saving moves them automatically. */
const SESSIONS = [
  { name: 'Sydney', tz: 'Australia/Sydney', open: 8 * 60, close: 17 * 60, color: '#00bcd4' },
  { name: 'Tokyo', tz: 'Asia/Tokyo', open: 9 * 60, close: 18 * 60, color: '#e91e63' },
  { name: 'London', tz: 'Europe/London', open: 8 * 60, close: 17 * 60, color: '#2962ff' },
  { name: 'New York', tz: 'America/New_York', open: 8 * 60, close: 17 * 60, color: '#ff9800' },
]

/** Offset (ms) of an IANA zone from UTC at instant `t`. */
function tzOffset(tz: string, t: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(t))
  const get = (k: string): number => Number(parts.find((p) => p.type === k)?.value ?? 0)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - Math.floor(t / MIN_MS) * MIN_MS
}

/** UTC instants of a session's open/close windows around `now` (yesterday, today, tomorrow local). */
function sessionWindows(s: (typeof SESSIONS)[number], now: number): { start: number; end: number }[] {
  const localMidnight = Math.floor((now + tzOffset(s.tz, now)) / DAY_MS) * DAY_MS
  // Wall-clock ms (as if UTC) → the real UTC instant in that zone.
  const toUtc = (wall: number): number => wall - tzOffset(s.tz, wall - tzOffset(s.tz, wall))
  const out: { start: number; end: number }[] = []
  for (const d of [-1, 0, 1]) {
    const day = localMidnight + d * DAY_MS
    const start = toUtc(day + s.open * MIN_MS)
    let end = toUtc(day + s.close * MIN_MS)
    if (end <= start) end += DAY_MS
    out.push({ start, end })
  }
  return out
}

function fmtDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / MIN_MS))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

function fmtClock(t: number): string {
  const d = new Date(t + displayZoneOffset(t))
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** Short name of the display zone, e.g. "UTC", "GMT+5:30", "EDT". */
export function displayZoneLabel(): string {
  const zone = getDisplayTimeZone()
  if (zone === 'UTC') return 'UTC'
  if (zone === 'Asia/Kolkata') return 'IST' // Intl only offers "GMT+5:30"
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? zone
  } catch {
    return zone
  }
}

function fmtVolume(v: number): string {
  if (!isFinite(v)) return '—'
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toFixed(0)
}

export class SymbolDetails {
  readonly root: HTMLElement
  private readonly provider: SymbolDetailsProvider
  private symbol = ''
  private daily: Candle | null = null
  private last: TickerUpdate | null = null
  private unsub: (() => void) | null = null
  private timer: number | null = null
  private loadGen = 0
  private visible = false

  private readonly logoEl: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly subEl: HTMLElement
  private readonly priceEl: HTMLElement
  private readonly chgEl: HTMLElement
  private readonly rangeEl: HTMLElement
  private readonly statsEl: HTMLElement
  private stats: TickerStats | null = null
  private readonly sessionsEl: HTMLElement
  private readonly minBtn: HTMLButtonElement

  constructor(provider: SymbolDetailsProvider) {
    this.provider = provider
    this.root = el('section', { class: 'sd', 'aria-label': 'Symbol details' })

    const head = el('div', { class: 'sd-head' })
    this.logoEl = el('span', { class: 'sd-logo' })
    const titles = el('div', { class: 'sd-titles' })
    this.nameEl = el('div', { class: 'sd-name' })
    this.subEl = el('div', { class: 'sd-sub' })
    titles.append(this.nameEl, this.subEl)
    this.minBtn = el('button', { class: 'mi-icon sd-min', title: 'Minimize details', 'aria-label': 'Minimize symbol details', 'aria-expanded': 'true' }, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 12h12"/></svg>') as HTMLButtonElement
    this.minBtn.addEventListener('click', () => this.setCollapsed(!this.root.classList.contains('collapsed')))
    head.append(this.logoEl, titles, this.minBtn)

    const quote = el('div', { class: 'sd-quote' })
    this.priceEl = el('span', { class: 'sd-price' }, '—')
    this.chgEl = el('span', { class: 'sd-chg' })
    quote.append(this.priceEl, this.chgEl)

    this.rangeEl = el('div', { class: 'sd-card' })
    this.sessionsEl = el('div', { class: 'sd-card' })
    this.statsEl = el('div', { class: 'sd-stats4' })
    const body = el('div', { class: 'sd-body' })
    body.append(this.statsEl, this.rangeEl, this.sessionsEl)
    this.root.append(head, quote, body)

    let collapsed = false
    try {
      collapsed = localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      /* storage unavailable */
    }
    this.setCollapsed(collapsed, false)
  }

  /**
   * Start / stop the daily-candle refresh with the panel's visibility. The
   * ticker stays subscribed (one shared stream), so reopening shows the last
   * price at once instead of "—" until the next tick.
   */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    if (visible) {
      void this.loadDaily()
      this.renderSessions()
      this.timer = window.setInterval(() => {
        this.renderSessions()
        void this.loadDaily()
      }, 30_000)
    } else if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  setSymbol(symbol: string): void {
    const sym = symbol.toUpperCase()
    if (sym === this.symbol) return
    this.symbol = sym
    this.daily = null
    this.last = null
    this.stats = null
    this.renderStats()
    const meta = symbolMeta(sym)
    this.logoEl.innerHTML = symbolLogo(sym, 'sd-logo-big')
    this.nameEl.textContent = meta.name
    this.subEl.textContent = `${meta.symbol} · ${meta.group} · Delta India`
    this.priceEl.textContent = '—'
    this.chgEl.textContent = ''
    this.renderRange()
    this.subscribe()
    if (this.visible) void this.loadDaily()
  }

  /** The display time zone changed — redraw the timeline labels. */
  refreshTimes(): void {
    this.renderSessions()
  }

  destroy(): void {
    this.setVisible(false)
    this.unsub?.()
    this.unsub = null
  }

  private setCollapsed(collapsed: boolean, persist = true): void {
    this.root.classList.toggle('collapsed', collapsed)
    this.minBtn.setAttribute('aria-expanded', String(!collapsed))
    this.minBtn.title = collapsed ? 'Expand details' : 'Minimize details'
    if (persist) {
      try {
        localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
      } catch {
        /* storage unavailable */
      }
    }
  }

  private subscribe(): void {
    this.unsub?.()
    this.unsub = null
    if (!this.symbol) return
    try {
      this.unsub = this.provider.subscribeTickers([this.symbol], (u) => {
        if (u.symbol !== this.symbol) return
        this.last = u
        this.renderQuote()
        this.renderRange()
      })
    } catch {
      this.unsub = null
    }
  }

  private async loadDaily(): Promise<void> {
    const sym = this.symbol
    if (!sym) return
    const gen = ++this.loadGen
    try {
      const [bars, stats] = await Promise.all([this.provider.fetchCandles(sym, '1d', 2), this.fetchStats(sym)])
      if (gen !== this.loadGen || sym !== this.symbol) return
      this.daily = bars.length ? bars[bars.length - 1] : null
      this.stats = stats
      this.renderRange()
      this.renderStats()
    } catch {
      /* offline — keep whatever we had */
    }
  }

  /** 24h high / low, funding and open interest from Delta's public ticker (null when unavailable). */
  private async fetchStats(sym: string): Promise<TickerStats | null> {
    try {
      const res = await fetch(`${DELTA_REST}/v2/tickers/${encodeURIComponent(sym)}`)
      if (!res.ok) return null
      const r = (await res.json())?.result
      if (!r) return null
      const num = (v: unknown): number | null => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v))
      return {
        high: Number(r.high),
        low: Number(r.low),
        funding: r.contract_type === 'perpetual_futures' ? num(r.funding_rate) : null,
        oiUsd: num(r.oi_value_usd),
        turnoverUsd: num(r.turnover_usd),
      }
    } catch {
      return null
    }
  }

  private renderStats(): void {
    const st = this.stats
    const usd = (v: number | null): string => (v == null ? '—' : `$${fmtVolume(v)}`)
    const tile = (k: string, v: string, cls = ''): HTMLElement => {
      const t = el('div', { class: 'sd-tile' })
      const val = el('b', cls ? { class: cls } : {})
      val.textContent = v
      t.append(el('span', {}, k), val)
      return t
    }
    if (!st) {
      this.statsEl.replaceChildren(tile('24h high', '—'), tile('24h low', '—'), tile('Funding', '—'), tile('Open interest', '—'))
      return
    }
    const f = st.funding
    this.statsEl.replaceChildren(
      tile('24h high', formatCompactPrice(st.high)),
      tile('24h low', formatCompactPrice(st.low)),
      f == null ? tile('24h turnover', usd(st.turnoverUsd)) : tile('Funding', `${f >= 0 ? '+' : ''}${f.toFixed(4)}%`, f > 0 ? 'up' : f < 0 ? 'down' : ''),
      tile('Open interest', usd(st.oiUsd)),
    )
  }

  private renderQuote(): void {
    const u = this.last
    if (!u) return
    this.priceEl.textContent = formatCompactPrice(u.price)
    const abs = u.price - u.price / (1 + u.changePct / 100)
    this.chgEl.textContent = `${abs >= 0 ? '+' : '−'}${formatCompactPrice(Math.abs(abs))} (${formatSignedPercent(u.changePct)})`
    this.chgEl.className = `sd-chg ${u.changePct > 0 ? 'up' : u.changePct < 0 ? 'down' : ''}`
  }

  private renderRange(): void {
    const d = this.daily
    const cur = this.last?.price ?? d?.close
    this.rangeEl.replaceChildren(el('div', { class: 'sd-card-head' }, 'Session range<span>Latest daily candle</span>'))
    if (!d || cur == null) {
      this.rangeEl.append(el('div', { class: 'sd-empty' }, 'Loading daily candle…'))
      return
    }
    const lo = Math.min(d.low, cur)
    const hi = Math.max(d.high, cur)
    const span = hi - lo || 1
    const pos = (v: number): string => `${(((v - lo) / span) * 100).toFixed(2)}%`
    const dayChg = d.open ? ((cur - d.open) / d.open) * 100 : 0
    const bar = el('div', { class: 'sd-range', role: 'img', 'aria-label': `Low ${formatCompactPrice(lo)}, high ${formatCompactPrice(hi)}, open ${formatCompactPrice(d.open)}, current ${formatCompactPrice(cur)}` })
    const fill = el('span', { class: `sd-range-fill ${cur >= d.open ? 'up' : 'down'}` })
    const a = Math.min(d.open, cur)
    const b = Math.max(d.open, cur)
    fill.style.left = pos(a)
    fill.style.width = `${(((b - a) / span) * 100).toFixed(2)}%`
    const openMark = el('span', { class: 'sd-range-open', title: 'Open' })
    openMark.style.left = pos(d.open)
    const curMark = el('span', { class: 'sd-range-cur', title: 'Current' })
    curMark.style.left = pos(cur)
    bar.append(fill, openMark, curMark)
    const ends = el('div', { class: 'sd-range-ends' })
    ends.append(el('span', {}, `Low <b>${formatCompactPrice(lo)}</b>`), el('span', {}, `High <b>${formatCompactPrice(hi)}</b>`))
    const stats = el('div', { class: 'sd-stats' })
    const stat = (k: string, v: string, cls = ''): HTMLElement => {
      const s = el('div', {})
      s.append(el('span', {}, k), el('b', cls ? { class: cls } : {}, v))
      return s
    }
    stats.append(
      stat('Range', formatCompactPrice(hi - lo)),
      stat('Open', formatCompactPrice(d.open)),
      stat('Day change', formatSignedPercent(dayChg), dayChg > 0 ? 'up' : dayChg < 0 ? 'down' : ''),
      stat('Volume', fmtVolume(d.volume)),
    )
    this.rangeEl.append(bar, ends, stats)
  }

  private renderSessions(): void {
    const now = Date.now()
    const off = displayZoneOffset(now)
    const dayStart = Math.floor((now + off) / DAY_MS) * DAY_MS - off
    const pct = (t: number): number => ((t - dayStart) / DAY_MS) * 100

    let next: { name: string; at: number } | null = null
    const active: string[] = []
    const rows = el('div', { class: 'sd-tl' })
    for (const s of SESSIONS) {
      const wins = sessionWindows(s, now)
      const isOpen = wins.some((w) => now >= w.start && now < w.end)
      if (isOpen) active.push(s.name)
      for (const w of wins) if (w.start > now && (!next || w.start < next.at)) next = { name: s.name, at: w.start }
      const row = el('div', { class: `sd-tl-row${isOpen ? ' open' : ''}` })
      const track = el('div', { class: 'sd-tl-track' })
      for (const w of wins) {
        const a = Math.max(0, pct(w.start))
        const b = Math.min(100, pct(w.end))
        if (b <= a) continue
        const seg = el('span', { class: 'sd-tl-seg', title: `${s.name} ${fmtClock(w.start)}–${fmtClock(w.end)}` })
        seg.style.left = `${a}%`
        seg.style.width = `${b - a}%`
        seg.style.background = s.color
        track.append(seg)
      }
      const nowLine = el('span', { class: 'sd-tl-now' })
      nowLine.style.left = `${pct(now)}%`
      track.append(nowLine)
      row.append(el('span', { class: 'sd-tl-name' }, s.name), track)
      rows.append(row)
    }
    const axis = el('div', { class: 'sd-tl-axis' })
    for (const h of [0, 6, 12, 18, 24]) axis.append(el('span', {}, String(h).padStart(2, '0')))

    const head = el('div', { class: 'sd-card-head' }, `Market sessions<span>${fmtClock(now)} ${displayZoneLabel()}</span>`)
    const status = el('div', { class: 'sd-sess-status' }, active.length ? `${active.join(' · ')}<em>Open</em>` : 'No major session open')
    const nextEl = el('div', { class: 'sd-next' })
    if (next) nextEl.innerHTML = `<span class="sd-next-dot"></span>Next · <b>${next.name}</b><span class="sd-next-in">opens in <b>${fmtDuration(next.at - now)}</b></span>`
    const note = el('div', { class: 'sd-note' }, 'Crypto trades 24/7 · FX session hours; holidays may differ')
    this.sessionsEl.replaceChildren(head, status, rows, axis, nextEl, note)
  }
}
