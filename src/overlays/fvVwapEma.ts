/**
 * FV + VWAP + EMA — port of "test strategy.pine" (Fractal Vector + VWAP Bands
 * + EMA 9/21/50 combo) with BUY / SELL labels for the setups backtested on
 * XAUTUSD 3m / 5m and a backtest card. Model and rules: fvVwapEmaModel.ts.
 *
 * Plots follow the Pine script: chart-TF vector (blue step line), HTF vector
 * (purple step line), VWAP (red dots), ±σ bands (grey, filled), EMA 9 (blue,
 * thick), EMA 21 (green), EMA 50 (red) with floating labels at the right edge.
 * The VWAP "Day" anchor follows the symbol's trading-day open (core/session.ts).
 *
 * Each trade is drawn as a TradingView-style position: entry line, red stop
 * (stepping up to the entry once TP1 fills), TP1 and TP2 lines from entry to
 * exit, with price tags on the most recent trade.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import type { StrategyOverlay, StrategyTrade } from '../strategy/types'
import { sessionOpenHourUTC } from '../core/session'
import { attachFloatingWidget, type FloatingWidgetHandle } from './floatingWidget'
import { drawTradePlot, TRADE_COLORS } from './tradePlot'
import {
  FV_VWAP_EMA_DEFAULTS,
  computeFvVwapEma,
  summarize,
  presetForBar,
  type FvPoint,
  type FvResult,
  type FvVwapEmaOptions,
} from './fvVwapEmaModel'
import { lazyCanvas } from './lazyCanvas'

export interface FvVwapEmaOverlayOptions extends FvVwapEmaOptions {
  showLtfVector: boolean
  showHtfVector: boolean
  showVwap: boolean
  showBands: boolean
  showEmas: boolean
  showEmaLabels: boolean
  showSignals: boolean
  /** Entry / SL / TP1 / TP2 lines for each trade. */
  showTradeLevels: boolean
  showExits: boolean
  showStats: boolean
}

export const FV_VWAP_EMA_OVERLAY_DEFAULTS: FvVwapEmaOverlayOptions = {
  ...FV_VWAP_EMA_DEFAULTS,
  showLtfVector: true,
  showHtfVector: true,
  showVwap: true,
  showBands: true,
  showEmas: true,
  showEmaLabels: true,
  showSignals: true,
  showTradeLevels: true,
  showExits: false,
  showStats: true,
}

type Rect = { x: number; y: number; width: number; height: number }

const COLORS = {
  ltf: '#2962ff',
  htf: '#9c27b0',
  vwap: '#f23645',
  band: 'rgba(120,123,134,0.6)',
  bandFill: 'rgba(120,123,134,0.10)',
  e1: '#2962ff',
  e2: '#4caf50',
  e3: '#f23645',
  buy: TRADE_COLORS.buy,
  sell: TRADE_COLORS.sell,
  text: '#ffffff',
}

function medianBarMs(c: Candle[]): number {
  const n = Math.min(c.length - 1, 50)
  if (n < 1) return 300_000
  const d: number[] = []
  for (let i = c.length - n; i < c.length; i++) d.push(c[i].time - c[i - 1].time)
  d.sort((a, b) => a - b)
  return d[Math.floor(d.length / 2)]
}

export default class FvVwapEmaOverlay implements StrategyOverlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private opts: FvVwapEmaOverlayOptions
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly ro: ResizeObserver
  private running = false
  private raf = 0
  private enabled = false

  private symbol = ''
  private candles: Candle[] = []
  private barMs = 300_000
  private lastSig = ''
  private result: FvResult = { points: [], trades: [], used: FV_VWAP_EMA_DEFAULTS }
  private revision = 0

  private readonly widgetRoot: HTMLElement
  private readonly widgetBody: HTMLElement
  private readonly dock: FloatingWidgetHandle

  constructor(container: HTMLElement, engine: IChartEngine, opts?: Partial<FvVwapEmaOverlayOptions>) {
    this.container = container
    this.engine = engine
    this.opts = { ...FV_VWAP_EMA_OVERLAY_DEFAULTS, ...opts }

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
    head.textContent = 'FV + VWAP + EMA'
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
    this.symbol = symbol
    this.lastSig = ''
  }

  /** Call whenever the pane's candle array changes (load, history, replay, live tick). */
  setCandles(candles: Candle[]): void {
    this.candles = candles
  }

  setOptions(patch: Partial<FvVwapEmaOverlayOptions>): void {
    this.opts = { ...this.opts, ...patch }
    this.lastSig = ''
    this.syncWidgetVisibility()
  }

  getOptions(): FvVwapEmaOverlayOptions {
    return { ...this.opts }
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
    this.syncWidgetVisibility()
    if (on) this.start()
    else this.stop()
  }

  getStrategyTrades(): StrategyTrade[] {
    return this.result.trades.map((t) => ({
      side: t.side,
      entryTime: t.entryTime,
      entryPrice: t.entryPrice,
      exitTime: t.exitTime,
      // Both halves blended, so the tester's P&L matches the scale-out.
      exitPrice: t.avgExitPrice,
      exitReason: t.exitReason
        ? `${t.tp1Time !== null && t.exitReason !== 'TP' ? `TP1 + ${t.exitReason}` : t.exitReason} (${t.setup === 'flip' ? 'aligned flip' : 'EMA21 pullback'})`
        : undefined,
      stop: t.stop,
    }))
  }

  getRevision(): number {
    return this.revision
  }

  reset(): void {
    this.candles = []
    this.lastSig = ''
    this.result = { points: [], trades: [], used: FV_VWAP_EMA_DEFAULTS }
    this.revision++
  }

  destroy(): void {
    this.stop()
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

  private recompute(): void {
    const c = this.candles
    if (c.length < 3) return
    const last = c[c.length - 1]
    const lastClosed = Date.now() >= last.time + this.barMs
    const sig = `${c.length}:${c[0].time}:${last.time}:${last.high}:${last.low}:${last.close}:${last.volume}:${lastClosed}`
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.barMs = medianBarMs(c)
    this.result = computeFvVwapEma(c, this.opts, sessionOpenHourUTC(this.symbol), this.barMs, lastClosed)
    this.revision++
    this.renderWidget()
  }

  private renderWidget(): void {
    if (!this.opts.showStats) return
    const s = summarize(this.result.trades)
    const r = (v: number): string => (isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}R` : '—')
    const col = (v: number): string => (!isFinite(v) || v === 0 ? '#d1d4dc' : v > 0 ? COLORS.buy : COLORS.sell)
    const p = this.result.points[this.result.points.length - 1]
    const arrow = (d: number): string => (d === 1 ? '▲' : d === -1 ? '▼' : '—')
    const u = this.result.used
    const tf = (m: number): string => (m % 60 === 0 ? `${m / 60}h` : `${m}m`)
    const htfs = u.htf2Minutes ? `${tf(u.htfMinutes)}+${tf(u.htf2Minutes)}` : tf(u.htfMinutes)
    const aligned = p && p.htfDir === p.dir && (!u.htf2Minutes || p.htf2Dir === p.dir)
    const biasColor = !p ? '#787b86' : aligned ? (p.dir === 1 ? COLORS.buy : COLORS.sell) : '#d1d4dc'
    const htfArrows = p ? (u.htf2Minutes ? `${arrow(p.htfDir)}${arrow(p.htf2Dir)}` : arrow(p.htfDir)) : ''
    const preset = u.autoTune ? presetForBar(this.barMs) : null
    const setups = [u.flipSignals && 'Flip', u.pullbackSignals && 'Pullback'].filter(Boolean).join(' + ') || 'none'
    const pct = (v: number): string => (isFinite(v) ? `${Math.round(v * 100)}%` : '—')
    const rows: [string, string, string][] = [
      ['Mode', `${preset ? `Auto ${preset}` : 'Custom'} · ${setups}`, '#d1d4dc'],
      ['Bias', p ? `HTF ${htfs} ${htfArrows} · LTF ${arrow(p.dir)}` : '—', biasColor],
      ['Trades', String(s.closed), '#d1d4dc'],
      ['Win rate', pct(s.winRate), '#d1d4dc'],
      ...(u.exitMode === 'scale' ? [['TP1 hit', pct(s.tp1Rate), '#d1d4dc'] as [string, string, string]] : []),
      ['Avg (before fees)', r(s.avgGrossR), col(s.avgGrossR)],
      ['Avg (net Delta fees)', r(s.avgR), col(s.avgR)],
      ['Profit factor (net)', isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : s.profitFactor === Infinity ? '∞' : '—', '#d1d4dc'],
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
    if (!conv || !rect || this.candles.length === 0 || this.result.points.length !== this.candles.length) return
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    const [from, to] = this.visibleRange(conv, rect)
    if (this.opts.showBands) this.drawBands(conv, from, to)
    if (this.opts.showEmas) {
      this.drawLine(conv, from, to, (p) => p.e3, COLORS.e3, 1)
      this.drawLine(conv, from, to, (p) => p.e2, COLORS.e2, 1)
      this.drawLine(conv, from, to, (p) => p.e1, COLORS.e1, 3)
    }
    if (this.opts.showHtfVector) this.drawStep(conv, from, to, (p) => p.htfLvl, COLORS.htf)
    if (this.opts.showLtfVector) this.drawStep(conv, from, to, (p) => p.lvl, COLORS.ltf)
    if (this.opts.showVwap) this.drawDots(conv, from, to, (p) => p.vwap, COLORS.vwap)
    ctx.restore()
    if (this.opts.showEmas && this.opts.showEmaLabels) this.drawEmaLabels(conv, rect)
    drawTradePlot(ctx, conv, rect, this.result.trades, {
      lastTime: this.candles[this.candles.length - 1].time,
      barMs: this.barMs,
      showSignals: this.opts.showSignals,
      showLevels: this.opts.showTradeLevels,
      showExits: this.opts.showExits,
    })
  }

  /** Candle indices on screen, padded one bar each side so lines run off the edges. */
  private visibleRange(conv: Converters, rect: Rect): [number, number] {
    const c = this.candles
    const t0 = conv.xToTime(rect.x)
    const t1 = conv.xToTime(rect.x + rect.width)
    let lo = 0
    let hi = c.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (c[m].time < t0) lo = m + 1
      else hi = m
    }
    let end = lo
    while (end < c.length - 1 && c[end].time <= t1) end++
    return [Math.max(0, lo - 1), end]
  }

  private drawLine(conv: Converters, from: number, to: number, get: (p: FvPoint) => number, color: string, width: number): void {
    const ctx = this.ctx
    const pts = this.result.points
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.beginPath()
    let pen = false
    for (let i = from; i <= to; i++) {
      const v = get(pts[i])
      if (!isFinite(v)) {
        pen = false
        continue
      }
      const x = conv.timeToX(this.candles[i].time)
      const y = conv.priceToY(v)
      if (pen) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
      pen = true
    }
    ctx.stroke()
  }

  private drawStep(conv: Converters, from: number, to: number, get: (p: FvPoint) => number, color: string): void {
    const ctx = this.ctx
    const pts = this.result.points
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    let prevY = NaN
    for (let i = from; i <= to; i++) {
      const v = get(pts[i])
      if (!isFinite(v)) {
        prevY = NaN
        continue
      }
      const x = conv.timeToX(this.candles[i].time)
      const y = Math.round(conv.priceToY(v)) + 0.5
      if (isNaN(prevY)) ctx.moveTo(x, y)
      else {
        ctx.lineTo(x, prevY)
        ctx.lineTo(x, y)
      }
      prevY = y
    }
    ctx.stroke()
  }

  private drawDots(conv: Converters, from: number, to: number, get: (p: FvPoint) => number, color: string): void {
    const ctx = this.ctx
    const pts = this.result.points
    ctx.fillStyle = color
    for (let i = from; i <= to; i++) {
      const v = get(pts[i])
      if (!isFinite(v)) continue
      ctx.beginPath()
      ctx.arc(conv.timeToX(this.candles[i].time), conv.priceToY(v), 1.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /** ±σ bands, filled between; broken at each anchor reset so sessions don't join up. */
  private drawBands(conv: Converters, from: number, to: number): void {
    const ctx = this.ctx
    const pts = this.result.points
    const flush = (a: number, b: number): void => {
      if (b <= a) return
      ctx.beginPath()
      for (let i = a; i <= b; i++) ctx.lineTo(conv.timeToX(this.candles[i].time), conv.priceToY(pts[i].upper))
      for (let i = b; i >= a; i--) ctx.lineTo(conv.timeToX(this.candles[i].time), conv.priceToY(pts[i].lower))
      ctx.closePath()
      ctx.fillStyle = COLORS.bandFill
      ctx.fill()
      ctx.strokeStyle = COLORS.band
      ctx.lineWidth = 1
      for (const k of ['upper', 'lower'] as const) {
        ctx.beginPath()
        for (let i = a; i <= b; i++) ctx.lineTo(conv.timeToX(this.candles[i].time), conv.priceToY(pts[i][k]))
        ctx.stroke()
      }
    }
    let s = from
    for (let i = from + 1; i <= to; i++) {
      // The band collapses to zero width on the first bar of each anchor period.
      if (pts[i].upper === pts[i].lower) {
        flush(s, i - 1)
        s = i
      }
    }
    flush(s, to)
  }

  /** "EMA 9 / 21 / 50" tags just right of the last bar, like the Pine floating labels. */
  private drawEmaLabels(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    const last = this.result.points[this.result.points.length - 1]
    const x = conv.timeToX(this.candles[this.candles.length - 1].time + 2 * this.barMs)
    if (x > rect.x + rect.width - 10) return
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    for (const [v, len, color] of [
      [last.e1, this.opts.ema1, COLORS.e1],
      [last.e2, this.opts.ema2, COLORS.e2],
      [last.e3, this.opts.ema3, COLORS.e3],
    ] as const) {
      if (!isFinite(v)) continue
      const text = `EMA ${len}`
      const y = conv.priceToY(v)
      const w = ctx.measureText(text).width + 8
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.roundRect(x, y - 7, w, 14, 2)
      ctx.fill()
      ctx.fillStyle = COLORS.text
      ctx.fillText(text, x + 4, y + 0.5)
    }
  }
}
