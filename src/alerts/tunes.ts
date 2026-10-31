// Alert tunes — ten short, distinct sounds synthesized with the Web Audio API.
// Each tune renders a motif that repeats/sustains to fill the requested number
// of seconds, so the same tune works for a 1s blip or a 10s ring. No audio
// assets: everything is generated live in a short-lived AudioContext that
// closes itself when the sound ends.

import { clampAlertDuration } from './types'

type Wave = OscillatorType

/** One enveloped note, with an optional frequency glide (freqTo). */
function note(
  ctx: AudioContext,
  dest: AudioNode,
  opts: { type?: Wave; freq: number; freqTo?: number; start: number; dur: number; peak?: number },
): void {
  const { type = 'sine', freq, freqTo, start, dur, peak = 0.2 } = opts
  const gain = ctx.createGain()
  gain.connect(dest)
  const attack = Math.min(0.012, dur * 0.25)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  const osc = ctx.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(freq, start)
  if (freqTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), start + dur)
  osc.connect(gain)
  osc.start(start)
  osc.stop(start + dur + 0.03)
}

/** Invoke render(start, i) for each motif repetition needed to fill `duration`. */
function repeat(
  t0: number,
  duration: number,
  period: number,
  render: (start: number, i: number) => void,
): void {
  const count = Math.max(1, Math.ceil(duration / period))
  for (let i = 0; i < count; i++) {
    const start = t0 + i * period
    if (start >= t0 + duration - 0.001) break
    render(start, i)
  }
}

type Render = (ctx: AudioContext, dest: AudioNode, t0: number, duration: number) => void

const TUNES: { name: string; render: Render }[] = [
  {
    name: 'Classic beep',
    render: (ctx, dest, t0, d) =>
      repeat(t0, d, 0.5, (s) => {
        note(ctx, dest, { freq: 880, start: s, dur: 0.15 })
        note(ctx, dest, { freq: 1320, start: s + 0.17, dur: 0.15 })
      }),
  },
  {
    name: 'Chime',
    render: (ctx, dest, t0, d) =>
      repeat(t0, d, 0.95, (s) => {
        note(ctx, dest, { type: 'triangle', freq: 1318, start: s, dur: 0.85, peak: 0.18 })
        note(ctx, dest, { type: 'triangle', freq: 1047, start: s + 0.12, dur: 0.8, peak: 0.14 })
      }),
  },
  {
    name: 'Ping',
    render: (ctx, dest, t0, d) =>
      repeat(t0, d, 0.6, (s) => note(ctx, dest, { freq: 1568, start: s, dur: 0.35, peak: 0.22 })),
  },
  {
    name: 'Rising alert',
    render: (ctx, dest, t0, d) =>
      repeat(t0, d, 0.7, (s) =>
        note(ctx, dest, { type: 'sawtooth', freq: 440, freqTo: 1760, start: s, dur: 0.5, peak: 0.14 }),
      ),
  },
  {
    name: 'Falling alert',
    render: (ctx, dest, t0, d) =>
      repeat(t0, d, 0.7, (s) =>
        note(ctx, dest, { type: 'sawtooth', freq: 1760, freqTo: 440, start: s, dur: 0.5, peak: 0.14 }),
      ),
  },
  {
    name: 'Pulse',
    render: (ctx, dest, t0, d) =>
      repeat(t0, d, 0.2, (s) => note(ctx, dest, { type: 'square', freq: 1100, start: s, dur: 0.09, peak: 0.12 })),
  },
  {
    name: 'Marimba',
    render: (ctx, dest, t0, d) =>
      repeat(t0, d, 0.62, (s) => {
        note(ctx, dest, { type: 'triangle', freq: 523, start: s, dur: 0.2, peak: 0.18 })
        note(ctx, dest, { type: 'triangle', freq: 659, start: s + 0.12, dur: 0.2, peak: 0.16 })
        note(ctx, dest, { type: 'triangle', freq: 784, start: s + 0.24, dur: 0.22, peak: 0.16 })
      }),
  },
  {
    name: 'Siren',
    render: (ctx, dest, t0, d) => {
      const gain = ctx.createGain()
      gain.connect(dest)
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.05)
      gain.gain.setValueAtTime(0.16, Math.max(t0 + 0.06, t0 + d - 0.08))
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + d)
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(620, t0)
      const step = 0.4
      let i = 0
      for (let s = t0; s < t0 + d; i++, s += step) {
        osc.frequency.linearRampToValueAtTime(i % 2 === 0 ? 980 : 620, Math.min(t0 + d, s + step))
      }
      osc.connect(gain)
      osc.start(t0)
      osc.stop(t0 + d + 0.03)
    },
  },
  {
    name: 'Arpeggio',
    render: (ctx, dest, t0, d) =>
      repeat(t0, d, 1.0, (s) =>
        [440, 554, 659, 880].forEach((freq, k) =>
          note(ctx, dest, { freq, start: s + k * 0.18, dur: 0.24, peak: 0.16 }),
        ),
      ),
  },
  {
    name: 'Digital',
    render: (ctx, dest, t0, d) =>
      repeat(t0, d, 0.5, (s) => {
        note(ctx, dest, { type: 'square', freq: 1047, start: s, dur: 0.1, peak: 0.1 })
        note(ctx, dest, { type: 'square', freq: 1568, start: s + 0.12, dur: 0.1, peak: 0.1 })
        note(ctx, dest, { type: 'square', freq: 1319, start: s + 0.26, dur: 0.12, peak: 0.1 })
      }),
  },
]

/** Names for the picker, paired with their tune index. */
export const ALERT_TUNES: readonly { id: number; name: string }[] = TUNES.map((t, id) => ({
  id,
  name: t.name,
}))

type AudioCtor = typeof AudioContext

/**
 * ONE AudioContext for the page, unlocked by the first click/key press.
 *
 * Browsers start an AudioContext suspended unless the page has had a user
 * gesture since it loaded, and resume() without one is refused. A fresh context
 * per alert therefore played SILENTLY whenever an alert fired before the user
 * touched the page (e.g. right after a reload) even though the toast showed.
 * A shared context that is resumed inside a gesture stays running from then
 * on; a tune requested while it is still locked is held and played on the
 * first gesture (if that comes within PENDING_TTL_MS).
 */
let sharedCtx: AudioContext | null = null
let unlockInstalled = false
let pending: { tuneId: number; durationSec: number; at: number } | null = null
const PENDING_TTL_MS = 5 * 60_000
const blockedListeners = new Set<() => void>()

function getCtx(): AudioContext | null {
  if (sharedCtx) return sharedCtx
  const w = window as typeof window & { webkitAudioContext?: AudioCtor }
  const Ctor: AudioCtor | undefined = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) return null
  try {
    sharedCtx = new Ctor()
  } catch {
    return null
  }
  return sharedCtx
}

/**
 * Listen for the first user gesture and unlock alert audio with it. Call once
 * at startup so alerts can sound even if the very first one fires before the
 * user clicks anything; playTune also installs it on demand. Idempotent.
 */
export function primeAlertAudio(): void {
  if (unlockInstalled || typeof window === 'undefined') return
  unlockInstalled = true
  const unlock = (): void => {
    const ctx = getCtx()
    if (!ctx) return
    void ctx.resume().then(() => {
      if (ctx.state !== 'running') return
      for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.removeEventListener(ev, unlock, true)
      unlockInstalled = false // playTune re-arms it if the browser ever suspends audio again (sleep, device change)
      const p = pending
      pending = null
      if (p && Date.now() - p.at <= PENDING_TTL_MS) render(ctx, p.tuneId, p.durationSec)
    }, () => undefined)
  }
  for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(ev, unlock, true)
  installWakeListeners()
}

/**
 * Keep an already-unlocked context running. The OS can suspend (or, in Safari,
 * "interrupt") audio on sleep, device / output changes or long background periods;
 * once the page has had a gesture, resume() is allowed without a new one, so try it
 * whenever the tab comes back or regains focus — before the next alert needs it.
 */
let wakeInstalled = false
function installWakeListeners(): void {
  if (wakeInstalled || typeof document === 'undefined') return
  wakeInstalled = true
  const wake = (): void => {
    if (sharedCtx && sharedCtx.state !== 'running') void sharedCtx.resume().catch(() => undefined)
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wake()
  })
  window.addEventListener('focus', wake)
  window.addEventListener('pageshow', wake)
}

/** True while the browser is still blocking alert sound (no click/key press on the page yet). */
export function isAlertAudioBlocked(): boolean {
  return !sharedCtx || sharedCtx.state !== 'running'
}

/** Notified when a tune could not sound because audio is still locked (e.g. to show a "click to enable sound" hint). */
export function onAlertAudioBlocked(cb: () => void): () => void {
  blockedListeners.add(cb)
  return () => blockedListeners.delete(cb)
}

/** Schedule one tune on `ctx`; returns a stop() that silences it early. */
function render(ctx: AudioContext, tuneId: number, durationSec: number): () => void {
  const duration = clampAlertDuration(durationSec)
  const tune = TUNES[tuneId] ?? TUNES[0]
  const master = ctx.createGain()
  master.gain.value = 0.85
  master.connect(ctx.destination)
  const t0 = ctx.currentTime + 0.03
  try {
    tune.render(ctx, master, t0, duration)
  } catch {
    // a scheduling error must not break later alerts
  }
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    try {
      master.gain.cancelScheduledValues(ctx.currentTime)
      master.gain.setValueAtTime(0, ctx.currentTime)
      master.disconnect()
    } catch {
      /* already torn down */
    }
  }
  const timer = window.setTimeout(stop, (duration + 0.5) * 1000)
  return () => {
    window.clearTimeout(timer)
    stop()
  }
}

/**
 * Play `tuneId` for ~`durationSec` seconds on the shared, gesture-unlocked
 * AudioContext. Returns a stop() that ends it early (used to cut off a
 * preview). If audio is still locked, the tune is held until the first
 * click/key press (within PENDING_TTL_MS) and blocked listeners are told.
 * No-ops where Web Audio is unavailable.
 */
export function playTune(tuneId: number, durationSec: number): () => void {
  primeAlertAudio()
  const ctx = getCtx()
  if (!ctx) return () => {}
  if (ctx.state === 'running') return render(ctx, tuneId, durationSec)
  // Locked (or merely suspended): try to resume — this succeeds when the page
  // has already had a gesture — otherwise hold the tune for the first gesture.
  let cancelled = false
  let stopInner: (() => void) | null = null
  let notified = false
  const notifyBlocked = (): void => {
    if (notified || cancelled) return
    notified = true
    for (const cb of blockedListeners) cb()
  }
  pending = { tuneId, durationSec, at: Date.now() }
  void ctx.resume().then(
    () => {
      if (ctx.state === 'running' && pending && !cancelled) {
        pending = null
        stopInner = render(ctx, tuneId, durationSec)
      } else if (ctx.state !== 'running') {
        notifyBlocked()
      }
    },
    notifyBlocked,
  )
  // Some browsers leave resume() pending (not rejected) without a gesture.
  window.setTimeout(() => {
    if (ctx.state !== 'running') notifyBlocked()
  }, 400)
  return () => {
    cancelled = true
    pending = null
    stopInner?.()
  }
}
