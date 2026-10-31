import type { DepthSnapshot } from '../data/types'

export type LiquiditySide = 'bid' | 'ask'

export interface LiquidityLevel {
  side: LiquiditySide
  price: number
  qty: number
  notional: number
  persistence: number
  fade: number
  strength: number
}

interface TrackedLevel {
  side: LiquiditySide
  price: number
  qty: number
  lastQty: number
  firstSeen: number
  lastSeen: number
}

const SMOOTHING_MS = 500
const FADE_MS = 1_500
const LEVELS_PER_SIDE = 4
const MIN_RELATIVE_STRENGTH = 0.25

/** Smooths live depth snapshots and ranks the strongest nearby displayed levels. */
export class LiquidityLevelsModel {
  private readonly levels = new Map<string, TrackedLevel>()
  private selected = new Set<string>()
  private lastUpdate = 0

  update(depth: DepthSnapshot, now: number): void {
    const observed = new Map<string, { side: LiquiditySide; price: number; qty: number }>()
    const add = (side: LiquiditySide, rows: [number, number][]): void => {
      for (const [price, qty] of rows) {
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) continue
        observed.set(this.key(side, price), { side, price, qty })
      }
    }
    add('bid', depth.bids)
    add('ask', depth.asks)

    const dt = this.lastUpdate ? Math.max(1, Math.min(now - this.lastUpdate, 1_000)) : SMOOTHING_MS
    const alpha = 1 - Math.exp(-dt / SMOOTHING_MS)
    this.lastUpdate = now

    for (const [key, item] of observed) {
      const old = this.levels.get(key)
      if (!old || now - old.lastSeen > FADE_MS) {
        this.levels.set(key, { ...item, lastQty: item.qty, firstSeen: now, lastSeen: now })
        continue
      }
      old.qty += (item.qty - old.qty) * alpha
      old.lastQty = item.qty
      old.lastSeen = now
    }

    for (const [key, level] of this.levels) {
      if (observed.has(key)) continue
      level.qty *= 1 - alpha
      if (now - level.lastSeen > FADE_MS || level.qty < level.lastQty * 0.03) this.levels.delete(key)
    }
  }

  getLevels(now: number): LiquidityLevel[] {
    const nextSelected = new Set<string>()
    const result: LiquidityLevel[] = []

    for (const side of ['bid', 'ask'] as const) {
      const candidates = [...this.levels.entries()]
        .filter(([, level]) => level.side === side && now - level.lastSeen <= FADE_MS && level.qty > 0)
        .map(([key, level]) => {
          const persistence = Math.min(1, Math.max(0, now - level.firstSeen) / 2_000)
          const ageFade = Math.max(0, 1 - (now - level.lastSeen) / FADE_MS)
          const qtyFade = level.lastSeen === this.lastUpdate ? 1 : Math.min(1, level.qty / level.lastQty)
          const notional = level.price * level.qty
          const score = notional * (0.85 + persistence * 0.15) * (this.selected.has(key) ? 1.08 : 1)
          return { key, level, persistence, fade: ageFade * qtyFade, notional, score }
        })
        .sort((a, b) => b.score - a.score)

      const strongest = candidates[0]?.score ?? 0
      const selected = candidates
        .filter((candidate) => candidate.score >= strongest * MIN_RELATIVE_STRENGTH)
        .slice(0, LEVELS_PER_SIDE)

      for (const candidate of selected) {
        nextSelected.add(candidate.key)
        result.push({
          side,
          price: candidate.level.price,
          qty: candidate.level.qty,
          notional: candidate.notional,
          persistence: candidate.persistence,
          fade: candidate.fade,
          strength: strongest > 0 ? candidate.score / strongest : 0,
        })
      }
    }

    this.selected = nextSelected
    return result
  }

  reset(): void {
    this.levels.clear()
    this.selected.clear()
    this.lastUpdate = 0
  }

  private key(side: LiquiditySide, price: number): string {
    return `${side}:${price}`
  }
}
