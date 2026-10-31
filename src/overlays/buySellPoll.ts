// Live buy/sell dominance gauge: a small floating "poll" card (BUY = buyers,
// SELL = sellers) fed ONLY by real trades (the caller must never route
// synthetic/fallback trades here — see the note in examples/basic/pane.ts's
// startTradeRainFallback). Volume is tracked with a leaky integrator —
// continuous exponential decay by wall-clock elapsed time, not a fixed
// trade-count window — so one whale trade swings the needle immediately and
// a quiet period relaxes the gauge back toward 50/50 instead of freezing on
// a stale read. This mirrors the "big trades matter more" philosophy behind
// trade rain's volume z-score highlighting, but expressed as a running lean
// rather than a per-trade cue.
import { attachFloatingWidget, type FloatingWidgetHandle } from './floatingWidget'

export interface BuySellPollOptions {
  /** Time for a trade's weight to decay to half, in ms. Shorter = more reactive/noisy. */
  halfLifeMs: number
  /** Wall-clock time since the first real trade before the reading is treated as "mature". */
  warmupMs: number
}

const DEFAULTS: BuySellPollOptions = {
  halfLifeMs: 20_000,
  warmupMs: 40_000, // ~2 half-lives
}

/** Smoothing applied to the *rendered* percentage per frame — bars glide instead of snapping. */
const DISPLAY_LERP = 0.12

type Status = 'idle' | 'warming' | 'live'

export default class BuySellPollOverlay {
  private readonly root: HTMLElement
  private readonly buyFill: HTMLElement
  private readonly sellFill: HTMLElement
  private readonly buyPctEl: HTMLElement
  private readonly sellPctEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly opts: BuySellPollOptions

  private emaBuy = 0
  private emaSell = 0
  private lastTs = 0
  private displayPct = 50
  private raf = 0
  private running = false
  private readonly dock: FloatingWidgetHandle
  private tradeCount = 0
  private firstTradeAt: number | null = null
  private status: Status = 'idle'

  constructor(container: HTMLElement, opts: Partial<BuySellPollOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts }

    this.root = document.createElement('div')
    this.root.className = 'bsp-widget'

    const track = document.createElement('div')
    track.className = 'bsp-track'
    const buyCol = document.createElement('div')
    buyCol.className = 'bsp-col'
    this.buyFill = document.createElement('div')
    this.buyFill.className = 'bsp-fill buy'
    buyCol.appendChild(this.buyFill)
    const sellCol = document.createElement('div')
    sellCol.className = 'bsp-col'
    this.sellFill = document.createElement('div')
    this.sellFill.className = 'bsp-fill sell'
    sellCol.appendChild(this.sellFill)
    track.append(buyCol, sellCol)

    const row = document.createElement('div')
    row.className = 'bsp-row'
    const buyLabel = document.createElement('div')
    buyLabel.className = 'bsp-col-label'
    buyLabel.innerHTML = '<div class="bsp-tag buy">BUY</div>'
    this.buyPctEl = document.createElement('div')
    this.buyPctEl.className = 'bsp-pct buy'
    buyLabel.appendChild(this.buyPctEl)
    const sellLabel = document.createElement('div')
    sellLabel.className = 'bsp-col-label'
    sellLabel.innerHTML = '<div class="bsp-tag sell">SELL</div>'
    this.sellPctEl = document.createElement('div')
    this.sellPctEl.className = 'bsp-pct sell'
    sellLabel.appendChild(this.sellPctEl)
    row.append(buyLabel, sellLabel)

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'bsp-status'

    this.root.append(track, row, this.statusEl)
    container.appendChild(this.root)
    this.dock = attachFloatingWidget(container, this.root, 'top-left')
    this.reset()
  }

  /** Real trades only — never feed this from a synthetic/demo fallback (see class-level note). */
  addTrade(t: { volume: number; side: 'buy' | 'sell' }): void {
    if (!Number.isFinite(t.volume) || t.volume <= 0) return // defensive: never let a bad tick poison the accumulator with NaN
    if (this.tradeCount === 0) this.firstTradeAt = performance.now()
    this.tradeCount++
    if (t.side === 'buy') this.emaBuy += t.volume
    else this.emaSell += t.volume
  }

  /** Snap back to a clean "no data yet" slate — call this on symbol switch so the
   * new symbol's reading isn't biased by the previous symbol's leftover volume. */
  reset(): void {
    this.emaBuy = 0
    this.emaSell = 0
    this.displayPct = 50
    this.tradeCount = 0
    this.firstTradeAt = null
    this.status = 'idle'
    this.lastTs = performance.now()
    this.root.classList.remove('warming')
    this.root.classList.add('idle')
    this.statusEl.textContent = 'No trades yet'
    this.render(50)
  }

  setEnabled(on: boolean): void {
    this.root.style.display = on ? 'flex' : 'none'
    this.dock.setVisible(on)
    if (on) this.start()
    else this.stop()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTs = performance.now()
    const loop = (now: number): void => {
      if (!this.running) return
      this.tick(now)
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
    this.dock.destroy()
    this.root.remove()
  }

  /** Re-stack (docked) or re-clamp (dragged away) after the container resizes (grid layout change, window resize, etc). */
  resize(): void {
    this.dock.resize()
  }

  private tick(now: number): void {
    const dt = Math.max(0, now - this.lastTs)
    this.lastTs = now
    // Browsers pause rAF entirely for a backgrounded tab/unfocused window, so
    // returning to it routinely delivers one large `dt`. That must NOT force
    // tradeCount/firstTradeAt back to "no data" — an app switch is not the
    // same as "no real trading activity" and shouldn't re-run the warmup
    // clock. The decay step right below already fades emaBuy/emaSell toward
    // 50/50 for exactly however long the gap was, so staleness is handled
    // without needing a separate hard reset here.
    if (dt > 0) {
      const decay = Math.exp((-dt / this.opts.halfLifeMs) * Math.LN2)
      this.emaBuy *= decay
      this.emaSell *= decay
    }
    const total = this.emaBuy + this.emaSell
    const target = total > 1e-6 ? (this.emaBuy / total) * 100 : 50
    this.displayPct += (target - this.displayPct) * DISPLAY_LERP
    if (Math.abs(this.displayPct - target) < 0.02) this.displayPct = target
    this.updateStatus(now)
    this.render(this.displayPct)
  }

  private updateStatus(now: number): void {
    if (this.tradeCount === 0) {
      this.setStatus('idle')
      return
    }
    const elapsed = now - (this.firstTradeAt ?? now)
    if (elapsed < this.opts.warmupMs) {
      this.setStatus('warming')
      this.statusEl.textContent = `Warming up… ${Math.ceil((this.opts.warmupMs - elapsed) / 1000)}s`
    } else {
      this.setStatus('live')
    }
  }

  private setStatus(s: Status): void {
    if (this.status === s) return
    this.status = s
    this.root.classList.toggle('idle', s === 'idle')
    this.root.classList.toggle('warming', s === 'warming')
    if (s === 'idle') this.statusEl.textContent = 'No trades yet'
    else if (s === 'live') this.statusEl.textContent = ''
  }

  private render(buyPct: number): void {
    if (this.status === 'idle') {
      this.buyFill.style.height = '0%'
      this.sellFill.style.height = '0%'
      this.buyPctEl.textContent = '—'
      this.sellPctEl.textContent = '—'
      return
    }
    const sellPct = 100 - buyPct
    this.buyFill.style.height = `${buyPct.toFixed(1)}%`
    this.sellFill.style.height = `${sellPct.toFixed(1)}%`
    this.buyPctEl.textContent = `${Math.round(buyPct)}%`
    this.sellPctEl.textContent = `${Math.round(sellPct)}%`
  }
}
