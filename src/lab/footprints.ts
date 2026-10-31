import type { TradeEvent } from '../data/types'

export type FootprintMarker = 'large_block' | 'unusual_size' | 'momentum' | 'absorption' | 'reversal'

export type Footprint = {
  timestamp: number // epoch ms
  price: number
  volume: number
  side: 'buy' | 'sell'
  confidence: number // 0-1, likelihood of institutional
  markers: FootprintMarker[]
  zscore?: number // volume zscore
}

interface VolumeStats {
  mean: number
  stdDev: number
  min: number
  max: number
}

/**
 * Identifies institutional footprints and block trades.
 * Tracks volume anomalies, momentum, and order patterns.
 */
/** Hard cap on `footprints`, in addition to the time-based cleanup() prune —
 *  bounds memory/scan cost during a burst even before the next 5-min cleanup. */
const MAX_FOOTPRINTS = 500

export class InstitutionalFootprinter {
  // Fixed-capacity ring buffers for the trailing `windowSize` trades (qty +
  // side), replacing a push/shift() array pair: shift() is O(n) per trade
  // once the window fills, and the old `.slice(-windowSize)` + 2x `.reduce()`
  // + spread `Math.min/max` in updateStats() re-allocated on every trade.
  // `ringPos` is the next WRITE slot; the most recent trade is at
  // `ringPos - 1` (mod windowSize). `sideAt(k)` reads k trades back from the
  // most recent (k=0 = most recent), used by detectMomentum/detectReversal.
  private qtyRing: Float64Array
  private sideRing: Uint8Array // 1 = buy, 0 = sell
  private ringPos = 0
  private ringLen = 0 // number of valid entries, <= windowSize
  private volumeStats: VolumeStats = { mean: 0, stdDev: 0, min: 0, max: 0 }
  private footprints: Footprint[] = []
  private cleanupInterval = 300_000 // 5 min
  private lastCleanup = 0

  constructor(
    private volumeThresholdZscore = 2.5, // stddev multiplier for anomaly
    private momentumWindow = 5, // consecutive same-side trades
    private windowSize = 100 // stats calculated on recent N trades
  ) {
    this.qtyRing = new Float64Array(windowSize)
    this.sideRing = new Uint8Array(windowSize)
  }

  private sideAt(k: number): 'buy' | 'sell' {
    const idx = (this.ringPos - 1 - k + this.windowSize) % this.windowSize
    return this.sideRing[idx] === 1 ? 'buy' : 'sell'
  }

  /**
   * Process incoming trade event
   */
  onTrade(t: TradeEvent) {
    this.qtyRing[this.ringPos] = t.qty
    this.sideRing[this.ringPos] = t.side === 'buy' ? 1 : 0
    this.ringPos = (this.ringPos + 1) % this.windowSize
    if (this.ringLen < this.windowSize) this.ringLen++

    this.updateStats()

    const zscore = (t.qty - this.volumeStats.mean) / Math.max(this.volumeStats.stdDev, 1)
    const markers: FootprintMarker[] = []
    let confidence = 0

    // Check for volume anomaly
    if (zscore > this.volumeThresholdZscore) {
      markers.push('large_block')
      confidence += 0.4
    } else if (zscore > this.volumeThresholdZscore * 0.7) {
      markers.push('unusual_size')
      confidence += 0.2
    }

    // Check for momentum
    if (this.detectMomentum()) {
      markers.push('momentum')
      confidence += 0.3
    }

    // Check for reversal pattern (side change after momentum)
    if (this.detectReversal()) {
      markers.push('reversal')
      confidence += 0.2
    }

    // Record as footprint if confidence threshold met
    if (confidence > 0.35) {
      this.footprints.push({
        timestamp: t.time,
        price: t.price,
        volume: t.qty,
        side: t.side,
        confidence: Math.min(1, confidence),
        markers,
        zscore
      })
      // Hard cap, independent of the time-based cleanup() below — bounds a
      // burst instead of letting it grow unbounded until the next 5-min prune.
      if (this.footprints.length > MAX_FOOTPRINTS) {
        this.footprints.splice(0, this.footprints.length - MAX_FOOTPRINTS)
      }
    }

    // Periodic cleanup
    if (t.time - this.lastCleanup > this.cleanupInterval) {
      this.cleanup(t.time)
      this.lastCleanup = t.time
    }
  }

  /**
   * Update running volume statistics over the trailing `windowSize` trades —
   * one indexed pass over the ring buffer (sum + sum-of-squares + min/max
   * together), no slice()/reduce()/spread-argument allocations per trade.
   */
  private updateStats() {
    if (this.ringLen < 10) return

    let sum = 0
    let sumSq = 0
    let min = Infinity
    let max = -Infinity
    for (let k = 0; k < this.ringLen; k++) {
      const v = this.qtyRing[(this.ringPos - 1 - k + this.windowSize) % this.windowSize]
      sum += v
      sumSq += v * v
      if (v < min) min = v
      if (v > max) max = v
    }
    const mean = sum / this.ringLen
    const variance = Math.max(0, sumSq / this.ringLen - mean * mean)

    this.volumeStats = { mean, stdDev: Math.sqrt(variance), min, max }
  }

  /**
   * Detect consecutive same-side trades (momentum)
   */
  private detectMomentum(): boolean {
    if (this.ringLen < this.momentumWindow) return false
    const firstSide = this.sideAt(this.momentumWindow - 1)
    for (let k = 0; k < this.momentumWindow; k++) {
      if (this.sideAt(k) !== firstSide) return false
    }
    return true
  }

  /**
   * Detect reversal: momentum followed by opposite side
   */
  private detectReversal(): boolean {
    if (this.ringLen < this.momentumWindow + 1) return false
    const momSide = this.sideAt(this.momentumWindow)
    for (let k = 1; k <= this.momentumWindow; k++) {
      if (this.sideAt(k) !== momSide) return false
    }
    return this.sideAt(0) !== momSide
  }

  /**
   * Get all detected footprints
   */
  getFootprints(timeWindowMs = 300_000): Footprint[] {
    const now = Date.now()
    return this.footprints.filter(f => now - f.timestamp < timeWindowMs)
  }

  /**
   * Get footprints of specific marker type
   */
  getFootprintsByMarker(marker: FootprintMarker, timeWindowMs = 300_000): Footprint[] {
    const now = Date.now()
    return this.footprints.filter(f => f.markers.includes(marker) && now - f.timestamp < timeWindowMs)
  }

  /**
   * Get footprints above confidence threshold
   */
  getHighConfidenceFootprints(minConfidence = 0.7, timeWindowMs = 300_000): Footprint[] {
    const now = Date.now()
    return this.footprints.filter(
      f => f.confidence >= minConfidence && now - f.timestamp < timeWindowMs
    )
  }

  /**
   * Get average confidence in time window (overall institutional activity level)
   */
  getConfidenceAverage(timeWindowMs = 300_000): number {
    const footprints = this.getFootprints(timeWindowMs)
    if (footprints.length === 0) return 0
    return footprints.reduce((sum, f) => sum + f.confidence, 0) / footprints.length
  }

  /**
   * Get buy vs sell institutional activity ratio
   */
  getInstitutionalBalance(timeWindowMs = 300_000): number {
    const footprints = this.getFootprints(timeWindowMs)
    if (footprints.length === 0) return 0

    const buyConfidence = footprints
      .filter(f => f.side === 'buy')
      .reduce((sum, f) => sum + f.confidence, 0)
    const sellConfidence = footprints
      .filter(f => f.side === 'sell')
      .reduce((sum, f) => sum + f.confidence, 0)

    const total = buyConfidence + sellConfidence
    if (total === 0) return 0

    return (buyConfidence - sellConfidence) / total
  }

  /**
   * Get volume stats for current window
   */
  getVolumeStats(): VolumeStats {
    return { ...this.volumeStats }
  }

  /**
   * Reset detector
   */
  reset() {
    this.ringPos = 0
    this.ringLen = 0
    this.footprints.length = 0
    this.volumeStats = { mean: 0, stdDev: 0, min: 0, max: 0 }
  }

  /**
   * Clean up old data
   */
  private cleanup(now: number) {
    const maxAge = 600_000 // 10 minutes
    this.footprints = this.footprints.filter(f => now - f.timestamp < maxAge)
  }
}

export default InstitutionalFootprinter
