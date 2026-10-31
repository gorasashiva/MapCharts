import { describe, expect, it, vi } from 'vitest'

vi.mock('./tunes', () => ({ playTune: vi.fn(() => () => {}) }))
import { alertCrossed, checkAndFireAlerts } from './notify'
import { playTune } from './tunes'
import type { Alert } from './types'

const T = 1_700_000_000_000
const alert = (condition: 'above' | 'below', price: number, createdAt = T - 60_000): Alert => ({ id: `a-${condition}-${price}`, symbol: 'XAUTUSD', price, condition, createdAt, triggered: false })

describe('alertCrossed', () => {
  it('plain crossing on the latest price', () => {
    expect(alertCrossed(alert('above', 100), { price: 100.5, prevPrice: 99.8 })).toBe(true)
    expect(alertCrossed(alert('above', 100), { price: 99.9, prevPrice: 99.8 })).toBe(false)
    expect(alertCrossed(alert('below', 100), { price: 99.5, prevPrice: 100.2 })).toBe(true)
  })

  it('catches a spike through the level and back between two updates (high / low)', () => {
    // prev 99.8 -> the candle went to 100.4 and came back to 99.9 before the next update
    expect(alertCrossed(alert('above', 100), { price: 99.9, prevPrice: 99.8, high: 100.4, low: 99.7, extremesSince: T })).toBe(true)
    expect(alertCrossed(alert('below', 100), { price: 100.1, prevPrice: 100.2, high: 100.3, low: 99.6, extremesSince: T })).toBe(true)
  })

  it('ignores a spike that happened before the alert was placed', () => {
    const fresh = alert('above', 100, T + 1_000) // created after the previous update
    expect(alertCrossed(fresh, { price: 99.9, prevPrice: 99.8, high: 100.4, low: 99.7, extremesSince: T })).toBe(false)
  })

  it('does not fire when the range never reaches the level', () => {
    expect(alertCrossed(alert('above', 100), { price: 99.9, prevPrice: 99.8, high: 99.95, low: 99.7, extremesSince: T })).toBe(false)
  })

  it('first update after a reload fires when price is already beyond the level', () => {
    expect(alertCrossed(alert('above', 100), { price: 100.2, prevPrice: null })).toBe(true)
    expect(alertCrossed(alert('below', 100), { price: 100.2, prevPrice: null })).toBe(false)
  })
})

describe('checkAndFireAlerts', () => {
  it('fires once with sound and skips other symbols and already-triggered alerts', () => {
    const a = alert('above', 100)
    const other = { ...alert('above', 100), id: 'other', symbol: 'BTCUSD' }
    const done = { ...alert('above', 100), id: 'done', triggered: true }
    const fired: string[] = []
    const run = (): void =>
      checkAndFireAlerts({
        symbol: 'XAUTUSD',
        price: 99.9,
        prevPrice: 99.8,
        high: 100.4,
        low: 99.7,
        extremesSince: T,
        alerts: [a, other, done],
        soundOn: true,
        tune: 2,
        tuneDurationSec: 3,
        onTriggered: (id) => {
          fired.push(id)
          a.triggered = true
        },
      })
    run()
    run() // the store marked it triggered -> no second fire
    expect(fired).toEqual([a.id])
    expect(playTune).toHaveBeenCalledTimes(1)
    expect(playTune).toHaveBeenCalledWith(2, 3)
  })
})
