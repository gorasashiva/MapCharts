/**
 * Footprint trade signals on the live chart — the layer the Volume Footprint
 * overlay (footprint.ts) runs: builds exact footprint bars from the trades it
 * holds (recorded tape + live), runs src/overlays/footprintSignalsModel.ts on
 * them, draws each trade (zone, entry, stop, target, result), keeps a
 * scorecard, and reports new signals / exits for alerts and drawings.
 *
 * Only bars built from exact trades count — an estimated footprint cannot show
 * a real imbalance. Rows use a fixed size from the candles (not the zoom), so
 * zooming never changes a signal. A signal is read on a closed bar; the
 * forming bar only moves open trades to their stop or target.
 */
import type { Candle } from '../core/types'
import type { FpBarFlow } from './footprintBarStore'
import {
  computeFootprintSignals,
  fpStats,
  gexConfluence,
  FP_SETUP_LABEL,
  FP_SIGNAL_DEFAULTS,
  type FpBar,
  type FpGexLevel,
  type FpGexMatch,
  type FpSetup,
  type FpSignalOptions,
  type FpTrade,
} from './footprintSignalsModel'

export interface FpSignalTrade extends FpTrade {
  signalTime: number
  entryTime: number
  exitTime: number | null
  /** Set when the target was moved in to a nearer GEX level (its label). */
  targetFrom?: string
}

export interface FpSignalEvent {
  kind: 'signal' | 'exit'
  trade: FpSignalTrade
  text: string
  /** The GEX level the signal formed at (null: none; undefined: GEX not in use). */
  gex?: FpGexMatch | null
}

/**
 * GEX Sabers levels to weigh signals against. GEX is live-only (no history of
 * the option chain), so a signal is matched against the levels at the moment it
 * fires and that match is kept; history from before has no GEX tag.
 */
export interface FpGexInput {
  levels: FpGexLevel[]
  /** 'tag': mark signals at a level; 'only': alerts, drawings and live plots only for those. */
  mode: 'tag' | 'only'
  /** "At a level" = the extreme within this many average bar ranges of it. */
  near: number
}

interface Print {
  time: number
  price: number
  qty: number
  buy: boolean
}

type Conv = { timeToX(t: number): number; priceToY(p: number): number }
type Rect = { x: number; y: number; width: number; height: number }

const SHORT: Record<FpSetup, string> = { stack: 'STACK', absorb: 'ABSORB', trap: 'TRAP', diverge: 'DIV' }
const UP = '#26a69a'
const DOWN = '#ef5350'
const GOLD = '#ffd54f'
const PURPLE = '#b388ff'
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

/** Signals are read in blocks of this many bars (see compute). */
const BLOCK_BARS = 120
/** Row size ≈ price × ROW_K / autoRows on 5m (gold ~3900 → 0.2, BTC ~77k → 5), growing with √timeframe. */
const ROW_K = 7.2e-4

/** A block's row size, from its first open: fixed for the block whatever else is loaded. */
function blockRowSize(price: number, barMs: number, autoRows: number): number {
  return niceStep(((price * ROW_K) / Math.max(1, autoRows)) * Math.sqrt(barMs / 300_000))
}

function buildBar(k: Candle, prints: Print[], rs: number): FpBar {
  const rows = new Map<number, [number, number]>()
  for (const p of prints) {
    const r = Math.floor(p.price / rs)
    const e = rows.get(r)
    if (e) p.buy ? (e[0] += p.qty) : (e[1] += p.qty)
    else rows.set(r, p.buy ? [p.qty, 0] : [0, p.qty])
  }
  return { time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, rows }
}

function barFlow(b: FpBar, rs: number): FpBarFlow {
  let delta = 0, vol = 0, sell = 0, buy = 0, sellLow = 0, buyHigh = 0
  const lowRow = Math.floor(b.low / rs), highRow = Math.floor(b.high / rs)
  for (const [r, [bu, se]] of b.rows) {
    delta += bu - se
    vol += bu + se
    sell += se
    buy += bu
    if (r < lowRow + 2) sellLow += se
    if (r > highRow - 2) buyHigh += bu
  }
  return { delta, vol, sellLowShare: sell ? sellLow / sell : 0, buyHighShare: buy ? buyHigh / buy : 0 }
}

function niceStep(x: number): number {
  if (!(x > 0)) return 1
  const p = Math.pow(10, Math.floor(Math.log10(x)))
  const m = x / p
  return (m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * p
}

export class FootprintSignalsLayer {
  trades: FpSignalTrade[] = []
  /** Order flow of each exact bar from the last computation (published for MAP V3's confirmation). */
  flow = new Map<number, FpBarFlow>()
  private key = ''
  private seen = new Set<string>() // signals already reported
  private exited = new Set<string>()
  private formingHit = new Map<string, 'target' | 'stop'>()
  private primed = false // the first computation is history, not news
  /** GEX match frozen when each live signal fired. */
  private gexMatch = new Map<string, FpGexMatch | null>()
  private gexMode: FpGexInput['mode'] | null = null

  constructor(public opts: Partial<FpSignalOptions> = {}) {}

  /** Options or symbol changed: recompute, and don't announce the history that appears. */
  reset(): void {
    this.key = ''
    this.primed = false
    this.trades = []
    this.seen.clear()
    this.exited.clear()
    this.formingHit.clear()
    this.gexMatch.clear()
  }

  gexOf(t: FpSignalTrade): FpGexMatch | null | undefined {
    return this.gexMatch.get(tradeKey(t))
  }

  /**
   * Recompute when a bar closed or the trade sources changed; check the forming
   * bar against open trades on every call. Returns what is new since the last call.
   */
  update(c: Candle[], barMs: number, autoRows: number, exact: [number, number][], sources: Print[][], now: number, gex?: FpGexInput, historyFrom = -Infinity): FpSignalEvent[] {
    const events: FpSignalEvent[] = []
    this.gexMode = gex && gex.levels.length ? gex.mode : gex ? this.gexMode : null
    if (c.length < 3) return events
    const closedN = c[c.length - 1].time + barMs <= now ? c.length : c.length - 1
    const key = `${closedN}|${c[0].time}|${c[closedN - 1].time}|${exact.length}|${sources[0]?.length ?? 0}|${historyFrom}|${JSON.stringify(this.opts)}`
    if (key !== this.key && sources.some((s) => s.length)) {
      this.key = key
      const closed = c.slice(0, closedN)
      this.trades = this.compute(closed, barMs, autoRows, exact, sources, historyFrom)
      for (const t of this.trades) this.useGexTarget(t, closed)
      for (const t of this.trades) {
        const k = tradeKey(t)
        if (!this.seen.has(k)) {
          this.seen.add(k)
          if (this.primed) {
            let match: FpGexMatch | null | undefined
            if (gex && gex.levels.length) {
              match = gexConfluence(t, gex.levels, avgRange(c), gex.near)
              this.gexMatch.set(k, match)
              this.useGexTarget(t, closed)
            }
            events.push({ kind: 'signal', trade: t, text: signalText(t, match), gex: match })
          }
        }
        if (t.r !== null && !this.exited.has(k)) {
          this.exited.add(k)
          // already announced from the forming bar: don't repeat
          if (this.primed && !this.formingHit.has(k)) events.push({ kind: 'exit', trade: t, text: exitText(t, t.outcome), gex: this.gexMatch.get(k) })
        }
      }
      this.primed = true
    }
    // the forming bar: stop / target as they happen
    if (closedN < c.length) {
      const f = c[c.length - 1]
      for (const t of this.trades) {
        const k = tradeKey(t)
        if (t.r !== null || t.entryTime > f.time || this.formingHit.has(k)) continue
        const stop = t.side > 0 ? f.low <= t.stop : f.high >= t.stop
        const target = t.side > 0 ? f.high >= t.target : f.low <= t.target
        if (!stop && !target) continue
        const hit = stop ? 'stop' : 'target'
        this.formingHit.set(k, hit)
        events.push({ kind: 'exit', trade: t, text: exitText(t, hit), gex: this.gexMatch.get(k) })
      }
    }
    return events
  }

  /**
   * Signals are read in fixed blocks of BLOCK_BARS bars aligned to the clock, each with its
   * own warm-up bars and its own row size (from the block's first open). A block's result
   * then depends only on its own bars and trades — never on where the chart's loaded
   * history happens to start — so a refresh, or the window sliding on, never moves a trade.
   * Blocks whose warm-up reaches before the loaded history are left out.
   */
  private compute(c: Candle[], barMs: number, autoRows: number, exact: [number, number][], sources: Print[][], historyFrom: number): FpSignalTrade[] {
    const covered = (t0: number, t1: number): boolean => exact.some(([a, b]) => a <= t0 + 2000 && b >= t1 - 2000)
    const first = c[0].time
    const idx = new Map<number, number>()
    c.forEach((k, i) => {
      if (covered(k.time, k.time + barMs)) idx.set(k.time, i)
    })
    // prints of each exact bar
    const byBar: Print[][] = c.map(() => [])
    for (const src of sources) {
      for (const p of src) {
        if (p.time < first) continue
        const i = idx.get(first + Math.floor((p.time - first) / barMs) * barMs)
        if (i !== undefined) byBar[i].push(p)
      }
    }
    const o = { ...FP_SIGNAL_DEFAULTS, ...this.opts }
    const warm = Math.max(o.trendBars, o.swingBars, 20) + 2
    const blockMs = BLOCK_BARS * barMs
    const from = Math.max(first, historyFrom)
    const lastT = c[c.length - 1].time
    const lowerBound = (t: number): number => {
      let lo = 0, hi = c.length
      while (lo < hi) {
        const m = (lo + hi) >> 1
        if (c[m].time < t) lo = m + 1
        else hi = m
      }
      return lo
    }
    this.flow = new Map()
    const out: FpSignalTrade[] = []
    for (let b0 = Math.ceil((from + warm * barMs) / blockMs) * blockMs; b0 <= lastT; b0 += blockMs) {
      const i0 = lowerBound(b0 - warm * barMs), iS = lowerBound(b0), i1 = lowerBound(b0 + blockMs)
      if (iS >= c.length) break
      const rs = blockRowSize(c[iS].open, barMs, autoRows)
      const bars: (FpBar | null)[] = []
      for (let i = i0; i < i1; i++) bars.push(byBar[i].length ? buildBar(c[i], byBar[i], rs) : null)
      for (let i = iS; i < i1; i++) {
        const b = bars[i - i0]
        if (b) this.flow.set(b.time, barFlow(b, rs))
      }
      // each run of consecutive exact bars is read on its own
      let start = -1
      const flush = (end: number): void => {
        if (start < 0) return
        const base = start
        const seg = bars.slice(base, end) as FpBar[]
        start = -1
        if (seg.length < 12) return
        const ci = (j: number): number => i0 + base + j // candle index of a segment bar
        const at = (j: number): number => (ci(j) < c.length ? c[ci(j)].time : lastT + (ci(j) - c.length + 1) * barMs)
        for (const t of computeFootprintSignals(seg, rs, this.opts).trades) {
          // the block keeps the trades signalled inside it; warm-up bars only set the state
          if (ci(t.signalIndex) < iS) continue
          const st: FpSignalTrade = { ...t, signalTime: at(t.signalIndex), entryTime: at(t.entryIndex), exitTime: t.exitIndex === null ? null : at(t.exitIndex) }
          // the exact run ended with the trade still open: follow it on the plain candles
          const after = ci(seg.length)
          if (st.r === null && after < c.length) this.followOn(st, c, ci(t.entryIndex), Math.max(after, ci(t.entryIndex)))
          out.push(st)
        }
      }
      bars.forEach((b, j) => {
        if (b && b.rows.size) {
          if (start < 0) start = j
        } else flush(j)
      })
      flush(bars.length)
    }
    return out
  }

  /**
   * A GEX level nearer than the R target is where the trade gets out: move the
   * target in and follow the trade again from its entry. (A farther one stays a
   * stretch TP2 line while the trade is open.)
   */
  private useGexTarget(t: FpSignalTrade, c: Candle[]): void {
    const next = this.gexMatch.get(tradeKey(t))?.next
    if (!next || (next.price - t.entry) * t.side >= (t.target - t.entry) * t.side) return
    t.target = next.price
    t.targetFrom = `GEX ${next.label}`
    t.r = t.exitIndex = t.exitPrice = t.exitTime = null
    const i = c.findIndex((k) => k.time === t.entryTime)
    if (i < 0) {
      t.outcome = 'pending'
      return
    }
    this.followOn(t, c, i, i)
  }

  /** As drawn: a trade whose stop or target traded in the forming bar is shown closed there already. */
  private shown(t: FpSignalTrade, lastT: number): FpSignalTrade {
    const hit = t.r === null ? this.formingHit.get(tradeKey(t)) : undefined
    if (!hit) return t
    const px = hit === 'stop' ? t.stop : t.target
    return { ...t, outcome: hit, exitTime: lastT, exitPrice: px, r: ((px - t.entry) * t.side) / Math.abs(t.entry - t.stop) }
  }

  /** Stop / target / time-out on candles [from…], counting bars from the entry bar. */
  private followOn(t: FpSignalTrade, c: Candle[], entryIdx: number, from: number): void {
    const maxBars = this.opts.maxBars ?? FP_SIGNAL_DEFAULTS.maxBars
    const cost = this.opts.cost ?? 0
    const risk = Math.abs(t.entry - t.stop)
    for (let j = from; j < c.length; j++) {
      const k = c[j]
      let px: number | null = null
      if (t.side > 0 ? k.low <= t.stop : k.high >= t.stop) (px = t.stop), (t.outcome = 'stop')
      else if (t.side > 0 ? k.high >= t.target : k.low <= t.target) (px = t.target), (t.outcome = 'target')
      else if (j - entryIdx + 1 >= maxBars) (px = k.close), (t.outcome = 'timeout')
      if (px === null) continue
      t.exitPrice = px
      t.exitTime = k.time
      t.r = Math.round((((px - t.entry) * t.side - cost) / risk) * 1e6) / 1e6
      return
    }
    t.outcome = 'open'
  }

  stats(): ReturnType<typeof fpStats> {
    return fpStats(this.trades)
  }

  draw(ctx: CanvasRenderingContext2D, conv: Conv, rect: Rect, c: Candle[], showHistory: boolean): void {
    if (c.length < 2) return
    const right = rect.x + rect.width
    const spacing = Math.abs(conv.timeToX(c[c.length - 1].time) - conv.timeToX(c[c.length - 2].time)) || 6
    const lastX = conv.timeToX(c[c.length - 1].time)
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    ctx.textBaseline = 'middle'
    const onlyGex = this.gexMode === 'only'
    const lastT = c[c.length - 1].time
    const all = this.trades.map((t) => this.shown(t, lastT))
    const live = all.filter((t) => t.r === null && (!onlyGex || this.gexMatch.get(tradeKey(t))))
    for (const t of showHistory ? all : live) {
      const open = t.r === null
      const g = this.gexMatch.get(tradeKey(t))
      if (open && onlyGex && !g) continue
      const x0 = conv.timeToX(t.entryTime) - spacing / 2
      const x1 = open ? Math.max(lastX + spacing * 4, x0 + spacing * 6) : conv.timeToX(t.exitTime as number) + spacing / 2
      if (x1 < rect.x || x0 > right) continue
      const yE = conv.priceToY(t.entry), yS = conv.priceToY(t.stop), yT = conv.priceToY(t.target)
      ctx.globalAlpha = open ? 1 : 0.55
      ctx.fillStyle = 'rgba(239,83,80,0.14)'
      ctx.fillRect(x0, Math.min(yE, yS), x1 - x0, Math.abs(yS - yE))
      ctx.fillStyle = 'rgba(38,166,154,0.14)'
      ctx.fillRect(x0, Math.min(yE, yT), x1 - x0, Math.abs(yT - yE))
      const line = (y: number, color: string, dash: number[]): void => {
        ctx.strokeStyle = color
        ctx.setLineDash(dash)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x0, Math.round(y) + 0.5)
        ctx.lineTo(x1, Math.round(y) + 0.5)
        ctx.stroke()
      }
      line(yE, '#d1d4dc', [])
      line(yS, DOWN, [4, 3])
      line(yT, UP, [4, 3])
      ctx.setLineDash([])
      // the bar the signal was read on, bracketed
      const xs = conv.timeToX(t.signalTime)
      const yz0 = conv.priceToY(t.zone[1]), yz1 = conv.priceToY(t.zone[0])
      ctx.strokeStyle = GOLD
      ctx.lineWidth = 1.5
      ctx.strokeRect(xs - spacing * 0.45, yz0, spacing * 0.9, Math.max(2, yz1 - yz0))
      // entry arrow and tag
      const col = t.side > 0 ? UP : DOWN
      const xa = conv.timeToX(t.entryTime)
      const ya = t.side > 0 ? Math.max(yE, yS) + 12 : Math.min(yE, yS) - 12
      ctx.fillStyle = col
      ctx.beginPath()
      if (t.side > 0) {
        ctx.moveTo(xa, ya - 7)
        ctx.lineTo(xa - 6, ya + 3)
        ctx.lineTo(xa + 6, ya + 3)
      } else {
        ctx.moveTo(xa, ya + 7)
        ctx.lineTo(xa - 6, ya - 3)
        ctx.lineTo(xa + 6, ya - 3)
      }
      ctx.fill()
      // zoomed far out the tags would pile up: arrows and boxes only, except the live trade
      if (spacing < 5 && !open) {
        ctx.globalAlpha = 1
        continue
      }
      pill(ctx, `${t.side > 0 ? 'LONG' : 'SHORT'} · ${SHORT[t.setup]}${g ? ` · @GEX ${g.at.label}` : ''}`, xa + 9, t.side > 0 ? ya + 8 : ya - 8, g ? PURPLE : col)
      // a live trade's labels reach past the last bar: keep them inside the plot
      const lx = open ? Math.min(x1 + 3, right - 130) : x1 + 3
      if (open && g?.next && !t.targetFrom) {
        // second target: the next GEX level in the trade's direction
        const y2 = conv.priceToY(g.next.price)
        line(y2, PURPLE, [2, 3])
        pill(ctx, `TP2 GEX ${g.next.label} ${fmtP(g.next.price)}`, lx, y2, PURPLE)
      }
      if (open) {
        pill(ctx, `TP${t.targetFrom ? ` ${t.targetFrom}` : ''} ${fmtP(t.target)}`, lx, yT, t.targetFrom ? PURPLE : UP)
        pill(ctx, `${t.outcome === 'pending' ? 'ENTRY' : 'IN'} ${fmtP(t.entry)}`, lx, yE, '#5d6b82')
        pill(ctx, `SL ${fmtP(t.stop)}`, lx, yS, DOWN)
      } else {
        const r = t.r as number
        const y = t.outcome === 'stop' ? yS : t.outcome === 'target' ? yT : conv.priceToY(t.exitPrice as number)
        pill(ctx, `${t.outcome === 'timeout' ? '⏱' : r > 0 ? '✓' : '✗'} ${r >= 0 ? '+' : ''}${r.toFixed(1)}R`, x1 + 3, y, r > 0 ? UP : DOWN)
      }
      ctx.globalAlpha = 1
    }
    // scorecard: the record on this chart's exact-trade bars, and the GEX-matched ones since the page opened
    const s = fpStats(all)
    let card = s.trades
      ? `Footprint signals · ${s.trades} closed · win ${(s.winRate * 100).toFixed(0)}% · ${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)}R avg · ${s.totalR >= 0 ? '+' : ''}${s.totalR.toFixed(1)}R total${live.length ? ` · ${live.length} live` : ''}`
      : `Footprint signals · no closed trades on exact-trade bars yet${live.length ? ` · ${live.length} live` : ''}`
    if (this.gexMode) {
      const g = fpStats(all.filter((t) => this.gexMatch.get(tradeKey(t))))
      const seen = [...this.gexMatch.values()].filter(Boolean).length
      card += ` │ at GEX (live): ${seen} signal${seen === 1 ? '' : 's'}${g.trades ? ` · ${g.trades} closed · win ${(g.winRate * 100).toFixed(0)}% · ${g.avgR >= 0 ? '+' : ''}${g.avgR.toFixed(2)}R` : ''}`
    }
    ctx.font = `600 11px ${FONT}`
    const w = ctx.measureText(card).width + 16
    ctx.fillStyle = 'rgba(19,23,34,0.85)'
    ctx.beginPath()
    // bottom left, above the footprint's own status lines (the legend owns the top left)
    const yCard = rect.y + rect.height - 62
    ctx.roundRect(rect.x + 8, yCard, w, 20, 4)
    ctx.fill()
    ctx.fillStyle = s.trades && s.avgR < 0 ? '#ff8a80' : '#d1d4dc'
    ctx.textAlign = 'left'
    ctx.fillText(card, rect.x + 16, yCard + 10.5)
    ctx.restore()
  }
}

const tradeKey = (t: FpSignalTrade): string => `${t.setup}|${t.side}|${t.signalTime}`
const fmtP = (v: number): string => (Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toPrecision(5))

function signalText(t: FpSignalTrade, g?: FpGexMatch | null): string {
  const tp2 = g?.next && !t.targetFrom ? ` TP2: GEX ${g.next.label} ${fmtP(g.next.price)}.` : ''
  const gex = g ? ` At GEX ${g.at.label} (${fmtP(g.at.price)}).${tp2}` : ''
  return `${t.side > 0 ? 'LONG' : 'SHORT'} — ${FP_SETUP_LABEL[t.setup]}. Entry ${fmtP(t.entry)}, stop ${fmtP(t.stop)}, target ${fmtP(t.target)}${t.targetFrom ? ` (${t.targetFrom})` : ''}.${gex} ${t.why}`
}

/** Average range of the last 20 closed candles. */
function avgRange(c: Candle[]): number {
  const cs = c.slice(-21, -1)
  return cs.length ? cs.reduce((s, k) => s + k.high - k.low, 0) / cs.length : 0
}
function exitText(t: FpSignalTrade, outcome: string): string {
  const what = outcome === 'target' ? `target ${fmtP(t.target)} hit` : outcome === 'stop' ? `stopped at ${fmtP(t.stop)}` : 'closed on time'
  return `${t.side > 0 ? 'LONG' : 'SHORT'} ${FP_SETUP_LABEL[t.setup]} from ${fmtP(t.entry)}: ${what}`
}

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string): void {
  ctx.font = `600 10px ${FONT}`
  const w = ctx.measureText(text).width + 8
  ctx.fillStyle = bg
  ctx.beginPath()
  ctx.roundRect(x, y - 7, w, 14, 3)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'left'
  ctx.fillText(text, x + 4, y + 0.5)
}
