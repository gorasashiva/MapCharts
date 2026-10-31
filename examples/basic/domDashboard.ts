// DOM Dashboard — a standalone top-level view (alongside Charts / Options / GEX):
// a moving tape of taker orders as bubbles, drawn over a heatmap of resting
// orders, the order-book ladder on
// the right, and the liquidity levels the order flow reveals — real walls,
// icebergs, spoofs and likely stop pools (see src/overlays/domLevelsModel.ts),
// with GEX Sabers walls tagged where they line up. A "Read" card on top turns
// all of it into LOOK FOR LONGS / LOOK FOR SHORTS / STAND ASIDE with reasons
// and a plan (src/overlays/domAdvisorModel.ts), and keeps a record of its calls.
//
// Data: Delta Exchange India's public feeds only — the incremental book
// (l2_updates), the trade tape (all_trades) and candles. The feeds run in the
// background from app start, whichever view is showing, so switching to DOM
// never starts it over; only drawing pauses while it is hidden. History of the
// book starts at app load; exchanges do not publish past order books.
import { el } from './ui'
import type { UnifiedProvider } from './provider'
import type { Candle } from '../../src/index'
import { classify, trust, type DomEventKind, type LevelKind, type LevelRecord, type StopPool } from '../../src/overlays/domLevelsModel'
import { computeGexSabersModel } from './gexSabers'
import { DOM_MARKETS, DomSession, type DomMarketSetup } from '../../src/overlays/domSession'

type SymbolSetup = DomMarketSetup
const SYMBOLS = DOM_MARKETS
/** How fast the tape scrolls left. */
const SPEEDS: { label: string; pxPerSec: number }[] = [
  { label: 'Slow', pxPerSec: 12 },
  { label: 'Normal', pxPerSec: 25 },
  { label: 'Fast', pxPerSec: 50 },
]
/** Tape history kept: enough to fill a wide screen at the slowest speed. */
const KEEP_MS = 240_000
const SNAP_MS = 500
const GROUPS = [1, 2, 5, 10, 25, 50, 100]

const KIND_COLOR: Record<LevelKind | 'pool' | 'swept', string> = {
  real: '#4fd1ff',
  iceberg: '#a78bfa',
  spoof: '#ff6bcb',
  watch: '#7d8a9c',
  pool: '#ffb74d',
  swept: '#ff9100',
}
const KIND_LABEL: Record<LevelKind | 'pool' | 'swept' | 'crossed', string> = {
  real: 'REAL WALL',
  iceberg: 'ICEBERG',
  spoof: 'SPOOF',
  watch: 'WATCHING',
  pool: 'STOP POOL',
  swept: 'SWEPT',
  crossed: 'CROSSED',
}
const EVENT_COLOR: Record<DomEventKind, string> = { pull: '#ff6bcb', absorb: '#ffd600', taken: '#cfd8e4', sweepUp: '#ff9100', sweepDn: '#ff9100' }
const EVENT_TEXT: Record<DomEventKind, string> = { pull: 'PULLED', absorb: 'ABSORB', taken: 'TAKEN', sweepUp: 'STOPS SWEPT', sweepDn: 'STOPS SWEPT' }
// absorption by side: buyers holding the bid (green) or sellers holding the ask (red)
const ABSORB_COLOR = { bid: '#19d27b', ask: '#ff4b5c' } as const
const ABSORB_TEXT = { bid: 'BUYERS ABSORB', ask: 'SELLERS ABSORB' } as const
/** The toolbar's absorption tally looks back this far. */
const ABSORB_TALLY_MS = 15 * 60_000
const WALL_YELLOW = '#ffd600'
const POC_ORANGE = '#ff9100'
const GEX_COLOR: Record<string, string> = { resistance: '#ff2d3d', support: '#25f06b', liquidity: '#c45cff', hvl: '#FF9100', peakPos: '#39ff14', peakNeg: '#FFD600', zero: '#dff4ff' }
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

const fmt = (v: number): string => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'K' : String(Math.round(v)))
const fmtDur = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
const istClock = (t: number): string => new Date(t + 5.5 * 3_600_000).toISOString().slice(11, 16)
const istClockSec = (t: number): string => new Date(t + 5.5 * 3_600_000).toISOString().slice(11, 19)
const decimalsOf = (x: number): number => {
  const s = String(x)
  return s.includes('e-') ? Number(s.split('e-')[1]) : (s.split('.')[1] ?? '').length
}

interface HeatSnap {
  t: number
  levels: [number, number][] // price, $
  agg: Map<number, number> | null
  aggStep: number
}
interface TapeOrder {
  t: number
  price: number
  usd: number
  buy: boolean
}
interface GexTag {
  price: number
  text: string
  short: string
  color: string
  kind: string
  strength: number
}

type ToggleKey = 'heat' | 'levels' | 'gex'

export class DomDashboardView {
  readonly el: HTMLElement
  private symbolSelect: HTMLSelectElement
  private speedSelect: HTMLSelectElement
  private groupSelect: HTMLSelectElement
  private priceEl: HTMLElement
  private imbBar: HTMLElement
  private imbText: HTMLElement
  private latencyEl: HTMLElement
  private absorbBuyEl: HTMLElement
  private absorbSellEl: HTMLElement
  private statusEl: HTMLElement
  private canvas: HTMLCanvasElement
  private liveList: HTMLElement
  private endedList: HTMLElement
  private subEl: HTMLElement
  private readEl: HTMLElement

  private setup: SymbolSetup = SYMBOLS[0]
  private speed = SPEEDS[1]
  private group = 0 // 0 = auto
  private show: Record<ToggleKey, boolean> = { heat: true, levels: true, gex: true }
  private active = false // on screen
  private running = false // feeds connected
  private unsubs: (() => void)[] = []
  private timers: number[] = []
  private raf = 0
  private gen = 0

  // live state
  private session = new DomSession(SYMBOLS[0], Date.now())
  private candles: Candle[] = []
  private poolCandles: Candle[] = []
  private snaps: HeatSnap[] = []
  private orders: TapeOrder[] = [] // one per taker order, merged from its fills
  private vp = new Map<number, number>() // price -> today's $ volume
  private gexTags: GexTag[] = []
  private tick = 0 // book price increment
  private lastPrice = 0
  private latency = 0
  private bookAt = 0
  private merge: { us: number; buy: boolean; price: number; qty: number } | null = null

  /** The level tracker inside the shared session (the replay drives the same one). */
  private get tracker(): DomSession['tracker'] {
    return this.session.tracker
  }

  // view
  private topRow = 0
  private rowStepNow = 0
  private dpr = 1
  private W = 0
  private H = 0
  private colors = { bg: '#131722', panel: '#1e222d', border: '#2a2e39', text: '#d1d4dc', muted: '#787b86', up: '#089981', down: '#f23645' }

  constructor(container: HTMLElement, private provider: UnifiedProvider) {
    this.el = container

    const toolbar = el('div', { class: 'opt-toolbar dom-toolbar' })
    this.symbolSelect = el('select', { class: 'opt-select', title: 'Market', 'aria-label': 'Market' }) as HTMLSelectElement
    for (const s of SYMBOLS) this.symbolSelect.appendChild(el('option', { value: s.symbol }, `${s.symbol} · ${s.label}`))
    this.symbolSelect.addEventListener('change', () => {
      this.setup = SYMBOLS.find((s) => s.symbol === this.symbolSelect.value) ?? SYMBOLS[0]
      this.group = 0
      this.groupSelect.value = '0'
      this.reconnect()
    })
    this.speedSelect = el('select', { class: 'opt-select', title: 'Tape speed', 'aria-label': 'Tape speed' }) as HTMLSelectElement
    SPEEDS.forEach((sp, i) => this.speedSelect.appendChild(el('option', { value: String(i) }, `Speed: ${sp.label}`)))
    this.speedSelect.value = '1'
    this.speedSelect.addEventListener('change', () => {
      this.speed = SPEEDS[Number(this.speedSelect.value)] ?? SPEEDS[1]
    })
    this.groupSelect = el('select', { class: 'opt-select', title: 'Price steps per row (or scroll on the chart)', 'aria-label': 'Price steps per row' }) as HTMLSelectElement
    this.groupSelect.appendChild(el('option', { value: '0' }, 'Rows: auto'))
    for (const g of GROUPS) this.groupSelect.appendChild(el('option', { value: String(g) }, `Rows: x${g}`))
    this.groupSelect.addEventListener('change', () => {
      this.group = Number(this.groupSelect.value)
      this.topRow = 0
    })

    const mkToggle = (key: ToggleKey, label: string, title: string): HTMLButtonElement => {
      const b = el('button', { class: 'dom-tog', 'aria-pressed': 'true', title }, label) as HTMLButtonElement
      b.addEventListener('click', () => {
        this.show[key] = !this.show[key]
        b.setAttribute('aria-pressed', String(this.show[key]))
      })
      return b
    }
    this.priceEl = el('span', { class: 'opt-spot' }, '—')
    this.imbBar = el('i', {})
    this.imbText = el('b', {}, '—')
    this.latencyEl = el('b', {}, '—')
    this.statusEl = el('span', { class: 'opt-status' }, '')
    const imbTrack = el('span', { class: 'dom-imb' })
    imbTrack.appendChild(this.imbBar)
    const imb = el('span', { class: 'dom-stat', title: 'Resting bids vs asks within 10 rows of price' })
    imb.append('Bid/Ask ', imbTrack, ' ', this.imbText)
    this.absorbBuyEl = el('b', { class: 'dom-up' }, '▲ buyers 0')
    this.absorbSellEl = el('b', { class: 'dom-down' }, '▼ sellers 0')
    const absorb = el('span', {
      class: 'dom-stat',
      title: 'Absorption in the last 15 minutes. Buyers: market selling soaked up by a bid that held (leans bullish). Sellers: market buying soaked up by an ask that held (leans bearish).',
    })
    absorb.append('Absorbed 15m ', this.absorbBuyEl, ' ', this.absorbSellEl)
    const lat = el('span', { class: 'dom-stat', title: 'Exchange timestamp to screen' })
    lat.append('Latency ', this.latencyEl)
    toolbar.append(
      this.symbolSelect,
      this.speedSelect,
      this.groupSelect,
      this.priceEl,
      mkToggle('heat', 'Heat', 'Resting orders over time, behind the candles'),
      mkToggle('levels', 'Levels', 'Real walls, icebergs, spoofs and stop pools'),
      mkToggle('gex', 'GEX', 'GEX Sabers walls from Delta options (BTC, ETH, gold)'),
      el('span', { class: 'foot-grow' }),
      absorb,
      imb,
      lat,
      this.statusEl,
    )

    const body = el('div', { class: 'dom-body' })
    const stage = el('div', { class: 'dom-stage' })
    this.canvas = el('canvas', { class: 'dom-canvas' }) as HTMLCanvasElement
    stage.appendChild(this.canvas)
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    const aside = el('aside', { class: 'dom-levels', 'aria-label': 'Liquidity levels' })
    this.subEl = el('p', { class: 'dom-sub' }, '')
    this.liveList = el('ol', {})
    this.endedList = el('ol', {})
    this.readEl = el('section', { class: 'dom-read', 'aria-live': 'polite', 'aria-label': 'Order-flow reading' })
    aside.append(this.readEl, el('h2', {}, 'Liquidity levels'), this.subEl, this.liveList, el('h3', {}, 'Recently ended'), this.endedList)
    body.append(stage, aside)
    this.el.append(toolbar, body)

    new ResizeObserver(() => this.resize()).observe(this.canvas)
  }

  /** Connect the feeds in the background; they then stay up whichever view is showing. */
  start(): void {
    if (this.running) return
    this.running = true
    this.connect()
  }

  async activate(): Promise<void> {
    if (this.active) return
    this.active = true
    this.readColors()
    this.resize()
    this.start()
    this.renderPanel()
    this.renderRead()
    const loop = (): void => {
      if (!this.active) return
      this.draw()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  /** Hidden: stop drawing only — the book, trades and level detection keep running. */
  deactivate(): void {
    if (!this.active) return
    this.active = false
    cancelAnimationFrame(this.raf)
  }

  /** Re-read theme colours (call after a theme switch). */
  readColors(): void {
    const cs = getComputedStyle(this.el)
    const v = (n: string, d: string): string => cs.getPropertyValue(n).trim() || d
    this.colors = { bg: v('--bg', '#131722'), panel: v('--panel', '#1e222d'), border: v('--border', '#2a2e39'), text: v('--text', '#d1d4dc'), muted: v('--muted', '#787b86'), up: v('--up', '#089981'), down: v('--down', '#f23645') }
  }

  private reconnect(): void {
    if (!this.running) return
    this.disconnect()
    this.connect()
  }

  private disconnect(): void {
    this.gen++
    for (const u of this.unsubs) u()
    this.unsubs = []
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  private connect(): void {
    const gen = ++this.gen
    const s = this.setup
    this.session = new DomSession(s, Date.now(), { candles: () => this.candles, poolCandles: () => this.poolCandles })
    this.candles = []
    this.poolCandles = []
    this.snaps = []
    this.orders = []
    this.vp.clear()
    this.gexTags = []
    this.tick = 0
    this.lastPrice = 0
    this.topRow = 0
    this.merge = null
    this.statusEl.textContent = 'connecting…'
    this.statusEl.classList.remove('live')

    void this.provider
      .fetchCandles(s.symbol, '1m', 300)
      .then((cs) => {
        if (gen !== this.gen) return
        // keep anything the live feed delivered meanwhile
        const live = this.candles
        this.candles = cs
        for (const c of live) this.upsertCandle(c)
        this.seedVolumeProfile(cs)
        if (!this.lastPrice && cs.length) this.lastPrice = cs[cs.length - 1].close
      })
      .catch((err: unknown) => {
        if (gen === this.gen) this.statusEl.textContent = `candles unavailable: ${err instanceof Error ? err.message : String(err)}`
      })
    const loadPools = (): void => {
      void this.provider
        .fetchCandles(s.symbol, '15m', 300)
        .then((cs) => {
          if (gen === this.gen) this.poolCandles = cs
        })
        .catch(() => {})
    }
    loadPools()

    this.unsubs.push(this.provider.subscribeCandles(s.symbol, '1m', (c) => this.upsertCandle(c)))
    this.unsubs.push(
      this.provider.subscribeBook(s.symbol, (e) => {
        const now = Date.now()
        if (e.action === 'snapshot' && !this.tick) this.tick = inferTick([...e.bids, ...e.asks].map((l) => l[0]))
        this.session.onBook(e.action, e.bids, e.asks, now)
        this.latency = Math.max(0, now - e.time)
        this.bookAt = now
        if (!this.statusEl.classList.contains('live')) {
          this.statusEl.textContent = 'live'
          this.statusEl.classList.add('live')
        }
      }),
    )
    this.unsubs.push(
      this.provider.subscribeTrades(s.symbol, (t) => {
        const now = Date.now()
        // the subscribe-time backlog predates the book we hold: chart it, don't classify with it
        if (now - t.time < 10_000) this.session.onTrade(t.price, t.qty, t.side === 'buy', now)
        this.lastPrice = t.price
        this.session.lastPrice = t.price
        this.addVolume(t.price, t.price * t.qty)
        // fills of one taker order share an exchange timestamp: one bubble per order
        const us = t.timeUs ?? t.time * 1000
        const buy = t.side === 'buy'
        if (this.merge && this.merge.us === us && this.merge.buy === buy) this.merge.qty += t.qty
        else {
          this.flushMerge()
          this.merge = { us, buy, price: t.price, qty: t.qty }
        }
      }),
    )
    this.timers.push(
      window.setInterval(() => {
        this.flushMerge()
        if (this.session.tick(Date.now()) && this.active) this.renderRead()
      }, 250),
      window.setInterval(() => this.takeSnapshot(), SNAP_MS),
      window.setInterval(() => this.renderPanel(), 500),
      window.setInterval(loadPools, 5 * 60_000),
      window.setInterval(() => this.refreshGex(), 3000),
    )
    window.setTimeout(() => {
      if (gen === this.gen) this.refreshGex()
    }, 2500)
  }

  private flushMerge(): void {
    const m = this.merge
    if (!m) return
    this.merge = null
    this.orders.push({ t: m.us / 1000, price: m.price, usd: m.price * m.qty, buy: m.buy })
    const cut = Date.now() - KEEP_MS
    while (this.orders.length && this.orders[0].t < cut) this.orders.shift()
  }

  private upsertCandle(c: Candle): void {
    const last = this.candles[this.candles.length - 1]
    if (last && last.time === c.time) this.candles[this.candles.length - 1] = c
    else if (!last || c.time > last.time) {
      this.candles.push(c)
      if (this.candles.length > 600) this.candles.shift()
    }
    this.lastPrice = c.close
    this.session.lastPrice = c.close
  }

  /** Today's volume per price, spread evenly across each closed candle's range; live trades add to it. */
  private seedVolumeProfile(cs: Candle[]): void {
    const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000
    for (const c of cs.slice(0, -1)) {
      if (c.time < dayStart || !(c.volume > 0)) continue
      const n = Math.max(1, Math.min(40, Math.round((c.high - c.low) / (this.tick || (c.high - c.low) / 20 || 1))))
      for (let i = 0; i <= n; i++) this.addVolume(c.low + ((c.high - c.low) * i) / n, (c.volume * c.close) / (n + 1))
    }
  }

  private addVolume(price: number, usd: number): void {
    this.vp.set(price, (this.vp.get(price) ?? 0) + usd)
  }

  private takeSnapshot(): void {
    const mid = this.tracker.mid
    if (!mid) return
    const levels: [number, number][] = []
    const range = mid * 0.015
    for (const book of [this.tracker.bids, this.tracker.asks]) for (const [p, q] of book) if (Math.abs(p - mid) <= range) levels.push([p, p * q])
    this.snaps.push({ t: Date.now(), levels, agg: null, aggStep: 0 })
    const cut = Date.now() - KEEP_MS
    while (this.snaps.length && this.snaps[0].t < cut) this.snaps.shift()
  }

  private refreshGex(): void {
    if (!this.candles.length) return
    const m = computeGexSabersModel(this.candles, {}, { symbol: this.setup.symbol, chartType: 'candles' })
    this.gexTags = m.sabers.map((s) => ({
      price: s.price,
      short: `GEX ${s.names[0]}`,
      text: `GEX ${s.names.join(' · ')}${Number.isFinite(s.strength) ? ` · str ${Math.round(s.strength)}` : ''}`,
      color: GEX_COLOR[s.kind] ?? '#c3cbd6',
      kind: s.kind,
      strength: Number.isFinite(s.strength) ? s.strength : 40,
    }))
    this.session.extraLevels = this.gexTags.map((t) => ({ price: t.price, label: t.short, strength: t.strength }))
  }

  // ---------------------------------------------------------------------------
  // The Read card: everything above, as one reading
  // ---------------------------------------------------------------------------
  private renderRead(): void {
    const a = this.session.advice
    const dec = Math.max(2, decimalsOf(this.tick))
    const px = (p: number): string => p.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
    const card = this.readEl
    card.dataset.bias = a?.bias ?? 'neutral'
    const head = el('div', { class: 'dom-read-head' })
    head.append(el('span', { class: 'dom-read-verdict' }, a?.headline ?? 'STAND ASIDE'))
    if (a && a.bias !== 'neutral') {
      const conf = el('span', { class: 'dom-read-conf' }, String(a.confidence))
      conf.appendChild(el('small', {}, ' confidence'))
      head.appendChild(conf)
    }
    const parts: HTMLElement[] = [head]
    if (a && a.bias !== 'neutral') {
      const meter = el('div', { class: 'dom-meter' })
      const fill = el('i', {})
      fill.style.width = `${a.confidence}%`
      meter.appendChild(fill)
      parts.push(meter)
    }
    if (a?.plan) {
      const pl = a.plan, long = a.bias === 'long'
      parts.push(
        el(
          'div',
          { class: 'dom-read-plan' },
          `${long ? 'Buy' : 'Sell'} zone ${px(pl.zone[0])}–${px(pl.zone[1])} (${pl.zoneFrom}) · stop ${px(pl.stop)} · target ${px(pl.target)} (${pl.targetFrom}) · ${pl.rr.toFixed(1)}R`,
        ),
      )
    }
    const pending = this.session.pendingBias
    if (pending) parts.push(el('div', { class: 'dom-read-pending' }, `Reading turning ${pending.bias === 'neutral' ? 'neutral' : pending.bias}…`))
    const why = el('ul', { class: 'dom-read-why' })
    for (const f of (a?.factors ?? []).slice(0, 5)) {
      const li = el('li', { class: f.score > 0.1 ? 'up' : f.score < -0.1 ? 'down' : '' }, `${f.score > 0.1 ? '▲' : f.score < -0.1 ? '▼' : '•'} ${f.text}`)
      why.appendChild(li)
    }
    if (why.childElementCount) parts.push(why)
    if (a?.cautions.length) {
      const cautions = el('ul', { class: 'dom-read-cautions' })
      for (const c of a.cautions) cautions.appendChild(el('li', {}, c))
      parts.push(cautions)
    }
    const t = this.session.record.tally()
    parts.push(
      el(
        'div',
        { class: 'dom-read-record' },
        t.calls ? `Calls since ${istClock(this.session.openedAt)} IST: ${t.calls} · target hit ${t.target} · stopped ${t.stop} · no result ${t.expired} · open ${t.open}` : `No calls yet since ${istClock(this.session.openedAt)} IST`,
      ),
      el('div', { class: 'dom-read-note' }, 'An order-flow reading, not advice. The weights are untested — judge it by its record above.'),
    )
    card.replaceChildren(...parts)
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const cur = this.group || this.autoGroup()
    const i = GROUPS.indexOf(cur)
    const next = GROUPS[Math.max(0, Math.min(GROUPS.length - 1, (i < 0 ? 2 : i) + (e.deltaY > 0 ? 1 : -1)))]
    this.group = next
    this.groupSelect.value = String(next)
    this.topRow = 0
  }

  /** Rows sized so the view spans about 0.6% of price. */
  private autoGroup(): number {
    const mid = this.tracker.mid || this.lastPrice
    if (!mid || !this.tick) return 1
    const rows = Math.max(10, Math.floor(this.H / 16))
    const want = (mid * 0.006) / rows / this.tick
    return GROUPS.reduce((best, g) => (Math.abs(Math.log(g / want)) < Math.abs(Math.log(best / want)) ? g : best), 1)
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect()
    this.dpr = window.devicePixelRatio || 1
    this.W = r.width
    this.H = r.height
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr))
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr))
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  private draw(): void {
    const g = this.canvas.getContext('2d')
    if (!g || !this.W || !this.H) return
    const C = this.colors
    const W = this.W, H = this.H
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.fillStyle = C.bg
    g.fillRect(0, 0, W, H)
    const tr = this.tracker
    const last = this.lastPrice || tr.mid
    if (!last || !this.tick) {
      g.fillStyle = C.muted
      g.font = `13px ${FONT}`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(`Connecting to the ${this.setup.symbol} order book…`, W / 2, H / 2)
      return
    }
    const now = Date.now()
    const narrow = W < 640
    const rowH = 16, volW = narrow ? 50 : 72, ladW = narrow ? 150 : 200, axisH = 20
    const x0 = volW, x1 = W - ladW, plotH = H - axisH
    const nRows = Math.floor(plotH / rowH)
    const step = this.tick * (this.group || this.autoGroup())
    if (step !== this.rowStepNow) {
      this.rowStepNow = step
      this.topRow = 0
    }
    const rowOf = (p: number): number => Math.floor(p / step + 1e-7)
    const midRow = rowOf(last)
    if (!this.topRow || midRow > this.topRow - nRows * 0.25 || midRow < this.topRow - nRows * 0.75) this.topRow = midRow + Math.floor(nRows / 2)
    const top = this.topRow
    const yOf = (row: number): number => (top - row) * rowH
    const yP = (p: number): number => (top + 1 - p / step) * rowH
    const pxPerMs = (narrow ? this.speed.pxPerSec * 0.7 : this.speed.pxPerSec) / 1000
    const xR = x1 - 12 // "now"
    const xOf = (t: number): number => xR - (now - t) * pxPerMs
    const dec = Math.max(decimalsOf(this.tick), decimalsOf(step))
    const fmtPx = (p: number): string => p.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
        const aggOf = (levels: Iterable<[number, number]>): Map<number, number> => {
      const m = new Map<number, number>()
      for (const [p, v] of levels) m.set(rowOf(p), (m.get(rowOf(p)) ?? 0) + v)
      return m
    }
    // heat scale: the 95th-percentile row on screen is full brightness
    const liveRows = aggOf((function* () {
      for (const book of [tr.bids, tr.asks]) for (const [p, q] of book) yield [p, p * q] as [number, number]
    })())
    const onScreen = [...liveRows].filter(([r]) => r <= top && r > top - nRows).map(([, v]) => v).sort((a, b) => a - b)
    const heatScale = Math.max(1, onScreen[Math.floor(onScreen.length * 0.95)] ?? 1)

    g.save()
    g.beginPath()
    g.rect(x0, 0, x1 - x0, plotH)
    g.clip()

    // resting liquidity heat
    if (this.show.heat) {
      const snapW = SNAP_MS * pxPerMs + 0.6
      for (const s of this.snaps) {
        const x = xOf(s.t) - snapW
        if (x < x0 - snapW) continue
        if (s.aggStep !== step) {
          s.agg = aggOf(s.levels)
          s.aggStep = step
        }
        for (const [r, v] of s.agg!) {
          const y = yOf(r)
          if (y < -rowH || y > plotH) continue
          g.fillStyle = heat(v / heatScale)
          g.fillRect(x, y, snapW, rowH)
        }
      }
      // the live book fills from the newest snapshot to the right edge
      const liveX = Math.min(xR, this.snaps.length ? xOf(this.snaps[this.snaps.length - 1].t) : xR)
      for (const [r, v] of liveRows) {
        const y = yOf(r)
        if (y < -rowH || y > plotH) continue
        g.fillStyle = heat(v / heatScale)
        g.fillRect(liveX, y, x1 - liveX, rowH)
      }
    }

    // grid and time lines
    g.strokeStyle = C.border
    g.lineWidth = 1
    for (let i = 0; i <= nRows; i++) if ((top - i) % 5 === 0) line(g, x0, i * rowH + 0.5, x1, i * rowH + 0.5)
    // a time line every 15s (30s on slow), on whole seconds so they scroll with the tape
    const markMs = this.speed.pxPerSec < 20 ? 30_000 : 15_000
    const timeMarks: number[] = []
    for (let t = Math.floor(now / markMs) * markMs; xOf(t) > x0; t -= markMs) timeMarks.push(t)
    for (const t of timeMarks) {
      const x = Math.round(xOf(t)) + 0.5
      if (x < x1) line(g, x, 0, x, plotH)
    }

    // GEX tags
    if (this.show.gex) {
      for (const t of this.gexTags) {
        const y = yP(t.price)
        if (y < 0 || y > plotH) continue
        g.setLineDash([5, 5])
        g.globalAlpha = 0.5
        g.strokeStyle = t.color
        line(g, x0, y, x1, y)
        g.setLineDash([])
        g.globalAlpha = 1
        pill(g, x0 + 6, y, t.text, t.color)
      }
    }

    // detected levels: a line from when each appeared, kind and trust at the right
    const labels: [number, string, string][] = []
    if (this.show.levels) {
      g.lineWidth = 2
      for (const p of tr.pools) {
        const y = yOf(rowOf(p.price)) + rowH / 2
        if (y < 0 || y > plotH) continue
        g.setLineDash([2, 4])
        g.strokeStyle = KIND_COLOR.pool
        g.globalAlpha = 0.8
        line(g, Math.max(x0, xOf(p.born)), y, x1, y)
        g.setLineDash([])
        g.globalAlpha = 1
        labels.push([y, `STOPS? ${p.why} · ${p.trust}`, KIND_COLOR.pool])
      }
      for (const p of tr.endedPools) {
        const y = yOf(rowOf(p.price)) + rowH / 2
        if (p.status !== 'swept' || y < 0 || y > plotH || xOf(p.end) < x0) continue
        g.strokeStyle = KIND_COLOR.swept
        line(g, Math.max(x0, xOf(p.born)), y, xOf(p.end), y)
      }
      for (const r of tr.live.values()) {
        const k = classify(r, now, tr.o)
        const y = yOf(rowOf(r.price)) + rowH / 2
        if (y < 0 || y > plotH) continue
        g.strokeStyle = KIND_COLOR[k]
        g.lineWidth = k === 'watch' ? 1 : 2.5
        g.globalAlpha = k === 'watch' ? 0.5 : 0.9
        if (k === 'spoof') g.setLineDash([6, 4])
        line(g, Math.max(x0, xOf(r.born)), y, x1, y)
        g.setLineDash([])
        g.globalAlpha = 1
        if (k !== 'watch') labels.push([y, `${KIND_LABEL[k]}${k === 'iceberg' ? ` ${r.refills}×` : ''} ${fmt(r.vis)} · ${trust(r, k, now)}`, KIND_COLOR[k]])
      }
    }

    // last price
    g.setLineDash([2, 3])
    g.strokeStyle = C.text
    g.globalAlpha = 0.55
    line(g, x0, yP(last), x1, yP(last))
    g.setLineDash([])
    g.globalAlpha = 1

    // the tape: one bubble per taker order, sliding left; gold ring at the big-trade size
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const big = this.setup.bigUsd
    for (const o of this.orders) {
      const x = xOf(o.t)
      const y = yP(o.price)
      if (x < x0 - 30 || y < -30 || y > plotH + 30) continue
      const r = Math.min(narrow ? 22 : 30, 2.5 + Math.sqrt(o.usd / big) * 9)
      g.globalAlpha = 0.8
      g.fillStyle = o.buy ? '#0f5a37' : '#8f2431'
      g.beginPath()
      g.arc(x, y, r, 0, Math.PI * 2)
      g.fill()
      g.globalAlpha = 1
      g.strokeStyle = o.usd >= big ? WALL_YELLOW : o.buy ? C.up : C.down
      g.lineWidth = o.usd >= big ? 2.5 : 1.2
      g.stroke()
      if (r >= 10) {
        g.fillStyle = '#fff'
        g.font = `600 ${r >= 18 ? 12 : 10}px ${FONT}`
        g.fillText(fmt(o.usd), x, y + 0.5)
      }
    }

    // event markers
    if (this.show.levels) {
      for (const e of tr.events) {
        const x = xOf(e.t)
        const y = yOf(rowOf(e.price)) + rowH / 2
        if (x < x0 - 80 || y < 0 || y > plotH) continue
        const col = e.kind === 'absorb' && e.side ? ABSORB_COLOR[e.side] : EVENT_COLOR[e.kind]
        // a level not yet confirmed as a wall: faint, with a question mark
        g.globalAlpha = e.tentative ? 0.5 : 1
        g.strokeStyle = col
        g.fillStyle = col
        g.lineWidth = 2
        g.beginPath()
        if (e.kind === 'pull') {
          g.moveTo(x - 5, y - 5)
          g.lineTo(x + 5, y + 5)
          g.moveTo(x + 5, y - 5)
          g.lineTo(x - 5, y + 5)
          g.stroke()
        } else if (e.kind === 'sweepUp' || e.kind === 'sweepDn') {
          const d = e.kind === 'sweepUp' ? -1 : 1
          g.moveTo(x, y + d * 8)
          g.lineTo(x + 7, y - d * 4)
          g.lineTo(x - 7, y - d * 4)
          g.closePath()
          g.fill()
        } else if (e.kind === 'taken') {
          g.arc(x, y, 5, 0, Math.PI * 2)
          g.fill()
        } else {
          g.moveTo(x, y - 7)
          g.lineTo(x + 7, y)
          g.lineTo(x, y + 7)
          g.lineTo(x - 7, y)
          g.closePath()
          g.globalAlpha = 0.35
          g.fill()
          g.globalAlpha = e.tentative ? 0.5 : 1
          g.stroke()
        }
        if (e.kind === 'absorb' && e.side) {
          // buyers' label sits under the price that held, sellers' above it
          const buyers = e.side === 'bid'
          pill(g, x + 10, y + (buyers ? 14 : -14), `${ABSORB_TEXT[e.side]} ${fmt(e.value)} ${buyers ? '▲' : '▼'}`, col)
        } else pill(g, x + 10, y + (e.kind === 'sweepDn' ? 14 : -14), `${EVENT_TEXT[e.kind]}${e.tentative ? '?' : ''} ${fmt(e.value)}`, col)
        g.globalAlpha = 1
      }
    }
    // the Read card's plan: zone band, stop and target
    const adv = this.session.advice
    if (adv?.plan && adv.bias !== 'neutral') {
      const pl = adv.plan, col = adv.bias === 'long' ? '#19d27b' : '#ff4b5c'
      const yA = yP(pl.zone[1]), yB = yP(pl.zone[0])
      g.globalAlpha = 0.14
      g.fillStyle = col
      g.fillRect(x0, Math.min(yA, yB), x1 - x0, Math.max(3, Math.abs(yB - yA)))
      g.globalAlpha = 1
      g.setLineDash([6, 4])
      g.lineWidth = 1.5
      g.strokeStyle = '#ff4b5c'
      line(g, x0, yP(pl.stop), x1, yP(pl.stop))
      g.strokeStyle = '#19d27b'
      line(g, x0, yP(pl.target), x1, yP(pl.target))
      g.setLineDash([])
      pill(g, x0 + (x1 - x0) * 0.55, Math.min(yA, yB) - 9, adv.bias === 'long' ? 'BUY ZONE' : 'SELL ZONE', col)
      pill(g, x0 + (x1 - x0) * 0.55, yP(pl.stop), 'STOP', '#ff4b5c')
      pill(g, x0 + (x1 - x0) * 0.55, yP(pl.target), 'TARGET', '#19d27b')
    }

    // level labels at the right edge: the 10 nearest price, nudged apart so they never stack
    const yLast = yP(last)
    labels.sort((a, b) => Math.abs(a[0] - yLast) - Math.abs(b[0] - yLast))
    labels.length = Math.min(labels.length, 10)
    labels.sort((a, b) => a[0] - b[0])
    let lastY = -99
    for (const [y, text, col] of labels) {
      const yy = Math.max(y - 10, lastY + 17)
      lastY = yy
      pill(g, x1 - 6, yy, text, col, 'right')
    }
    g.restore()

    // time axis (IST)
    g.fillStyle = C.panel
    g.fillRect(x0, plotH, x1 - x0, axisH)
    g.strokeStyle = C.border
    g.lineWidth = 1
    line(g, x0, plotH + 0.5, x1, plotH + 0.5)
    g.font = `10px ${FONT}`
    g.fillStyle = C.muted
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (const t of timeMarks) {
      const x = xOf(t)
      if (x > x0 + 28 && x < x1 - 28) g.fillText(istClockSec(t), x, plotH + axisH / 2)
    }

    // volume column
    const vpRow = aggOf(this.vp)
    let poc = NaN, pocV = 0
    for (const [r, v] of vpRow) if (v > pocV) [pocV, poc] = [v, r]
    g.fillStyle = C.panel
    g.fillRect(0, 0, volW, H)
    g.font = `${narrow ? 10 : 11}px ${FONT}`
    g.textAlign = 'left'
    for (let i = 0; i < nRows; i++) {
      const r = top - i, v = vpRow.get(r)
      if (!v) continue
      const y = i * rowH
      g.fillStyle = 'rgba(41,98,255,.22)'
      g.fillRect(0, y + 2, (v / pocV) * (volW - 4), rowH - 4)
      g.fillStyle = r === poc ? POC_ORANGE : C.text
      g.fillText(fmt(v), 4, y + rowH / 2 + 0.5)
      if (r === poc) {
        g.strokeStyle = POC_ORANGE
        g.lineWidth = 1.5
        g.strokeRect(1, y + 1, volW - 3, rowH - 2)
      }
    }

    // ladder
    const priceW = narrow ? 64 : 76
    const sideW = (ladW - priceW) / 2, pxX = x1 + sideW, askX = pxX + priceW
    g.fillStyle = C.panel
    g.fillRect(x1, 0, ladW, H)
    const bids = new Map<number, number>(), asks = new Map<number, number>()
    for (const [p, q] of tr.bids) bids.set(rowOf(p), (bids.get(rowOf(p)) ?? 0) + p * q)
    for (const [p, q] of tr.asks) asks.set(rowOf(p), (asks.get(rowOf(p)) ?? 0) + p * q)
    const lvRows = new Map<number, string>()
    if (this.show.levels) {
      for (const r of tr.live.values()) {
        const k = classify(r, now, tr.o)
        if (k !== 'watch') lvRows.set(rowOf(r.price), KIND_COLOR[k])
      }
    }
    let maxV = 1, maxRow = NaN, maxSide = ''
    for (let i = 0; i < nRows; i++) {
      const r = top - i
      if ((bids.get(r) ?? 0) > maxV) [maxV, maxRow, maxSide] = [bids.get(r)!, r, 'b']
      if ((asks.get(r) ?? 0) > maxV) [maxV, maxRow, maxSide] = [asks.get(r)!, r, 'a']
    }
    let sumB = 0, sumA = 0
    const bbRow = rowOf(tr.bestBid()), baRow = rowOf(tr.bestAsk())
    for (let i = 0; i < nRows; i++) {
      const r = top - i, y = i * rowH, ym = y + rowH / 2 + 0.5
      const vb = bids.get(r) ?? 0, va = asks.get(r) ?? 0
      if (Math.abs(r - midRow) <= 10) {
        sumB += vb
        sumA += va
      }
      if (vb) {
        const big = r === maxRow && maxSide === 'b'
        g.fillStyle = 'rgba(8,153,129,.22)'
        const w = Math.max(2, Math.sqrt(vb / maxV) * sideW)
        g.fillRect(pxX - w, y + 1, w, rowH - 2)
        if (big) {
          g.fillStyle = WALL_YELLOW
          g.fillRect(x1 + 1, y + 1, sideW - 1, rowH - 2)
        }
        g.fillStyle = big ? '#111' : r === bbRow ? C.up : C.text
        g.textAlign = 'right'
        g.fillText(fmt(vb), pxX - 5, ym)
      }
      if (va) {
        const big = r === maxRow && maxSide === 'a'
        g.fillStyle = 'rgba(242,54,69,.22)'
        const w = Math.max(2, Math.sqrt(va / maxV) * sideW)
        g.fillRect(askX, y + 1, w, rowH - 2)
        if (big) {
          g.fillStyle = WALL_YELLOW
          g.fillRect(askX, y + 1, sideW - 1, rowH - 2)
        }
        g.fillStyle = big ? '#111' : r === baRow ? C.down : C.text
        g.textAlign = 'left'
        g.fillText(fmt(va), askX + 5, ym)
      }
      if (r === midRow) {
        g.fillStyle = C.border
        g.fillRect(pxX, y, priceW, rowH)
      }
      g.textAlign = 'center'
      g.fillStyle = r === midRow || r % 5 === 0 ? C.text : C.muted
      g.fillText(fmtPx(r * step), pxX + priceW / 2, ym)
      if (this.show.gex) {
        for (const t of this.gexTags) {
          if (rowOf(t.price) !== r) continue
          g.fillStyle = t.color
          g.fillRect(pxX, y + 3, 3, rowH - 6)
        }
      }
      const lc = lvRows.get(r)
      if (lc) {
        g.strokeStyle = lc
        g.lineWidth = 1.5
        g.strokeRect(x1 + 1.5, y + 1, ladW - 3, rowH - 2)
      }
    }
    g.strokeStyle = C.border
    g.lineWidth = 1
    line(g, x1 + 0.5, 0, x1 + 0.5, H)
    line(g, volW - 0.5, 0, volW - 0.5, H)

    // toolbar readouts
    this.priceEl.textContent = fmtPx(last)
    const pct = sumB + sumA ? Math.round((sumB / (sumB + sumA)) * 100) : 50
    this.imbBar.style.width = `${pct}%`
    this.imbText.textContent = `${pct}% bid`
    this.latencyEl.textContent = now - this.bookAt > 5000 ? 'stale' : `${this.latency}ms`
    let buyersUsd = 0, sellersUsd = 0, buyersN = 0, sellersN = 0
    for (const e of tr.events) {
      if (e.kind !== 'absorb' || now - e.t > ABSORB_TALLY_MS) continue
      if (e.side === 'bid') [buyersUsd, buyersN] = [buyersUsd + e.value, buyersN + 1]
      else if (e.side === 'ask') [sellersUsd, sellersN] = [sellersUsd + e.value, sellersN + 1]
    }
    this.absorbBuyEl.textContent = `▲ buyers ${buyersN}${buyersN ? ` · ${fmt(buyersUsd)}` : ''}`
    this.absorbSellEl.textContent = `▼ sellers ${sellersN}${sellersN ? ` · ${fmt(sellersUsd)}` : ''}`
  }

  // ---------------------------------------------------------------------------
  // Liquidity levels panel
  // ---------------------------------------------------------------------------
  private renderPanel(): void {
    if (!this.active) return
    const tr = this.tracker, now = Date.now()
    const dec = Math.max(2, decimalsOf(this.tick))
    const px = (p: number): string => p.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
    const gexAt = (p: number): string[] => {
      const tol = Math.max(this.tick * 3, p * 0.0004)
      return this.gexTags.filter((t) => Math.abs(t.price - p) <= tol).map((t) => t.short)
    }
    const item = (o: { price: number; label: string; color: string; side: string; trust: number; det: string; ended: boolean }): HTMLElement => {
      const li = el('li', { class: `dom-lv${o.ended ? ' ended' : ''}` })
      li.style.setProperty('--c', o.color)
      const head = el('div', { class: 'dom-lv-top' })
      const tr = el('span', { class: 'dom-trust' }, String(o.trust))
      tr.appendChild(el('small', {}, ' trust'))
      head.append(el('span', {}, px(o.price)), el('span', { class: 'dom-chip' }, o.label), el('span', { class: 'dom-side' }, o.side), tr)
      const meter = el('div', { class: 'dom-meter' })
      const fill = el('i', {})
      fill.style.width = `${o.trust}%`
      meter.appendChild(fill)
      li.append(head, meter, el('div', { class: 'dom-det' }, o.det))
      const cf = gexAt(o.price)
      if (cf.length) li.appendChild(el('div', { class: 'dom-cf' }, `+ ${cf.join(' · ')} at this price`))
      return li
    }
    const recDetail = (r: LevelRecord, k: LevelKind): string => {
      const rest = (r.end || now) - r.born
      if (k === 'iceberg') return `${r.refills} refills · ${fmt(r.traded)} traded vs ${fmt(r.maxVis)} shown · ~${fmt(Math.max(0, r.traded - r.maxVis))} hidden so far`
      if (k === 'spoof') return `${fmt(r.cancelled)} cancelled vs ${fmt(r.filled)} traded · sat ${fmtDur(rest)}`
      return `sat ${fmtDur(rest)} · ${r.approaches} approach${r.approaches === 1 ? '' : 'es'} · ${fmt(r.filled)} traded into it · ${fmt(r.vis)} left`
    }
    const poolDetail = (p: StopPool): string => {
      if (p.status === 'swept') return `Swept ${istClock(p.end)} IST: ${fmt(p.swept)} of market orders inside a second · watch for a reversal`
      if (p.status === 'crossed') return `Crossed ${istClock(p.end)} IST without a stop run`
      return `${p.why} · not in the book · ${p.side === 'above' ? 'buy stops of shorts' : 'sell stops of longs'} expected beyond`
    }

    const live: { t: number; node: HTMLElement }[] = []
    for (const r of tr.live.values()) {
      const k = classify(r, now, tr.o), t = trust(r, k, now)
      live.push({ t, node: item({ price: r.price, label: KIND_LABEL[k], color: KIND_COLOR[k], side: r.side, trust: t, det: recDetail(r, k), ended: false }) })
    }
    for (const p of tr.pools) live.push({ t: p.trust, node: item({ price: p.price, label: KIND_LABEL.pool, color: KIND_COLOR.pool, side: p.side, trust: p.trust, det: poolDetail(p), ended: false }) })
    live.sort((a, b) => b.t - a.t)
    this.liveList.replaceChildren(...(live.length ? live.slice(0, 14).map((x) => x.node) : [el('li', { class: 'dom-empty' }, 'No large resting orders near price yet. Levels appear here as the book is watched.')]))

    const ended: { t: number; node: HTMLElement }[] = []
    for (const r of tr.ended.slice(0, 8)) {
      const k = r.kind ?? 'watch'
      const det = `${r.status === 'pulled' ? 'Pulled before price reached it' : 'Traded through'} ${istClock(r.end)} IST · ${recDetail(r, k)}`
      ended.push({ t: r.end, node: item({ price: r.price, label: KIND_LABEL[k], color: KIND_COLOR[k], side: r.side, trust: trust(r, k, now), det, ended: true }) })
    }
    for (const p of tr.endedPools.slice(0, 6)) {
      const label = p.status === 'swept' ? KIND_LABEL.swept : KIND_LABEL.crossed
      ended.push({ t: p.end, node: item({ price: p.price, label, color: p.status === 'swept' ? KIND_COLOR.swept : KIND_COLOR.watch, side: p.side, trust: p.trust, det: poolDetail(p), ended: true }) })
    }
    ended.sort((a, b) => b.t - a.t)
    this.endedList.replaceChildren(...(ended.length ? ended.slice(0, 8).map((x) => x.node) : [el('li', { class: 'dom-empty' }, 'Pulled, traded-through and swept levels appear here.')]))
    this.subEl.textContent = tr.mid
      ? `Ranked by trust · a wall is ${tr.o.wallMult}× the usual quote for ${tr.o.persistMs / 1000}s+ · watching since ${istClock(this.session.openedAt)} IST`
      : 'Watching the book…'
  }
}

/** The book's price increment: the smallest gap between listed prices. */
function inferTick(prices: number[]): number {
  const s = [...new Set(prices)].sort((a, b) => a - b)
  let best = Infinity
  for (let i = 1; i < s.length; i++) {
    const d = s[i] - s[i - 1]
    if (d > 1e-9 && d < best) best = d
  }
  if (!Number.isFinite(best)) return 0.01
  const dec = Math.min(8, Math.max(0, Math.ceil(-Math.log10(best)) + 1))
  return Number(best.toFixed(dec))
}

function heat(a: number): string {
  // deep blue -> cyan -> amber as resting size grows
  const t = Math.min(1, Math.max(0, a))
  const r = Math.round(20 + (235 * Math.max(0, t - 0.55)) / 0.45), gr = Math.round(60 + 150 * Math.min(1, t / 0.6)), b = Math.round(140 + 60 * (1 - t))
  return `rgba(${r},${gr},${b},${(0.04 + t * 0.55).toFixed(2)})`
}

function line(g: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number): void {
  g.beginPath()
  g.moveTo(ax, ay)
  g.lineTo(bx, by)
  g.stroke()
}

function pill(g: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, align: 'left' | 'right' = 'left'): void {
  g.font = `600 10px ${FONT}`
  const w = g.measureText(text).width + 10
  const px = align === 'right' ? x - w : x
  g.fillStyle = 'rgba(11,14,19,.86)'
  g.strokeStyle = color
  g.lineWidth = 1
  g.beginPath()
  g.roundRect(px, y - 8, w, 16, 4)
  g.fill()
  g.stroke()
  g.fillStyle = color
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  g.fillText(text, px + 5, y + 0.5)
}
