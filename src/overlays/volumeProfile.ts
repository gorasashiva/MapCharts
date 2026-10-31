/**
 * Volume Profile & TPO — a fixed-period profile study, separate from the
 * lightweight "visible range" volume profile already built into pane.ts.
 * Two render modes:
 *   - 'profile': a classic horizontal volume-by-price histogram, each bar
 *     split into a buy (green) / sell (red) portion by delta at that price
 *     level — a "Delta" profile, not a plain single-color one.
 *   - 'tpo': a Market Profile / TPO letter chart. The period is divided into
 *     up to 26 time brackets (A, B, C…); for each price level, one letter is
 *     drawn per bracket that touched it, stacked out from the anchor edge —
 *     the classic stepped "profile" shape, letters colored by that
 *     bracket's local delta at that level. This covers the core TPO
 *     construction (brackets → letters → shape); it does not attempt the
 *     fuller Market Profile toolkit (single prints, initial balance, etc).
 *
 * VPOC (point of control), VAH/VAL (value area high/low) are computed the
 * same way across all modes and independently toggleable.
 *
 * A third mode, 'delta', shows the NET delta (buy volume − sell volume) per
 * row instead of total volume — bar width scaled to |delta| relative to the
 * largest one in the profile, colored by sign, with the signed delta number
 * printed on the bar. This is a distinct read from 'profile' mode (which
 * shows total volume, split by color into its buy/sell share): delta can be
 * small even when volume is huge (balanced two-sided trading), or large even
 * when volume is modest (one-sided flow) — the two modes answer different
 * questions and are common side-by-side options in real footprint tools.
 */
import type { IChartEngine, PriceTag } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import { sessionIndex } from '../core/session'
import { buildProfileZones, buyShare, findLvns, nearestZones, nextLvns, zoneHeadline, type PriceBand, type ProfileZone } from './profileZones'
import { lazyCanvas } from './lazyCanvas'

const TAG_SOURCE = 'volumeProfile'

export type VolumeProfileMode = 'profile' | 'tpo' | 'delta'
export type VolumeProfilePeriod = 'session' | 'bars' | 'visible'
export type VolumeProfilePlacement = 'left' | 'right'

export interface VolumeProfileOptions {
  enabled: boolean
  mode: VolumeProfileMode
  period: VolumeProfilePeriod
  barsCount: number // used when period === 'bars'
  placement: VolumeProfilePlacement
  bins: number // price rows
  valueAreaPct: number // 0..1, e.g. 0.70 = 70% value area
  showVpoc: boolean
  showVah: boolean
  showVal: boolean
  buyColor: string
  sellColor: string
  vpocColor: string
  vahColor: string
  valColor: string
  widthPct: number // profile width as a fraction of pane width
  alpha: number
  showValue: boolean // print the delta number on each bar — 'delta' mode only
  // ---- v2: supply/demand zones + support/resistance strength (see profileZones.ts) ----
  showZones: boolean
  /** A row joins a zone when its volume is ≥ this % of the VPOC row's. */
  zoneThresholdPct: number
  /** Print kind · strength · reactions · buy% on each zone. */
  showZoneLabels: boolean
  /** Hide zones scoring below this (0 = show all). */
  minZoneScore: number
  /** Shade low-volume nodes between zones (fast-travel areas). */
  showLvn: boolean
  lvnPct: number
  /** Also draw the previous trading session's zones (Session period only). */
  showPrevSessionZones: boolean
  /** 'nearest' = only the zone price is in + the nearest `zonesPerSide` each side; 'all' = every zone. */
  zoneFocus: 'nearest' | 'all'
  zonesPerSide: number
  /** Merge zones separated by up to this many thin rows. */
  mergeGapRows: number
}

const DEFAULTS: VolumeProfileOptions = {
  enabled: false,
  mode: 'profile',
  period: 'session',
  barsCount: 200,
  placement: 'right',
  bins: 30,
  valueAreaPct: 0.7,
  showVpoc: true,
  showVah: true,
  showVal: true,
  buyColor: '#0ecb81',
  sellColor: '#f6465d',
  vpocColor: '#ffc107',
  vahColor: '#4a9eff',
  valColor: '#4a9eff',
  widthPct: 0.22,
  alpha: 0.85,
  showValue: true,
  showZones: true,
  zoneThresholdPct: 70,
  showZoneLabels: true,
  minZoneScore: 0,
  showLvn: false,
  lvnPct: 25,
  showPrevSessionZones: false,
  zoneFocus: 'nearest',
  zonesPerSide: 2,
  mergeGapRows: 1,
}

const ZONE_COLORS = {
  demand: { fill: 'rgba(14,203,129,0.10)', edge: '#0ecb81' },
  supply: { fill: 'rgba(246,70,93,0.10)', edge: '#f6465d' },
  inplay: { fill: 'rgba(255,193,7,0.10)', edge: '#ffc107' },
  lvn: 'rgba(160,160,170,0.07)',
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

interface ProfileResult {
  lo: number
  hi: number
  binVolume: Float64Array
  binBuyVolume: Float64Array
  pocBin: number
  vahBin: number
  valBin: number
}

interface TPOResult {
  lo: number
  hi: number
  binVolume: Float64Array
  // per bin: sequence of {letter, bullish} touches, in bracket order
  rows: { letter: string; bullish: boolean }[][]
  pocBin: number
  vahBin: number
  valBin: number
  maxLetters: number
}

type Rect = { x: number; y: number; width: number; height: number }

function lowerBoundByX(candles: Candle[], x: number, conv: Converters): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (conv.timeToX(candles[mid].time) < x) lo = mid + 1
    else hi = mid
  }
  return lo
}
function upperBoundByX(candles: Candle[], x: number, conv: Converters): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (conv.timeToX(candles[mid].time) <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Bin a candle subset's volume (and buy volume) by price. */
function binCandles(subset: Candle[], bins: number): { lo: number; hi: number; binVolume: Float64Array; binBuyVolume: Float64Array } | null {
  let lo = Infinity
  let hi = -Infinity
  for (const c of subset) {
    if (c.low < lo) lo = c.low
    if (c.high > hi) hi = c.high
  }
  if (subset.length < 2 || !isFinite(lo) || hi <= lo) return null

  const range = hi - lo
  const binVolume = new Float64Array(bins)
  const binBuyVolume = new Float64Array(bins)
  for (const c of subset) {
    const b0 = Math.max(0, Math.min(bins - 1, Math.floor(((c.low - lo) / range) * bins)))
    const b1 = Math.max(0, Math.min(bins - 1, Math.floor(((c.high - lo) / range) * bins)))
    const spread = b1 - b0 + 1
    const volPer = c.volume / spread
    // Real taker buy volume when the feed has it (live bars), else the
    // close-location estimate — a flat 50/50 would zero out every delta.
    const buyPer = (c.volume * buyShare(c)) / spread
    for (let b = b0; b <= b1; b++) {
      binVolume[b] += volPer
      binBuyVolume[b] += buyPer
    }
  }
  return { lo, hi, binVolume, binBuyVolume }
}

/** POC = highest-volume bin. Value area = smallest contiguous band around POC holding valueAreaPct of total volume, grown one side at a time toward whichever neighbor has more volume. */
function valueArea(binVolume: ArrayLike<number>, valueAreaPct: number): { pocBin: number; vahBin: number; valBin: number } {
  const bins = binVolume.length
  let pocBin = 0
  let maxVol = 0
  let total = 0
  for (let b = 0; b < bins; b++) {
    total += binVolume[b]
    if (binVolume[b] > maxVol) {
      maxVol = binVolume[b]
      pocBin = b
    }
  }
  let lo = pocBin
  let hi = pocBin
  let covered = binVolume[pocBin]
  const target = total * valueAreaPct
  while (covered < target && (lo > 0 || hi < bins - 1)) {
    const belowVol = lo > 0 ? binVolume[lo - 1] : -1
    const aboveVol = hi < bins - 1 ? binVolume[hi + 1] : -1
    if (aboveVol >= belowVol) {
      hi++
      covered += binVolume[hi]
    } else {
      lo--
      covered += binVolume[lo]
    }
  }
  return { pocBin, vahBin: hi, valBin: lo }
}

export default class VolumeProfileOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private opts: VolumeProfileOptions
  private candles: Candle[] = []
  private openHourUTC = 0 // trading-day open for the Session period — see core/session.ts
  private cached: ProfileResult | TPOResult | null = null
  private cacheKey = ''
  /** Last seen delta per price row (delta mode) — drives the live-change flash/arrows. */
  private deltaSeen = new Map<number, { v: number; at: number; up: boolean }>()
  private zones: ProfileZone[] = []
  private prevZones: ProfileZone[] = []
  private lvns: PriceBand[] = []
  private zonePrice = 0
  private running = false
  private raf = 0
  private ro: ResizeObserver | null = null
  /** Value-area prices + session delta from the last frame, for the pane legend. */
  private summary: { vah: number; poc: number; val: number; totalDelta: number | null } | null = null
  private totalDelta: number | null = null

  constructor(container: HTMLElement, engine: IChartEngine, opts?: Partial<VolumeProfileOptions>) {
    this.container = container
    this.engine = engine
    this.opts = { ...DEFAULTS, ...opts }
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '17'
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

  setOptions(opts: Partial<VolumeProfileOptions>): void {
    this.opts = { ...this.opts, ...opts }
    this.cacheKey = '' // force recompute — a setting that affects the shape just changed
  }

  getOptions(): VolumeProfileOptions {
    return { ...this.opts }
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

  /** UTC hour each trading session opens (the Session period starts there). */
  setSessionOpenHour(hourUTC: number): void {
    if (hourUTC === this.openHourUTC) return
    this.openHourUTC = hourUTC
    this.cached = null
    this.cacheKey = ''
  }

  reset(): void {
    this.candles = []
    this.cached = null
    this.cacheKey = ''
    this.deltaSeen.clear()
    this.zones = []
    this.prevZones = []
    this.lvns = []
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  destroy(): void {
    this.stop()
    this.ro?.disconnect()
    this.canvas.remove()
    this.clearLevels()
  }

  /** VAH / VPOC / VAL (and Σ delta in delta mode) as drawn last frame; null while off or empty. */
  getSummary(): { vah: number; poc: number; val: number; totalDelta: number | null } | null {
    return this.summary
  }

  private clearLevels(): void {
    this.summary = null
    this.engine.setPriceTags(TAG_SOURCE, [])
  }

  /** The candle subset the current period selects — 'visible' needs the live viewport, everything else is derived from setCandles(). */
  private selectSubset(conv: Converters | null, rect: Rect | null): Candle[] {
    if (this.opts.period === 'bars') return this.candles.slice(-Math.max(2, this.opts.barsCount))
    if (this.opts.period === 'session') {
      if (this.candles.length === 0) return []
      const h = this.openHourUTC
      const lastDay = sessionIndex(this.candles[this.candles.length - 1].time, h)
      let start = this.candles.length
      while (start > 0 && sessionIndex(this.candles[start - 1].time, h) === lastDay) start--
      return this.candles.slice(start)
    }
    // 'visible' — bounded to whatever's on screen right now.
    if (!conv || !rect) return []
    const i0 = lowerBoundByX(this.candles, rect.x - 2, conv)
    const i1 = upperBoundByX(this.candles, rect.x + rect.width + 2, conv)
    return this.candles.slice(i0, i1)
  }

  private draw(): void {
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)
    if (!this.opts.enabled || this.candles.length === 0) return this.clearLevels()

    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect) return this.clearLevels()

    const subset = this.selectSubset(conv, rect)
    if (subset.length < 2) return this.clearLevels()

    // Cache by subset identity + settings, not every frame — 'visible' still
    // recomputes each frame it changes (its own key includes the range),
    // but doesn't redo the work when the viewport hasn't moved.
    // The live close is in the key too: zones re-classify as price moves.
    const live = this.candles[this.candles.length - 1].close
    const key = `${this.opts.mode}|${this.opts.period}|${this.opts.bins}|${this.opts.valueAreaPct}|${subset.length}|${subset[0].time}|${subset[subset.length - 1].time}|${subset[subset.length - 1].close}|${live}`
    if (key !== this.cacheKey) {
      this.cacheKey = key
      this.cached = this.opts.mode === 'tpo' ? this.computeTPO(subset) : this.computeProfile(subset)
      this.computeZones(subset, live)
    }
    if (!this.cached) return this.clearLevels()
    this.totalDelta = null

    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.clip()

    this.drawZones(conv, rect)

    if (this.opts.mode === 'tpo') this.drawTPO(conv, rect, this.cached as TPOResult)
    else if (this.opts.mode === 'delta') this.drawDeltaProfile(conv, rect, this.cached as ProfileResult)
    else this.drawProfile(conv, rect, this.cached as ProfileResult)

    this.ctx.restore()
  }

  /** v2 zones / LVNs / previous-session zones for the current profile. */
  private computeZones(subset: Candle[], price: number): void {
    this.zones = []
    this.prevZones = []
    this.lvns = []
    this.zonePrice = price
    const r = this.cached
    if (!r) return
    const o = this.opts
    const focus = <T extends { lo: number; hi: number }>(zs: T[]): T[] => (o.zoneFocus === 'nearest' ? nearestZones(zs, price, o.zonesPerSide) : zs)
    if (o.showZones) this.zones = focus(buildProfileZones(r, subset, subset, price, o.zoneThresholdPct, o.mergeGapRows).filter((z) => z.score >= o.minZoneScore))
    if (o.showLvn) {
      const lvns = findLvns(r, o.lvnPct)
      this.lvns = o.zoneFocus === 'nearest' ? nextLvns(lvns, price) : lvns
    }
    if (o.showPrevSessionZones && o.period === 'session') {
      const today = sessionIndex(subset[0].time, this.openHourUTC)
      const prev = this.candles.filter((c) => sessionIndex(c.time, this.openHourUTC) === today - 1)
      const binned = binCandles(prev, o.bins)
      if (binned) {
        const p = { ...binned, ...valueArea(binned.binVolume, o.valueAreaPct) }
        // Reactions count across yesterday and today: today's tests are what matter.
        // Nearest mode keeps one previous-session zone per side.
        const all = buildProfileZones(p, prev, prev.concat(subset), price, o.zoneThresholdPct, o.mergeGapRows).filter((z) => z.score >= o.minZoneScore)
        this.prevZones = o.zoneFocus === 'nearest' ? nearestZones(all, price, 1) : all
      }
    }
  }

  private drawZones(conv: Converters, rect: Rect): void {
    if (!this.zones.length && !this.prevZones.length && !this.lvns.length) return
    const ctx = this.ctx
    const right = rect.x + rect.width
    const profileW = rect.width * this.opts.widthPct
    // Labels sit on the far side of the profile so they don't cover its bars.
    const labelRight = this.opts.placement === 'right'
    const labelX = labelRight ? right - profileW - 6 : rect.x + profileW + 6
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textAlign = labelRight ? 'right' : 'left'
    ctx.textBaseline = 'middle'

    for (const l of this.lvns) {
      const yTop = conv.priceToY(l.hi)
      const yBot = conv.priceToY(l.lo)
      ctx.fillStyle = ZONE_COLORS.lvn
      ctx.fillRect(rect.x, yTop, rect.width, yBot - yTop)
      if (this.opts.showZoneLabels && yBot - yTop >= 10) {
        ctx.fillStyle = 'rgba(160,160,170,0.8)'
        ctx.fillText('LVN (thin volume)', labelX, (yTop + yBot) / 2)
      }
    }

    const band = (z: ProfileZone, prev: boolean): void => {
      const c = ZONE_COLORS[z.kind]
      const yTop = conv.priceToY(z.hi)
      const yBot = conv.priceToY(z.lo)
      if (yBot < rect.y || yTop > rect.y + rect.height) return
      // Fill opacity follows the score, so significant zones stand out and minor ones recede.
      ctx.globalAlpha = (prev ? 0.55 : 1) * (0.45 + 0.55 * Math.min(1, z.score / 80))
      ctx.fillStyle = c.fill
      ctx.fillRect(rect.x, yTop, rect.width, yBot - yTop)
      ctx.globalAlpha = prev ? 0.55 : 1
      ctx.strokeStyle = c.edge
      ctx.lineWidth = z.strength === 'Strong' ? 1.6 : 1
      ctx.setLineDash(prev ? [6, 4] : z.strength === 'Weak' ? [2, 3] : [])
      ctx.beginPath()
      ctx.moveTo(rect.x, Math.round(yTop) + 0.5)
      ctx.lineTo(right, Math.round(yTop) + 0.5)
      ctx.moveTo(rect.x, Math.round(yBot) - 0.5)
      ctx.lineTo(right, Math.round(yBot) - 0.5)
      ctx.stroke()
      ctx.setLineDash([])
      if (this.opts.showZoneLabels && yBot - yTop >= 11) {
        const text = `${prev ? 'PREV ' : ''}${zoneHeadline(z.kind, z.lo, z.hi, this.zonePrice, z.buyPct)} · ${z.strength} ${z.score}`
        ctx.fillStyle = c.edge
        // Today's labels hug the top edge, previous-session labels the bottom,
        // so overlapping zones from the two sessions don't print on each other.
        const tall = yBot - yTop >= 20
        ctx.fillText(text, labelX, !tall ? (yTop + yBot) / 2 : prev ? yBot - 9 : yTop + 9)
      }
      ctx.globalAlpha = 1
    }
    for (const z of this.prevZones) band(z, true)
    for (const z of this.zones) band(z, false)
  }

  private computeProfile(subset: Candle[]): ProfileResult | null {
    const binned = binCandles(subset, this.opts.bins)
    if (!binned) return null
    const va = valueArea(binned.binVolume, this.opts.valueAreaPct)
    return { ...binned, ...va }
  }

  private computeTPO(subset: Candle[]): TPOResult | null {
    const binned = binCandles(subset, this.opts.bins)
    if (!binned) return null
    const { lo, hi, binVolume } = binned
    const va = valueArea(binVolume, this.opts.valueAreaPct)
    const range = hi - lo
    const bins = this.opts.bins

    const bracketSize = Math.max(1, Math.ceil(subset.length / LETTERS.length))
    const rows: { letter: string; bullish: boolean }[][] = Array.from({ length: bins }, () => [])
    let maxLetters = 0

    for (let start = 0; start < subset.length; start += bracketSize) {
      const bracket = subset.slice(start, start + bracketSize)
      const letter = LETTERS[Math.min(LETTERS.length - 1, Math.floor(start / bracketSize))]
      // Which bins this bracket touched, and was it net buy or sell within each.
      const touched = new Map<number, { buy: number; sell: number }>()
      for (const c of bracket) {
        const b0 = Math.max(0, Math.min(bins - 1, Math.floor(((c.low - lo) / range) * bins)))
        const b1 = Math.max(0, Math.min(bins - 1, Math.floor(((c.high - lo) / range) * bins)))
        const buy = c.volume * buyShare(c)
        const sell = c.volume - buy
        for (let b = b0; b <= b1; b++) {
          const e = touched.get(b) ?? { buy: 0, sell: 0 }
          e.buy += buy / (b1 - b0 + 1)
          e.sell += sell / (b1 - b0 + 1)
          touched.set(b, e)
        }
      }
      for (const [b, e] of touched) {
        rows[b].push({ letter, bullish: e.buy >= e.sell })
        if (rows[b].length > maxLetters) maxLetters = rows[b].length
      }
    }

    return { lo, hi, binVolume, rows, maxLetters, ...va }
  }

  private anchorX(rect: Rect): { edge: number; dir: 1 | -1 } {
    return this.opts.placement === 'left' ? { edge: rect.x, dir: 1 } : { edge: rect.x + rect.width, dir: -1 }
  }

  private drawProfile(conv: Converters, rect: Rect, r: ProfileResult): void {
    const ctx = this.ctx
    const { lo, hi, binVolume, binBuyVolume } = r
    const range = hi - lo
    const bins = binVolume.length
    const maxVol = Math.max(...binVolume)
    if (maxVol <= 0) return
    const maxW = rect.width * this.opts.widthPct
    const { edge, dir } = this.anchorX(rect)

    for (let b = 0; b < bins; b++) {
      const yTop = conv.priceToY(lo + ((b + 1) / bins) * range)
      const yBot = conv.priceToY(lo + (b / bins) * range)
      const h = Math.max(1, yBot - yTop - 1)
      const w = (binVolume[b] / maxVol) * maxW
      const buyShare = binVolume[b] > 0 ? binBuyVolume[b] / binVolume[b] : 0.5
      const buyW = w * buyShare
      const x0 = dir === 1 ? edge : edge - w
      ctx.globalAlpha = this.opts.alpha
      ctx.fillStyle = this.opts.sellColor
      ctx.fillRect(x0, yTop, w - buyW, h)
      ctx.fillStyle = this.opts.buyColor
      ctx.fillRect(x0 + (w - buyW), yTop, buyW, h)
      ctx.globalAlpha = 1
    }
    this.drawValueAreaLines(conv, rect, r, lo, hi, bins)
  }

  /** Net delta (buy − sell) per row — bar width by |delta|, signed value printed on the bar. */
  private drawDeltaProfile(conv: Converters, rect: Rect, r: ProfileResult): void {
    const ctx = this.ctx
    const { lo, hi, binVolume, binBuyVolume } = r
    const range = hi - lo
    const bins = binVolume.length
    const deltas = new Float64Array(bins)
    let maxAbs = 0
    let total = 0
    for (let b = 0; b < bins; b++) {
      deltas[b] = 2 * binBuyVolume[b] - binVolume[b] // buy - sell, since binVolume = buy + sell
      total += deltas[b]
      if (Math.abs(deltas[b]) > maxAbs) maxAbs = Math.abs(deltas[b])
    }
    if (maxAbs <= 0) return
    const maxW = rect.width * this.opts.widthPct
    const { edge, dir } = this.anchorX(rect)
    const now = performance.now()
    // Thin rows can't all carry a label: label every `stride`-th row, plus the
    // strongest row and any row whose delta changed in the last 5s.
    const rowPx = Math.abs(conv.priceToY(lo) - conv.priceToY(lo + range / bins))
    const stride = Math.max(1, Math.ceil(11 / Math.max(1, rowPx)))
    let strongest = 0
    const labels: { b: number; delta: number; cy: number; h: number; x0: number; w: number; prio: number; arrow: string }[] = []
    for (let b = 1; b < bins; b++) if (Math.abs(deltas[b]) > Math.abs(deltas[strongest])) strongest = b
    const fmtD = (v: number): string => {
      const a = Math.abs(v)
      const t = a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'K' : a >= 100 ? Math.round(a).toString() : a.toFixed(1)
      return (v > 0 ? '+' : v < 0 ? '−' : '') + t
    }

    for (let b = 0; b < bins; b++) {
      const yTop = conv.priceToY(lo + ((b + 1) / bins) * range)
      const yBot = conv.priceToY(lo + (b / bins) * range)
      const h = Math.max(1, yBot - yTop - 1)
      const delta = deltas[b]
      const w = Math.max(1, (Math.abs(delta) / maxAbs) * maxW)
      const x0 = dir === 1 ? edge : edge - w
      const cy = (yTop + yBot) / 2

      // Live change tracking, keyed by the row's price so a growing session
      // range (which re-bins) doesn't read as a change on every row.
      const key = Math.round((lo + (b + 0.5) * (range / bins)) / (range / bins))
      const prev = this.deltaSeen.get(key)
      if (prev !== undefined && Math.abs(delta - prev.v) > maxAbs * 1e-3) this.deltaSeen.set(key, { v: delta, at: now, up: delta > prev.v })
      else if (prev === undefined) this.deltaSeen.set(key, { v: delta, at: -Infinity, up: true })
      const seen = this.deltaSeen.get(key)!
      const age = now - seen.at

      ctx.globalAlpha = this.opts.alpha
      ctx.fillStyle = delta >= 0 ? this.opts.buyColor : this.opts.sellColor
      ctx.fillRect(x0, yTop, w, h)
      ctx.globalAlpha = 1
      if (age < 1500) {
        // Flash the row that just changed: white outline fading over 1.5s.
        ctx.strokeStyle = `rgba(255,255,255,${(1 - age / 1500).toFixed(2)})`
        ctx.lineWidth = 1.5
        ctx.strokeRect(x0 + 0.5, yTop + 0.5, Math.max(1, w - 1), Math.max(1, h - 1))
      }

      const recent = age < 5000
      if (this.opts.showValue && (b % stride === 0 || b === strongest || recent)) {
        labels.push({ b, delta, cy, h, x0, w, prio: recent ? 2 : b === strongest ? 1 : 0, arrow: recent ? (seen.up ? ' ▲' : ' ▼') : '' })
      }
    }
    // Draw labels by priority (just-changed, strongest, then evenly spaced),
    // skipping any that would overlap one already drawn.
    labels.sort((a, c) => c.prio - a.prio)
    const taken: number[] = []
    for (const L of labels) {
      const fontSize = Math.max(9, Math.min(12, L.h * 0.75))
      if (taken.some((y) => Math.abs(y - L.cy) < fontSize + 1)) continue
      taken.push(L.cy)
      const label = fmtD(L.delta) + L.arrow
      ctx.font = `800 ${fontSize}px ui-monospace, monospace`
      ctx.textBaseline = 'middle'
      const tw = ctx.measureText(label).width
      // Inside the bar when it fits, otherwise just past its far end.
      const inside = tw + 6 <= L.w && L.h >= fontSize
      const tx = inside ? L.x0 + L.w / 2 : dir === 1 ? L.x0 + L.w + 4 + tw / 2 : L.x0 - 4 - tw / 2
      ctx.textAlign = 'center'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(2, fontSize * 0.3)
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'
      ctx.strokeText(label, tx, L.cy)
      ctx.fillStyle = inside ? '#ffffff' : L.delta >= 0 ? this.opts.buyColor : this.opts.sellColor
      ctx.fillText(label, tx, L.cy)
    }
    // Session (profile) total delta goes to the pane legend (getSummary), not the plot.
    this.totalDelta = total
    this.drawValueAreaLines(conv, rect, r, lo, hi, bins)
  }

  private drawTPO(conv: Converters, rect: Rect, r: TPOResult): void {
    const ctx = this.ctx
    const { lo, hi, rows, maxLetters } = r
    if (maxLetters === 0) return
    const range = hi - lo
    const bins = rows.length
    const maxW = rect.width * this.opts.widthPct
    const letterW = Math.max(4, Math.min(11, maxW / maxLetters))
    const { edge, dir } = this.anchorX(rect)

    for (let b = 0; b < bins; b++) {
      const yTop = conv.priceToY(lo + ((b + 1) / bins) * range)
      const yBot = conv.priceToY(lo + (b / bins) * range)
      const cy = (yTop + yBot) / 2
      const fontSize = Math.max(6, Math.min(11, (yBot - yTop) * 0.85))
      ctx.font = `700 ${fontSize}px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let i = 0; i < rows[b].length; i++) {
        const touch = rows[b][i]
        const cx = dir === 1 ? edge + i * letterW + letterW / 2 : edge - i * letterW - letterW / 2
        ctx.globalAlpha = this.opts.alpha
        ctx.fillStyle = touch.bullish ? this.opts.buyColor : this.opts.sellColor
        ctx.fillText(touch.letter, cx, cy)
      }
      ctx.globalAlpha = 1
    }
    this.drawValueAreaLines(conv, rect, r, lo, hi, bins)
  }

  private drawValueAreaLines(conv: Converters, rect: Rect, r: { pocBin: number; vahBin: number; valBin: number }, lo: number, hi: number, bins: number): void {
    const ctx = this.ctx
    const range = hi - lo
    const priceOf = (bin: number): number => lo + ((bin + 0.5) / bins) * range
    const tags: PriceTag[] = []
    // Level names live on the price scale as tags — the plot keeps just the lines.
    const line = (bin: number, color: string, label: string): void => {
      const y = conv.priceToY(priceOf(bin))
      tags.push({ price: priceOf(bin), color, label })
      ctx.strokeStyle = color
      ctx.lineWidth = 1.2
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(rect.x, y)
      ctx.lineTo(rect.x + rect.width, y)
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (this.opts.showVpoc) line(r.pocBin, this.opts.vpocColor, 'VPOC')
    if (this.opts.showVah) line(r.vahBin, this.opts.vahColor, 'VAH')
    if (this.opts.showVal) line(r.valBin, this.opts.valColor, 'VAL')
    this.engine.setPriceTags(TAG_SOURCE, tags)
    this.summary = { vah: priceOf(r.vahBin), poc: priceOf(r.pocBin), val: priceOf(r.valBin), totalDelta: this.totalDelta }
  }
}
