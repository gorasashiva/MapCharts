// Confluence "setup" marker: fires only when several independently-noisy
// signals agree near the same price — level proximity, absorption, live
// order-book imbalance (leading), and candle dominance (lagging). Any one
// alone is unreliable; several agreeing at once is the actual edge. Reads
// live state from the other overlays rather than recomputing any of it.
import type { IChartEngine, Candle } from '../../src/index'
import type OrderFlowOverlay from '../../src/overlays/orderflow'
import type DepthImbalanceOverlay from '../../src/overlays/depthImbalance'
import { candleDominanceSide } from './custom-indicators'
import { lazyCanvas } from '../../src/overlays/lazyCanvas'

const MIN_SCORE = 3 // out of 4 (level proximity + dominance + imbalance + absorption)

export default class ConfluenceOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly orderflow: OrderFlowOverlay
  private readonly depth: DepthImbalanceOverlay
  private candles: Candle[] = []
  private running = false
  private raf = 0
  private lastEvaluatedTime = -1
  private ro: ResizeObserver | null = null

  constructor(container: HTMLElement, engine: IChartEngine, orderflow: OrderFlowOverlay, depth: DepthImbalanceOverlay) {
    this.container = container
    this.engine = engine
    this.orderflow = orderflow
    this.depth = depth
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '21'
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
    const rect = this.container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  setCandles(candles: Candle[]): void {
    this.candles = candles
  }

  start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      this.draw()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  reset(): void {
    this.candles = []
    this.lastEvaluatedTime = -1
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  destroy(): void {
    this.stop()
    this.ro?.disconnect()
    this.canvas.remove()
  }

  private draw(): void {
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)
    if (this.candles.length < 2) return
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect) return

    const last = this.candles[this.candles.length - 1]
    if (last.time === this.lastEvaluatedTime) return // score once per bar, not every frame
    this.lastEvaluatedTime = last.time

    const levels = this.orderflow.getLevelDetector()
    const nearest = levels.getNearestLevel(last.close)
    if (!nearest) return
    if (Math.abs(nearest.price - last.close) > last.close * 0.0015) return // must actually be AT the level

    const bullish = nearest.type === 'support'
    const dom = candleDominanceSide(last)
    const imbalance = this.depth.getImbalance()
    const absorptionBalance = levels.getAbsorptionDetector().getAbsorptionBalance(nearest.price, 60_000)

    let score = 1 // level proximity itself
    if (dom === (bullish ? 'buy' : 'sell')) score++
    if (bullish ? imbalance > 0.1 : imbalance < -0.1) score++
    if (bullish ? absorptionBalance > 0.1 : absorptionBalance < -0.1) score++
    if (score < MIN_SCORE) return

    const x = conv.timeToX(last.time)
    const y = bullish ? conv.priceToY(last.low) + 22 : conv.priceToY(last.high) - 22
    const ctx = this.ctx
    const color = bullish ? '#0ecb81' : '#f6465d'
    const text = `${bullish ? 'LONG' : 'SHORT'} SETUP ${score}/4`
    ctx.font = '700 10px -apple-system, sans-serif'
    const w = ctx.measureText(text).width + 10
    ctx.fillStyle = color
    ctx.fillRect(x - w / 2, y - 8, w, 16)
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x, y + 0.5)
  }
}
