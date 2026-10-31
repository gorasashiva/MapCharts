/**
 * CPR Strategy — the two-mode CPR playbook (see cprStrategyModel.ts) drawn as
 * BUY / SELL labels on the signal candles, with an optional backtest card,
 * exit markers and stop/target lines. Built and tested on 5m charts.
 *
 * Levels come from the previous trading session, so this fetches 1h history
 * for the sessions before the first chart candle (≈40 days, enough for the
 * 14-session ATR and 20-session width percentile) and folds the chart's own
 * candles in after that. Sessions follow the symbol's trading-day open
 * (gold: 03:30 IST, weekends skipped) — core/session.ts.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import type { StrategyOverlay, StrategyTrade } from '../strategy/types'
import { sessionClosedWeekends, sessionOpenHourUTC } from '../core/session'
import { periodBounds, type OHLCBar } from './cprModel'
import { attachFloatingWidget, type FloatingWidgetHandle } from './floatingWidget'
import {
  CPR_STRATEGY_DEFAULTS,
  computeCprStrategy,
  summarize,
  type CprDay,
  type CprStrategyOptions,
  type CprStrategyResult,
  type CprStrategyTrade,
} from './cprStrategyModel'
import { lazyCanvas } from './lazyCanvas'

export interface CprStrategyOverlayOptions extends CprStrategyOptions {
  showSignals: boolean
  showExits: boolean // small TP / SL / END markers where trades closed
  showTradeLines: boolean // stop & target lines across each trade
  showStats: boolean
}

export const CPR_STRATEGY_OVERLAY_DEFAULTS: CprStrategyOverlayOptions = {
  ...CPR_STRATEGY_DEFAULTS,
  showSignals: true,
  showExits: false,
  showTradeLines: false,
  showStats: true,
}

export interface CprStrategySources {
  /** Ascending 1h bars for the chart's symbol, ending before `endTime` (now when omitted). */
  fetchHourly(limit: number, endTime?: number): Promise<OHLCBar[]>
}

type Rect = { x: number; y: number; width: number; height: number }

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const HISTORY_DAYS = 40
const DENSE_BAR_PX = 6
const COLORS = { buy: '#26a69a', sell: '#ef5350', tp: '#26a69a', sl: '#ef5350', end: '#9aa0a6', text: '#ffffff' }

function medianBarMs(c: Candle[]): number {
  const n = Math.min(c.length - 1, 50)
  if (n < 1) return 300_000
  const d: number[] = []
  for (let i = c.length - n; i < c.length; i++) d.push(c[i].time - c[i - 1].time)
  d.sort((a, b) => a - b)
  return d[Math.floor(d.length / 2)]
}

export default class CprStrategyOverlay implements StrategyOverlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly sources: CprStrategySources
  private opts: CprStrategyOverlayOptions
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly ro: ResizeObserver
  private running = false
  private raf = 0
  private enabled = false

  private symbol = ''
  private candles: Candle[] = []
  private hourly: OHLCBar[] = []
  private hourlyKey = '' // symbol:endHour of the loaded history
  private loadingKey = ''
  private gen = 0
  private status = 'idle'
  private barMs = 300_000
  private lastSig = ''
  private result: CprStrategyResult = { days: [], trades: [] }
  private revision = 0

  private readonly widgetRoot: HTMLElement
  private readonly widgetBody: HTMLElement
  private readonly dock: FloatingWidgetHandle

  constructor(container: HTMLElement, engine: IChartEngine, sources: CprStrategySources, opts?: Partial<CprStrategyOverlayOptions>) {
    this.container = container
    this.engine = engine
    this.sources = sources
    this.opts = { ...CPR_STRATEGY_OVERLAY_DEFAULTS, ...opts }

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
    head.textContent = 'CPR STRATEGY'
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
    this.hourlyKey = ''
    this.loadingKey = ''
    this.lastSig = ''
  }

  /** Call whenever the pane's candle array changes (load, history, replay, live tick). */
  setCandles(candles: Candle[]): void {
    this.candles = candles
    if (this.enabled) void this.ensureHistory()
  }

  setOptions(patch: Partial<CprStrategyOverlayOptions>): void {
    this.opts = { ...this.opts, ...patch }
    this.lastSig = ''
    this.syncWidgetVisibility()
  }

  getOptions(): CprStrategyOverlayOptions {
    return { ...this.opts }
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
    this.syncWidgetVisibility()
    if (on) {
      void this.ensureHistory()
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
      exitPrice: t.exitPrice,
      exitReason: t.exitReason ? `${t.exitReason} (${t.mode})` : undefined,
      stop: t.stop,
    }))
  }

  getRevision(): number {
    return this.revision
  }

  /** Today's mode and the latest trade, for the pane legend. */
  getToday(): { day: CprDay | null; last: CprStrategyTrade | null } {
    const t = this.candles[this.candles.length - 1]?.time
    const day = t === undefined ? null : (this.result.days.find((d) => d.start <= t && t < d.end) ?? null)
    return { day, last: this.result.trades[this.result.trades.length - 1] ?? null }
  }

  getStatus(): string {
    return this.status
  }

  reset(): void {
    this.candles = []
    this.lastSig = ''
    this.result = { days: [], trades: [] }
    this.revision++
  }

  destroy(): void {
    this.stop()
    this.gen++
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

  /** 1h bars for the ~40 days before the first chart candle (the chart's own candles cover the rest). */
  private async ensureHistory(): Promise<void> {
    if (!this.symbol || this.candles.length === 0) return
    const first = this.candles[0].time
    const endHour = Math.floor(first / HOUR_MS) * HOUR_MS + HOUR_MS
    const firstLoaded = this.hourly[0]?.time ?? Infinity
    const lastLoaded = this.hourly[this.hourly.length - 1]?.time ?? -Infinity
    // Covered: reaches back ~40 days before the first candle and up to it.
    if (firstLoaded <= first - (HISTORY_DAYS - 2) * DAY_MS && lastLoaded >= first - 2 * HOUR_MS) return
    const key = `${this.symbol}:${endHour}`
    if (key === this.loadingKey || key === this.hourlyKey) return
    this.loadingKey = key
    const gen = this.gen
    this.status = 'loading history…'
    try {
      const bars = await this.sources.fetchHourly(HISTORY_DAYS * 24 + 24, endHour)
      if (gen !== this.gen) return
      this.hourly = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }))
      this.hourlyKey = key
      this.status = 'live'
      this.lastSig = ''
    } catch (err) {
      if (gen !== this.gen) return
      this.status = 'history unavailable'
      console.warn('[cprStrategy]', err)
    } finally {
      if (this.loadingKey === key) this.loadingKey = ''
    }
  }

  private recompute(): void {
    const c = this.candles
    if (c.length < 3) return
    const last = c[c.length - 1]
    const lastClosed = Date.now() >= last.time + this.barMs
    const sig = `${c.length}:${c[0].time}:${last.time}:${last.high}:${last.low}:${last.close}:${lastClosed}:${this.hourly.length}:${this.hourlyKey}`
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.barMs = medianBarMs(c)
    this.result = computeCprStrategy(c, this.hourly, this.opts, sessionOpenHourUTC(this.symbol), sessionClosedWeekends(this.symbol), this.barMs, lastClosed)
    this.revision++
    this.renderWidget()
  }

  private renderWidget(): void {
    if (!this.opts.showStats) return
    const s = summarize(this.result.trades)
    const r = (v: number): string => (isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}R` : '—')
    const col = (v: number): string => (!isFinite(v) || v === 0 ? '#d1d4dc' : v > 0 ? COLORS.buy : COLORS.sell)
    const { day } = this.getToday()
    const today: [string, string, string] = !day
      ? ['Today', this.status === 'live' ? 'No session levels' : this.status, '#787b86']
      : day.mode === 'breakout'
        ? ['Today', 'Narrow CPR → breakout', '#ffb74d']
        : ['Today', 'CPR reclaim', '#d1d4dc']
    const rows: [string, string, string][] = [
      today,
      ['Trades', String(s.closed), '#d1d4dc'],
      ['Win rate', isFinite(s.winRate) ? `${Math.round(s.winRate * 100)}%` : '—', '#d1d4dc'],
      ['Avg (net fees)', r(s.avgR), col(s.avgR)],
      ['Total', r(s.totalR), col(s.totalR)],
      ['Profit factor', isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : s.profitFactor === Infinity ? '∞' : '—', '#d1d4dc'],
      s.open ? [`Open ${s.open.side === 'long' ? 'LONG' : 'SHORT'}`, r(s.open.r), col(s.open.r)] : ['Position', 'Flat', '#787b86'],
    ]
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
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    const t = this.candles[this.candles.length - 1].time
    const dense = conv.timeToX(t) - conv.timeToX(t - this.barMs) < DENSE_BAR_PX
    if (this.opts.showTradeLines) this.drawTradeLines(conv, rect)
    if (this.opts.showExits) this.drawExits(conv, rect)
    if (this.opts.showSignals) this.drawSignals(conv, rect, dense)
    ctx.restore()
  }

  private visible(x: number, rect: Rect, pad = 30): boolean {
    return x >= rect.x - pad && x <= rect.x + rect.width + pad
  }

  private drawTradeLines(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    const lastT = this.candles[this.candles.length - 1].time
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.globalAlpha = 0.75
    for (const tr of this.result.trades) {
      const x0 = conv.timeToX(tr.entryTime)
      const x1 = conv.timeToX(tr.exitTime ?? Math.min(lastT, periodBounds(tr.entryTime, 'day', sessionOpenHourUTC(this.symbol))[1]))
      if (x1 < rect.x || x0 > rect.x + rect.width) continue
      for (const [price, color] of [
        [tr.stop, COLORS.sl],
        [tr.target, COLORS.tp],
      ] as const) {
        const y = Math.round(conv.priceToY(price)) + 0.5
        ctx.strokeStyle = color
        ctx.beginPath()
        ctx.moveTo(x0, y)
        ctx.lineTo(Math.max(x1, x0 + 6), y)
        ctx.stroke()
      }
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  private drawExits(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    ctx.font = '600 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const tr of this.result.trades) {
      if (tr.exitTime === null || tr.exitPrice === null) continue
      const x = conv.timeToX(tr.exitTime)
      if (!this.visible(x, rect)) continue
      const y = conv.priceToY(tr.exitPrice)
      ctx.fillStyle = tr.exitReason === 'TP' ? COLORS.tp : tr.exitReason === 'SL' ? COLORS.sl : COLORS.end
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillText(tr.exitReason === 'Day end' ? 'END' : (tr.exitReason ?? ''), x, y - 9)
    }
  }

  private drawSignals(conv: Converters, rect: Rect, dense: boolean): void {
    const ctx = this.ctx
    ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const tr of this.result.trades) {
      const x = conv.timeToX(tr.entryTime)
      if (!this.visible(x, rect)) continue
      const buy = tr.side === 'long'
      const color = buy ? COLORS.buy : COLORS.sell
      const tipY = buy ? conv.priceToY(tr.barLow) + 6 : conv.priceToY(tr.barHigh) - 6
      if (dense) this.drawArrow(x, tipY, buy, color)
      else this.drawLabel(x, tipY, buy, buy ? 'BUY' : 'SELL', color)
    }
  }

  private drawArrow(x: number, tipY: number, pointUp: boolean, color: string): void {
    const ctx = this.ctx
    const dy = pointUp ? 7 : -7
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(x, tipY)
    ctx.lineTo(x - 4, tipY + dy)
    ctx.lineTo(x + 4, tipY + dy)
    ctx.closePath()
    ctx.fill()
  }

  /** TradingView-style label: below the bar pointing up for BUY, above pointing down for SELL. */
  private drawLabel(x: number, tipY: number, pointUp: boolean, text: string, color: string): void {
    const ctx = this.ctx
    const w = ctx.measureText(text).width + 10
    const h = 16
    const arrow = 5
    const boxY = pointUp ? tipY + arrow : tipY - arrow - h
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(x, tipY)
    ctx.lineTo(x - arrow, pointUp ? tipY + arrow : tipY - arrow)
    ctx.lineTo(x + arrow, pointUp ? tipY + arrow : tipY - arrow)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.roundRect(x - w / 2, boxY, w, h, 3)
    ctx.fill()
    ctx.fillStyle = COLORS.text
    ctx.fillText(text, x, boxY + h / 2 + 0.5)
  }
}
