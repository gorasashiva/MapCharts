/**
 * Block Break overlay — fresh 1H/4H block breaks confirmed by the footprint
 * (blockBreakModel.ts), drawn with entry, stop, T1 / T2 and the result.
 *
 * Data: individual trades. History (the last `daysToLoad` days) comes from the
 * tape recorder (/tape/trades, recorder/tapeRecorder.mjs); live trades arrive
 * through addTrade(). Both are folded into 1-minute footprint bars here, so the
 * blocks and signals are the same on every chart timeframe.
 *
 * Drawn: fresh (untouched) blocks as faint boxes; a block being watched (touched,
 * 5-minute window running) highlighted; each signal as an arrow + label at the
 * entry, entry / stop / T1 / T2 lines until the exit (or the 4h close-out while
 * open), and the exit with its R. A status pill shows the running tally.
 * Alerts (onAlert): new signal, T1 reached, exit.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import type { RecordedTape, TapeFetcher } from './footprint'
import { BLOCK_BREAK_DEFAULTS, addPrintToBars, autoRowSize, computeBlockBreak, type BbBar, type BbSignal, type BlockBreakOptions, type BlockBreakResult } from './blockBreakModel'
import { lazyCanvas } from './lazyCanvas'

type Rect = { x: number; y: number; width: number; height: number }

export interface BlockBreakOverlayOptions extends BlockBreakOptions {
  daysToLoad: number
  /** Draw the untouched (fresh) blocks being watched for a break. Signals are always drawn. */
  showBlocks: 'fresh' | 'none'
  /** Also mark touched blocks that gave no signal. */
  showPassed: boolean
  /** Round-trip cost (% of price) for the net R in the status pill. */
  costPct: number
  buyColor: string
  sellColor: string
  stopColor: string
  targetColor: string
  alertOnSignal: boolean
  alertOnExit: boolean
  alertSound: boolean
}

export const BLOCK_BREAK_OVERLAY_DEFAULTS: BlockBreakOverlayOptions = {
  ...BLOCK_BREAK_DEFAULTS,
  daysToLoad: 4,
  showBlocks: 'fresh',
  showPassed: false,
  costPct: 0.1,
  buyColor: '#0ecb81',
  sellColor: '#f6465d',
  stopColor: '#f6465d',
  targetColor: '#26a69a',
  alertOnSignal: true,
  alertOnExit: true,
  alertSound: true,
}

const DAY_MS = 86_400_000
const MIN = 60_000
const RECOMPUTE_MS = 1000
const MODEL_KEYS: (keyof BlockBreakOptions)[] = ['windowMin', 'stackRows', 'imbalance', 'minRowShare', 'rowSize', 'stopBufPct', 'minStopPct', 't1R', 't2R', 'holdHours', 'blocks']
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

const rgba = (hex: string, a: number): string => {
  const v = parseInt(hex.replace('#', '').slice(0, 6), 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`
}
const fmtR = (r: number): string => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`

export default class BlockBreakOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly getCandles: () => Candle[]
  private readonly fetchTape: TapeFetcher
  private opts: BlockBreakOverlayOptions
  private enabled = false
  private symbol = ''
  private row = 0
  /** 1-minute footprint bars: recorded history, then live. */
  private bars: BbBar[] = []
  /** Live prints since the chart opened [ms, price, qty, buy] (re-folded after a history load). */
  private live: [number, number, number, boolean][] = []
  private historyTo = 0
  private recordedFrom: number | null = null
  private loading = false
  private loadGen = 0
  private result: BlockBreakResult | null = null
  private dirty = true
  private lastCompute = 0
  private lastMinute = 0
  private cutoff: number | null = null
  private alerted = new Set<string>()
  private primed = false
  private running = false
  private raf = 0
  private ro: ResizeObserver | null = null
  onAlert: ((text: string, sound: boolean) => void) | null = null

  constructor(container: HTMLElement, engine: IChartEngine, getCandles: () => Candle[], fetchTape: TapeFetcher, opts?: Partial<BlockBreakOverlayOptions>) {
    this.container = container
    this.engine = engine
    this.getCandles = getCandles
    this.fetchTape = fetchTape
    this.opts = { ...BLOCK_BREAK_OVERLAY_DEFAULTS, ...opts, blocks: { ...BLOCK_BREAK_DEFAULTS.blocks, ...(opts?.blocks ?? {}) } }
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '18'
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

  getOptions(): BlockBreakOverlayOptions {
    return { ...this.opts, blocks: { ...this.opts.blocks } }
  }

  setOptions(patch: Partial<BlockBreakOverlayOptions>): void {
    const reload = patch.daysToLoad !== undefined && patch.daysToLoad !== this.opts.daysToLoad
    const rowChanged = patch.rowSize !== undefined && patch.rowSize !== this.opts.rowSize
    this.opts = { ...this.opts, ...patch, blocks: { ...this.opts.blocks, ...(patch.blocks ?? {}) } }
    if (MODEL_KEYS.some((k) => k in patch)) this.dirty = true
    if ((reload || rowChanged) && this.enabled) void this.loadHistory()
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      this.start()
      void this.loadHistory()
    } else {
      this.stop()
      this.clearData()
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    }
  }

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return
    this.symbol = symbol
    this.clearData()
    if (this.enabled) void this.loadHistory()
  }

  /** Bar replay: only data before `time` (null = live). */
  setCutoff(time: number | null): void {
    this.cutoff = time
    this.dirty = true
  }

  /** Live trade from the WS tape (base-asset quantity, taker side). */
  addTrade(t: { time: number; price: number; qty: number; side: 'buy' | 'sell' }): void {
    if (!this.enabled) return
    const p: [number, number, number, boolean] = [t.time, t.price, t.qty, t.side === 'buy']
    this.live.push(p)
    if (this.live.length > 2_000_000) this.live.splice(0, 500_000)
    if (this.row > 0 && t.time > this.historyTo) {
      addPrintToBars(this.bars, t.time, t.price, t.qty, p[3], this.row)
      this.dirty = true
    }
  }

  getResult(): BlockBreakResult | null {
    return this.result
  }

  private rowFor(price: number): number {
    return this.opts.rowSize > 0 ? this.opts.rowSize : autoRowSize(price, this.symbol)
  }

  private clearData(): void {
    this.loadGen++
    this.bars = []
    this.live = []
    this.row = 0
    this.historyTo = 0
    this.recordedFrom = null
    this.result = null
    this.alerted.clear()
    this.primed = false
    this.dirty = true
  }

  /** Recorded tape, a day at a time (the recorder caps each request), folded into 1-minute bars. */
  private async loadHistory(): Promise<void> {
    const gen = ++this.loadGen
    const now = Date.now()
    const from = now - this.opts.daysToLoad * DAY_MS
    this.loading = true
    const prints: [number, number, number, boolean][] = []
    let recordedFrom: number | null = null
    try {
      for (let t = from; t < now; t += DAY_MS) {
        const chunk: RecordedTape | null = await this.fetchTape(t, Math.min(now, t + DAY_MS)).catch(() => null)
        if (gen !== this.loadGen) return
        if (!chunk) continue
        for (const [time, price, qty, side] of chunk.prints) prints.push([time, price, qty, side > 0])
        if (recordedFrom === null && chunk.sessions.length) recordedFrom = Math.max(t, chunk.sessions[0][0])
      }
    } finally {
      if (gen === this.loadGen) this.loading = false
    }
    prints.sort((a, b) => a[0] - b[0])
    const to = prints.length ? prints[prints.length - 1][0] : 0
    const firstPrice = prints.length ? prints[0][1] : this.live.length ? this.live[0][1] : 0
    this.row = firstPrice > 0 ? this.rowFor(firstPrice) : 0
    const bars: BbBar[] = []
    if (this.row > 0) {
      for (const [t, p, q, b] of prints) addPrintToBars(bars, t, p, q, b, this.row)
      for (const [t, p, q, b] of this.live) if (t > to) addPrintToBars(bars, t, p, q, b, this.row)
    }
    this.bars = bars
    this.historyTo = to
    this.recordedFrom = recordedFrom
    this.primed = false // history just arrived: record what's there, don't alert on it
    this.dirty = true
  }

  start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      this.maybeRecompute()
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

  destroy(): void {
    this.stop()
    this.ro?.disconnect()
    this.canvas.remove()
  }

  private maybeRecompute(): void {
    // live trades fold in every frame; the blocks / signals only need a pass a second (and at each new minute)
    const now = performance.now()
    const minute = Math.floor(Date.now() / MIN)
    const newMinute = minute !== this.lastMinute
    if (!this.dirty && !newMinute) return
    if (!newMinute && now - this.lastCompute < RECOMPUTE_MS) return
    this.lastMinute = minute
    this.lastCompute = now
    this.dirty = false
    const cut = this.cutoff
    const bars = cut === null ? this.bars : this.bars.filter((b) => b.time < cut)
    this.result = bars.length > 300 ? computeBlockBreak(bars, this.opts) : null
    this.runAlerts()
  }

  /** Alerts for what changed since the last pass; the first pass after a load only records. */
  private runAlerts(): void {
    const r = this.result
    if (!r || this.cutoff !== null || this.loading) return
    const priming = !this.primed
    this.primed = true
    for (const s of r.signals) {
      const id = `${s.zone.left}|${s.zone.side}|${s.entryTime}`
      const side = s.dir > 0 ? 'long' : 'short'
      const items: [string, boolean, boolean, string][] = [
        [`${id}|new`, true, this.opts.alertOnSignal, `${s.dir > 0 ? 'BUY' : 'SELL'} ${this.symbol} @ ${s.entry} · SL ${s.stop.toFixed(2)} · T1 ${s.t1.toFixed(2)} · T2 ${s.t2.toFixed(2)} (${s.zone.side} block broken, ${s.stack}-row stacked imbalance)`],
        [`${id}|t1`, s.t1Time !== null, this.opts.alertOnExit, `T1 reached on the ${this.symbol} ${side} from ${s.entry}`],
        [`${id}|exit`, s.outcome !== 'open', this.opts.alertOnExit, `${this.symbol} ${side} closed at ${s.outcome === 't2' ? 'T2' : s.outcome === 'stop' ? 'the stop' : `the ${this.opts.holdHours}h close`}: ${fmtR(s.r)}`],
      ]
      for (const [k, due, wanted, text] of items) {
        if (!due || this.alerted.has(k)) continue
        this.alerted.add(k)
        if (!priming && wanted) this.onAlert?.(text, this.opts.alertSound)
      }
    }
  }

  status(): string {
    const r = this.result
    const src = this.loading ? 'loading tape…' : this.recordedFrom === null ? 'no recorded tape: live trades only' : `tape since ${new Date(this.recordedFrom).toISOString().slice(5, 16).replace('T', ' ')} UTC`
    if (!r) return `Block Break · ${this.loading ? src : `collecting 1-minute footprint (${this.bars.length} min so far)`}`
    if (r.error) return `Block Break · ${r.error}`
    const closed = r.signals.filter((s) => s.outcome !== 'open')
    const net = closed.map((s) => s.r - ((this.opts.costPct / 100) * s.entry) / Math.abs(s.entry - s.stop))
    const avg = net.length ? net.reduce((a, b) => a + b, 0) / net.length : Number.NaN
    const w = r.watching.length ? ` · watching ${r.watching.length}` : ''
    const open = r.signals.length - closed.length
    return `Block Break · ${r.fresh.length} fresh blocks${w} · ${r.signals.length} signals (${open} open), ${closed.filter((s) => s.r > 0).length}/${closed.length} won${net.length ? `, avg ${fmtR(avg)} after cost` : ''} · ${src}`
  }

  private draw(): void {
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)
    if (!this.enabled) return
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    const candles = this.getCandles()
    if (!conv || !rect || candles.length < 2) return
    const g = this.ctx
    g.save()
    g.beginPath()
    g.rect(rect.x, rect.y, rect.width, rect.height)
    g.clip()
    const r = this.result
    if (r) {
      const t0 = conv.xToTime(rect.x - 200)
      const t1 = conv.xToTime(rect.x + rect.width + 200)
      const right = rect.x + rect.width
      if (this.opts.showBlocks === 'fresh') {
        for (const z of r.fresh) this.drawBox(conv, rect, z.left, right, z.top, z.bottom, z.side === 'high' ? this.opts.sellColor : this.opts.buyColor, 0.1, `${z.side === 'high' ? 'High' : 'Low'} block · fresh`)
      }
      for (const w of r.watching) this.drawBox(conv, rect, w.zone.left, right, w.zone.top, w.zone.bottom, '#ffd54f', 0.22, `touched · deciding at ${new Date(w.windowEnd).toISOString().slice(11, 16)} UTC`)
      if (this.opts.showPassed) for (const p of r.passed) if (p.touchTime >= t0 && p.zone.left <= t1) this.drawBox(conv, rect, p.zone.left, conv.timeToX(p.touchTime), p.zone.top, p.zone.bottom, '#787b86', 0.08, '')
      for (const s of r.signals) if ((s.exitTime ?? s.expiry) >= t0 && s.entryTime <= t1) this.drawSignal(conv, rect, s)
    }
    // status pill, above the Heavy Absorption / footprint ones
    const text = this.status()
    g.font = `500 10px ${FONT}`
    const w = g.measureText(text).width + 12
    const px = rect.x + (rect.width - w) / 2
    const py = rect.y + rect.height - 61
    g.fillStyle = 'rgba(19, 23, 34, 0.82)'
    g.beginPath()
    g.roundRect(px, py, w, 17, 4)
    g.fill()
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    g.fillStyle = 'rgba(209, 212, 220, 0.95)'
    g.fillText(text, px + 6, py + 9)
    g.restore()
  }

  private drawBox(conv: Converters, rect: Rect, left: number, xRight: number, top: number, bottom: number, col: string, a: number, label: string): void {
    const g = this.ctx
    const x0 = Math.max(rect.x, conv.timeToX(left))
    const ya = conv.priceToY(top)
    const yb = conv.priceToY(bottom)
    const y = Math.min(ya, yb)
    const h = Math.max(2, Math.abs(yb - ya))
    if (xRight <= x0 || y + h < rect.y || y > rect.y + rect.height) return
    g.fillStyle = rgba(col, a)
    g.fillRect(x0, y, xRight - x0, h)
    g.strokeStyle = rgba(col, Math.min(1, a * 4))
    g.lineWidth = 1
    g.strokeRect(x0 + 0.5, y + 0.5, xRight - x0, h)
    if (label) {
      g.font = `500 9px ${FONT}`
      g.fillStyle = rgba(col, 0.9)
      g.textAlign = 'right'
      g.textBaseline = 'bottom'
      g.fillText(label, xRight - 4, y - 2)
    }
  }

  private drawSignal(conv: Converters, rect: Rect, s: BbSignal): void {
    const g = this.ctx
    const o = this.opts
    const col = s.dir > 0 ? o.buyColor : o.sellColor
    const xe = conv.timeToX(s.entryTime)
    const endT = s.exitTime ?? Math.min(s.expiry, Date.now())
    const xx = Math.max(xe + 30, conv.timeToX(endT))
    // the broken block, from its start to the entry
    this.drawBox(conv, rect, s.zone.left, xe, s.zone.top, s.zone.bottom, col, 0.12, '')
    const dec = s.entry >= 1000 ? 1 : 2
    const line = (price: number, c: string, dash: number[], label: string): void => {
      const y = Math.round(conv.priceToY(price)) + 0.5
      g.strokeStyle = c
      g.lineWidth = 1.3
      g.setLineDash(dash)
      g.beginPath()
      g.moveTo(xe, y)
      g.lineTo(xx, y)
      g.stroke()
      g.setLineDash([])
      // the label sits over later candles: give it a backing
      g.font = `500 9px ${FONT}`
      const lw = g.measureText(label).width + 6
      g.fillStyle = 'rgba(19, 23, 34, 0.85)'
      g.fillRect(xx + 2, y - 6, lw, 12)
      g.fillStyle = c
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      g.fillText(label, xx + 5, y)
    }
    line(s.stop, rgba(o.stopColor, 0.95), [], `SL ${s.stop.toFixed(dec)}`)
    line(s.t1, rgba(o.targetColor, 0.85), [4, 3], `T1 ${o.t1R}R ${s.t1.toFixed(dec)}`)
    line(s.t2, rgba(o.targetColor, 1), [], `T2 ${o.t2R}R ${s.t2.toFixed(dec)}`)
    line(s.entry, 'rgba(209, 212, 220, 0.9)', [2, 2], `Entry ${s.entry.toFixed(dec)}`)
    // entry arrow + tag
    const ye = conv.priceToY(s.entry)
    const tip = s.dir > 0 ? ye + 6 : ye - 6
    const base = s.dir > 0 ? tip + 10 : tip - 10
    g.fillStyle = col
    g.beginPath()
    g.moveTo(xe, tip)
    g.lineTo(xe - 7, base)
    g.lineTo(xe + 7, base)
    g.closePath()
    g.fill()
    const tag = `${s.dir > 0 ? 'BUY' : 'SELL'} · block break`
    g.font = `600 10px ${FONT}`
    const tw = g.measureText(tag).width + 10
    const ty = s.dir > 0 ? base + 3 : base - 19
    g.beginPath()
    g.roundRect(xe - tw / 2, ty, tw, 16, 3)
    g.fill()
    g.fillStyle = '#ffffff'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(tag, xe, ty + 8)
    // T1 reached
    if (s.t1Time !== null) {
      g.fillStyle = rgba(o.targetColor, 1)
      g.beginPath()
      g.arc(conv.timeToX(s.t1Time), conv.priceToY(s.t1), 3.5, 0, Math.PI * 2)
      g.fill()
    }
    // result at the exit (or the latest price while open)
    const res = s.outcome === 'open' ? `open ${fmtR(s.r)}` : `${s.outcome === 't2' ? 'T2' : s.outcome === 'stop' ? 'SL' : `${o.holdHours}h`} ${fmtR(s.r)}`
    const yr = Math.max(rect.y + 20, conv.priceToY(s.exitPrice ?? s.entry))
    g.font = `600 10px ${FONT}`
    const rw = g.measureText(res).width + 10
    g.fillStyle = s.outcome === 'open' ? 'rgba(120, 123, 134, 0.9)' : s.r > 0 ? rgba(o.targetColor, 0.95) : rgba(o.stopColor, 0.95)
    // ends just before the line ends, so the price labels after the lines stay readable
    const rx = Math.max(xe + 2, xx - rw - 6)
    g.beginPath()
    g.roundRect(rx, yr - 22, rw, 16, 3)
    g.fill()
    g.fillStyle = '#ffffff'
    g.textAlign = 'center'
    g.fillText(res, rx + rw / 2, yr - 14)
  }
}
