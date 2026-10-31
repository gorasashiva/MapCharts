/**
 * IV Walls — projects each trading session's likely HOD/LOD as zones from
 * the session open, combining option pricing with realized history. All the
 * math is in ivWallsModel.ts; this file fetches, keeps today's session live,
 * and draws.
 *
 *  - σ walls (dashed): ±kσ from the open, where σ is today's option-implied
 *    daily move read off the smile on each side. Symbols without an options
 *    chain fall back to realized (HV) σ.
 *  - HOD / LOD zones (filled): where past sessions' highs/lows landed, in
 *    units of the realized σ known before each session, scaled to today.
 *  - Past sessions are redrawn with HV walls only (Delta publishes no
 *    historical IV), so the zones can be checked against what actually printed.
 *
 * Data-agnostic: the host supplies hourly bars and (optionally) an options
 * chain for whatever symbol the chart shows.
 */
import type { IChartEngine, PriceTag } from '../chart/types'
import { sessionOpenHourUTC } from '../core/session'
import {
  buildSessions,
  calibrate,
  closeToCloseSigma,
  continuationOdds,
  extensionSamples,
  impliedFromChain,
  ivToDaily,
  parkinsonSigma,
  wallsFor,
  type ChainPoint,
  type DayWalls,
  type ImpliedVol,
  type OHLCBar,
  type SessionDay,
  type ZoneStats,
} from './ivWallsModel'
import { lazyCanvas } from './lazyCanvas'

const HOUR_MS = 3_600_000

export interface IVWallsOptions {
  enabled: boolean
  sessionStartHourUTC: number | null // null = the symbol's own session open (core/session.ts)
  hvLookback: number // sessions of realized range feeding σ_HV
  calibrationDays: number // sessions of history behind the HOD/LOD zones
  zoneLo: number // quantile of past extensions where a zone begins (0.5 = median session's HOD/LOD)
  zoneHi: number // quantile where it ends
  pastDays: number // completed sessions to redraw for comparison
  showSigmaLines: boolean
  showZones: boolean
  showPanel: boolean
  hodColor: string
  lodColor: string
  lineColor: string
  refreshMs: number
}

export interface IVWallsSources {
  /** Ascending 1h bars for the chart's current symbol. */
  fetchHourly(limit: number): Promise<OHLCBar[]>
  /** The options chain for the chart's current symbol, or null if it has none. */
  fetchChain(): Promise<ChainPoint[] | null>
}

const DEFAULTS: IVWallsOptions = {
  enabled: false,
  sessionStartHourUTC: null,
  hvLookback: 20,
  calibrationDays: 180,
  zoneLo: 0.5,
  zoneHi: 0.8,
  pastDays: 5,
  showSigmaLines: true,
  showZones: true,
  showPanel: true,
  hodColor: '#f6465d',
  lodColor: '#0ecb81',
  lineColor: '#b388ff',
  refreshMs: 120_000,
}

const MULTIPLES = [0.5, 1, 1.5, 2]
const TAG_SOURCE = 'ivWalls'
const FONT = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

const pct = (v: number, d = 2): string => `${(v * 100).toFixed(d)}%`

export default class IVWallsOverlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly sources: IVWallsSources
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly ro: ResizeObserver
  private opts: IVWallsOptions
  private symbol = ''
  private bars: OHLCBar[] = []
  private implied: ImpliedVol | null = null
  private sessions: SessionDay[] = []
  /** Bar replay: the replayed time (null = live) and a stand-in bar for its unfinished hour. */
  private replayAt: number | null = null
  private replayHour: OHLCBar | null = null
  private stats: ZoneStats | null = null
  private walls: DayWalls[] = []
  private hvNow: number | null = null
  private c2cNow: number | null = null
  private status = 'idle'
  private gen = 0
  private inflightKey = '' // symbol:limit of the history load in flight
  private raf = 0
  private pollTimer: number | null = null
  private readonly panelEl: HTMLButtonElement
  private panelTextAt = 0
  private expanded = false

  constructor(container: HTMLElement, engine: IChartEngine, sources: IVWallsSources, opts?: Partial<IVWallsOptions>) {
    this.container = container
    this.engine = engine
    this.sources = sources
    this.opts = { ...DEFAULTS, ...opts }
    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '15' })
    container.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()
    this.panelEl = document.createElement('button')
    this.panelEl.type = 'button'
    this.panelEl.style.cssText =
      'position:absolute;z-index:16;display:none;text-align:left;cursor:pointer;padding:5px 10px;border-radius:4px;' +
      'background:rgba(30,34,45,0.94);border:1px solid #2a2e39;color:#b2b5be;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    this.panelEl.addEventListener('click', () => {
      this.expanded = !this.expanded
      this.panelTextAt = 0
    })
    container.appendChild(this.panelEl)
  }

  /** UTC hour sessions open: the explicit setting, else the symbol's session (03:30 IST for gold). */
  hour(): number {
    return this.opts.sessionStartHourUTC ?? sessionOpenHourUTC(this.symbol)
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

  getOptions(): IVWallsOptions {
    return { ...this.opts }
  }

  setOptions(patch: Partial<IVWallsOptions>): void {
    const prev = this.opts
    this.opts = { ...this.opts, ...patch }
    this.panelTextAt = 0
    if (!this.opts.enabled) return this.publishTags()
    const needsMoreHistory = this.opts.calibrationDays + this.opts.hvLookback > prev.calibrationDays + prev.hvLookback
    if (needsMoreHistory && this.bars.length > 0) void this.reload()
    else this.recompute()
    if (patch.refreshMs !== undefined && patch.refreshMs !== prev.refreshMs) this.startPolling()
  }

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return
    this.symbol = symbol
    this.bars = []
    this.implied = null
    this.recompute()
    if (this.opts.enabled) void this.reload()
  }

  setEnabled(on: boolean): void {
    this.opts.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
    if (on) {
      void this.reload()
      this.startPolling()
      if (!this.raf) {
        const loop = (): void => {
          this.draw()
          this.raf = this.opts.enabled ? requestAnimationFrame(loop) : 0
        }
        this.raf = requestAnimationFrame(loop)
      }
    } else {
      this.stopPolling()
      this.panelEl.style.display = 'none'
      this.publishTags()
    }
  }

  /**
   * Bar replay: compute as of time `t` — history cut there, the unfinished hour
   * filled in from the chart's `candles`, and no option IV (Delta publishes no
   * historical chains, so replayed sessions use HV walls). null returns to live.
   */
  setReplay(t: number | null, candles: readonly OHLCBar[] = []): void {
    if (t === null) {
      if (this.replayAt === null) return
      this.replayAt = null
      this.replayHour = null
      this.recompute()
      return
    }
    const hourStart = Math.floor(t / HOUR_MS) * HOUR_MS
    let bar: OHLCBar | null = null
    for (let i = candles.length - 1; i >= 0 && candles[i].time >= hourStart; i--) {
      const c = candles[i]
      if (!bar) bar = { time: hourStart, open: c.open, high: c.high, low: c.low, close: c.close }
      else {
        bar.open = c.open
        bar.high = Math.max(bar.high, c.high)
        bar.low = Math.min(bar.low, c.low)
      }
    }
    this.replayAt = t
    this.replayHour = bar
    if (this.bars.length) this.recompute()
  }

  private now(): number {
    return this.replayAt ?? Date.now()
  }

  /** Live candle from the chart's own stream — keeps today's HOD/LOD current between refreshes. */
  onCandle(c: OHLCBar): void {
    let today = this.sessions[this.sessions.length - 1]
    if (!this.opts.enabled || !today || this.replayAt !== null) return
    if (c.time >= today.end) {
      // A new session just opened: start it from this candle now instead of
      // waiting up to refreshMs for the next hourly fetch (which replaces this
      // stand-in bar with the real one).
      this.bars = [...this.bars, { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }]
      this.recompute()
      return
    }
    if (this.now() >= today.end) return
    const inSession = c.time >= today.start // a bar opened before the session (e.g. a 1d/4h chart) only contributes its last price
    const hi = inSession ? c.high : c.close
    const lo = inSession ? c.low : c.close
    if (hi > today.high) {
      today.high = hi
      today.hodAt = Math.max(c.time, today.start)
    }
    if (lo < today.low) {
      today.low = lo
      today.lodAt = Math.max(c.time, today.start)
    }
    today.close = c.close
  }

  destroy(): void {
    this.opts.enabled = false
    this.gen++
    this.stopPolling()
    if (this.raf) cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.canvas.remove()
    this.panelEl.remove()
    this.engine.setPriceTags(TAG_SOURCE, [])
  }

  // ---- data ----

  private startPolling(): void {
    this.stopPolling()
    if (this.opts.enabled) this.pollTimer = window.setInterval(() => void this.refresh(), this.opts.refreshMs)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private async reload(): Promise<void> {
    const limit = (this.opts.calibrationDays + this.opts.hvLookback + 2) * 24
    // setSymbol() and setEnabled() both reload on start-up; don't fetch the same history twice.
    const key = `${this.symbol}:${limit}`
    if (key === this.inflightKey) return
    this.inflightKey = key
    const gen = ++this.gen
    this.status = 'loading history…'
    try {
      const bars = await this.sources.fetchHourly(limit)
      if (gen !== this.gen) return
      this.bars = bars
      await this.fetchImplied(gen)
      if (gen !== this.gen) return
      this.status = 'live'
      this.recompute()
    } catch (err) {
      if (gen !== this.gen) return
      this.status = 'history unavailable'
      console.warn('[ivWalls]', err)
    } finally {
      if (gen === this.gen) this.inflightKey = ''
    }
  }

  /** Cheap periodic top-up: the last two days of hourly bars plus a fresh chain read. */
  private async refresh(): Promise<void> {
    if (!this.opts.enabled || this.bars.length === 0) return
    const gen = this.gen
    try {
      const recent = await this.sources.fetchHourly(48)
      if (gen !== this.gen || recent.length === 0) return
      const from = recent[0].time
      this.bars = [...this.bars.filter((b) => b.time < from), ...recent]
      await this.fetchImplied(gen)
      if (gen !== this.gen) return
      this.status = 'live'
      this.recompute()
    } catch (err) {
      console.warn('[ivWalls] refresh', err)
    }
  }

  private async fetchImplied(gen: number): Promise<void> {
    const spot = this.bars[this.bars.length - 1]?.close ?? 0
    try {
      const chain = await this.sources.fetchChain()
      if (gen !== this.gen) return
      this.implied = chain ? impliedFromChain(chain, spot, Date.now()) : null
    } catch (err) {
      this.implied = null // walls fall back to HV; the panel says so
      console.warn('[ivWalls] chain', err)
    }
  }

  private recompute(): void {
    const o = this.opts
    const now = this.now()
    const t = this.replayAt
    const bars = t === null ? this.bars : this.bars.filter((b) => b.time + HOUR_MS <= t)
    if (t !== null && this.replayHour) bars.push(this.replayHour)
    this.sessions = buildSessions(bars, this.hour())
    // A session with many missing hours would understate its range — keep it out of the statistics.
    const complete = this.sessions.filter((s) => s.end <= now && s.bars >= 20).slice(-(o.calibrationDays + o.hvLookback))
    this.stats = calibrate(extensionSamples(complete, o.hvLookback), Math.min(o.zoneLo, o.zoneHi), Math.max(o.zoneLo, o.zoneHi), MULTIPLES)
    this.hvNow = parkinsonSigma(complete.slice(-o.hvLookback))
    this.c2cNow = closeToCloseSigma(complete.slice(-o.hvLookback - 1))

    const walls: DayWalls[] = []
    for (const s of this.sessions.slice(-(o.pastDays + 1))) {
      const before = complete.filter((c) => c.end <= s.start).slice(-o.hvLookback)
      const hv = parkinsonSigma(before)
      if (!hv || before.length < o.hvLookback / 2) continue
      walls.push(wallsFor(s, hv, this.stats, s.end > now && this.replayAt === null ? this.implied : null, MULTIPLES))
    }
    this.walls = walls
    this.publishTags()
  }

  // ---- drawing ----

  private draw(): void {
    const ctx = this.ctx
    const dpr = window.devicePixelRatio || 1
    ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr)
    if (!this.opts.enabled) return
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect) {
      this.panelEl.style.display = 'none'
      return
    }
    const right = rect.x + rect.width
    const now = this.now()

    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    ctx.font = FONT
    for (const w of this.walls) {
      const isToday = w.end > now
      const x0 = Math.max(rect.x, conv.timeToX(w.start))
      const xEnd = conv.timeToX(w.end)
      const x1 = Number.isFinite(xEnd) ? Math.min(right, xEnd) : right
      if (x1 <= rect.x || x0 >= right || x1 - x0 < 2) continue
      const hline = (price: number, color: string, dash: number[], lw = 1): void => {
        const y = Math.round(conv.priceToY(price)) + 0.5
        ctx.strokeStyle = color
        ctx.lineWidth = lw
        ctx.setLineDash(dash)
        ctx.beginPath()
        ctx.moveTo(x0, y)
        ctx.lineTo(x1, y)
        ctx.stroke()
        ctx.setLineDash([])
      }

      if (this.opts.showZones) {
        for (const [zone, color] of [
          [w.hodZone, this.opts.hodColor],
          [w.lodZone, this.opts.lodColor],
        ] as const) {
          if (!zone) continue
          const yA = conv.priceToY(zone[0])
          const yB = conv.priceToY(zone[1])
          ctx.globalAlpha = isToday ? 0.16 : 0.08
          ctx.fillStyle = color
          ctx.fillRect(x0, Math.min(yA, yB), x1 - x0, Math.max(1, Math.abs(yB - yA)))
          ctx.globalAlpha = isToday ? 0.9 : 0.45
          hline(zone[0], color, [])
          hline(zone[1], color, [])
          ctx.globalAlpha = 1
        }
      }

      ctx.globalAlpha = isToday ? 0.8 : 0.4
      hline(w.open, '#9aa0a6', [2, 3])
      if (this.opts.showSigmaLines) {
        for (const l of w.lines) {
          const lw = l.mult === 1 ? 1.4 : 1
          const dash = l.mult === 1 ? [6, 4] : [3, 4]
          hline(l.up, this.opts.lineColor, dash, lw)
          hline(l.down, this.opts.lineColor, dash, lw)
        }
      }
      ctx.globalAlpha = 1
    }
    ctx.restore()

    if (this.opts.showPanel) this.drawPanel(rect)
    else this.panelEl.style.display = 'none'
  }

  private panelLines(): { text: string; color?: string }[] {
    const o = this.opts
    const lines: { text: string; color?: string }[] = [
      { text: `IV WALLS · ${this.symbol} · session ${String(this.hour()).padStart(2, '0')}:00 UTC · ${this.replayAt === null ? this.status : 'replay (HV walls)'}` },
    ]
    const st = this.stats
    const hv = this.hvNow
    const imp = this.replayAt === null ? this.implied : null // today's chain doesn't describe a replayed session
    if (hv) {
      const c2c = this.c2cNow ? ` / close-close ${pct(this.c2cNow)}` : ''
      lines.push({ text: `HV σ/day ${pct(hv)} (range${c2c}, ${o.hvLookback}d)` })
    }
    if (imp) {
      const iv = ivToDaily(imp.atmIV)
      const straddle = imp.straddleSigmaDay ? ` · straddle ${pct(imp.straddleSigmaDay)}` : ''
      lines.push({ text: `IV σ/day ${pct(iv)} (ATM ${pct(imp.atmIV, 1)}/yr) · up ${pct(ivToDaily(imp.upIV))} · down ${pct(ivToDaily(imp.downIV))}${straddle}` })
      if (hv) {
        const r = iv / hv
        const verdict = r > 1.15 ? 'options price a wider day than recent history' : r < 0.85 ? 'options price a quieter day than recent history' : 'options agree with recent history'
        lines.push({ text: `IV/HV ${r.toFixed(2)}× — ${verdict}`, color: r > 1.15 ? '#ffb74d' : r < 0.85 ? '#64b5f6' : undefined })
      }
      lines.push({ text: `expiry used: ${new Date(imp.expiry).toISOString().slice(5, 16).replace('T', ' ')} UTC (${(imp.tDays * 24).toFixed(1)}h out)` })
    } else if (hv) {
      lines.push({ text: this.replayAt === null ? 'no options chain for this symbol — σ walls use HV' : 'replay: no historical option IV — σ walls use HV', color: '#9aa0a6' })
    }
    if (st) {
      const rate = (h: { reached: number; held: number }): string => (h.reached ? `${Math.round((h.held / h.reached) * 100)}% (${h.held}/${h.reached})` : '—')
      lines.push({ text: `HOD zone +${st.up.lo.toFixed(2)}…${st.up.hi.toFixed(2)}σ · reached → reversed in zone ${rate(st.holdUp)}`, color: o.hodColor })
      lines.push({ text: `LOD zone −${st.down.lo.toFixed(2)}…${st.down.hi.toFixed(2)}σ · reached → reversed in zone ${rate(st.holdDown)}`, color: o.lodColor })
      const t1 = st.touch.find((t) => t.mult === 1)
      if (t1) lines.push({ text: `±1σ(HV) touched: up ${Math.round(t1.up * 100)}% · down ${Math.round(t1.down * 100)}% of ${st.n} sessions` })
      const today = this.sessions[this.sessions.length - 1]
      const tw = this.walls[this.walls.length - 1]
      if (today && tw && today.end > this.now() && tw.start === today.start) {
        const upX = (today.high - today.open) / today.open / tw.sigmaHV
        const dnX = (today.open - today.low) / today.open / tw.sigmaHV
        const odds = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v * 100)}%`)
        lines.push({ text: `today high +${upX.toFixed(2)}σ → extends further ${odds(continuationOdds(st.ups, upX))} · low −${dnX.toFixed(2)}σ → extends ${odds(continuationOdds(st.downs, dnX))}` })
        const h = Math.min(24, Math.floor((this.now() - today.start) / 3_600_000))
        lines.push({ text: `by hour ${h} of session: ${Math.round(st.hodSetBy[h] * 100)}% of HODs / ${Math.round(st.lodSetBy[h] * 100)}% of LODs were already in` })
      }
    } else if (this.status === 'live') {
      lines.push({ text: 'not enough complete sessions to calibrate zones yet', color: '#9aa0a6' })
    }
    return lines
  }

  /**
   * Stats as a DOM chip at the pane's bottom-left: one line by default, the full
   * readout on click. Text refreshes at most once a second (the "by hour" line
   * moves with the clock); position follows the pane every frame.
   */
  private drawPanel(rect: { x: number; y: number; width: number; height: number }): void {
    const el = this.panelEl
    el.style.display = 'block'
    const now = this.now()
    if (now - this.panelTextAt >= 1000) {
      this.panelTextAt = now
      const st = this.stats
      const rate = (h: { reached: number; held: number }): string => (h.reached ? `${Math.round((h.held / h.reached) * 100)}%` : '—')
      const head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;gap:10px;white-space:nowrap'
      const name = document.createElement('span')
      name.textContent = 'IV Walls'
      name.style.cssText = 'color:#e0e3eb;font-weight:600'
      head.appendChild(name)
      if (!this.expanded && st) {
        for (const [label, color, h] of [
          ['HOD zone', this.opts.hodColor, st.holdUp],
          ['LOD zone', this.opts.lodColor, st.holdDown],
        ] as const) {
          const s = document.createElement('span')
          const tag = document.createElement('span')
          tag.textContent = label
          tag.style.color = color
          s.append(tag, ` reversed ${rate(h)}`)
          head.appendChild(s)
        }
      } else if (!st) {
        head.append(this.status)
      }
      const more = document.createElement('span')
      more.textContent = this.expanded ? 'Hide ▾' : 'Details ▸'
      more.style.color = '#8b8f9a'
      head.appendChild(more)
      el.replaceChildren(head)
      if (this.expanded) {
        for (const l of this.panelLines().slice(1)) {
          const row = document.createElement('div')
          row.textContent = l.text
          row.style.cssText = `color:${l.color ?? '#b2b5be'};white-space:nowrap;margin-top:3px`
          el.appendChild(row)
        }
      }
    }
    el.style.left = `${rect.x + 10}px`
    el.style.top = `${rect.y + rect.height - el.offsetHeight - 10}px`
  }

  /** Today's walls as price-scale tags (no text inside the chart). */
  private publishTags(): void {
    const tw = this.walls[this.walls.length - 1]
    const isToday = !!tw && tw.end > this.now()
    if (!this.opts.enabled || !isToday) {
      this.engine.setPriceTags(TAG_SOURCE, [])
      return
    }
    const tags: PriceTag[] = []
    const one = tw.lines.find((l) => l.mult === 1)
    const tag = tw.implied ? 'IV' : 'HV'
    if (this.opts.showSigmaLines && one) {
      tags.push({ price: one.up, color: this.opts.lineColor, label: `${tag} +1σ` })
      tags.push({ price: one.down, color: this.opts.lineColor, label: `${tag} −1σ` })
    }
    if (this.opts.showZones && tw.hodZone) tags.push({ price: tw.hodZone[0], color: this.opts.hodColor, label: 'HOD zone' })
    if (this.opts.showZones && tw.lodZone) tags.push({ price: tw.lodZone[1], color: this.opts.lodColor, label: 'LOD zone' })
    this.engine.setPriceTags(TAG_SOURCE, tags)
  }

  /** Key numbers for the pane legend row; null until today's walls exist. */
  getSummary(): { up1: number; down1: number; implied: boolean; ivHv: number | null } | null {
    const tw = this.walls[this.walls.length - 1]
    const one = tw?.lines.find((l) => l.mult === 1)
    if (!tw || !one || tw.end <= this.now()) return null
    // Today's option IV says nothing about a replayed session.
    const ivHv = this.implied && this.hvNow && this.replayAt === null ? ivToDaily(this.implied.atmIV) / this.hvNow : null
    return { up1: one.up, down1: one.down, implied: tw.implied, ivHv }
  }
}
