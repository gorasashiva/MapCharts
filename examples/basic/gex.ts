// GEX (Gamma Exposure) for BTC/ETH/Gold — derived from Delta Exchange India's
// public options chain (see options.ts): open interest × exchange-published
// gamma per strike, netted call-positive / put-negative, exposed as Call Wall /
// Put Wall / Net GEX Crossover levels (+ an optional per-strike bar profile) plotted
// directly on the underlying's own price chart.
//
// IMPORTANT CAVEAT: GEX is a MODEL, not a measured fact. It assumes dealers
// are net long gamma from calls and net short gamma from puts (the
// convention most retail GEX tools use) — actual dealer positioning isn't
// published anywhere, by any exchange. Treat this as an estimate of likely
// hedging pressure, not a guaranteed level.
//
// The gamma and open interest going INTO that model are real, though: Delta
// publishes both per contract, so nothing here is re-derived from a pricing
// model of our own.
//
// The "net GEX crossover" here is the simplified, widely-used approximation: sort
// strikes and find where the CUMULATIVE per-strike GEX (using each option's
// CURRENTLY reported gamma) turns positive after its minimum (mapModel.gexFlip). A fully rigorous flip would
// re-price every option's gamma at a range of hypothetical spot prices
// (gamma itself is a function of spot) — that needs a volatility-smile
// model this app doesn't have. This approximation is what most publicly
// available GEX charts actually show.
import type { IChartEngine, Converters, PriceTag } from '../../src/index'
import { fetchOptionChain, SUPPORTED_OPTION_UNDERLYINGS, type OptionUnderlying } from './options'
import { loadGexSnapshots, recordGexSnapshot, snapshotAt, type GexSnapshot } from './gexSnapshots'
import { gexFlip } from '../../src/overlays/mapModel'
import { lazyCanvas } from '../../src/overlays/lazyCanvas'

/** 429 = rate-limited (same convention as options.ts). */
const isRateLimited = (err: unknown): boolean => /HTTP 429/.test(String(err))

/** GEX is charted on the underlying's perpetual — the symbol the chart shows. */
export type GexUnderlying = OptionUnderlying

export const isGexUnderlying = (s: string): s is GexUnderlying =>
  (SUPPORTED_OPTION_UNDERLYINGS as readonly string[]).includes(s)

export interface GexLevel {
  strike: number
  gex: number // signed dollar gamma exposure at this strike (calls +, puts -)
  /** Gross signed components are retained so a Call/Put Wall is not confused
   *  with the largest *net* exposure at a strike. */
  callGex: number
  putGex: number
  /** Options traded at this strike (24h, calls + puts, base units). Absent in older saved snapshots. */
  volume?: number
}
export interface GexResult {
  spot: number
  levels: GexLevel[] // ascending by strike
  callWall: number | null
  putWall: number | null
  /** HVL: the strike with the most options volume — highlighted yellow in the profile. */
  hvlStrike?: number | null
  /** Static net-GEX crossover at the reported spot. This is deliberately not
   *  called a "gamma flip": a true flip requires repricing every option over
   *  a grid of hypothetical spot prices. */
  flipStrike: number | null
  /** ATM implied vol (avg of the nearest expiry's closest call+put), for IV
   *  Rank — see ivRank.ts. null if the chain had no readable IV at the ATM strike. */
  atmIV: number | null
  totals: {
    callOI: number
    putOI: number
    callGex: number
    putGex: number
    netGex: number
  }
  quality: {
    contractCount: number
    quotedShare: number
    nearestDteDays: number | null
  }
}

interface RawGexEntry {
  strike: number
  expiry: number
  gex: number
  side: 'CALL' | 'PUT'
  openInterest: number
  volume: number
  quoted: boolean
}

/** Shared fetch + per-(strike,expiry) GEX math — computeGex() (below) collapses
 *  this across expiries into one number per strike; computeGexGrid() keeps
 *  the full breakdown for the GEX dashboard's heatmap.
 *
 *  On Delta the whole chain — gamma, open interest and IV for every contract —
 *  arrives in ONE request (see fetchOptionChain), so `nearExpiries` is purely
 *  an analytical choice about how far out to look, not a request-count budget:
 *  near-term options dominate gamma exposure, and including every far-dated
 *  strike mostly adds noise. */
async function fetchRawGex(
  underlying: GexUnderlying,
  spot: number,
  nearExpiries: number,
): Promise<{ entries: RawGexEntry[]; atmIV: number | null; nearestDteDays: number | null } | null> {
  // Settled contracts can linger in the ticker feed briefly — drop them (expiry is the exact settlement time).
  const now = Date.now()
  const chain = (await fetchOptionChain(underlying)).filter((s) => s.expiry > now)
  if (chain.length === 0) return null

  const expiries = [...new Set(chain.map((s) => s.expiry))].sort((a, b) => a - b).slice(0, Math.max(1, nearExpiries))
  const expirySet = new Set(expiries)
  const relevant = chain.filter((s) => expirySet.has(s.expiry))

  // Dollar gamma per 1% move: gamma (per unit of underlying, published by the
  // exchange) x open interest (base units) x spot^2 x 1%. Calls count positive
  // and puts negative — the dealer-positioning convention noted at the top.
  const entries: RawGexEntry[] = []
  for (const s of relevant) {
    if (!s.gamma || !s.openInterest) continue
    const gex = s.gamma * s.openInterest * spot * spot * 0.01 * (s.side === 'CALL' ? 1 : -1)
    const mid = s.bid > 0 && s.ask >= s.bid ? (s.bid + s.ask) / 2 : 0
    const spreadOk = mid > 0 && (s.ask - s.bid) / mid <= 0.25
    // Quoted = a live two-sided market within 25% — every row has a mark price, so that proves nothing.
    entries.push({ strike: s.strike, expiry: s.expiry, gex, side: s.side, openInterest: s.openInterest, volume: s.volume || 0, quoted: spreadOk })
  }

  // ATM IV: the nearest expiry's strike closest to spot, averaging call+put IV.
  let atmIV: number | null = null
  const nearSyms = relevant.filter((s) => s.expiry === expiries[0])
  if (nearSyms.length) {
    let atmStrike = nearSyms[0].strike
    let bestDiff = Math.abs(atmStrike - spot)
    for (const s of nearSyms) {
      const diff = Math.abs(s.strike - spot)
      if (diff < bestDiff) {
        bestDiff = diff
        atmStrike = s.strike
      }
    }
    const ivVals = nearSyms.filter((s) => s.strike === atmStrike && s.markIV > 0).map((s) => s.markIV)
    if (ivVals.length) atmIV = ivVals.reduce((a, b) => a + b, 0) / ivVals.length
  }

  const nearestDteDays = expiries.length ? Math.max(0, (expiries[0] - now) / 86_400_000) : null
  return { entries, atmIV, nearestDteDays }
}

export async function computeGex(underlying: GexUnderlying, spot: number, nearExpiries: number): Promise<GexResult | null> {
  const raw = await fetchRawGex(underlying, spot, nearExpiries)
  if (!raw || raw.entries.length === 0) return null

  const byStrike = new Map<number, { callGex: number; putGex: number; volume: number }>()
  for (const r of raw.entries) {
    const row = byStrike.get(r.strike) ?? { callGex: 0, putGex: 0, volume: 0 }
    if (r.side === 'CALL') row.callGex += r.gex
    else row.putGex += r.gex
    row.volume += r.volume
    byStrike.set(r.strike, row)
  }

  const levels = [...byStrike.entries()]
    .map(([strike, row]) => ({ strike, callGex: row.callGex, putGex: row.putGex, gex: row.callGex + row.putGex, volume: row.volume }))
    .sort((a, b) => a.strike - b.strike)
  const top = levels.reduce<GexLevel | null>((b, l) => ((l.volume ?? 0) > (b?.volume ?? 0) ? l : b), null)
  const hvlStrike = top ? top.strike : null

  let callWall: number | null = null
  let maxCallGex = -Infinity
  let putWall: number | null = null
  let minPutGex = Infinity
  for (const l of levels) {
    if (l.callGex > maxCallGex) {
      maxCallGex = l.callGex
      callWall = l.strike
    }
    if (l.putGex < minPutGex) {
      minPutGex = l.putGex
      putWall = l.strike
    }
  }

  // Net GEX crossover: the same zero-gamma rule THE MAP uses (mapModel.gexFlip) — the
  // cumulative's negative->positive crossing after its global minimum; null when the
  // book never crosses (then the regime is the sign of total net GEX).
  const flip = gexFlip(levels.map((l) => ({ strike: l.strike, net: l.gex })))
  const flipStrike = Number.isFinite(flip) ? flip : null

  const quotedShare = raw.entries.filter((e) => e.quoted).length / raw.entries.length
  const totals = raw.entries.reduce(
    (acc, entry) => {
      if (entry.side === 'CALL') {
        acc.callOI += entry.openInterest
        acc.callGex += entry.gex
      } else {
        acc.putOI += entry.openInterest
        acc.putGex += entry.gex
      }
      return acc
    },
    { callOI: 0, putOI: 0, callGex: 0, putGex: 0, netGex: 0 },
  )
  totals.netGex = totals.callGex + totals.putGex
  return {
    spot,
    levels,
    callWall,
    putWall,
    hvlStrike,
    flipStrike,
    atmIV: raw.atmIV,
    totals,
    quality: { contractCount: raw.entries.length, quotedShare, nearestDteDays: raw.nearestDteDays },
  }
}

export interface GexGridResult {
  spot: number
  expiries: number[] // ascending
  strikes: number[] // ascending
  grid: Map<number, Map<number, number>> // strike -> expiry -> gex (missing = no OI at that combo)
  netByExpiry: Map<number, number>
}

/** Same data as computeGex(), but keeping the per-expiry breakdown — feeds the
 *  GEX dashboard's heatmap (strike x expiry) and its per-strike histogram. */
export async function computeGexGrid(underlying: GexUnderlying, spot: number, nearExpiries: number): Promise<GexGridResult | null> {
  const raw = await fetchRawGex(underlying, spot, nearExpiries)
  if (!raw || raw.entries.length === 0) return null

  const grid = new Map<number, Map<number, number>>()
  const netByExpiry = new Map<number, number>()
  const strikeSet = new Set<number>()
  const expirySet = new Set<number>()
  for (const r of raw.entries) {
    strikeSet.add(r.strike)
    expirySet.add(r.expiry)
    const row = grid.get(r.strike) ?? new Map<number, number>()
    row.set(r.expiry, (row.get(r.expiry) ?? 0) + r.gex)
    grid.set(r.strike, row)
    netByExpiry.set(r.expiry, (netByExpiry.get(r.expiry) ?? 0) + r.gex)
  }

  return {
    spot,
    expiries: [...expirySet].sort((a, b) => a - b),
    strikes: [...strikeSet].sort((a, b) => a - b),
    grid,
    netByExpiry,
  }
}

export interface GexOptions {
  enabled: boolean
  showCallWall: boolean
  showPutWall: boolean
  showFlip: boolean
  showProfile: boolean
  callWallColor: string
  putWallColor: string
  flipColor: string
  refreshMs: number // OI/gamma move slowly — no need to poll like a live price
  nearExpiries: number
}

const DEFAULTS: GexOptions = {
  enabled: false,
  showCallWall: true,
  showPutWall: true,
  showFlip: true,
  showProfile: true,
  callWallColor: '#ff2d3d',
  putWallColor: '#25f06b',
  flipColor: '#dff4ff',
  refreshMs: 90_000,
  nearExpiries: 6,
}

type Rect = { x: number; y: number; width: number; height: number }

/** The highest-volume strike's profile bar. */
const HVL_COLOR = '#FFD600'

/** Earlier default colours -> the glowing palette shared with GEX Sabers (custom colours are kept). */
const OLD_DEFAULT_COLORS: Record<string, string> = { '#f6465d': '#ff2d3d', '#0ecb81': '#25f06b', '#ffc107': '#dff4ff' }
function withNewDefaults(o: Partial<GexOptions> | undefined): Partial<GexOptions> {
  if (!o) return {}
  const out = { ...o }
  for (const k of ['callWallColor', 'putWallColor', 'flipColor'] as const) {
    const c = out[k]
    if (c && OLD_DEFAULT_COLORS[c.toLowerCase()]) out[k] = OLD_DEFAULT_COLORS[c.toLowerCase()]
  }
  return out
}

/** A glowing horizontal line: coloured glow plus a white-hot core (GEX Sabers' look). */
function glowLine(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number, color: string, width: number, strength: number): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.shadowColor = color
  ctx.shadowBlur = 6 + 10 * strength
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.5 + 0.45 * strength
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(x1, y)
  ctx.lineTo(x2, y)
  ctx.stroke()
  ctx.shadowBlur = 3
  ctx.globalAlpha = 0.9
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
  ctx.lineWidth = Math.max(0.8, width * 0.3)
  ctx.beginPath()
  ctx.moveTo(x1, y)
  ctx.lineTo(x2, y)
  ctx.stroke()
  ctx.restore()
}

export default class GexOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private opts: GexOptions
  private symbol: GexUnderlying | null = null
  private spot = 0
  private result: GexResult | null = null
  private raf = 0
  private running = false
  private pollTimer: number | null = null
  private fetching = false
  private ro: ResizeObserver | null = null
  private statusListener: ((status: string) => void) | null = null
  private resultListener: ((result: GexResult | null) => void) | null = null
  /** Bar replay: the replayed time, the recorded snapshots for this symbol, and the one live then. */
  private replayAt: number | null = null
  private replaySnaps: GexSnapshot[] | null = null
  private replaySnap: GexSnapshot | null = null

  constructor(container: HTMLElement, engine: IChartEngine, opts?: Partial<GexOptions>) {
    this.container = container
    this.engine = engine
    this.opts = { ...DEFAULTS, ...withNewDefaults(opts) }
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '16'
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

  setOptions(opts: Partial<GexOptions>): void {
    const refreshChanged = opts.refreshMs !== undefined && opts.refreshMs !== this.opts.refreshMs
    const expiriesChanged = opts.nearExpiries !== undefined && opts.nearExpiries !== this.opts.nearExpiries
    this.opts = { ...this.opts, ...withNewDefaults(opts) }
    if (refreshChanged && this.pollTimer !== null) this.restartPolling()
    if (expiriesChanged) void this.fetchNow()
  }

  getOptions(): GexOptions {
    return { ...this.opts }
  }

  /** GEX applies to an options underlying's perpetual (BTCUSD/ETHUSD/XAUTUSD) — anything else is a no-op. */
  setSymbol(symbol: string): void {
    const next = isGexUnderlying(symbol) ? symbol : null
    if (next === this.symbol) return
    this.symbol = next
    this.result = null
    this.replaySnaps = null
    this.replaySnap = null
    // The old symbol's price must not scale the new chain: wait for setSpot() from the new candles.
    this.spot = 0
  }

  /** Feed the latest close as the spot reference for the GEX $-scaling. */
  setSpot(price: number): void {
    const first = this.spot <= 0
    this.spot = price
    // First price after a symbol switch / startup: fetch now rather than at the next poll.
    if (first && price > 0 && !this.result && this.opts.enabled) void this.fetchNow()
  }

  setEnabled(on: boolean): void {
    this.opts.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
    if (on) {
      void this.fetchNow()
      this.startPolling()
    } else {
      this.stopPolling()
    }
  }

  /**
   * Bar replay: draw the snapshot recorded at time `t` instead of the live
   * chain (nothing when none was recorded then); null returns to live.
   */
  setReplayTime(t: number | null): void {
    this.replayAt = t
    if (t === null) {
      this.replaySnap = null
      return
    }
    const symbol = this.symbol
    if (!symbol) return
    if (this.replaySnaps) {
      this.replaySnap = snapshotAt(this.replaySnaps, t)
      return
    }
    void loadGexSnapshots(symbol).then((snaps) => {
      if (symbol !== this.symbol) return
      this.replaySnaps = snaps
      if (this.replayAt !== null) this.replaySnap = snapshotAt(snaps, this.replayAt)
    })
  }

  /** In replay: the recorded snapshot's time, 'none' when nothing was recorded then, null when live. */
  getReplayState(): { time: number } | 'none' | null {
    if (this.replayAt === null) return null
    return this.replaySnap ? { time: this.replaySnap.time } : 'none'
  }

  /** Optional: surface fetch status (loading/live/rate-limited) to the host UI. */
  onStatus(cb: (status: string) => void): void {
    this.statusListener = cb
  }

  /** Optional: fires with every fetched result (see fetchNow) — lets another
   *  consumer of the same chain (e.g. GexV2Overlay) reuse this fetch instead
   *  of polling Delta separately. */
  onResult(cb: (result: GexResult | null) => void): void {
    this.resultListener = cb
  }

  /** What the chart is showing: the replayed snapshot in replay, else the live result. */
  getDisplayedResult(): GexResult | null {
    return this.replayAt !== null ? (this.replaySnap?.result ?? null) : this.result
  }

  getResult(): GexResult | null {
    return this.result
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
    this.result = null
    this.stopPolling()
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  destroy(): void {
    this.stop()
    this.stopPolling()
    this.ro?.disconnect()
    this.canvas.remove()
    this.engine.setPriceTags('gex', [])
  }

  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = window.setInterval(() => void this.fetchNow(), this.opts.refreshMs)
  }
  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
  private restartPolling(): void {
    if (this.opts.enabled) this.startPolling()
  }

  private async fetchNow(): Promise<void> {
    if (!this.opts.enabled || !this.symbol || this.spot <= 0 || this.fetching) return
    this.fetching = true
    this.statusListener?.('loading')
    try {
      const result = await computeGex(this.symbol, this.spot, this.opts.nearExpiries)
      this.result = result
      if (result && this.symbol) void recordGexSnapshot(this.symbol, result)
      this.statusListener?.(result ? 'live' : 'no chain data')
      this.resultListener?.(result)
    } catch (err) {
      this.statusListener?.(isRateLimited(err) ? 'rate-limited — backing off' : 'unavailable')
      console.warn('[gex]', err)
    } finally {
      this.fetching = false
    }
  }

  private draw(): void {
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)
    const shown = this.replayAt !== null ? (this.replaySnap?.result ?? null) : this.result
    if (!this.opts.enabled || !shown) return this.engine.setPriceTags('gex', [])

    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect) return
    const tags: PriceTag[] = []

    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.clip()

    if (this.opts.showProfile) this.drawProfile(conv, rect, shown)
    if (this.opts.showCallWall && shown.callWall !== null) this.levelLine(conv, rect, shown.callWall, this.opts.callWallColor, 'Call wall', tags)
    if (this.opts.showPutWall && shown.putWall !== null) this.levelLine(conv, rect, shown.putWall, this.opts.putWallColor, 'Put wall', tags)
    if (this.opts.showFlip && shown.flipStrike !== null) this.levelLine(conv, rect, shown.flipStrike, this.opts.flipColor, 'GEX cross', tags)

    this.ctx.restore()
    this.engine.setPriceTags('gex', tags)
  }

  /** Dashed level across the plot; its name and price go on the price scale as a tag. */
  private levelLine(conv: Converters, rect: Rect, price: number, color: string, label: string, tags: PriceTag[]): void {
    tags.push({ price, color, label })
    const y = conv.priceToY(price)
    if (y < rect.y || y > rect.y + rect.height) return
    const ctx = this.ctx
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 6
    ctx.strokeStyle = color
    ctx.lineWidth = 1.4
    ctx.setLineDash([6, 4])
    ctx.beginPath()
    ctx.moveTo(rect.x, y)
    ctx.lineTo(rect.x + rect.width, y)
    ctx.stroke()
    ctx.restore()
  }

  /** Sideways GEX profile from the left edge: one glowing line per strike, length = |net GEX| (GEX Sabers' look). */
  private drawProfile(conv: Converters, rect: Rect, r: GexResult): void {
    const ctx = this.ctx
    const maxAbs = Math.max(...r.levels.map((l) => Math.abs(l.gex)), 1e-9)
    const maxW = rect.width * 0.16
    const x0 = rect.x
    const barH = Math.max(2, rect.height / Math.max(20, r.levels.length))

    for (const l of r.levels) {
      const y = conv.priceToY(l.strike)
      if (y < rect.y - barH || y > rect.y + rect.height + barH) continue
      const hvl = l.strike === r.hvlStrike
      const s = Math.abs(l.gex) / maxAbs
      const w = Math.max(s * maxW, hvl ? 6 : 0)
      if (w < 0.5) continue
      const color = hvl ? HVL_COLOR : l.gex >= 0 ? this.opts.callWallColor : this.opts.putWallColor
      glowLine(ctx, x0, x0 + w, Math.round(y) + 0.5, color, Math.min(Math.max(1.5, barH - 2), 2 + 4 * s), hvl ? 1 : s)
      if (hvl) {
        ctx.fillStyle = HVL_COLOR
        ctx.font = "600 9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText('HVL', x0 + w + 6, y)
      }
    }
  }
}
