/**
 * IV Zone Retest Strategy — retest of a broken expected-move zone, graded by
 * DeepCharts big trades. Draws graded BUY / SELL labels ("BUY A", "SELL B")
 * with entry, stop, TP1 (1R, half off, stop to breakeven) and TP2 (the swing),
 * optional faint zone bands (no text), and a backtest card. Rules and figures:
 * zoneRetestModel.ts.
 *
 * Needs 1h history reaching ~90 sessions before the chart's first candle (the
 * EM, the narrow-day rank and CPR); built for 5m / 15m charts.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import type { StrategyOverlay, StrategyTrade } from '../strategy/types'
import { sessionClosedWeekends, sessionOpenHourUTC } from '../core/session'
import { attachFloatingWidget, type FloatingWidgetHandle } from './floatingWidget'
import { summarize } from './fvVwapEmaModel'
import type { OHLCBar } from './ivWallsModel'
import { drawTradePlot, TRADE_COLORS } from './tradePlot'
import { computeZoneRetest, ZONE_RETEST_DEFAULTS, type ZoneRetestOptions, type ZrResult, type ZrTrade } from './zoneRetestModel'
import { lazyCanvas } from './lazyCanvas'

export interface ZoneRetestOverlayOptions extends ZoneRetestOptions {
  showZones: boolean
  showSignals: boolean
  showTradeLevels: boolean
  showExits: boolean
  showStats: boolean
}

export const ZONE_RETEST_OVERLAY_DEFAULTS: ZoneRetestOverlayOptions = {
  ...ZONE_RETEST_DEFAULTS,
  showZones: true,
  showSignals: true,
  showTradeLevels: true,
  showExits: true,
  showStats: true,
}

export interface ZoneRetestSources {
  /** Ascending 1h bars for the chart's symbol, ending now. */
  fetchHourly(limit: number): Promise<OHLCBar[]>
}

type Rect = { x: number; y: number; width: number; height: number }

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const HISTORY_DAYS = 140 // ~90 weekday sessions: 60-session range rank + 20-day vol + slack
const REFRESH_MS = 120_000
const ZONE_FILL = 'rgba(120,123,134,0.07)'
const ZONE_LINE = 'rgba(120,123,134,0.45)'
const PREV_LINE = 'rgba(120,123,134,0.75)'

function medianBarMs(c: Candle[]): number {
  const n = Math.min(c.length - 1, 50)
  if (n < 1) return 300_000
  const d: number[] = []
  for (let i = c.length - n; i < c.length; i++) d.push(c[i].time - c[i - 1].time)
  d.sort((a, b) => a - b)
  return d[Math.floor(d.length / 2)]
}

export default class ZoneRetestOverlay implements StrategyOverlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly sources: ZoneRetestSources
  private opts: ZoneRetestOverlayOptions
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
  private loading = false
  private gen = 0
  private status = 'idle'
  private barMs = 300_000
  private lastSig = ''
  private result: ZrResult = { sessions: [], trades: [] }
  private revision = 0

  private readonly widgetRoot: HTMLElement
  private readonly widgetBody: HTMLElement
  private readonly dock: FloatingWidgetHandle

  constructor(container: HTMLElement, engine: IChartEngine, sources: ZoneRetestSources, opts?: Partial<ZoneRetestOverlayOptions>) {
    this.container = container
    this.engine = engine
    this.sources = sources
    this.opts = { ...ZONE_RETEST_OVERLAY_DEFAULTS, ...opts }

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
    head.textContent = 'IV ZONE RETEST'
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
    this.loading = false
    this.lastSig = ''
  }

  /** Call whenever the pane's candle array changes (load, history, replay, live tick). */
  setCandles(candles: Candle[]): void {
    this.candles = candles
    if (this.enabled && candles.length && candles[0].time < this.coveredFrom) void this.reload()
  }

  setOptions(patch: Partial<ZoneRetestOverlayOptions>): void {
    this.opts = { ...this.opts, ...patch }
    this.lastSig = ''
    this.syncWidgetVisibility()
  }

  getOptions(): ZoneRetestOverlayOptions {
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
      // New hourly bars close yesterday's session and roll the zones.
      this.pollTimer = window.setInterval(() => void this.reload(true), REFRESH_MS)
      this.start()
    } else this.stop()
  }

  /** Strategy Tester feed — A trades full size, B trades half size. */
  getStrategyTrades(): StrategyTrade[] {
    return this.result.trades.map((t) => ({
      side: t.side,
      entryTime: t.entryTime,
      entryPrice: t.entryPrice,
      exitTime: t.exitTime,
      exitPrice: t.avgExitPrice,
      exitReason: t.exitReason
        ? `${t.tp1Time !== null && t.exitReason !== 'TP' ? `TP1 + ${t.exitReason}` : t.exitReason} (${t.grade}, ${t.zone} retest)`
        : undefined,
      stop: t.stop,
      qty: t.grade === 'A' ? 1 : 0.5,
    }))
  }

  getRevision(): number {
    return this.revision
  }

  getStatus(): string {
    return this.status
  }

  /** The open trade, if any, for the pane legend. */
  getOpenTrade(): ZrTrade | null {
    return this.result.trades.find((t) => t.exitTime === null) ?? null
  }

  reset(): void {
    this.candles = []
    this.lastSig = ''
    this.result = { sessions: [], trades: [] }
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

  private async reload(refresh = false): Promise<void> {
    if (!this.symbol || this.candles.length === 0 || this.loading) return
    const first = this.candles[0].time
    if (!refresh && first >= this.coveredFrom) return
    this.loading = true
    const gen = this.gen
    if (this.hourly.length === 0) this.status = 'loading history…'
    try {
      const from = first - HISTORY_DAYS * DAY_MS
      const limit = Math.ceil((Date.now() - from) / HOUR_MS) + 24
      const bars = await this.sources.fetchHourly(limit)
      if (gen !== this.gen) return
      this.hourly = bars
      this.coveredFrom = Math.min(this.coveredFrom, first)
      this.status = 'live'
      this.lastSig = ''
    } catch (err) {
      if (gen !== this.gen) return
      this.status = 'history unavailable'
      console.warn('[zoneRetest]', err)
    } finally {
      if (gen === this.gen) this.loading = false
    }
  }

  private recompute(): void {
    const c = this.candles
    if (c.length < 3) return
    const last = c[c.length - 1]
    const sig = `${c.length}:${c[0].time}:${last.time}:${last.high}:${last.low}:${last.close}:${last.volume}:${this.hourly.length}:${this.hourly[this.hourly.length - 1]?.time}`
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.barMs = medianBarMs(c)
    this.result = computeZoneRetest(c, this.hourly, this.opts, sessionOpenHourUTC(this.symbol), sessionClosedWeekends(this.symbol))
    this.revision++
    this.renderWidget()
  }

  private renderWidget(): void {
    if (!this.opts.showStats) return
    const all = this.result.trades
    const s = summarize(all)
    const a = summarize(all.filter((t) => t.grade === 'A'))
    const b = summarize(all.filter((t) => t.grade === 'B'))
    const r = (v: number): string => (isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}R` : '—')
    const col = (v: number): string => (!isFinite(v) || v === 0 ? '#d1d4dc' : v > 0 ? TRADE_COLORS.buy : TRADE_COLORS.sell)
    const pct = (v: number): string => (isFinite(v) ? `${Math.round(v * 100)}%` : '—')
    const fmt = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: 2 })
    const today = this.result.sessions[this.result.sessions.length - 1]
    const tf = Math.round(this.barMs / 60_000)
    const goodTf = tf === 5 || tf === 15
    const rows: [string, string, string][] = [
      ['Chart', goodTf ? `${tf}m ✓` : `${tf}m (built for 5m / 15m)`, goodTf ? TRADE_COLORS.buy : '#ffb74d'],
      today
        ? ['Today EM', `±${fmt(today.em)}${today.smallRangeDay && this.opts.skipSmallRange ? ' · quiet day, skip' : ''}`, today.smallRangeDay ? '#ffb74d' : '#64b5f6']
        : ['Today EM', this.status === 'live' ? '—' : this.status, '#787b86'],
      ['Trades (A / B)', `${s.closed} (${a.closed} / ${b.closed})`, '#d1d4dc'],
      ['Win rate (A / B)', `${pct(s.winRate)} (${pct(a.winRate)} / ${pct(b.winRate)})`, '#d1d4dc'],
      ['Avg before fees', r(s.avgGrossR), col(s.avgGrossR)],
      ['Avg A / B', `${r(a.avgGrossR)} / ${r(b.avgGrossR)}`, '#d1d4dc'],
      ['Avg net Delta fees', r(s.avgR), col(s.avgR)],
    ]
    const o = s.open
    if (o) {
      const sl = o.tp1Time !== null ? o.entryPrice : o.stop
      rows.push([`Open ${o.label}`, `${fmt(o.entryPrice)} · ${r(o.grossR)}`, col(o.grossR)])
      rows.push(['SL / TP1 / TP2', `${fmt(sl)} / ${fmt(o.tp1)} / ${fmt(o.target)}`, '#d1d4dc'])
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

  // ---- drawing ----

  private draw(): void {
    this.recompute()
    const dpr = window.devicePixelRatio || 1
    this.ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr)
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect || this.candles.length === 0) return
    const lastTime = this.candles[this.candles.length - 1].time
    if (this.opts.showZones) this.drawZones(conv, rect, lastTime)
    drawTradePlot(this.ctx, conv, rect, this.result.trades, {
      lastTime,
      barMs: this.barMs,
      showSignals: this.opts.showSignals,
      showLevels: this.opts.showTradeLevels,
      showExits: this.opts.showExits,
    })
  }

  /** Faint bands at each zone and a dashed line at the previous close — no text. */
  private drawZones(conv: Converters, rect: Rect, lastTime: number): void {
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    for (const s of this.result.sessions) {
      const x0 = conv.timeToX(s.start)
      const x1 = conv.timeToX(Math.min(s.end, lastTime + this.barMs))
      if (x1 < rect.x || x0 > rect.x + rect.width) continue
      ctx.lineWidth = 1
      for (const lv of s.levels) {
        const yT = Math.round(conv.priceToY(lv + s.halfWidth)) + 0.5
        const yB = Math.round(conv.priceToY(lv - s.halfWidth)) + 0.5
        ctx.fillStyle = ZONE_FILL
        ctx.fillRect(x0, Math.min(yT, yB), x1 - x0, Math.abs(yB - yT))
        ctx.strokeStyle = ZONE_LINE
        ctx.beginPath()
        const y = Math.round(conv.priceToY(lv)) + 0.5
        ctx.moveTo(x0, y)
        ctx.lineTo(x1, y)
        ctx.stroke()
      }
      ctx.strokeStyle = PREV_LINE
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      const yp = Math.round(conv.priceToY(s.prevClose)) + 0.5
      ctx.moveTo(x0, yp)
      ctx.lineTo(x1, yp)
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.restore()
  }
}
