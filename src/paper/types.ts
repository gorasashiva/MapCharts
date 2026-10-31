/**
 * Paper trading on bar replay — shared types.
 *
 * Quantities are in exchange CONTRACTS (what Delta's order ticket takes);
 * `contractValue` converts them to base-asset units, so P&L and notional are
 * price × contracts × contractValue in the quote currency (USD on Delta).
 */
import type { StrategyTrade } from '../strategy/types'

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'market' | 'limit' | 'stop'
export type Liquidity = 'maker' | 'taker'

/** Fees as % of notional; GST is charged on top of the fee (Delta India). */
export interface FeeSchedule {
  takerPct: number
  makerPct: number
  gstPct: number
}

/** Delta Exchange India futures & perpetuals: taker 0.05%, maker 0.02%, +18% GST on the fee. */
export const DELTA_INDIA_FEES: FeeSchedule = { takerPct: 0.05, makerPct: 0.02, gstPct: 18 }

export interface PaperOrder {
  id: number
  side: OrderSide
  type: 'limit' | 'stop'
  /** Contracts. */
  qty: number
  price: number
  /** Time of the bar it was placed on; it can only fill on later bars. */
  placedAt: number
}

export interface PaperPosition {
  side: 'long' | 'short'
  /** Contracts, > 0. */
  qty: number
  avgPrice: number
  openTime: number
  /** Entry fees not yet allocated to a closed trade. */
  entryFees: number
  stop: number | null
  target: number | null
  /** First stop attached to the position — the R-multiple basis. */
  initialStop: number | null
}

export interface PaperFill {
  time: number
  side: OrderSide
  qty: number
  price: number
  fee: number
  liquidity: Liquidity
  reason: string
}

export interface PaperEvent {
  kind: 'fill' | 'reject' | 'cancel'
  text: string
}

export interface PaperAccount {
  id: string
  name: string
  initialCapital: number
  /** Realized cash: capital ± closed P&L − fees, carried across sessions. */
  balance: number
  leverage: number
  fees: FeeSchedule
  sessions: PaperSessionRecord[]
}

export interface PaperSessionRecord {
  id: string
  symbol: string
  interval: string
  /** First and last replayed bar of the session. */
  from: number
  to: number
  startBalance: number
  endBalance: number
  fees: number
  trades: StrategyTrade[]
}
