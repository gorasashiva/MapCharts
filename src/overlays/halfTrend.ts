/**
 * HalfTrend — chart overlay for "halftrend.pine" (everget). Math: halfTrendModel.ts.
 *
 * Plots follow the Pine script: the HalfTrend line (blue in an uptrend, red in a
 * downtrend, 2px), the ATR channel as small dots (red above, blue below) with
 * translucent ribbons between line and channel, triangles at each flip and
 * Buy / Sell tags.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import { HALF_TREND_DEFAULTS, computeHalfTrend, type HalfTrendOptions, type HalfTrendPoint } from './halfTrendModel'
import { lazyCanvas } from './lazyCanvas'

export interface HalfTrendOverlayOptions extends HalfTrendOptions {
  showArrows: boolean
  showChannels: boolean
  showLabels: boolean
}

export const HALF_TREND_OVERLAY_DEFAULTS: HalfTrendOverlayOptions = {
  ...HALF_TREND_DEFAULTS,
  showArrows: true,
  showChannels: true,
  showLabels: true,
}

type Rect = { x: number; y: number; width: number; height: number }

// Pine's color.blue / color.red, fills at 85% transparency.
const COLORS = {
  buy: '#2962ff',
  sell: '#f23645',
  buyFill: 'rgba(41,98,255,0.15)',
  sellFill: 'rgba(242,54,69,0.15)',
  text: '#ffffff',
}

export default class HalfTrendOverlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private opts: HalfTrendOverlayOptions
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly ro: ResizeObserver
  private running = false
  private raf = 0

  private candles: Candle[] = []
  private points: HalfTrendPoint[] = []
  private lastSig = ''

  constructor(container: HTMLElement, engine: IChartEngine, opts?: Partial<HalfTrendOverlayOptions>) {
    this.container = container
    this.engine = engine
    this.opts = { ...HALF_TREND_OVERLAY_DEFAULTS, ...opts }

    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '18', display: 'none' })
    container.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)

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
  }

  /** Call whenever the pane's candle array changes (load, history, replay, live tick). */
  setCandles(candles: Candle[]): void {
    this.candles = candles
  }

  setOptions(patch: Partial<HalfTrendOverlayOptions>): void {
    this.opts = { ...this.opts, ...patch }
    this.lastSig = ''
  }

  getOptions(): HalfTrendOverlayOptions {
    return { ...this.opts }
  }

  setEnabled(on: boolean): void {
    this.canvas.style.display = on ? 'block' : 'none'
    if (on) this.start()
    else this.stop()
  }

  reset(): void {
    this.candles = []
    this.points = []
    this.lastSig = ''
  }

  destroy(): void {
    this.stop()
    this.ro.disconnect()
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

  private recompute(): void {
    const c = this.candles
    if (c.length === 0) return
    const last = c[c.length - 1]
    const sig = `${c.length}:${c[0].time}:${last.time}:${last.high}:${last.low}:${last.close}:${this.opts.amplitude}:${this.opts.channelDeviation}`
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.points = computeHalfTrend(c, this.opts)
  }

  // ---- drawing ----

  private draw(): void {
    this.recompute()
    const dpr = window.devicePixelRatio || 1
    this.ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr)
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect || this.candles.length === 0 || this.points.length !== this.candles.length) return
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    const [from, to] = this.visibleRange(conv, rect)
    if (this.opts.showChannels) {
      this.drawRibbon(conv, from, to, 'atrHigh', COLORS.sellFill)
      this.drawRibbon(conv, from, to, 'atrLow', COLORS.buyFill)
      this.drawDots(conv, from, to, 'atrHigh', COLORS.sell)
      this.drawDots(conv, from, to, 'atrLow', COLORS.buy)
    }
    this.drawLine(conv, from, to)
    if (this.opts.showArrows || this.opts.showLabels) this.drawSignals(conv, from, to)
    ctx.restore()
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

  /** Each segment takes the colour of the bar it ends on, as Pine's per-bar plot colour does. */
  private drawLine(conv: Converters, from: number, to: number): void {
    const ctx = this.ctx
    const pts = this.points
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    for (let i = Math.max(from, 1); i <= to; i++) {
      const a = pts[i - 1].ht
      const b = pts[i].ht
      if (!isFinite(a) || !isFinite(b)) continue
      ctx.strokeStyle = pts[i].trend === 0 ? COLORS.buy : COLORS.sell
      ctx.beginPath()
      ctx.moveTo(conv.timeToX(this.candles[i - 1].time), conv.priceToY(a))
      ctx.lineTo(conv.timeToX(this.candles[i].time), conv.priceToY(b))
      ctx.stroke()
    }
  }

  private drawDots(conv: Converters, from: number, to: number, key: 'atrHigh' | 'atrLow', color: string): void {
    const ctx = this.ctx
    ctx.fillStyle = color
    for (let i = from; i <= to; i++) {
      const v = this.points[i][key]
      if (!isFinite(v)) continue
      ctx.beginPath()
      ctx.arc(conv.timeToX(this.candles[i].time), conv.priceToY(v), 1.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /** Fill between the HalfTrend line and one channel edge, in runs where both exist. */
  private drawRibbon(conv: Converters, from: number, to: number, key: 'atrHigh' | 'atrLow', color: string): void {
    const ctx = this.ctx
    const pts = this.points
    ctx.fillStyle = color
    const flush = (a: number, b: number): void => {
      if (b <= a) return
      ctx.beginPath()
      for (let i = a; i <= b; i++) ctx.lineTo(conv.timeToX(this.candles[i].time), conv.priceToY(pts[i][key]))
      for (let i = b; i >= a; i--) ctx.lineTo(conv.timeToX(this.candles[i].time), conv.priceToY(pts[i].ht))
      ctx.closePath()
      ctx.fill()
    }
    let s = -1
    for (let i = from; i <= to; i++) {
      const ok = isFinite(pts[i][key]) && isFinite(pts[i].ht)
      if (ok && s < 0) s = i
      if (!ok && s >= 0) {
        flush(s, i - 1)
        s = -1
      }
    }
    if (s >= 0) flush(s, to)
  }

  /** Triangle at the channel edge and a Buy / Sell tag beyond it, like the Pine plotshapes. */
  private drawSignals(conv: Converters, from: number, to: number): void {
    const ctx = this.ctx
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = from; i <= to; i++) {
      const p = this.points[i]
      if (!p.buy && !p.sell) continue
      const buy = p.buy
      const v = buy ? p.atrLow : p.atrHigh
      if (!isFinite(v)) continue
      const x = conv.timeToX(this.candles[i].time)
      const y = conv.priceToY(v)
      const dir = buy ? 1 : -1 // +1 draws below the level, −1 above
      const color = buy ? COLORS.buy : COLORS.sell
      let offset = 0
      if (this.opts.showArrows) {
        ctx.fillStyle = color
        ctx.beginPath()
        const tip = y + dir * 3
        const base = tip + dir * 7
        ctx.moveTo(x, tip)
        ctx.lineTo(x - 4.5, base)
        ctx.lineTo(x + 4.5, base)
        ctx.closePath()
        ctx.fill()
        offset = 10
      }
      if (this.opts.showLabels) {
        const text = buy ? 'Buy' : 'Sell'
        const w = ctx.measureText(text).width + 10
        const h = 15
        const top = dir > 0 ? y + 3 + offset + 4 : y - 3 - offset - 4 - h
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.roundRect(x - w / 2, top, w, h, 2)
        ctx.fill()
        // Pointer toward the level, like shape.labelup / labeldown.
        ctx.beginPath()
        const py = dir > 0 ? top : top + h
        ctx.moveTo(x - 4, py)
        ctx.lineTo(x + 4, py)
        ctx.lineTo(x, py - dir * 4)
        ctx.closePath()
        ctx.fill()
        ctx.fillStyle = COLORS.text
        ctx.fillText(text, x, top + h / 2 + 0.5)
      }
    }
  }
}
