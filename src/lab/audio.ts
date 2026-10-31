// Market sonification — turns the live trade tape into tasteful ambient plucks.
//
// Each trade becomes a short enveloped oscillator note: sine for buys, triangle
// one octave lower for sells. Pitch is chosen on an A minor pentatonic scale
// (3 octaves) by trade-size percentile over a rolling window — bigger trades
// land lower, louder and longer. Buys pan slightly right, sells slightly left.
// All notes run through a shared master gain -> compressor -> destination
// chain, with a single feedback delay providing ambience.
//
// Web Audio only — no dependencies. `start()` must be called from a user
// gesture call stack (autoplay policy); `stop()` fades out and suspends the
// context, leaving the sonifier fully restartable.

import type { TradeEvent } from '../data/types'

/** Minimum spacing between notes (~18 notes/sec). */
const TICK_MS = 55

/** Rolling window of recent trade sizes (log scale) for percentile/loudness. */
const SIZE_WINDOW = 256

/** Master output level — deliberately quiet, this is ambience not an alarm. */
const MASTER_LEVEL = 0.12

/** Envelope: fast attack, exponential release (release length scales 0.3-0.8s). */
const ATTACK_S = 0.005
const RELEASE_MIN_S = 0.3
const RELEASE_SPAN_S = 0.5

/** Feedback delay (shared by all notes). */
const DELAY_TIME_S = 0.28
const DELAY_FEEDBACK = 0.35
const DELAY_WET = 0.25

/** Stereo placement: buys slightly right, sells slightly left. */
const PAN_AMOUNT = 0.28

/** A minor pentatonic intervals, in semitones from the root. */
const PENTATONIC = [0, 3, 5, 7, 10]
const OCTAVES = 3
/** Scale root: A3 (220 Hz). Sells additionally drop one octave (down to A2). */
const ROOT_HZ = 220

/** Scale frequencies, ascending — index 0 is the lowest note. */
const SCALE_HZ: number[] = []
for (let oct = 0; oct < OCTAVES; oct++) {
  for (const semi of PENTATONIC) {
    SCALE_HZ.push(ROOT_HZ * Math.pow(2, oct + semi / 12))
  }
}

/** One pending (rate-limited, same-side-coalesced) note. */
interface PendingNote {
  qty: number // summed base-asset quantity of the coalesced trades
  firstAt: number // performance.now() of the first coalesced trade (FIFO fairness)
}

export class TradeSonifier {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private delay: DelayNode | null = null
  private _running = false

  // Rolling window of log(1+qty) values, as a ring buffer.
  private readonly sizes = new Float64Array(SIZE_WINDOW)
  private sizeCount = 0
  private sizeIdx = 0

  // Rate limiting: at most one note per TICK_MS, coalescing same-side trades.
  private pending: Record<'buy' | 'sell', PendingNote | null> = { buy: null, sell: null }
  private tickTimer: ReturnType<typeof setTimeout> | null = null
  private suspendTimer: ReturnType<typeof setTimeout> | null = null

  get running(): boolean {
    return this._running
  }

  /**
   * Create (lazily) and resume the audio graph. MUST be called from a user
   * gesture call stack so the browser allows the context to run. Resolves
   * silently (without starting) if Web Audio is unavailable.
   */
  async start(): Promise<void> {
    if (this._running) return
    if (!this.ensureGraph()) return // Web Audio unavailable — stay stopped
    const ctx = this.ctx
    const master = this.masterGain
    if (!ctx || !master) return

    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer) // a stop() fade was in flight — abort it
      this.suspendTimer = null
    }
    if (ctx.state !== 'running') {
      await ctx.resume()
    }

    // Fade the master in so a restart never clicks.
    const now = ctx.currentTime
    const g = master.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(Math.max(g.value, 0.0001), now)
    g.exponentialRampToValueAtTime(MASTER_LEVEL, now + 0.08)

    this._running = true
  }

  /** Fade out, then suspend the context. Restartable via start(). */
  stop(): void {
    this._running = false

    // Never let timers or pending notes accumulate while stopped.
    if (this.tickTimer !== null) {
      clearTimeout(this.tickTimer)
      this.tickTimer = null
    }
    this.pending.buy = null
    this.pending.sell = null

    const ctx = this.ctx
    const master = this.masterGain
    if (!ctx || !master) return

    // Ramp the master to silence (no clicks), then suspend once the fade and
    // note tails are inaudible.
    const now = ctx.currentTime
    const g = master.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(Math.max(g.value, 0.0001), now)
    g.exponentialRampToValueAtTime(0.0001, now + 0.12)

    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer)
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null
      if (!this._running && this.ctx && this.ctx.state === 'running') {
        this.ctx.suspend().catch(() => {
          /* context may already be closing — nothing to do */
        })
      }
    }, 180)
  }

  /** Feed one live trade. Cheap no-op while stopped. */
  onTrade(t: TradeEvent): void {
    if (!this._running || !this.ctx) return
    if (!(t.qty > 0)) return

    // The rolling window tracks *individual* trade sizes (pre-coalescing) so
    // percentiles reflect the real tape, not our rate limiter.
    this.pushSize(Math.log1p(t.qty))

    const bucket = this.pending[t.side]
    if (bucket) {
      bucket.qty += t.qty // coalesce same-side trades within the tick
    } else {
      this.pending[t.side] = { qty: t.qty, firstAt: performance.now() }
    }

    if (this.tickTimer === null) {
      // Leading edge: an isolated trade sounds immediately, then the tick
      // timer gates everything that follows.
      this.flushOne()
      this.scheduleTick()
    }
  }

  // ----- internals -----

  /** Lazily build the node graph. Returns false if Web Audio is unavailable. */
  private ensureGraph(): boolean {
    if (this.ctx) return true
    const g = globalThis as unknown as {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
    }
    const Ctor = g.AudioContext ?? g.webkitAudioContext
    if (!Ctor) return false

    const ctx = new Ctor()

    // Master chain: notes -> masterGain -> compressor -> destination.
    const master = ctx.createGain()
    master.gain.value = 0.0001 // start() fades it up

    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -22
    comp.knee.value = 18
    comp.ratio.value = 5
    comp.attack.value = 0.004
    comp.release.value = 0.22

    master.connect(comp)
    comp.connect(ctx.destination)

    // Shared ambience: a single feedback delay all notes send into.
    const delay = ctx.createDelay(1)
    delay.delayTime.value = DELAY_TIME_S
    const feedback = ctx.createGain()
    feedback.gain.value = DELAY_FEEDBACK
    const wet = ctx.createGain()
    wet.gain.value = DELAY_WET
    delay.connect(feedback)
    feedback.connect(delay)
    delay.connect(wet)
    wet.connect(master)

    this.ctx = ctx
    this.masterGain = master
    this.delay = delay
    return true
  }

  /** One rate-limit tick: keep ticking only while there is something pending. */
  private scheduleTick(): void {
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null
      if (!this._running) return
      if (this.pending.buy || this.pending.sell) {
        this.flushOne()
        this.scheduleTick()
      }
    }, TICK_MS)
  }

  /**
   * Play at most ONE pending note (strict ≤ ~18 notes/sec). If both sides are
   * waiting, the side whose first trade arrived earlier goes first; the other
   * keeps accumulating until the next tick.
   */
  private flushOne(): void {
    const { buy, sell } = this.pending
    let side: 'buy' | 'sell'
    if (buy && sell) side = buy.firstAt <= sell.firstAt ? 'buy' : 'sell'
    else if (buy) side = 'buy'
    else if (sell) side = 'sell'
    else return
    const note = this.pending[side]
    this.pending[side] = null
    if (note) this.playNote(side, note.qty)
  }

  private playNote(side: 'buy' | 'sell', qty: number): void {
    const ctx = this.ctx
    const master = this.masterGain
    const delay = this.delay
    if (!ctx || !master || !delay || ctx.state !== 'running') return

    const x = Math.log1p(Math.max(0, qty))
    const pct = this.percentile(x) // 0..1, 1 = biggest in the window
    const vel = this.velocity(x) // 0..1 loudness, log-scaled + window-normalized

    // Bigger trades land on higher notes.
    const idx = Math.min(SCALE_HZ.length - 1, Math.max(0, Math.floor(pct * SCALE_HZ.length)))
    let freq = SCALE_HZ[idx]
    if (side === 'sell') freq /= 2 // sells: one octave below the chosen note

    const t0 = ctx.currentTime + 0.001
    const release = RELEASE_MIN_S + RELEASE_SPAN_S * vel // bigger = longer
    const peak = 0.18 + 0.82 * vel // bigger = louder (master/compressor cap it)

    const osc = ctx.createOscillator()
    osc.type = side === 'buy' ? 'sine' : 'triangle'
    osc.frequency.value = freq

    // Per-note envelope: ~5ms linear attack, exponential release.
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t0)
    env.gain.linearRampToValueAtTime(peak, t0 + ATTACK_S)
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + ATTACK_S + release)
    osc.connect(env)

    // Stereo placement (graceful if StereoPannerNode is missing).
    let out: AudioNode = env
    if (typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner()
      pan.pan.value = side === 'buy' ? PAN_AMOUNT : -PAN_AMOUNT
      env.connect(pan)
      out = pan
    }
    out.connect(master) // dry
    out.connect(delay) // shared ambience send

    osc.start(t0)
    osc.stop(t0 + ATTACK_S + release + 0.05)
    osc.onended = () => {
      // Free the per-note nodes once the tail is done.
      osc.disconnect()
      env.disconnect()
      if (out !== env) out.disconnect()
    }
  }

  private pushSize(x: number): void {
    this.sizes[this.sizeIdx] = x
    this.sizeIdx = (this.sizeIdx + 1) % SIZE_WINDOW
    if (this.sizeCount < SIZE_WINDOW) this.sizeCount++
  }

  /** Fraction of the rolling window at or below x. */
  private percentile(x: number): number {
    const n = this.sizeCount
    if (n === 0) return 0.5
    let below = 0
    for (let i = 0; i < n; i++) {
      if (this.sizes[i] <= x) below++
    }
    return below / n
  }

  /** Loudness 0..1: log(1+qty) normalized by the rolling-window max, clamped. */
  private velocity(x: number): number {
    const n = this.sizeCount
    if (n === 0) return 0.5
    let max = 0
    for (let i = 0; i < n; i++) {
      if (this.sizes[i] > max) max = this.sizes[i]
    }
    if (max <= 0) return 0.5
    return Math.min(1, Math.max(0.05, x / max))
  }
}

/** App-wide singleton — wire UI toggles and the trade stream to this. */
export const sonifier = new TradeSonifier()
