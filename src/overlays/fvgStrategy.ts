/**
 * FVG + Supertrend Strategy — ported from "FVG strategy.pine" (v5 strategy).
 *
 *   1. Fair Value Gaps on the chart timeframe and/or a higher timeframe (MTF),
 *      extended right until price fully fills them (then deleted, or frozen
 *      at the fill bar when "Delete Old On Fill" is off), optional midpoint
 *      line and "<tf> FVG" label.
 *   2. Supertrend (ATR 2, factor 2 by default — hardcoded in the source,
 *      exposed as settings here). Reuses UltraV2's implementation.
 *   3. Entries: BUY once price has traded into a "bullish" FVG while the
 *      Supertrend is green and close is above it; SELL mirrors that. Only one
 *      position at a time (pyramiding=0). Exit on the opposite Supertrend flip.
 *      Orders fill on the signal bar's close (process_orders_on_close=true).
 *   4. A small backtest summary card (trades, win rate, net %), which Pine's
 *      Strategy Tester would otherwise provide.
 *
 * NOTE on naming — kept faithful to the source: the script calls a gap DOWN
 * (bearish middle candle, high < low[2]) a "bullish" FVG and a gap UP a
 * "bearish" FVG, the reverse of the usual ICT convention (ict.ts has the
 * conventional detector). The "interacted" flags are sticky (Pine `var`) and
 * only reset when a position opens.
 *
 * HTF bars are built by bucketing candles on UTC boundaries (weeks start
 * Monday, like TradingView). The HTF gap check mirrors the source's
 * request.security(..., lookahead_on) with [1]/[2] offsets: on the first
 * chart bar of each new HTF bar it compares the previous HTF bar (the
 * middle candle), the HTF bar two back, and the running htfH/htfL — which
 * the source resets to `open` just before, so both equal the current bar's
 * open.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import { computeSupertrend, type SupertrendPoint } from './ultraV2'
import { attachFloatingWidget, type FloatingWidgetHandle } from './floatingWidget'
import type { StrategyOverlay, StrategyTrade } from '../strategy/types'
import { lazyCanvas } from './lazyCanvas'

type Rect = { x: number; y: number; width: number; height: number }

const MIN_MS = 60_000
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
/** 1970-01-05 (the first Monday after the epoch) — aligns weekly buckets to Monday. */
const WEEK_ANCHOR_MS = 4 * DAY_MS

export type FvgMtfMode = 'current' | 'currentHtf' | 'htf'
export type FvgHtf = '1h' | '4h' | 'D' | 'W'

export interface FvgStrategyOptions {
  mtfMode: FvgMtfMode
  htfTimeframe: FvgHtf
  /** Label offset in bars to the right of the gap's start (chart-TF gaps). */
  labelOffset: number
  /** Label offset in bars for HTF gaps. */
  htfLabelOffset: number
  fillByMid: boolean
  deleteOnFill: boolean
  labelTf: boolean
  stAtrPeriod: number
  stFactor: number
  showSupertrend: boolean
  showSignals: boolean
  showStats: boolean
}

export const FVG_STRATEGY_DEFAULTS: FvgStrategyOptions = {
  mtfMode: 'current',
  htfTimeframe: 'D',
  labelOffset: 10,
  htfLabelOffset: 20,
  fillByMid: false,
  deleteOnFill: true,
  labelTf: true,
  stAtrPeriod: 2,
  stFactor: 2,
  showSupertrend: true,
  showSignals: true,
  showStats: true,
}

export interface FvgGap {
  /** Source naming: 'bull' = gap down (price below), 'bear' = gap up. */
  kind: 'bull' | 'bear'
  htf: boolean
  top: number
  bottom: number
  mid: number
  startTime: number
  /** Time of the bar that fully filled it; null while still open. */
  endTime: number | null
}

export type FvgSignalType = 'buy' | 'sell' | 'exitLong' | 'exitShort'

export interface FvgSignal {
  type: FvgSignalType
  time: number
  high: number
  low: number
}

export interface FvgTrade {
  side: 'long' | 'short'
  entryTime: number
  entryPrice: number
  exitTime: number | null
  exitPrice: number | null
  /** Return in % of entry price; for an open trade, marked to the last close. */
  pnlPct: number
}

export interface FvgStrategyResult {
  gaps: FvgGap[]
  signals: FvgSignal[]
  trades: FvgTrade[]
  supertrend: SupertrendPoint[]
}

function htfBucket(time: number, tf: FvgHtf): number {
  switch (tf) {
    case '1h':
      return Math.floor(time / HOUR_MS)
    case '4h':
      return Math.floor(time / (4 * HOUR_MS))
    case 'D':
      return Math.floor(time / DAY_MS)
    case 'W':
      return Math.floor((time - WEEK_ANCHOR_MS) / WEEK_MS)
  }
}

interface HtfBar {
  open: number
  high: number
  low: number
  close: number
}

/** Pure port of the strategy's per-bar logic over a whole candle array. */
export function computeFvgStrategy(candles: Candle[], opts: FvgStrategyOptions): FvgStrategyResult {
  const n = candles.length
  const supertrend = computeSupertrend(candles, opts.stAtrPeriod, opts.stFactor)
  const bullGaps: FvgGap[] = []
  const bearGaps: FvgGap[] = []
  const filledGaps: FvgGap[] = []
  const signals: FvgSignal[] = []
  const trades: FvgTrade[] = []
  if (n === 0) return { gaps: [], signals, trades, supertrend }

  const useCurrent = opts.mtfMode === 'current' || opts.mtfMode === 'currentHtf'
  const useHtf = opts.mtfMode === 'currentHtf' || opts.mtfMode === 'htf'

  let htfH = candles[0].open
  let htfL = candles[0].open
  const htfDone: HtfBar[] = []
  let htfCur: HtfBar | null = null
  let prevBucket = NaN

  let bullFilled = false
  let bearFilled = false
  let pos = 0 // +1 long, -1 short, 0 flat
  let openTrade: FvgTrade | null = null
  let prevStBull = false
  let prevStBear = false

  const gapLogic = (close: number, high: number, highP2: number, low: number, lowP2: number, open: number, time: number, htf: boolean): void => {
    if (open > close) {
      if (high - lowP2 < 0) {
        bullGaps.push({ kind: 'bull', htf, top: lowP2, bottom: high, mid: (lowP2 + high) / 2, startTime: time, endTime: null })
      }
    } else if (low - highP2 > 0) {
      bearGaps.push({ kind: 'bear', htf, top: low, bottom: highP2, mid: (low + highP2) / 2, startTime: time, endTime: null })
    }
  }

  const fill = (list: FvgGap[], idx: number, time: number): void => {
    const [g] = list.splice(idx, 1)
    if (!opts.deleteOnFill) {
      g.endTime = time
      filledGaps.push(g)
    }
  }

  for (let i = 0; i < n; i++) {
    const c = candles[i]
    const st = supertrend[i]
    const stValid = isFinite(st.value)
    const stBull = stValid && st.up
    const stBear = stValid && !st.up

    if (c.close > htfH) htfH = c.close
    if (c.close < htfL) htfL = c.close

    // ---- FVG interaction (gaps created on earlier bars only) ----
    for (let k = bullGaps.length - 1; k >= 0; k--) {
      const g = bullGaps[k]
      if (c.low <= g.top && c.high >= g.bottom) bullFilled = true
      if (c.high >= g.top) fill(bullGaps, k, c.time)
    }
    for (let k = bearGaps.length - 1; k >= 0; k--) {
      const g = bearGaps[k]
      if (c.high >= g.bottom && c.low <= g.top) bearFilled = true
      if (c.low <= g.bottom) fill(bearGaps, k, c.time)
    }

    // ---- entries / exits (position as of the previous bar) ----
    const flipBull = stBull && prevStBear
    const flipBear = stBear && prevStBull
    const buy = bullFilled && stBull && c.close > st.value && pos === 0
    const sell = bearFilled && stBear && c.close < st.value && pos === 0
    const exitLong = pos > 0 && flipBear
    const exitShort = pos < 0 && flipBull

    if (buy || sell) {
      openTrade = { side: buy ? 'long' : 'short', entryTime: c.time, entryPrice: c.close, exitTime: null, exitPrice: null, pnlPct: 0 }
      trades.push(openTrade)
      signals.push({ type: buy ? 'buy' : 'sell', time: c.time, high: c.high, low: c.low })
      pos = buy ? 1 : -1
      bullFilled = false
      bearFilled = false
    } else if ((exitLong || exitShort) && openTrade) {
      openTrade.exitTime = c.time
      openTrade.exitPrice = c.close
      signals.push({ type: exitLong ? 'exitLong' : 'exitShort', time: c.time, high: c.high, low: c.low })
      openTrade = null
      pos = 0
    }
    prevStBull = stBull
    prevStBear = stBear

    // ---- HTF bookkeeping + new-HTF-bar reset ----
    const bucket = htfBucket(c.time, opts.htfTimeframe)
    const newHtfBar = bucket !== prevBucket
    if (newHtfBar) {
      if (htfCur) htfDone.push(htfCur)
      htfCur = { open: c.open, high: c.high, low: c.low, close: c.close }
      prevBucket = bucket
      htfH = c.open
      htfL = c.open
    } else if (htfCur) {
      htfCur.high = Math.max(htfCur.high, c.high)
      htfCur.low = Math.min(htfCur.low, c.low)
      htfCur.close = c.close
    }

    // ---- gap creation: HTF first, then chart TF (source order) ----
    if (newHtfBar && useHtf && htfDone.length >= 2) {
      const p1 = htfDone[htfDone.length - 1]
      const p2 = htfDone[htfDone.length - 2]
      gapLogic(p1.close, htfH, p2.high, htfL, p2.low, p1.open, c.time, true)
    }
    if (useCurrent && i >= 2) {
      const p1 = candles[i - 1]
      const p2 = candles[i - 2]
      gapLogic(p1.close, c.high, p2.high, c.low, p2.low, p1.open, c.time, false)
    }
  }

  const lastClose = candles[n - 1].close
  for (const t of trades) {
    const exit = t.exitPrice ?? lastClose
    const diff = t.side === 'long' ? exit - t.entryPrice : t.entryPrice - exit
    t.pnlPct = t.entryPrice !== 0 ? (diff / t.entryPrice) * 100 : 0
  }

  // Pine caps drawings at max_boxes_count=500; keep the newest frozen ones.
  const frozen = filledGaps.length > 500 ? filledGaps.slice(-500) : filledGaps
  return { gaps: [...frozen, ...bullGaps, ...bearGaps], signals, trades, supertrend }
}

export interface FvgStats {
  closed: number
  wins: number
  winRate: number
  netPct: number
  profitFactor: number
  open: FvgTrade | null
}

export function summarizeTrades(trades: FvgTrade[]): FvgStats {
  const closed = trades.filter((t) => t.exitTime !== null)
  const wins = closed.filter((t) => t.pnlPct > 0).length
  const grossWin = closed.reduce((s, t) => s + Math.max(0, t.pnlPct), 0)
  const grossLoss = closed.reduce((s, t) => s + Math.max(0, -t.pnlPct), 0)
  const last = trades[trades.length - 1]
  return {
    closed: closed.length,
    wins,
    winRate: closed.length ? (wins / closed.length) * 100 : NaN,
    netPct: closed.reduce((s, t) => s + t.pnlPct, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN,
    open: last && last.exitTime === null ? last : null,
  }
}

/** Chart-timeframe name for gap labels, inferred from median bar spacing. */
function tfName(barMs: number): string {
  if (barMs >= WEEK_MS) return 'W'
  if (barMs >= DAY_MS) return barMs === DAY_MS ? 'D' : `${Math.round(barMs / DAY_MS)}D`
  if (barMs >= HOUR_MS) return `${Math.round(barMs / HOUR_MS)}h`
  return `${Math.max(1, Math.round(barMs / MIN_MS))}m`
}

function medianBarMs(candles: Candle[]): number {
  const diffs: number[] = []
  for (let i = Math.max(1, candles.length - 50); i < candles.length; i++) diffs.push(candles[i].time - candles[i - 1].time)
  if (diffs.length === 0) return MIN_MS
  diffs.sort((a, b) => a - b)
  return diffs[Math.floor(diffs.length / 2)]
}

// ---------------------------------------------------------------------------
// Overlay class
// ---------------------------------------------------------------------------

/** Below this many px per bar, signals draw as arrows and gap labels declutter. */
const DENSE_BAR_PX = 6

// Pine's color.new(c, transp) → alpha = 1 - transp/100.
const COLORS = {
  bull: 'rgba(76,175,80,0.10)', // color.green, 90
  bullHtf: 'rgba(0,230,118,0.20)', // color.lime, 80
  bear: 'rgba(255,82,82,0.10)', // color.red, 90
  bearHtf: 'rgba(136,14,79,0.20)', // color.maroon, 80
  mid: 'rgba(255,255,255,0.15)',
  text: '#ffffff',
  stUp: '#4CAF50',
  stDown: '#FF5252',
  buy: '#4CAF50',
  sell: '#FF5252',
  exit: '#FF9800',
}

export default class FvgStrategyOverlay implements StrategyOverlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private opts: FvgStrategyOptions
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private ro: ResizeObserver | null = null
  private running = false
  private raf = 0
  private enabled = false

  private candles: Candle[] = []
  private lastSig = ''
  private result: FvgStrategyResult = { gaps: [], signals: [], trades: [], supertrend: [] }
  private barMs = MIN_MS
  private revision = 0

  private readonly widgetRoot: HTMLElement
  private readonly widgetBody: HTMLElement
  private readonly dock: FloatingWidgetHandle

  constructor(container: HTMLElement, engine: IChartEngine, opts?: Partial<FvgStrategyOptions>) {
    this.container = container
    this.engine = engine
    this.opts = { ...FVG_STRATEGY_DEFAULTS, ...opts }

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

    // Reuses Ultra V2's card styling (.uv2-*); stacks with it in the bottom-right slot.
    this.widgetRoot = document.createElement('div')
    this.widgetRoot.className = 'uv2-widget'
    this.widgetRoot.style.display = 'none'
    const head = document.createElement('div')
    head.className = 'uv2-head'
    head.textContent = 'FVG + ST BACKTEST'
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
    const rect = this.container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.dock.resize()
  }

  /** Call whenever the pane's candle array changes (load, symbol/interval switch, live tick). */
  setCandles(candles: Candle[]): void {
    this.candles = candles
  }

  setOptions(opts: Partial<FvgStrategyOptions>): void {
    this.opts = { ...this.opts, ...opts }
    this.lastSig = '' // every option affects the computed result
    this.syncWidgetVisibility()
  }

  getOptions(): FvgStrategyOptions {
    return { ...this.opts }
  }

  /** Strategy Tester feed. No stop in this strategy, so the tester shows no R multiples. */
  getStrategyTrades(): StrategyTrade[] {
    return this.result.trades.map((t) => ({
      side: t.side,
      entryTime: t.entryTime,
      entryPrice: t.entryPrice,
      exitTime: t.exitTime,
      exitPrice: t.exitPrice,
      exitReason: t.exitTime === null ? undefined : 'Supertrend flip',
    }))
  }

  getRevision(): number {
    return this.revision
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
    this.syncWidgetVisibility()
    if (on) this.start()
    else this.stop()
  }

  private syncWidgetVisibility(): void {
    const show = this.enabled && this.opts.showStats
    this.widgetRoot.style.display = show ? 'flex' : 'none'
    this.dock.setVisible(show)
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
    this.lastSig = ''
    this.result = { gaps: [], signals: [], trades: [], supertrend: [] }
    this.revision++
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  destroy(): void {
    this.stop()
    this.ro?.disconnect()
    this.dock.destroy()
    this.widgetRoot.remove()
    this.canvas.remove()
  }

  private recompute(): void {
    const c = this.candles
    if (c.length < 3) return
    const last = c[c.length - 1]
    const sig = `${c.length}:${c[0].time}:${last.time}:${last.high}:${last.low}:${last.close}`
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.barMs = medianBarMs(c)
    this.result = computeFvgStrategy(c, this.opts)
    this.revision++
    this.renderWidget()
  }

  private renderWidget(): void {
    if (!this.opts.showStats) return
    const s = summarizeTrades(this.result.trades)
    const pct = (v: number): string => (isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—')
    const pnlColor = (v: number): string => (!isFinite(v) || v === 0 ? '#d1d4dc' : v > 0 ? COLORS.buy : COLORS.sell)
    const pf = isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : s.profitFactor === Infinity ? '∞' : '—'
    const rows: [string, string, string][] = [
      ['Trades', String(s.closed), '#d1d4dc'],
      ['Win rate', isFinite(s.winRate) ? `${s.winRate.toFixed(0)}%` : '—', '#d1d4dc'],
      ['Net', pct(s.netPct), pnlColor(s.netPct)],
      ['Profit factor', pf, '#d1d4dc'],
      s.open
        ? [`Open ${s.open.side === 'long' ? 'LONG' : 'SHORT'}`, pct(s.open.pnlPct), pnlColor(s.open.pnlPct)]
        : ['Position', 'Flat', '#787b86'],
    ]
    this.widgetBody.innerHTML = ''
    for (const [label, value, color] of rows) {
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
      this.widgetBody.appendChild(row)
    }
  }

  private draw(): void {
    this.recompute()
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)

    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect || this.candles.length === 0) return

    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.clip()

    // Zoomed out, full text badges pile on top of each other — fall back to
    // compact arrows and drop gap labels that would collide.
    const t = this.candles[this.candles.length - 1].time
    const dense = conv.timeToX(t) - conv.timeToX(t - this.barMs) < DENSE_BAR_PX

    this.drawGaps(conv, rect, dense)
    if (this.opts.showSupertrend) this.drawSupertrend(conv, rect)
    if (this.opts.showSignals) this.drawSignals(conv, rect, dense)

    this.ctx.restore()
  }

  private drawGaps(conv: Converters, rect: Rect, dense: boolean): void {
    const ctx = this.ctx
    const labelBoxes: { x: number; y: number; w: number }[] = []
    const right = rect.x + rect.width
    const chartTf = tfName(this.barMs)
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const g of this.result.gaps) {
      const x1 = conv.timeToX(g.startTime)
      const x2 = g.endTime === null ? right : conv.timeToX(g.endTime)
      if (x2 < rect.x || x1 > right) continue
      const yTop = conv.priceToY(g.top)
      const yBot = conv.priceToY(g.bottom)
      ctx.fillStyle = g.kind === 'bull' ? (g.htf ? COLORS.bullHtf : COLORS.bull) : g.htf ? COLORS.bearHtf : COLORS.bear
      ctx.fillRect(x1, Math.min(yTop, yBot), Math.max(1, x2 - x1), Math.max(1, Math.abs(yBot - yTop)))

      if (this.opts.fillByMid) {
        const ym = Math.round(conv.priceToY(g.mid)) + 0.5
        ctx.strokeStyle = COLORS.mid
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x1, ym)
        ctx.lineTo(x2, ym)
        ctx.stroke()
      }
      // The source deletes a label on fill only when deleteOnFill is on, so a
      // frozen (filled) gap keeps its label.
      if (this.opts.labelTf) {
        const offset = g.htf ? this.opts.htfLabelOffset : this.opts.labelOffset
        const lx = conv.timeToX(g.startTime + offset * this.barMs)
        const ly = conv.priceToY(g.mid * 0.999)
        const text = `${g.htf ? this.opts.htfTimeframe : chartTf} FVG`
        const w = ctx.measureText(text).width
        if (dense && labelBoxes.some((b) => Math.abs(b.y - ly) < 14 && Math.abs(b.x - lx) < (b.w + w) / 2)) continue
        labelBoxes.push({ x: lx, y: ly, w })
        ctx.fillStyle = COLORS.text
        ctx.fillText(text, lx, ly)
      }
    }
  }

  private drawSupertrend(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    const series = this.result.supertrend
    if (series.length === 0) return
    let started = false
    let curUp = series[0]?.up ?? true
    ctx.lineWidth = 2
    ctx.strokeStyle = curUp ? COLORS.stUp : COLORS.stDown
    ctx.beginPath()
    for (const p of series) {
      if (!isFinite(p.value)) continue
      const x = conv.timeToX(p.time)
      if (x < rect.x - 20 || x > rect.x + rect.width + 20) continue
      // Pine plots two series with `na` gaps, so a flip breaks the line.
      if (p.up !== curUp) {
        if (started) ctx.stroke()
        curUp = p.up
        ctx.strokeStyle = curUp ? COLORS.stUp : COLORS.stDown
        ctx.beginPath()
        started = false
      }
      const y = conv.priceToY(p.value)
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else ctx.lineTo(x, y)
    }
    if (started) ctx.stroke()
  }

  private drawSignals(conv: Converters, rect: Rect, dense: boolean): void {
    const ctx = this.ctx
    ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const s of this.result.signals) {
      const x = conv.timeToX(s.time)
      if (x < rect.x - 30 || x > rect.x + rect.width + 30) continue
      // labelup = below bar pointing up; labeldown = above bar pointing down.
      const below = s.type === 'buy' || s.type === 'exitShort'
      const color = s.type === 'buy' ? COLORS.buy : s.type === 'sell' ? COLORS.sell : COLORS.exit
      const text = s.type === 'buy' ? 'BUY' : s.type === 'sell' ? 'SELL' : 'EXIT'
      const tipY = below ? conv.priceToY(s.low) + 6 : conv.priceToY(s.high) - 6
      if (dense) this.drawArrow(x, tipY, below, color)
      else this.drawLabel(x, tipY, below, text, color)
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
    ctx.fillStyle = '#ffffff'
    ctx.fillText(text, x, boxY + h / 2 + 0.5)
  }
}
