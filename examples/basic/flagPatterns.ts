// Auto Flag Pattern Detection — canvas overlay, same architecture as
// src/overlays/ict.ts: pure OHLCV pattern detection recomputed whenever
// setCandles() gets a new array, drawn on a transparent canvas over the
// price pane. Detects the classic "flag": a strong impulsive move (the
// pole) followed by a tight, shallow consolidation (the flag) that breaks
// out in the pole's direction — the same checklist item the Ninja GEX
// System (ninjagex.com/system) calls "Flag: strong move (pole) followed by
// tight pullback consolidation" plus its volume-confirmation requirement
// ("volume 1.5x-3x above average" on the breakout).
//
// Both the CURRENTLY forming flag (still consolidating on the most recent
// bars, no breakout yet) and CONFIRMED historical flags (breakout occurred
// with volume confirmation) are kept and drawn — an unconfirmed breakout
// (price cleared the channel but volume didn't confirm) is dropped unless
// it's still live, matching the system's "no signal without volume
// confirmation" rule. Purely a pattern-recognition heuristic, not a
// certified reproduction of any specific proprietary scanner.
import type { IChartEngine, Converters, Candle } from '../../src/index'
import { lazyCanvas } from '../../src/overlays/lazyCanvas'

export interface FlagPatternsOptions {
  enabled: boolean
  poleLen: number // bars spanning the pole window
  poleMinAtrMult: number // pole's net move must be >= this x the recent average bar range
  flagMinBars: number
  flagMaxBars: number
  flagMaxRetrace: number // max pullback into the pole, as a fraction of the pole's range
  flagMaxRangeRatio: number // flag channel height must be tighter than this x the pole's range
  volumeMult: number // breakout bar volume vs recent average, required to confirm
  lookbackBars: number // how far back to scan (perf bound on very long history)
}

const DEFAULTS: FlagPatternsOptions = {
  enabled: false,
  poleLen: 8,
  poleMinAtrMult: 2.5,
  flagMinBars: 3,
  flagMaxBars: 15,
  flagMaxRetrace: 0.5,
  flagMaxRangeRatio: 0.6,
  volumeMult: 1.5,
  lookbackBars: 1500,
}

interface FlagPattern {
  bullish: boolean
  poleStartIdx: number
  poleStartPrice: number
  poleEndIdx: number
  poleEndPrice: number
  flagStartIdx: number
  flagEndIdx: number
  channelHigh: number
  channelLow: number
  confirmed: boolean // breakout occurred AND volume confirmed
  breakoutIdx: number | null
  target: number | null // measured-move target (pole's range projected off the breakout), confirmed only
}

function rollingAvg(values: number[], win: number): number[] {
  const n = values.length
  const out = new Array(n).fill(0)
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += values[i]
    if (i >= win) sum -= values[i - win]
    out[i] = i >= win - 1 ? sum / win : sum / (i + 1)
  }
  return out
}

function detectFlags(candles: Candle[], opts: FlagPatternsOptions): FlagPattern[] {
  const n = candles.length
  const out: FlagPattern[] = []
  if (n < opts.poleLen + opts.flagMinBars + 2) return out
  const startAt = Math.max(opts.poleLen, n - opts.lookbackBars)

  const avgRange = rollingAvg(
    candles.map((c) => c.high - c.low),
    20,
  )
  const avgVolume = rollingAvg(
    candles.map((c) => c.volume),
    20,
  )

  let i = startAt
  while (i < n) {
    const poleStart = i - opts.poleLen
    const netMove = candles[i].close - candles[poleStart].open
    const bullish = netMove > 0
    let poleHigh = -Infinity
    let poleLow = Infinity
    let dirBars = 0
    for (let k = poleStart; k <= i; k++) {
      poleHigh = Math.max(poleHigh, candles[k].high)
      poleLow = Math.min(poleLow, candles[k].low)
      if (candles[k].close >= candles[k].open === bullish) dirBars++
    }
    const poleRange = poleHigh - poleLow
    const baseline = avgRange[poleStart] || 1e-9
    const impulsive = dirBars / (opts.poleLen + 1) >= 0.65

    if (poleRange <= 0 || !impulsive || Math.abs(netMove) < opts.poleMinAtrMult * baseline) {
      i++
      continue
    }

    let channelHigh = candles[i].high
    let channelLow = candles[i].low
    let validFlagEnd = i
    let breakoutIdx: number | null = null
    let confirmed = false
    const maxJ = Math.min(n - 1, i + opts.flagMaxBars)
    let j = i + 1
    for (; j <= maxJ; j++) {
      const c = candles[j]
      const flagLenSoFar = j - i
      const brokeOut = bullish ? c.close > channelHigh : c.close < channelLow
      if (brokeOut && flagLenSoFar > opts.flagMinBars) {
        breakoutIdx = j
        confirmed = c.volume >= opts.volumeMult * (avgVolume[j - 1] || 0)
        break
      }
      const nextHigh = Math.max(channelHigh, c.high)
      const nextLow = Math.min(channelLow, c.low)
      const retrace = bullish ? (poleHigh - nextLow) / poleRange : (nextHigh - poleLow) / poleRange
      const channelHeight = nextHigh - nextLow
      if (retrace > opts.flagMaxRetrace || channelHeight > poleRange * opts.flagMaxRangeRatio) break
      channelHigh = nextHigh
      channelLow = nextLow
      if (flagLenSoFar >= opts.flagMinBars) validFlagEnd = j
    }

    // "Live": still a valid, un-invalidated consolidation sitting right at the
    // most recent bar — no breakout yet, but worth showing as it develops.
    const isLive = breakoutIdx === null && validFlagEnd === n - 1 && validFlagEnd > i
    if (validFlagEnd > i && (confirmed || isLive)) {
      out.push({
        bullish,
        poleStartIdx: poleStart,
        poleStartPrice: candles[poleStart].open,
        poleEndIdx: i,
        poleEndPrice: candles[i].close,
        flagStartIdx: i + 1,
        flagEndIdx: validFlagEnd,
        channelHigh,
        channelLow,
        confirmed,
        breakoutIdx,
        target: confirmed ? (bullish ? channelHigh + poleRange : channelLow - poleRange) : null,
      })
    }
    i = Math.max(i + 1, (breakoutIdx ?? Math.min(j, maxJ)) + 1)
  }
  return out
}

type Rect = { x: number; y: number; width: number; height: number }

const BULL_COLOR = '#0ecb81'
const BEAR_COLOR = '#f6465d'

export default class FlagPatternsOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private opts: FlagPatternsOptions
  private candles: Candle[] = []
  private lastSig = ''
  private running = false
  private raf = 0
  private ro: ResizeObserver | null = null
  private patterns: FlagPattern[] = []

  constructor(container: HTMLElement, engine: IChartEngine, opts?: Partial<FlagPatternsOptions>) {
    this.container = container
    this.engine = engine
    this.opts = { ...DEFAULTS, ...opts }
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '18'
    this.canvas.style.display = this.opts.enabled ? 'block' : 'none'
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

  setOptions(opts: Partial<FlagPatternsOptions>): void {
    this.opts = { ...this.opts, ...opts }
    this.lastSig = '' // force recompute with the new params
  }

  getOptions(): FlagPatternsOptions {
    return { ...this.opts }
  }

  /** Most recent pattern (confirmed or still forming), for other tools (Setup
   *  Checklist) to reuse without redoing detection — null if there isn't one,
   *  or the closest one found is stale (its last touched bar is more than
   *  `recentBars` candles behind the latest loaded one). */
  getLatestSignal(recentBars = 10): { bullish: boolean; confirmed: boolean } | null {
    if (this.patterns.length === 0) return null
    const p = this.patterns[this.patterns.length - 1]
    const lastTouched = p.breakoutIdx ?? p.flagEndIdx
    if (this.candles.length - 1 - lastTouched > recentBars) return null
    return { bullish: p.bullish, confirmed: p.confirmed }
  }

  setEnabled(on: boolean): void {
    this.opts.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
  }

  /** Call whenever the pane's candle array changes (load, symbol/interval switch, live tick). */
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
    this.patterns = []
    this.lastSig = ''
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  destroy(): void {
    this.stop()
    this.ro?.disconnect()
    this.canvas.remove()
  }

  private recompute(): void {
    const c = this.candles
    if (c.length < this.opts.poleLen + this.opts.flagMinBars + 2) return
    const last = c[c.length - 1]
    const sig = `${c.length}:${last.time}:${last.close}:${JSON.stringify(this.opts)}`
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.patterns = detectFlags(c, this.opts)
  }

  private draw(): void {
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)
    if (!this.opts.enabled) return
    this.recompute()

    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect) return

    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.clip()
    for (const p of this.patterns) this.drawPattern(conv, rect, p)
    this.ctx.restore()
  }

  private drawPattern(conv: Converters, rect: Rect, p: FlagPattern): void {
    const ctx = this.ctx
    const color = p.bullish ? BULL_COLOR : BEAR_COLOR
    const endTime = p.breakoutIdx !== null ? this.candles[p.breakoutIdx].time : this.candles[p.flagEndIdx].time
    const x0 = conv.timeToX(this.candles[p.poleStartIdx].time)
    const xPole = conv.timeToX(this.candles[p.poleEndIdx].time)
    const xFlagEnd = conv.timeToX(this.candles[p.flagEndIdx].time)
    const xEnd = conv.timeToX(endTime)
    if (xEnd < rect.x - 20 || x0 > rect.x + rect.width + 20) return

    // Pole: solid line from its start to end price.
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x0, conv.priceToY(p.poleStartPrice))
    ctx.lineTo(xPole, conv.priceToY(p.poleEndPrice))
    ctx.stroke()

    // Flag: dashed channel box.
    const yTop = conv.priceToY(p.channelHigh)
    const yBot = conv.priceToY(p.channelLow)
    ctx.globalAlpha = p.confirmed ? 0.14 : 0.08
    ctx.fillStyle = color
    ctx.fillRect(xPole, yTop, xFlagEnd - xPole, yBot - yTop)
    ctx.globalAlpha = 1
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.strokeRect(xPole, yTop, xFlagEnd - xPole, yBot - yTop)
    ctx.setLineDash([])

    // Breakout marker + measured-move target (confirmed patterns only).
    if (p.confirmed && p.breakoutIdx !== null && p.target !== null) {
      const yTarget = conv.priceToY(p.target)
      ctx.strokeStyle = color
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(xEnd, yTarget)
      ctx.lineTo(rect.x + rect.width, yTarget)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.font = '9px monospace'
      ctx.fillStyle = color
      ctx.fillText('TARGET', Math.min(xEnd + 4, rect.x + rect.width - 45), yTarget - 4)
    }

    ctx.font = '700 10px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.fillStyle = color
    // A pushed pattern is always either confirmed (breakout + volume) or still
    // live (no breakout yet) — see detectFlags: an unconfirmed breakout is
    // dropped entirely, so there's no third "broke out but not confirmed" case here.
    const label = `${p.bullish ? 'BULL' : 'BEAR'} FLAG${p.confirmed ? '' : ' (forming)'}`
    ctx.fillText(label, xPole + 3, yTop - 5)
  }
}
