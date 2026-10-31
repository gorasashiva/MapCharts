import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A fake Web Audio context that behaves like a browser's autoplay policy:
 * resume() only works once `gesture` has happened.
 */
function installFakeAudio() {
  const state: { gesture: boolean; created: number; gains: number; ctx: { state: string } | null } = { gesture: false, created: 0, gains: 0, ctx: null }
  class FakeParam {
    value = 0
    setValueAtTime(): void {}
    exponentialRampToValueAtTime(): void {}
    linearRampToValueAtTime(): void {}
    cancelScheduledValues(): void {}
    setTargetAtTime(): void {}
  }
  class FakeNode {
    gain = new FakeParam()
    frequency = new FakeParam()
    detune = new FakeParam()
    Q = new FakeParam()
    type = 'sine'
    connect(): void {}
    disconnect(): void {}
    start(): void {}
    stop(): void {}
  }
  class FakeCtx {
    state: 'suspended' | 'running' = 'suspended'
    currentTime = 0
    destination = new FakeNode()
    sampleRate = 44100
    constructor() {
      state.created++
      state.ctx = this
    }
    resume(): Promise<void> {
      if (state.gesture) this.state = 'running'
      return state.gesture ? Promise.resolve() : Promise.reject(new Error('not allowed'))
    }
    close(): Promise<void> {
      return Promise.resolve()
    }
    createGain(): FakeNode {
      state.gains++
      return new FakeNode()
    }
    createOscillator(): FakeNode {
      return new FakeNode()
    }
    createBiquadFilter(): FakeNode {
      return new FakeNode()
    }
    createBuffer(): { getChannelData: () => Float32Array } {
      return { getChannelData: () => new Float32Array(16) }
    }
    createBufferSource(): FakeNode & { buffer: unknown } {
      return Object.assign(new FakeNode(), { buffer: null })
    }
  }
  const target = new EventTarget()
  const win = Object.assign(target, {
    AudioContext: FakeCtx,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  })
  vi.stubGlobal('window', win)
  return { state, win }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('alert audio unlock', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('holds a tune fired before any gesture, reports it blocked, and plays it on the first click', async () => {
    const { state, win } = installFakeAudio()
    const { playTune, onAlertAudioBlocked, isAlertAudioBlocked } = await import('./tunes')
    const blocked = vi.fn()
    onAlertAudioBlocked(blocked)

    playTune(0, 1)
    await flush()
    expect(blocked).toHaveBeenCalledTimes(1)
    expect(isAlertAudioBlocked()).toBe(true)
    expect(state.gains).toBe(0) // nothing scheduled while locked

    state.gesture = true
    win.dispatchEvent(new Event('pointerdown'))
    await flush()
    expect(isAlertAudioBlocked()).toBe(false)
    expect(state.gains).toBeGreaterThan(0) // the held tune played
  })

  it('re-arms the click unlock if the browser suspends audio after it was unlocked', async () => {
    const { state, win } = installFakeAudio()
    const { playTune, primeAlertAudio, onAlertAudioBlocked } = await import('./tunes')
    primeAlertAudio()
    state.gesture = true
    win.dispatchEvent(new Event('pointerdown'))
    await flush()

    // e.g. the machine slept: context suspended, and no gesture since.
    state.ctx!.state = 'suspended'
    state.gesture = false
    const blocked = vi.fn()
    onAlertAudioBlocked(blocked)
    const before = state.gains
    playTune(0, 1)
    await flush()
    expect(blocked).toHaveBeenCalledTimes(1)
    expect(state.gains).toBe(before)

    state.gesture = true
    win.dispatchEvent(new Event('pointerdown'))
    await flush()
    expect(state.gains).toBeGreaterThan(before) // the click still plays the held alert
  })

  it('reuses one context and plays immediately once unlocked', async () => {
    const { state, win } = installFakeAudio()
    const { playTune, primeAlertAudio } = await import('./tunes')
    primeAlertAudio()
    state.gesture = true
    win.dispatchEvent(new Event('keydown'))
    await flush()

    const before = state.gains
    playTune(3, 1)
    playTune(5, 1)
    expect(state.gains).toBeGreaterThan(before)
    expect(state.created).toBe(1)
  })
})
