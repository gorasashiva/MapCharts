import type { TradeEvent } from '../data/types'

export type AbsorptionStrength = 'weak' | 'moderate' | 'strong'

/** Hard cap on `absorptionEvents`, in addition to the time-based cleanup()
 *  prune — bounds memory and per-call filter cost during a burst even before
 *  the next 5-min cleanup. */
const MAX_ABSORPTION_EVENTS = 500

export type AbsorptionEvent = {
  timestamp: number // epoch ms
  priceLevel: number
  buyVolume: number
  sellVolume: number
  ratio: number // max(buy, sell) / (buy + sell)
  strength: AbsorptionStrength
  absorbed: 'buy' | 'sell' // which side was absorbed
}

/**
 * Detects buyer/seller absorption at price levels.
 * When one side of trading is heavily absorbed by the other,
 * it indicates institutional or significant retail participation.
 */
export class AbsorptionDetector {
  // Each level's buy/sell also carries `lastUpdate` so onTrade() can decay it
  // by elapsed time before adding new volume — without this, buy/sell at a
  // level accumulated for the entire session (never shrinking, since
  // cleanup() only drops levels that are already ~zero), so a level heavily
  // bought hours ago kept reading "buy absorption" on every later trade
  // there regardless of what was actually happening now, AND kept logging a
  // fresh (near-duplicate) AbsorptionEvent on literally every trade once the
  // ratio crossed the threshold.
  private priceWindow: Map<number, { buy: number; sell: number; lastUpdate: number }> = new Map()
  private lastEventAt: Map<number, number> = new Map()
  private absorptionEvents: AbsorptionEvent[] = []
  private volumeThreshold = 0 // minimum volume to qualify
  private cleanupInterval = 300_000 // 5 min, clean old entries
  private lastCleanup = 0
  private readonly decayHalfLifeMs = 60_000 // matches getAbsorptions()'s default window — ratio reflects recent activity, not the whole session
  private readonly minEventGapMs = 3_000 // don't log a near-duplicate event every single trade once the ratio is past threshold

  constructor(
    private levelPrecision = 100, // e.g., $100 levels for BTC
    private absorptionRatio = 0.75, // 75%+ one-sided = absorption
    private minVolumeMultiplier = 0.5 // threshold = recent avg * multiplier
  ) {}

  /**
   * Process a single trade event
   */
  onTrade(t: TradeEvent) {
    // Quantize price to precision level
    const level = Math.round(t.price / this.levelPrecision) * this.levelPrecision

    let entry = this.priceWindow.get(level)
    if (!entry) {
      entry = { buy: 0, sell: 0, lastUpdate: t.time }
      this.priceWindow.set(level, entry)
    } else {
      const dt = Math.max(0, t.time - entry.lastUpdate)
      if (dt > 0) {
        const decay = Math.exp((-dt / this.decayHalfLifeMs) * Math.LN2)
        entry.buy *= decay
        entry.sell *= decay
      }
    }
    entry.lastUpdate = t.time
    if (t.side === 'buy') entry.buy += t.qty
    else entry.sell += t.qty

    // Detect absorption
    this.checkAbsorption(level, entry, t.time)

    // Cleanup old data periodically
    if (t.time - this.lastCleanup > this.cleanupInterval) {
      this.cleanup(t.time)
      this.lastCleanup = t.time
    }
  }

  /**
   * Check if current price level shows absorption
   */
  private checkAbsorption(
    level: number,
    entry: { buy: number; sell: number; lastUpdate: number },
    timestamp: number
  ) {
    const total = entry.buy + entry.sell
    if (total === 0) return

    const buyRatio = entry.buy / total
    const sellRatio = entry.sell / total
    const dominantRatio = Math.max(buyRatio, sellRatio)

    // Check if absorption threshold is met
    if (dominantRatio < this.absorptionRatio) return

    const lastEvent = this.lastEventAt.get(level) ?? 0
    if (timestamp - lastEvent < this.minEventGapMs) return
    this.lastEventAt.set(level, timestamp)

    // Determine strength
    let strength: AbsorptionStrength = 'weak'
    if (dominantRatio > 0.9) strength = 'strong'
    else if (dominantRatio > 0.82) strength = 'moderate'

    const absorbed = buyRatio > sellRatio ? 'sell' : 'buy'

    const event: AbsorptionEvent = {
      timestamp,
      priceLevel: level,
      buyVolume: entry.buy,
      sellVolume: entry.sell,
      ratio: dominantRatio,
      strength,
      absorbed
    }

    this.absorptionEvents.push(event)
    if (this.absorptionEvents.length > MAX_ABSORPTION_EVENTS) {
      this.absorptionEvents.splice(0, this.absorptionEvents.length - MAX_ABSORPTION_EVENTS)
    }
  }

  /**
   * Get absorption events within a time window
   */
  getAbsorptions(timeWindowMs = 60_000): AbsorptionEvent[] {
    const now = Date.now()
    return this.absorptionEvents.filter(e => now - e.timestamp < timeWindowMs)
  }

  /**
   * Get absorptions at a specific price level
   */
  getAbsorptionsAtLevel(level: number, timeWindowMs = 60_000): AbsorptionEvent[] {
    const now = Date.now()
    return this.absorptionEvents.filter(
      e => Math.abs(e.priceLevel - level) < this.levelPrecision * 0.5 && now - e.timestamp < timeWindowMs
    )
  }

  /**
   * Get cumulative absorption pressure at a price level
   * Returns ratio of buy vs sell absorption
   */
  getAbsorptionBalance(level: number, timeWindowMs = 60_000): number {
    const absorptions = this.getAbsorptionsAtLevel(level, timeWindowMs)
    const buyCount = absorptions.filter(a => a.absorbed === 'buy').length
    const sellCount = absorptions.filter(a => a.absorbed === 'sell').length
    const total = buyCount + sellCount

    if (total === 0) return 0
    return (buyCount - sellCount) / total
  }

  /**
   * Reset detector state
   */
  reset() {
    this.priceWindow.clear()
    this.lastEventAt.clear()
    this.absorptionEvents.length = 0
  }

  /**
   * Clean up old entries and events
   */
  private cleanup(now: number) {
    // Remove absorption events older than 10 minutes
    const maxAge = 600_000
    this.absorptionEvents = this.absorptionEvents.filter(e => now - e.timestamp < maxAge)

    // Clear price windows with no recent activity
    for (const [level, data] of this.priceWindow.entries()) {
      if (data.buy + data.sell < 1) {
        this.priceWindow.delete(level)
      }
    }
  }

  /**
   * Get all current price levels being tracked
   */
  getPriceLevels(): number[] {
    return Array.from(this.priceWindow.keys()).sort((a, b) => a - b)
  }

  /**
   * Get volume distribution at a price level
   */
  getLevelVolume(level: number): { buy: number; sell: number } {
    return this.priceWindow.get(level) || { buy: 0, sell: 0 }
  }
}

export default AbsorptionDetector
