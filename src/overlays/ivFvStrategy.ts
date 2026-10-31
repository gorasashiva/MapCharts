/**
 * IV × FV Strategy — trades only: BUY / SELL labels with entry, stop, TP1 and
 * TP2 for the FV signals, TP2 capped at the next IV expected-move zone, plus
 * the optional ±1× zone fade. No indicator lines are drawn. Rules and
 * backtest figures: ivFvStrategyModel.ts.
 *
 * Needs 1h history reaching ~30 sessions before the chart's first candle (the
 * zones' realized-vol fallback) and, where the symbol has one, the options
 * chain for today's IV.
 */
import type { IChartEngine } from '../chart/types'
import type { Candle } from '../core/types'
import type { StrategyOverlay, StrategyTrade } from '../strategy/types'
import { sessionClosedWeekends, sessionOpenHourUTC } from '../core/session'
import { attachFloatingWidget, type FloatingWidgetHandle } from './floatingWidget'
import { presetForBar, resolveOptions, summarize } from './fvVwapEmaModel'
import { impliedFromChain, type ChainPoint, type OHLCBar } from './ivWallsModel'
import { computeIvFvStrategy, IV_FV_STRATEGY_DEFAULTS, type IvFvResult, type IvFvStrategyOptions, type IvFvTrade } from './ivFvStrategyModel'
import { drawTradePlot, TRADE_COLORS } from './tradePlot'
import { lazyCanvas } from './lazyCanvas'

export interface IvFvStrategyOverlayOptions extends IvFvStrategyOptions {
  showSignals: boolean
  showTradeLevels: boolean
  showExits: boolean
  showStats: boolean
}

export const IV_FV_STRATEGY_OVERLAY_DEFAULTS: IvFvStrategyOverlayOptions = {
  ...IV_FV_STRATEGY_DEFAULTS,
  showSignals: true,
  showTradeLevels: true,
  showExits: true,
  showStats: true,
}

export interface IvFvStrategySources {
  /** Ascending 1h bars for the chart's symbol, ending now. */
  fetchHourly(limit: number): Promise<OHLCBar[]>
  /** The symbol's options chain, or null if it has none. */
  fetchChain(): Promise<ChainPoint[] | null>
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const REFRESH_MS = 120_000
/** The timeframe the backtest favoured — shown on the card. */
const BEST_TF = '3m'
const SETUP_NAME = { flip: 'aligned flip', pullback: 'EMA21 pullback', fade: '±1× zone fade' } as const

function medianBarMs(c: Candle[]): number {
  const n = Math.min(c.length - 1, 50)
  if (n < 1) return 300_000
  const d: number[] = []
  for (let i = c.length - n; i < c.length; i++) d.push(c[i].time - c[i - 1].time)
  d.sort((a, b) => a - b)
  return d[Math.floor(d.length / 2)]
}

export default class IvFvStrategyOverlay implements StrategyOverlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly sources: IvFvStrategySources
  private opts: IvFvStrategyOverlayOptions
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly ro: ResizeObserver
  private running = false
  private raf = 0
  private enabled = false
  private pollTimer: number | null = null

  private symbol = ''
  private candles: Candle[] = []
  private hourly: OHLCBar[] = []
  /** First chart candle time the loaded history was fetched for; earlier candles trigger a reload. */
  private coveredFrom = Infinity
  private liveIV: number | null = null
  private loading = false
  private gen = 0
  private status = 'idle'
  private barMs = 300_000
  private lastSig = ''
  private result: IvFvResult = { trades: [], zones: [] }
  private revision = 0

  private readonly widgetRoot: HTMLElement
  private readonly widgetBody: HTMLElement
  private readonly dock: FloatingWidgetHandle

  constructor(container: HTMLElement, engine: IChartEngine, sources: IvFvStrategySources, opts?: Partial<IvFvStrategyOverlayOptions>) {
    this.container = container
    this.engine = engine
    this.sources = sources
    this.opts = { ...IV_FV_STRATEGY_OVERLAY_DEFAULTS, ...opts }

    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '18', display: 'none' })
    container.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)

    // Same card styling (.uv2-*) and bottom-right slot as the other strategy cards.
    this.widgetRoot = document.createElement('div')
    this.widgetRoot.className = 'uv2-widget'
    this.widgetRoot.style.display = 'none'
    const head = document.createElement('div')
    head.className = 'uv2-head'
    head.textContent = 'IV × FV STRATEGY'
    this.widgetBody = document.createElement('div')
    this.widgetBody.className = 'uv2-body'
    this.widgetRoot.append(head, this.widgetBody)
    container.appendChild(this.widgetRoot)
    this.dock = attachFloatingWidget(container, this.widgetRoot, 'bottom-right')

    this.resize()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
  }

  resize(): void {
    const r = this.container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(r.width * dpr)
    this.canvas.height = Math.round(r.height * dpr)
    this.canvas.style.width = `${r.width}px`
    this.canvas.style.height = `${r.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.dock.resize()
  }

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return
    this.symbol = symbol
    this.gen++
    this.hourly = []
    this.coveredFrom = Infinity
    this.liveIV = null
    this.loading = false
    this.lastSig = ''
  }

  /** Call whenever the pane's candle array changes (load, history, replay, live tick). */
  setCandles(candles: Candle[]): void {
    this.candles = candles
    if (this.enabled && candles.length && candles[0].time < this.coveredFrom) void this.reload()
  }

  setOptions(patch: Partial<IvFvStrategyOverlayOptions>): void {
    const needsMore = patch.hvLookback !== undefined && patch.hvLookback > this.opts.hvLookback
    this.opts = { ...this.opts, ...patch }
    this.lastSig = ''
    this.syncWidgetVisibility()
    if (needsMore) {
      this.coveredFrom = Infinity
      if (this.enabled) void this.reload()
    }
  }

  getOptions(): IvFvStrategyOverlayOptions {
    return { ...this.opts }
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
    this.syncWidgetVisibility()
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (on) {
      void this.reload()
      // Hourly bars close yesterday's session and the chain's IV moves — refresh both.
      this.pollTimer = window.setInterval(() => void this.reload(true), REFRESH_MS)
      this.start()
    } else this.stop()
  }

  /** Strategy Tester feed — stops included, so the tester reports R multiples. */
  getStrategyTrades(): StrategyTrade[] {
    return this.result.trades.map((t) => ({
      side: t.side,
      entryTime: t.entryTime,
      entryPrice: t.entryPrice,
      exitTime: t.exitTime,
      // Both halves blended, so the tester's P&L matches the scale-out.
      exitPrice: t.avgExitPrice,
      exitReason: t.exitReason
        ? `${t.tp1Time !== null && t.exitReason !== 'TP' ? `TP1 + ${t.exitReason}` : t.exitReason}${t.zoneTarget && t.exitReason === 'TP' ? ' @ IV zone' : ''} (${SETUP_NAME[t.setup]})`
        : undefined,
      stop: t.stop,
    }))
  }

  getRevision(): number {
    return this.revision
  }

  getStatus(): string {
    return this.status
  }

  /** The open trade, if any, for the pane legend. */
  getOpenTrade(): IvFvTrade | null {
    return this.result.trades.find((t) => t.exitTime === null) ?? null
  }

  reset(): void {
    this.candles = []
    this.lastSig = ''
    this.result = { trades: [], zones: [] }
    this.revision++
  }

  destroy(): void {
    this.stop()
    this.gen++
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.ro.disconnect()
    this.dock.destroy()
    this.widgetRoot.remove()
    this.canvas.remove()
  }

  private start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      this.draw()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  private stop(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  private syncWidgetVisibility(): void {
    const show = this.enabled && this.opts.showStats
    this.widgetRoot.style.display = show ? 'flex' : 'none'
    this.dock.setVisible(show)
  }

  // ---- data ----

  /** 1h history back past the chart's first session by the HV lookback, plus today's option IV. */
  private async reload(refresh = false): Promise<void> {
    if (!this.symbol || this.candles.length === 0 || this.loading) return
    const first = this.candles[0].time
    if (!refresh && first >= this.coveredFrom) return
    this.loading = true
    const gen = this.gen
    if (this.hourly.length === 0) this.status = 'loading history…'
    try {
      // ~1.6 calendar days per trading session leaves room for weekends.
      const from = first - Math.ceil((this.opts.hvLookback + 5) * 1.6) * DAY_MS
      const limit = Math.ceil((Date.now() - from) / HOUR_MS) + 24
      const [bars, chain] = await Promise.all([this.sources.fetchHourly(limit), this.sources.fetchChain().catch(() => null)])
      if (gen !== this.gen) return
      this.hourly = bars
      this.coveredFrom = Math.min(this.coveredFrom, first)
      const spot = this.candles[this.candles.length - 1]?.close ?? 0
      this.liveIV = chain && chain.length ? (impliedFromChain(chain, spot, Date.now())?.atmIV ?? null) : null
      this.status = 'live'
      this.lastSig = ''
    } catch (err) {
      if (gen !== this.gen) return
      this.status = 'history unavailable'
      console.warn('[ivFvStrategy]', err)
    } finally {
      if (gen === this.gen) this.loading = false
    }
  }

  private recompute(): void {
    const c = this.candles
    if (c.length < 3) return
    const last = c[c.length - 1]
    const lastClosed = Date.now() >= last.time + this.barMs
    const sig = `${c.length}:${c[0].time}:${last.time}:${last.high}:${last.low}:${last.close}:${last.volume}:${lastClosed}:${this.hourly.length}:${this.liveIV}`
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.barMs = medianBarMs(c)
    const open = sessionOpenHourUTC(this.symbol)
    this.result = computeIvFvStrategy(c, this.hourly, this.opts, open, sessionClosedWeekends(this.symbol), this.liveIV, this.barMs, lastClosed)
    this.revision++
    this.renderWidget()
  }

  private renderWidget(): void {
    if (!this.opts.showStats) return
    const s = summarize(this.result.trades)
    const r = (v: number): string => (isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}R` : '—')
    const col = (v: number): string => (!isFinite(v) || v === 0 ? '#d1d4dc' : v > 0 ? TRADE_COLORS.buy : TRADE_COLORS.sell)
    const pct = (v: number): string => (isFinite(v) ? `${Math.round(v * 100)}%` : '—')
    const fmt = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: 2 })
    const preset = this.opts.autoTune ? presetForBar(this.barMs) : null
    const used = resolveOptions(this.opts, this.barMs)
    const setups = [used.flipSignals && 'Flip', used.pullbackSignals && 'Pullback', this.opts.fadeSetup && '±1× fade'].filter(Boolean).join(' + ') || 'none'
    const today = this.result.zones[this.result.zones.length - 1]
    const ivName = today?.ivSource === 'implied' ? 'Option IV' : today?.ivSource === 'override' ? 'IV (typed)' : 'HV'
    const ivRow: [string, string, string] =
      today && today.em !== null && today.iv !== null
        ? [`${ivName} · EM`, `${(today.iv * 100).toFixed(1)}% · ±${fmt(today.em)}`, '#64b5f6']
        : ['IV · EM', this.status === 'live' ? '—' : this.status, '#787b86']
    const rows: [string, string, string][] = [
      ['Watch', preset === BEST_TF ? `${BEST_TF} ✓` : `${BEST_TF} (best tested)`, preset === BEST_TF ? TRADE_COLORS.buy : '#ffb74d'],
      ['Mode', `${preset ? `Auto ${preset}` : 'Custom'} · ${setups}`, '#d1d4dc'],
      ivRow,
      ['Trades', String(s.closed), '#d1d4dc'],
      ['Win rate', pct(s.winRate), '#d1d4dc'],
      ['TP1 hit', pct(s.tp1Rate), '#d1d4dc'],
      ['Avg (before fees)', r(s.avgGrossR), col(s.avgGrossR)],
      ['Avg (net Delta fees)', r(s.avgR), col(s.avgR)],
    ]
    const o = s.open
    if (o) {
      const sl = o.tp1Time !== null ? o.entryPrice : o.stop
      rows.push([`Open ${o.side === 'long' ? 'LONG' : 'SHORT'}`, `${fmt(o.entryPrice)} · ${r(o.r)}`, col(o.r)])
      rows.push(['SL / TP1 / TP2', `${fmt(sl)} / ${o.tp1 !== null ? fmt(o.tp1) : '—'} / ${o.target !== null ? fmt(o.target) : '—'}`, '#d1d4dc'])
    } else rows.push(['Position', 'Flat', '#787b86'])
    this.widgetBody.replaceChildren(
      ...rows.map(([label, value, color]) => {
        const row = document.createElement('div')
        row.className = 'uv2-row'
        const l = document.createElement('span')
        l.className = 'uv2-label'
        l.textContent = label
        const v = document.createElement('span')
        v.className = 'uv2-value'
        v.style.color = color
        v.textContent = value
        row.append(l, v)
        return row
      }),
    )
  }

  private draw(): void {
    this.recompute()
    const dpr = window.devicePixelRatio || 1
    this.ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr)
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect || this.candles.length === 0) return
    drawTradePlot(this.ctx, conv, rect, this.result.trades, {
      lastTime: this.candles[this.candles.length - 1].time,
      barMs: this.barMs,
      showSignals: this.opts.showSignals,
      showLevels: this.opts.showTradeLevels,
      showExits: this.opts.showExits,
    })
  }
}
