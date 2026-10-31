/**
 * Trade Buddy levels — draws one idea's entry / stop / targets as labelled
 * horizontal lines from the trigger time to the right edge. Runs its frame
 * loop only while levels are set.
 */
import type { IChartEngine } from '../chart/types'
import { lazyCanvas } from './lazyCanvas'

export interface BuddyLevels {
  side: 'long' | 'short'
  from: number
  entry: number
  stop: number
  targets: number[]
}

const COLORS = { entry: '#2962FF', stop: '#ef5350', target: '#26a69a', zoneLoss: 'rgba(239,83,80,0.08)', zoneWin: 'rgba(38,166,154,0.08)' }

export default class BuddyLevelsOverlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly ro: ResizeObserver
  private levels: BuddyLevels | null = null
  private raf = 0

  constructor(container: HTMLElement, engine: IChartEngine) {
    this.container = container
    this.engine = engine
    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '19' })
    container.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()
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

  set(levels: BuddyLevels | null): void {
    this.levels = levels
    if (levels && !this.raf) {
      const loop = (): void => {
        this.draw()
        this.raf = this.levels ? requestAnimationFrame(loop) : 0
      }
      this.raf = requestAnimationFrame(loop)
    }
    if (!levels) this.clear()
  }

  destroy(): void {
    this.levels = null
    if (this.raf) cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.canvas.remove()
  }

  private clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  private draw(): void {
    this.clear()
    const L = this.levels
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!L || !conv || !rect) return
    const ctx = this.ctx
    const right = rect.x + rect.width
    const x0 = Math.max(rect.x, Math.min(right - 40, conv.timeToX(L.from)))
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    const yE = conv.priceToY(L.entry)
    const yS = conv.priceToY(L.stop)
    ctx.fillStyle = COLORS.zoneLoss
    ctx.fillRect(x0, Math.min(yE, yS), right - x0, Math.abs(yS - yE))
    const last = L.targets[L.targets.length - 1]
    if (last !== undefined) {
      const yT = conv.priceToY(last)
      ctx.fillStyle = COLORS.zoneWin
      ctx.fillRect(x0, Math.min(yE, yT), right - x0, Math.abs(yT - yE))
    }
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textBaseline = 'bottom'
    ctx.textAlign = 'left'
    const line = (price: number, color: string, label: string, dash: number[]): void => {
      const y = Math.round(conv.priceToY(price)) + 0.5
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.setLineDash(dash)
      ctx.beginPath()
      ctx.moveTo(x0, y)
      ctx.lineTo(right, y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = color
      ctx.fillText(`${label} ${price.toFixed(2)}`, x0 + 4, y - 2)
    }
    line(L.entry, COLORS.entry, `BUDDY ${L.side.toUpperCase()} · Entry`, [])
    line(L.stop, COLORS.stop, 'Stop', [5, 4])
    L.targets.forEach((t, i) => line(t, COLORS.target, `T${i + 1}`, [2, 3]))
    ctx.restore()
  }
}
