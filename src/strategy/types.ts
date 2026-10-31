/**
 * The contract between strategies and the Strategy Tester.
 *
 * A strategy overlay (FVG + Supertrend, IV Walls Fade, any future Pine port)
 * implements `StrategyOverlay`: it hands over its simulated trades in the
 * common `StrategyTrade` shape and bumps a revision whenever they change. The
 * tester and `metrics.ts` never look at strategy-specific types, so a new
 * strategy only needs to map its trades and register itself on the pane.
 */

export type StrategySide = 'long' | 'short'

export interface StrategyTrade {
  side: StrategySide
  entryTime: number // epoch ms
  entryPrice: number
  /** null while the trade is still open. */
  exitTime: number | null
  exitPrice: number | null
  /** Free text shown in the trades list: 'TP', 'SL', 'Day end', 'Supertrend flip'… */
  exitReason?: string
  /** Initial stop price; when present the tester reports R multiples. */
  stop?: number
  /** Units traded; the tester's Properties quantity is used when omitted. */
  qty?: number
  /** Fees actually charged (entry + exit), in quote currency. When present it replaces the Properties commission. */
  fees?: number
}

/** Implemented by strategy overlays. */
export interface StrategyOverlay {
  /** Every simulated trade over the loaded candles, oldest first. */
  getStrategyTrades(): StrategyTrade[]
  /** Increments whenever the trade list may have changed. */
  getRevision(): number
}

/** One active strategy as the tester sees it. */
export interface StrategySource extends StrategyOverlay {
  id: string
  name: string
}

/** Tester-wide settings, applied the same way to every strategy so results compare. */
export interface StrategyProperties {
  initialCapital: number
  /** Default units per trade (a trade's own `qty` wins). */
  qty: number
  /** Commission in % of traded value, charged on entry and on exit. */
  commissionPct: number
  /** Slippage in price units, against the trade on entry and on exit. */
  slippage: number
}

export const DEFAULT_STRATEGY_PROPERTIES: StrategyProperties = {
  initialCapital: 10_000,
  qty: 1,
  commissionPct: 0,
  slippage: 0,
}
