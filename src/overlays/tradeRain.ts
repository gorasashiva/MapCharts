import type { IChartEngine } from '../chart/types'
import { lazyCanvas } from './lazyCanvas'

export type TradeEvent = {
  timestamp: number // epoch ms
  price: number
  volume: number
  side: 'buy' | 'sell'
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

export class TradeRainOverlay {
  /** How long without a real trade before showing "No trades" — short enough
   *  that a busy spot pair never sees it, long enough to ride out brief WS gaps. */
  private static readonly IDLE_MS = 5000
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private particles: any[] = []
  /** Brief attention-grabbing blinks at the top of the pane for "big" (market-moving) trades — see addTrade()/draw(). */
  private flashes: any[] = []
  private running = false
  private enabled = true
  private opts: {
    sideColumn: boolean
    sideOffset: number
    sideWidth: number
    maxParticles: number
    vscale: number
    lifeMs: number
    fallSpeed: number
    landFadeMs: number
    volWindowSize: number
    bigZ: number
    smallZ: number
  }
  private engine: IChartEngine | null
  private container: HTMLElement
  private last = 0
  private resizeObserver: ResizeObserver | null = null
  // Rolling recent-volume stats (ring buffer, O(1) per trade) — lets addTrade
  // judge each trade's SIZE relative to recent market activity ("decent
  // volume that can move markets" vs "minimal") rather than an absolute
  // threshold, which would need re-tuning per instrument/timeframe. Same
  // ring-buffer + single-pass-stats pattern as InstitutionalFootprinter in
  // src/lab/footprints.ts.
  private volRing: Float64Array
  private volRingPos = 0
  private volRingLen = 0
  /** Last real addTrade() call, for the "No trades" idle indicator — this
   *  overlay only ever reflects genuine trades, never synthetic filler. */
  private lastTradeAt = 0

  constructor(
    container: HTMLElement,
    engine?: IChartEngine,
    opts?: Partial<{
      sideColumn: boolean
      sideOffset: number
      sideWidth: number
      maxParticles: number
      vscale: number
      lifeMs: number
      /** Vertical fall speed once a drop has a pane to fall through, in px/sec — slower = a longer, more gradual rain. */
      fallSpeed: number
      /** How long a drop lingers (fading out) once it reaches the bottom of the pane. */
      landFadeMs: number
      /** How many recent trades' volumes to judge "big"/"small" against. */
      volWindowSize: number
      /** Volume z-score at/above which a trade is highlighted as market-moving. */
      bigZ: number
      /** Volume z-score at/below which a trade is faded further as minimal/noise. */
      smallZ: number
    }>,
  ) {
    this.container = container
    this.engine = engine ?? null
    this.opts = Object.assign(
      {
        sideColumn: true,
        sideOffset: 34,
        sideWidth: 18,
        maxParticles: 4800,
        vscale: 0.12,
        lifeMs: 1200,
        fallSpeed: 90,
        landFadeMs: 500,
        volWindowSize: 200,
        bigZ: 1.75,
        smallZ: -0.25,
      },
      opts || {},
    )
    this.volRing = new Float64Array(this.opts.volWindowSize)
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '25'
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)
    container.style.position = container.style.position || 'relative'
    container.appendChild(this.canvas)
    this.bindResize()
    requestAnimationFrame(() => this.resize())
  }

  bindResize() {
    const resize = () => this.resize()
    resize()
    window.addEventListener('resize', resize)
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(resize)
      this.resizeObserver.observe(this.container)
    }
  }

  resize() {
    const rect = this.container.getBoundingClientRect()
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  start() {
    if (this.running) return
    if (!this.enabled) return
    this.running = true
    this.last = performance.now()
    this.raf()
  }

  stop() {
    this.running = false
  }

  clear() {
    this.particles.length = 0
    this.flashes.length = 0
    this.lastTradeAt = 0
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled
    if (enabled) {
      this.start()
    } else {
      this.stop()
      this.clear()
    }
  }

  raf() {
    if (!this.running) return
    this.update()
    this.draw()
    requestAnimationFrame(() => this.raf())
  }

  attachEngine(engine: IChartEngine) {
    this.engine = engine
  }

  /** z-score of `v` against the recent volume window (0 until enough samples exist to judge against). */
  private volumeZScore(v: number): number {
    const n = this.volRingLen
    if (n < 10) return 0
    let sum = 0
    let sumSq = 0
    for (let k = 0; k < n; k++) {
      const x = this.volRing[k]
      sum += x
      sumSq += x * x
    }
    const mean = sum / n
    const variance = Math.max(0, sumSq / n - mean * mean)
    const stdDev = Math.sqrt(variance)
    return (v - mean) / Math.max(stdDev, mean * 0.05 || 1)
  }

  private pushVolumeSample(v: number): void {
    this.volRing[this.volRingPos] = v
    this.volRingPos = (this.volRingPos + 1) % this.opts.volWindowSize
    if (this.volRingLen < this.opts.volWindowSize) this.volRingLen++
  }

  addTrade(t: TradeEvent, opts?: { lifeMs?: number; vscale?: number }) {
    if (!this.enabled) return
    this.lastTradeAt = performance.now()
    const life = opts?.lifeMs ?? this.opts.lifeMs
    const vscale = opts?.vscale ?? this.opts.vscale
    const color = t.side === 'buy' ? '#0ecb81' : '#f6465d'
    // Judge this trade's volume against the RECENT window before folding it
    // into that same window — "big"/"small" are relative to current market
    // activity, not a fixed absolute size, so the same threshold works
    // whether the instrument normally trades in single digits or millions.
    const z = this.volumeZScore(t.volume)
    this.pushVolumeSample(t.volume)
    const big = z >= this.opts.bigZ
    const small = z <= this.opts.smallZ

    // Wide size range (~1-16px) so most trades render as small dust-like dots
    // and only genuinely large ones stand out — a narrower clamp (previously
    // 3-12px) made every particle look roughly the same size.
    let r = Math.min(16, Math.max(1, Math.pow(Math.max(t.volume, 1), 0.45) * vscale))
    let alpha = Math.min(1, 0.22 + Math.min(1, (r - 1) / 15) * 0.78)
    if (big) {
      // Market-moving: firmly bigger and fully opaque, plus a blink at the
      // top of the pane (spawned below) — a trader glancing at the chart
      // should catch it even if their eyes aren't on the falling dot itself.
      r = Math.min(20, r * 1.35 + 2)
      alpha = 1
    } else if (small) {
      // Below-average size: fade further toward "dust" than the base curve already does.
      alpha *= 0.4
    }

    const spawn = performance.now()
    this.particles.push({
      t,
      color,
      r,
      alpha,
      spawn,
      life,
      // Per-drop variance so simultaneous/nearby trades don't fall as a
      // single rigid, stacked column — real rain scatters both sideways and
      // in speed. speedMul skews a little faster for bigger drops (roughly
      // matching real raindrops: bigger = faster terminal velocity).
      vx: (Math.random() - 0.5) * 22,
      speedMul: 0.7 + Math.random() * 0.5 + Math.min(0.3, r / 60),
      wobbleAmp: 2 + Math.random() * 4,
      wobbleFreq: 1.4 + Math.random() * 1.6,
      wobblePhase: Math.random() * Math.PI * 2,
    })
    if (big) this.flashes.push({ color, spawn })

    if (this.particles.length > this.opts.maxParticles) {
      this.particles.splice(0, this.particles.length - this.opts.maxParticles)
    }
  }

  /**
   * Motion model: purely atmospheric rain, NOT a by-price heatmap — a drop
   * spawns at the TOP of the pane (not at its trade's price height) and
   * falls straight down at a constant, slow `fallSpeed` all the way to the
   * bottom, in a column beside the price axis. This deliberately drops the
   * earlier price-anchored design: anchoring each drop to conv.priceToY(the
   * trade's price) meant nothing ever spawned above the current price on a
   * downtrend (or below it on an uptrend), since no trades occur there —
   * candl.live's rain fills the whole pane top-to-bottom regardless of where
   * price currently is, so the spawn point can't be price-derived.
   */
  update() {
    const now = performance.now()
    const paneRect = this.engine?.getMainPaneRect() || null
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.age = now - p.spawn

      if (paneRect) {
        if (p.dropY === undefined) {
          // Anchor once: spawn near the pane's top edge (small random
          // stagger so simultaneous trades don't fall in a single lockstep
          // row) + a base horizontal lane. x is then re-derived from this
          // base every frame (drift + wobble below) rather than fixed, so
          // the drop's PATH scatters instead of falling in a straight line.
          p.dropY = paneRect.y - Math.random() * 24
          const rightEdge = paneRect.x + paneRect.width - this.opts.sideOffset
          const leftEdge = rightEdge - this.opts.sideWidth
          p.baseX = leftEdge + Math.random() * this.opts.sideWidth
          p.y = p.dropY
        }
        const ageSec = p.age / 1000
        const bottomY = paneRect.y + paneRect.height
        p.y = Math.min(bottomY, p.dropY + this.opts.fallSpeed * p.speedMul * ageSec)
        // Lateral scatter: a slow constant drift (some drops lean left, some
        // right) plus a gentle per-drop wobble, clamped to the plot area so
        // it never drifts off-chart. This is what breaks up the "stacked
        // vertical column" look of many drops sharing a near-identical path.
        const driftedX = p.baseX + p.vx * ageSec + Math.sin(ageSec * p.wobbleFreq + p.wobblePhase) * p.wobbleAmp
        p.x = Math.min(paneRect.x + paneRect.width, Math.max(paneRect.x, driftedX))
        const landed = p.y >= bottomY - 0.5
        if (landed) {
          if (p.landedAt === undefined) p.landedAt = now
          p.fade = Math.max(0, 1 - (now - p.landedAt) / this.opts.landFadeMs)
          if (p.fade <= 0) {
            this.particles.splice(i, 1)
            continue
          }
        } else {
          p.fade = 1
        }
      } else {
        // No engine/pane yet (e.g. still mounting) — fall back to a plain
        // timed drift so trades queued before attachEngine() aren't lost.
        if (p.age >= p.life) {
          this.particles.splice(i, 1)
          continue
        }
        const rect = this.container.getBoundingClientRect()
        if (p.startX === undefined) {
          p.startX = rect.width - this.opts.sideOffset + (Math.random() - 0.5) * this.opts.sideWidth
          p.startY = 0
        }
        const t = Math.min(1, p.age / p.life)
        p.x = p.startX
        p.y = p.startY + (rect.height - p.startY) * t
        p.fade = Math.max(0, 1 - t * 1.1)
      }
    }

    const FLASH_LIFE_MS = 550
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i]
      const age = now - f.spawn
      if (age >= FLASH_LIFE_MS) {
        this.flashes.splice(i, 1)
        continue
      }
      if (f.x === undefined) {
        // Anchor once, centered in the rain column right at the top edge —
        // same lane the falling dots spawn from.
        if (paneRect) {
          const rightEdge = paneRect.x + paneRect.width - this.opts.sideOffset
          f.x = rightEdge - this.opts.sideWidth / 2
          f.y = paneRect.y + 6
        } else {
          const rect = this.container.getBoundingClientRect()
          f.x = rect.width - this.opts.sideOffset - this.opts.sideWidth / 2
          f.y = 6
        }
      }
      f.t = age / FLASH_LIFE_MS // 0 (just occurred) -> 1 (done)
    }
  }

  draw() {
    const ctx = this.ctx
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    ctx.clearRect(0, 0, cw, ch)
    ctx.save()
    // Flat matte dots, plain alpha blending (no additive glow/bloom) — a
    // single fill per particle, matching a light dusting of small trades
    // with a few bold, fully-opaque large ones standing out.
    for (const p of this.particles) {
      ctx.globalAlpha = p.alpha * (p.fade ?? 1)
      ctx.fillStyle = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
    ctx.globalAlpha = 1

    // "Big" (market-moving) trades additionally blink at the top of the
    // pane — a soft expanding glow ring plus a quick bright core, additively
    // blended so it actually reads as a flash against the background rather
    // than a flat dot. This is the attention cue; the falling dot itself
    // stays flat/matte like the rest of the rain.
    if (this.flashes.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      for (const f of this.flashes) {
        if (f.x === undefined) continue
        const [r, g, b] = hexToRgb(f.color)
        const t = f.t as number
        const glowR = 3 + t * 22
        const glowAlpha = Math.max(0, 1 - t)
        const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, glowR)
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${(glowAlpha * 0.9).toFixed(3)})`)
        grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(f.x, f.y, glowR, 0, Math.PI * 2)
        ctx.fill()

        // Bright core: fades faster than the glow, giving the "blink" pop.
        const coreAlpha = Math.max(0, 1 - t * 2.5)
        if (coreAlpha > 0) {
          ctx.globalAlpha = coreAlpha
          ctx.fillStyle = '#ffffff'
          ctx.beginPath()
          ctx.arc(f.x, f.y, 3, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
        }
      }
      ctx.restore()
    }

    // Honest-data-only: no synthetic filler, so say so plainly once genuinely
    // idle instead of just sitting empty (easy to mistake for "broken").
    const idleMs = this.lastTradeAt === 0 ? Infinity : performance.now() - this.lastTradeAt
    if (idleMs > TradeRainOverlay.IDLE_MS) {
      ctx.save()
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'
      ctx.fillStyle = 'rgba(120, 123, 134, 0.9)'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText('No trades', 12, 8)
      ctx.restore()
    }
  }
}

export default TradeRainOverlay
