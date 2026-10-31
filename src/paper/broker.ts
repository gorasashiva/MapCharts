/**
 * Paper broker for bar replay — a single-symbol, net-position simulator.
 *
 * Fill rules (no look-ahead, close to TradingView's replay trading):
 *  - Market orders fill at the close of the bar the replay cursor is on.
 *  - Working limit/stop orders and the position's SL/TP are checked only
 *    against bars revealed AFTER they were placed (`onBar`). A bar that gaps
 *    through the price fills at its open.
 *  - When one bar reaches both SL and TP, the SL fills (conservative).
 *  - Limit orders and TP pay the maker fee; market, stop and SL pay taker.
 *    Fee = notional × rate × (1 + GST).
 *  - Margin: notional ÷ leverage must fit in free equity to open or add.
 *    Liquidation is not simulated.
 *
 * Every reduction of the position emits a closed StrategyTrade (qty in base
 * units, actual fees attached), so src/strategy/metrics.ts reports on it.
 */
import type { Candle } from '../core/types'
import type { StrategyTrade } from '../strategy/types'
import type { FeeSchedule, Liquidity, OrderSide, PaperEvent, PaperFill, PaperOrder, PaperPosition } from './types'

export interface BrokerOptions {
  balance: number
  leverage: number
  fees: FeeSchedule
  /** Base-asset units per contract (1 for non-Delta symbols). */
  contractValue: number
}

export interface Bracket {
  stop?: number | null
  target?: number | null
}

export type BrokerResult = { ok: true } | { ok: false; error: string }

const sign = (side: OrderSide): 1 | -1 => (side === 'buy' ? 1 : -1)
const fmt = (v: number): string => String(+v.toFixed(8))

export class PaperBroker {
  balance: number
  readonly leverage: number
  readonly fees: FeeSchedule
  readonly contractValue: number

  position: PaperPosition | null = null
  orders: PaperOrder[] = []
  readonly fills: PaperFill[] = []
  /** Closed trades, in exit order. */
  readonly trades: StrategyTrade[] = []
  feesPaid = 0
  /** The bar the replay cursor is on. */
  bar: Candle | null = null
  /** Bumped on every state change (UI and Strategy Tester polling). */
  revision = 0

  private nextId = 1

  constructor(o: BrokerOptions) {
    this.balance = o.balance
    this.leverage = Math.max(1, o.leverage)
    this.fees = o.fees
    this.contractValue = o.contractValue > 0 ? o.contractValue : 1
  }

  // ---- read-outs ----

  notional(qty: number, price: number): number {
    return Math.abs(qty) * this.contractValue * price
  }

  fee(qty: number, price: number, liq: Liquidity): number {
    const pct = liq === 'maker' ? this.fees.makerPct : this.fees.takerPct
    return this.notional(qty, price) * (pct / 100) * (1 + this.fees.gstPct / 100)
  }

  get mark(): number {
    return this.bar?.close ?? NaN
  }

  unrealized(mark = this.mark): number {
    const p = this.position
    if (!p || !isFinite(mark)) return 0
    return (p.side === 'long' ? 1 : -1) * (mark - p.avgPrice) * p.qty * this.contractValue
  }

  equity(mark = this.mark): number {
    return this.balance + this.unrealized(mark)
  }

  usedMargin(): number {
    const p = this.position
    return p ? this.notional(p.qty, p.avgPrice) / this.leverage : 0
  }

  freeMargin(): number {
    return this.equity() - this.usedMargin()
  }

  /** True once anything happened — the replay must not be rewound past it. */
  hasActivity(): boolean {
    return this.fills.length > 0 || this.orders.length > 0
  }

  /** Closed trades plus the open position (marked by the metrics to the last close). */
  snapshotTrades(): StrategyTrade[] {
    const out = this.trades.slice()
    const p = this.position
    if (p) {
      out.push({
        side: p.side,
        entryTime: p.openTime,
        entryPrice: p.avgPrice,
        exitTime: null,
        exitPrice: null,
        stop: p.initialStop ?? undefined,
        qty: p.qty * this.contractValue,
        fees: p.entryFees,
      })
    }
    return out
  }

  // ---- replay ----

  /** Feed the next revealed bar: fills working orders and the bracket against it. */
  onBar(c: Candle): PaperEvent[] {
    const events: PaperEvent[] = []
    const prev = this.bar
    this.bar = c
    if (!prev || c.time <= prev.time) {
      this.revision++
      return events // first bar, or a re-feed of the same bar: nothing can fill yet
    }

    // Bracket first, SL before TP.
    const p = this.position
    if (p) {
      const long = p.side === 'long'
      const exitSide: OrderSide = long ? 'sell' : 'buy'
      const slHit = p.stop !== null && (long ? c.low <= p.stop : c.high >= p.stop)
      const tpHit = p.target !== null && (long ? c.high >= p.target : c.low <= p.target)
      if (slHit) {
        const px = long ? Math.min(c.open, p.stop!) : Math.max(c.open, p.stop!)
        events.push(this.fillEvent(this.execute(exitSide, p.qty, px, 'taker', c.time, 'SL')))
      } else if (tpHit) {
        const px = long ? Math.max(c.open, p.target!) : Math.min(c.open, p.target!)
        events.push(this.fillEvent(this.execute(exitSide, p.qty, px, 'maker', c.time, 'TP')))
      }
    }

    for (const o of this.orders.slice()) {
      if (o.placedAt >= c.time) continue
      const buy = o.side === 'buy'
      let px: number | null = null
      if (o.type === 'limit') {
        if (buy && c.low <= o.price) px = Math.min(c.open, o.price)
        if (!buy && c.high >= o.price) px = Math.max(c.open, o.price)
      } else {
        if (buy && c.high >= o.price) px = Math.max(c.open, o.price)
        if (!buy && c.low <= o.price) px = Math.min(c.open, o.price)
      }
      if (px === null) continue
      this.orders = this.orders.filter((x) => x !== o)
      const err = this.marginError(o.side, o.qty, px)
      if (err) {
        events.push({ kind: 'reject', text: `${o.type} ${o.side} ${fmt(o.qty)} cancelled: ${err}` })
        continue
      }
      const liq: Liquidity = o.type === 'limit' ? 'maker' : 'taker'
      events.push(this.fillEvent(this.execute(o.side, o.qty, px, liq, c.time, o.type === 'limit' ? 'Limit' : 'Stop')))
    }
    this.revision++
    return events
  }

  // ---- orders ----

  /** Market order at the current bar's close, optionally attaching SL/TP to the resulting position. */
  market(side: OrderSide, qty: number, bracket?: Bracket): BrokerResult {
    const bad = this.validate(qty)
    if (bad) return bad
    const px = this.mark
    const err = this.marginError(side, qty, px)
    if (err) return { ok: false, error: `Not enough margin: ${err}` }
    this.execute(side, qty, px, 'taker', this.bar!.time, 'Market')
    if (bracket && this.position) this.setBracket(bracket)
    this.revision++
    return { ok: true }
  }

  /** Working limit or stop order; it can fill from the next bar on. */
  place(side: OrderSide, type: 'limit' | 'stop', qty: number, price: number): BrokerResult {
    const bad = this.validate(qty)
    if (bad) return bad
    if (!(price > 0)) return { ok: false, error: 'Enter a price above 0.' }
    const err = this.marginError(side, qty, price)
    if (err) return { ok: false, error: `Not enough margin: ${err}` }
    this.orders.push({ id: this.nextId++, side, type, qty, price, placedAt: this.bar!.time })
    this.revision++
    return { ok: true }
  }

  cancel(id: number): void {
    this.orders = this.orders.filter((o) => o.id !== id)
    this.revision++
  }

  modifyOrder(id: number, price: number): void {
    const o = this.orders.find((x) => x.id === id)
    if (o && price > 0) {
      o.price = price
      this.revision++
    }
  }

  /** Set or clear the position's SL / TP (undefined leaves a leg unchanged, null clears it). */
  setBracket(b: Bracket): void {
    const p = this.position
    if (!p) return
    if (b.stop !== undefined) p.stop = b.stop !== null && b.stop > 0 ? b.stop : null
    if (b.target !== undefined) p.target = b.target !== null && b.target > 0 ? b.target : null
    if (p.initialStop === null && p.stop !== null) p.initialStop = p.stop
    this.revision++
  }

  /** Flatten at the current bar's close. */
  closePosition(reason = 'Close'): void {
    const p = this.position
    if (!p || !this.bar) return
    this.execute(p.side === 'long' ? 'sell' : 'buy', p.qty, this.mark, 'taker', this.bar.time, reason)
    this.revision++
  }

  /** Flip to the same size on the other side, at the current bar's close. */
  reverse(): BrokerResult {
    const p = this.position
    if (!p) return { ok: false, error: 'No open position.' }
    return this.market(p.side === 'long' ? 'sell' : 'buy', p.qty * 2)
  }

  /** End of session: flatten and cancel everything. */
  closeAll(reason: string): void {
    this.orders = []
    this.closePosition(reason)
    this.revision++
  }

  // ---- internals ----

  private validate(qty: number): { ok: false; error: string } | null {
    if (!this.bar) return { ok: false, error: 'Pick a replay start bar first.' }
    if (!(qty > 0) || !Number.isFinite(qty)) return { ok: false, error: 'Quantity must be more than 0 contracts.' }
    return null
  }

  /** Margin check for the part of an order that opens or adds exposure. */
  private marginError(side: OrderSide, qty: number, price: number): string | null {
    const p = this.position
    const reducing = p && (p.side === 'long') !== (side === 'buy') ? Math.min(qty, p.qty) : 0
    const opening = qty - reducing
    if (opening <= 0) return null
    const need = this.notional(opening, price) / this.leverage + this.fee(qty, price, 'taker')
    const free = this.freeMargin() + (reducing && p ? this.notional(reducing, p.avgPrice) / this.leverage : 0)
    return need > free ? `needs ${need.toFixed(2)}, ${Math.max(0, free).toFixed(2)} free.` : null
  }

  private fillEvent(f: PaperFill): PaperEvent {
    return { kind: 'fill', text: `${f.reason}: ${f.side} ${fmt(f.qty)} @ ${fmt(f.price)}` }
  }

  private execute(side: OrderSide, qty: number, price: number, liq: Liquidity, time: number, reason: string): PaperFill {
    const fee = this.fee(qty, price, liq)
    const fill: PaperFill = { time, side, qty, price, fee, liquidity: liq, reason }
    this.fills.push(fill)
    this.balance -= fee
    this.feesPaid += fee

    let rest = qty
    let restFee = fee
    const p = this.position
    if (p && (p.side === 'long') !== (side === 'buy')) {
      const closeQty = Math.min(qty, p.qty)
      const exitFee = (fee * closeQty) / qty
      const entryFee = (p.entryFees * closeQty) / p.qty
      const pnl = -sign(side) * (price - p.avgPrice) * closeQty * this.contractValue
      this.balance += pnl
      this.trades.push({
        side: p.side,
        entryTime: p.openTime,
        entryPrice: p.avgPrice,
        exitTime: time,
        exitPrice: price,
        exitReason: reason,
        stop: p.initialStop ?? undefined,
        qty: closeQty * this.contractValue,
        fees: entryFee + exitFee,
      })
      p.entryFees -= entryFee
      p.qty -= closeQty
      rest -= closeQty
      restFee -= exitFee
      if (p.qty <= 1e-12) this.position = null
    }
    if (rest > 1e-12) {
      const q = this.position
      if (q) {
        q.avgPrice = (q.avgPrice * q.qty + price * rest) / (q.qty + rest)
        q.qty += rest
        q.entryFees += restFee
      } else {
        this.position = {
          side: side === 'buy' ? 'long' : 'short',
          qty: rest,
          avgPrice: price,
          openTime: time,
          entryFees: restFee,
          stop: null,
          target: null,
          initialStop: null,
        }
      }
    }
    return fill
  }
}
