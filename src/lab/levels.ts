import type { Candle } from '../core/types'
import type { TradeEvent } from '../data/types'
import { AbsorptionDetector } from './absorption'

export type LevelType = 'support' | 'resistance'

export type KeyLevel = {
  price: number
  type: LevelType
  strength: number // 0-1, higher = more significant
  touchCount: number // how many times price touched
  lastTouch: number // epoch ms
  totalVolume: number // accumulated volume at level
  absorptionEvents: number // count of absorption events
  breakOutCount: number // how many times price broke through
}

/**
 * Detects and tracks key support/resistance levels.
 * Combines candle high/low touches with volume absorption data.
 */
export class LevelDetector {
  private levels: Map<number, KeyLevel> = new Map()
  private priceHistory: number[] = []
  private absorption: AbsorptionDetector
  private cleanupInterval = 300_000 // 5 min
  private lastCleanup = 0
  /** Bumped once per onCandle() — the only place `levels` is mutated — so
   *  getKeyLevels() can skip its full rebuild+re-score+sort when nothing
   *  has changed since the last call. */
  private version = 0
  private cachedVersion = -1
  private cachedAt = 0
  private cachedKeyLevels: KeyLevel[] = []
  /** The current, possibly still-forming bar — committed only once superseded
   *  by a new bar time, since an exchange's candle WS re-fires the SAME bar
   *  repeatedly (growing volume) until it closes. Committing on every tick
   *  was inflating touchCount/totalVolume by however many WS ticks a bar got. */
  private pendingTime = -1
  private pendingHighKey = 0
  private pendingLowKey = 0
  private pendingVolume = 0
  private pendingClose = 0

  constructor(
    private precision = 100, // price quantization (e.g., $100 for BTC)
    private absorptionPrecision = 100,
    private decayFactor = 0.95, // strength decay over time
    private strengthThreshold = 0.2 // minimum strength to track
  ) {
    this.absorption = new AbsorptionDetector(absorptionPrecision)
  }

  /**
   * Process a candle to detect support/resistance
   */
  onCandle(candle: Candle) {
    if (candle.time !== this.pendingTime) {
      // A new bar started, so the previously-pending one just closed —
      // commit its FINAL high/low/volume/close exactly once here, rather
      // than every intra-bar WS tick.
      if (this.pendingTime !== -1) this.commitPending()
      this.pendingTime = candle.time
    }
    this.pendingHighKey = Math.round(candle.high / this.precision) * this.precision
    this.pendingLowKey = Math.round(candle.low / this.precision) * this.precision
    this.pendingVolume = candle.volume
    this.pendingClose = candle.close
  }

  private commitPending(): void {
    this.version++
    this.registerLevel(this.pendingHighKey, 'resistance', this.pendingVolume, this.pendingTime)
    this.registerLevel(this.pendingLowKey, 'support', this.pendingVolume, this.pendingTime)

    this.priceHistory.push(this.pendingClose)
    this.checkBreakouts(this.pendingHighKey, this.pendingLowKey, this.pendingTime)

    if (this.pendingTime - this.lastCleanup > this.cleanupInterval) {
      this.cleanup(this.pendingTime)
      this.lastCleanup = this.pendingTime
    }
  }

  /**
   * Process trades to feed absorption detector
   */
  onTrade(t: TradeEvent) {
    this.absorption.onTrade(t)
  }

  /**
   * Register or update a price level
   */
  private registerLevel(price: number, type: LevelType, volume: number, timestamp: number) {
    // Skip if price is 0 or invalid
    if (price <= 0) return

    const key = price
    if (!this.levels.has(key)) {
      this.levels.set(key, {
        price,
        type,
        strength: 0,
        touchCount: 0,
        lastTouch: timestamp,
        totalVolume: 0,
        absorptionEvents: 0,
        breakOutCount: 0
      })
    }

    const level = this.levels.get(key)!
    level.touchCount++
    level.lastTouch = timestamp
    level.totalVolume += volume

    // Update absorption event count
    const absorptions = this.absorption.getAbsorptionsAtLevel(price, 300_000)
    level.absorptionEvents = absorptions.length

    // Calculate strength
    this.updateLevelStrength(level, timestamp)
  }

  /**
   * Calculate level strength based on multiple factors
   */
  private updateLevelStrength(level: KeyLevel, now: number) {
    let strength = 0

    // Touch count contribution (0-0.4)
    const touchStrength = Math.min(0.4, level.touchCount * 0.05)
    strength += touchStrength

    // Absorption contribution (0-0.35)
    const absorptionStrength = Math.min(0.35, level.absorptionEvents * 0.07)
    strength += absorptionStrength

    // Volume contribution (0-0.25)
    const normalizedVol = Math.min(1, level.totalVolume / 100_000_000) // normalize
    strength += normalizedVol * 0.25

    // Time decay (recent levels stronger)
    const ageMs = now - level.lastTouch
    const maxAgeMs = 3_600_000 // 1 hour
    const decayMultiplier = Math.max(0.3, 1 - ageMs / maxAgeMs)
    strength *= decayMultiplier

    level.strength = Math.min(1, strength)
  }

  /**
   * Detect if price broke through established levels
   */
  private checkBreakouts(high: number, low: number, timestamp: number) {
    if (this.priceHistory.length < 2) return

    const prevClose = this.priceHistory[this.priceHistory.length - 2]
    const currClose = this.priceHistory[this.priceHistory.length - 1]

    for (const [, level] of this.levels.entries()) {
      const levelPrice = level.price

      // Breakout if crossed from one side to other
      if (level.type === 'resistance' && prevClose < levelPrice && currClose > levelPrice) {
        level.breakOutCount++
      } else if (level.type === 'support' && prevClose > levelPrice && currClose < levelPrice) {
        level.breakOutCount++
      }
    }
  }

  /**
   * Get all key levels above strength threshold. Memoized: the overlay calls
   * this (via getTopLevels/getSupportLevels/getResistanceLevels, each of
   * which delegates here) roughly every animation frame, but the underlying
   * level set only changes on onCandle(). Recomputes on an actual mutation
   * (version bump) OR after 1s so time-decayed strength still drifts
   * smoothly — just not on every single frame.
   */
  getKeyLevels(): KeyLevel[] {
    const now = Date.now()
    if (this.version === this.cachedVersion && now - this.cachedAt < 1000) {
      return this.cachedKeyLevels
    }
    const levels = Array.from(this.levels.values()).filter(l => l.strength > this.strengthThreshold)

    // Update strength before returning (time decay)
    for (const level of levels) {
      this.updateLevelStrength(level, now)
    }

    const sorted = levels.sort((a, b) => b.strength - a.strength)
    this.cachedVersion = this.version
    this.cachedAt = now
    this.cachedKeyLevels = sorted
    return sorted
  }

  /**
   * Get support levels only
   */
  getSupportLevels(): KeyLevel[] {
    return this.getKeyLevels().filter(l => l.type === 'support')
  }

  /**
   * Get resistance levels only
   */
  getResistanceLevels(): KeyLevel[] {
    return this.getKeyLevels().filter(l => l.type === 'resistance')
  }

  /**
   * Get levels within a price range
   */
  getLevelsInRange(minPrice: number, maxPrice: number): KeyLevel[] {
    return this.getKeyLevels().filter(l => l.price >= minPrice && l.price <= maxPrice)
  }

  /**
   * Find nearest level to a price
   */
  getNearestLevel(price: number): KeyLevel | null {
    const levels = this.getKeyLevels()
    if (levels.length === 0) return null

    let nearest = levels[0]
    let minDist = Math.abs(nearest.price - price)

    for (const level of levels) {
      const dist = Math.abs(level.price - price)
      if (dist < minDist) {
        minDist = dist
        nearest = level
      }
    }

    return nearest
  }

  /**
   * Check if price is near a level (within precision)
   */
  isNearLevel(price: number, tolerance = this.precision * 2): KeyLevel | null {
    for (const [, level] of this.levels.entries()) {
      if (Math.abs(level.price - price) <= tolerance && level.strength > this.strengthThreshold) {
        return level
      }
    }
    return null
  }

  /**
   * Get strongest levels (top N)
   */
  getTopLevels(count = 5): KeyLevel[] {
    return this.getKeyLevels().slice(0, count)
  }

  /**
   * Calculate cluster of levels (potential support/resistance zones)
   */
  getLevelClusters(clusterRange = this.precision * 5): KeyLevel[][] {
    const levels = this.getKeyLevels().sort((a, b) => a.price - b.price)
    if (levels.length === 0) return []

    const clusters: KeyLevel[][] = []
    let currentCluster: KeyLevel[] = [levels[0]]

    for (let i = 1; i < levels.length; i++) {
      if (levels[i].price - currentCluster[currentCluster.length - 1].price <= clusterRange) {
        currentCluster.push(levels[i])
      } else {
        clusters.push(currentCluster)
        currentCluster = [levels[i]]
      }
    }
    if (currentCluster.length > 0) {
      clusters.push(currentCluster)
    }

    return clusters
  }

  /**
   * Get absorption detector instance for direct access
   */
  getAbsorptionDetector(): AbsorptionDetector {
    return this.absorption
  }

  /**
   * Reset detector
   */
  reset() {
    this.levels.clear()
    this.priceHistory.length = 0
    this.absorption.reset()
    this.pendingTime = -1
    this.pendingVolume = 0
    this.version++ // invalidate getKeyLevels()'s cache — cleared levels must not read back stale
  }

  /**
   * Clean up weak/old levels
   */
  private cleanup(now: number) {
    const maxAge = 1_800_000 // 30 minutes
    const levelsCopy = Array.from(this.levels.entries())

    for (const [key, level] of levelsCopy) {
      this.updateLevelStrength(level, now)

      // Remove if too old and weak
      if (now - level.lastTouch > maxAge && level.strength < 0.15) {
        this.levels.delete(key)
      }
    }

    // Keep price history manageable
    if (this.priceHistory.length > 1000) {
      this.priceHistory = this.priceHistory.slice(-500)
    }
  }

  /**
   * Get level statistics
   */
  getStats() {
    const levels = this.getKeyLevels()
    return {
      totalLevels: levels.length,
      supportCount: levels.filter(l => l.type === 'support').length,
      resistanceCount: levels.filter(l => l.type === 'resistance').length,
      avgStrength: levels.length > 0 ? levels.reduce((s, l) => s + l.strength, 0) / levels.length : 0,
      totalAbsorptionEvents: levels.reduce((s, l) => s + l.absorptionEvents, 0),
      totalTouches: levels.reduce((s, l) => s + l.touchCount, 0)
    }
  }
}

export default LevelDetector
