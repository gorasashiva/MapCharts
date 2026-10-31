// Paper trading on bar replay — TradingView-style order ticket docked right of
// the chart while replay is on, position/order lines on the chart, and a
// session summary when the replay ends.
//
//  - Demo accounts live in this browser (localStorage, no login): each has its
//    own starting capital, leverage, fee schedule (Delta India by default:
//    taker 0.05%, maker 0.02%, +18% GST) and session history. The balance
//    carries over from one replay session to the next.
//  - Quantity is in Delta contracts; the symbol's contract value converts it
//    to base units for notional, fees and P&L.
//  - Fills come from src/paper/broker.ts (no look-ahead). The summary is the
//    Strategy Tester's own computeReport() over the session's trades, and the
//    pane exposes the trades to the Strategy Tester as "Paper trades".

import type { ChartPane } from './pane'
import { el } from './ui'
import type { SymbolInfo } from '../../src/core/types'
import { PaperBroker } from '../../src/paper/broker'
import { DELTA_INDIA_FEES, type OrderSide, type OrderType, type PaperAccount, type PaperEvent, type PaperSessionRecord } from '../../src/paper/types'
import { computeReport, lowerBound, tradesCsv, type StrategyReport } from '../../src/strategy/metrics'
import { DEFAULT_STRATEGY_PROPERTIES } from '../../src/strategy/types'

const STORE_KEY = 'candl.paper.v1'
const MAX_SESSIONS = 50
export const PAPER_SOURCE_ID = 'paper'

interface Store {
  activeId: string
  accounts: PaperAccount[]
}

interface Session {
  pane: ChartPane
  symbol: string
  interval: string
  info: SymbolInfo
  broker: PaperBroker
  /** First replayed bar of the session. */
  from: number
  startBalance: number
}

export interface PaperTradingHost {
  getSymbolInfo(symbol: string): Promise<SymbolInfo>
  /** The dock was shown or hidden — the chart area changed width. */
  onLayout(): void
  openStrategyTester(strategyId: string): void
}

const newId = (): string => Math.random().toString(36).slice(2, 10)

function defaultAccount(name = 'Demo'): PaperAccount {
  return { id: newId(), name, initialCapital: 10_000, balance: 10_000, leverage: 10, fees: { ...DELTA_INDIA_FEES }, sessions: [] }
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as Store
      if (Array.isArray(s.accounts) && s.accounts.length) {
        for (const a of s.accounts) a.fees = { ...DELTA_INDIA_FEES, ...(a.fees ?? {}) }
        if (!s.accounts.some((a) => a.id === s.activeId)) s.activeId = s.accounts[0].id
        return s
      }
    }
  } catch {
    /* corrupt or unavailable storage — start fresh */
  }
  const a = defaultAccount()
  return { activeId: a.id, accounts: [a] }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function money(v: number, signed = false): string {
  if (!isFinite(v)) return '—'
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const sg = v < 0 ? '−' : signed && v > 0 ? '+' : ''
  return `${sg}$${s}`
}
const pct = (v: number | null): string => (v === null || !isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`)
const tone = (v: number): string => (v > 0 ? 'pp-pos' : v < 0 ? 'pp-neg' : '')
const qtyStr = (v: number): string => String(+v.toFixed(8))

function fmtTime(t: number): string {
  const d = new Date(t)
  return `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export class PaperTrading {
  readonly root: HTMLElement
  private readonly host: PaperTradingHost
  private store: Store
  private session: Session | null = null
  private starting: Promise<void> | null = null
  private pane: ChartPane | null = null
  /** Trades of the last finished session, kept in the Strategy Tester until the next one starts. */
  private lastRecord: PaperSessionRecord | null = null
  private sourceRev = 0

  private orderType: OrderType = 'market'
  private renderedRev = -1
  private msgTimer: number | null = null

  // ticket elements
  private readonly acctSel: HTMLSelectElement
  private readonly stats: HTMLElement
  private readonly typeSeg: HTMLElement
  private readonly priceRow: HTMLElement
  private readonly priceInput: HTMLInputElement
  private readonly qtyInput: HTMLInputElement
  private readonly qtyHint: HTMLElement
  private readonly slInput: HTMLInputElement
  private readonly tpInput: HTMLInputElement
  private readonly buyBtn: HTMLButtonElement
  private readonly sellBtn: HTMLButtonElement
  private readonly feeHint: HTMLElement
  private readonly msg: HTMLElement
  private readonly positionBox: HTMLElement
  private readonly ordersBox: HTMLElement
  private readonly sessionBox: HTMLElement

  // chart lines
  private readonly lines: HTMLElement
  private raf = 0
  private drag: { key: string; price: number } | null = null

  constructor(host: PaperTradingHost) {
    this.host = host
    this.store = loadStore()
    this.root = el('aside', { id: 'tv-paper', class: 'hidden', 'aria-label': 'Paper trading' })

    const head = el('div', { class: 'pp-head' })
    head.append(el('span', { class: 'pp-title' }, 'Paper trading'))
    this.acctSel = el('select', { class: 'pp-select', 'aria-label': 'Demo account' })
    this.acctSel.addEventListener('change', () => this.onAccountChange())
    const gear = el('button', { class: 'pp-icon', type: 'button', title: 'Account settings', 'aria-label': 'Account settings' }, '⚙')
    gear.addEventListener('click', () => this.openAccountSettings(this.account()))
    head.append(this.acctSel, gear)

    this.stats = el('div', { class: 'pp-kv' })

    this.typeSeg = el('div', { class: 'pp-seg', role: 'group', 'aria-label': 'Order type' })
    for (const [t, label] of [['market', 'Market'], ['limit', 'Limit'], ['stop', 'Stop']] as [OrderType, string][]) {
      const b = el('button', { type: 'button', 'data-type': t }, label)
      b.addEventListener('click', () => this.setOrderType(t))
      this.typeSeg.append(b)
    }

    this.priceRow = el('label', { class: 'pp-field' })
    this.priceInput = el('input', { type: 'number', step: 'any', class: 'pp-input', id: 'pp-price' })
    this.priceRow.append(el('span', {}, 'Price'), this.priceInput)

    const qtyRow = el('label', { class: 'pp-field' })
    this.qtyInput = el('input', { type: 'number', min: '1', step: '1', value: '1', class: 'pp-input', id: 'pp-qty' })
    qtyRow.append(el('span', {}, 'Quantity (contracts)'), this.qtyInput)
    this.qtyHint = el('div', { class: 'pp-hint' })

    const bracket = el('div', { class: 'pp-row2' })
    const slRow = el('label', { class: 'pp-field' })
    this.slInput = el('input', { type: 'number', step: 'any', class: 'pp-input', id: 'pp-sl', placeholder: 'none' })
    slRow.append(el('span', {}, 'Stop loss'), this.slInput)
    const tpRow = el('label', { class: 'pp-field' })
    this.tpInput = el('input', { type: 'number', step: 'any', class: 'pp-input', id: 'pp-tp', placeholder: 'none' })
    tpRow.append(el('span', {}, 'Take profit'), this.tpInput)
    bracket.append(slRow, tpRow)

    const bs = el('div', { class: 'pp-bs' })
    this.buyBtn = el('button', { type: 'button', class: 'pp-buy' })
    this.sellBtn = el('button', { type: 'button', class: 'pp-sell' })
    this.buyBtn.addEventListener('click', () => this.submit('buy'))
    this.sellBtn.addEventListener('click', () => this.submit('sell'))
    bs.append(this.buyBtn, this.sellBtn)
    this.feeHint = el('div', { class: 'pp-hint' })
    this.msg = el('div', { class: 'pp-msg', role: 'status' })

    for (const i of [this.qtyInput, this.priceInput]) i.addEventListener('input', () => this.renderTicket())

    this.positionBox = el('div', { class: 'pp-section' })
    this.ordersBox = el('div', { class: 'pp-section' })
    this.sessionBox = el('div', { class: 'pp-section' })

    const ticket = el('div', { class: 'pp-ticket' })
    ticket.append(this.typeSeg, this.priceRow, qtyRow, this.qtyHint, bracket, bs, this.feeHint, this.msg)
    const body = el('div', { class: 'pp-body' })
    body.append(this.stats, ticket, this.positionBox, this.ordersBox, this.sessionBox)
    this.root.append(head, body)

    this.lines = el('div', { class: 'pp-lines' })
    this.setOrderType('market')
    this.renderAccounts()
  }

  // ---- replay hooks (called by main.ts) ----

  /** Replay turned on for `pane`: show the dock. A session starts on the first replayed bar. */
  start(pane: ChartPane): void {
    this.pane = pane
    this.root.classList.remove('hidden')
    pane.attachChartOverlay(this.lines)
    if (!this.raf) this.raf = requestAnimationFrame(() => this.positionLines())
    this.render(true)
    this.host.onLayout()
  }

  /** The replay cursor moved: feed every newly revealed bar to the broker. */
  onReplayBar(): void {
    const pane = this.pane
    if (!pane) return
    const c = pane.candles
    if (!c.length) return
    if (!this.session) {
      void this.beginSession(pane)
      return
    }
    const b = this.session.broker
    const last = c[c.length - 1]
    const events: PaperEvent[] = []
    if (!b.bar || last.time <= b.bar.time) {
      b.onBar(last) // rewound before any activity, or the same bar again
      if (!b.hasActivity()) this.session.from = last.time
    } else {
      for (let i = lowerBound(c, b.bar.time + 1); i < c.length; i++) events.push(...b.onBar(c[i]))
    }
    for (const e of events) this.flash(e.text, e.kind === 'fill' ? 'ok' : 'err')
    this.render()
  }

  /** Stepping back or picking a new start would rewrite filled history. */
  canRewind(): boolean {
    return !this.session?.broker.hasActivity()
  }

  /**
   * Replay ended (exit, or the last bar was reached): flatten, save the
   * session to the account, and show the summary when anything was traded.
   */
  endSession(reason: string): void {
    const s = this.session
    this.session = null
    this.starting = null
    if (s && s.broker.hasActivity()) {
      s.broker.closeAll(reason)
      const acct = this.account()
      const rec: PaperSessionRecord = {
        id: newId(),
        symbol: s.symbol,
        interval: s.interval,
        from: s.from,
        to: s.broker.bar?.time ?? s.from,
        startBalance: s.startBalance,
        endBalance: s.broker.balance,
        fees: s.broker.feesPaid,
        trades: s.broker.trades.slice(),
      }
      acct.balance = s.broker.balance
      acct.sessions = [rec, ...acct.sessions].slice(0, MAX_SESSIONS)
      this.save()
      this.lastRecord = rec
      this.sourceRev++
      this.showSummary(rec, s.pane, s.info.pricePrecision)
    }
    this.render(true)
  }

  /** Replay turned off: end the session and hide the dock. */
  stop(): void {
    this.endSession('Replay exit')
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.lines.replaceChildren()
    this.lines.remove()
    this.root.classList.add('hidden')
    this.pane = null
    this.host.onLayout()
  }

  // ---- session ----

  private beginSession(pane: ChartPane): Promise<void> {
    if (this.starting) return this.starting
    const symbol = pane.state.symbol
    const starting: Promise<void> = this.host
      .getSymbolInfo(symbol)
      .catch((): SymbolInfo => ({ symbol, base: symbol, quote: '', pricePrecision: 2 }))
      .then((info) => {
        if (this.starting !== starting || this.pane !== pane || this.session) return
        this.starting = null
        const c = pane.candles
        if (!c.length) return
        const acct = this.account()
        const broker = new PaperBroker({ balance: acct.balance, leverage: acct.leverage, fees: acct.fees, contractValue: info.contractValue ?? 1 })
        broker.onBar(c[c.length - 1])
        this.session = { pane, symbol, interval: pane.state.interval, info, broker, from: c[c.length - 1].time, startBalance: acct.balance }
        this.lastRecord = null
        this.sourceRev++
        pane.paperSource = {
          id: PAPER_SOURCE_ID,
          name: 'Paper trades',
          getStrategyTrades: () => this.session?.broker.snapshotTrades() ?? this.lastRecord?.trades ?? [],
          getRevision: () => this.sourceRev * 1_000_000 + (this.session?.broker.revision ?? 0),
        }
        this.render(true)
      })
    this.starting = starting
    return starting
  }

  private account(): PaperAccount {
    return this.store.accounts.find((a) => a.id === this.store.activeId) ?? this.store.accounts[0]
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.store))
    } catch {
      /* storage unavailable — the account still works for this page load */
    }
  }

  private onAccountChange(): void {
    const v = this.acctSel.value
    if (v === '__new') {
      this.acctSel.value = this.store.activeId
      this.openAccountSettings(null)
      return
    }
    this.switchAccount(v)
  }

  private switchAccount(id: string): void {
    this.store.activeId = id
    this.save()
    // A session that hasn't traded yet restarts on the new account's balance.
    if (this.session && !this.session.broker.hasActivity() && this.pane) {
      this.session = null
      void this.beginSession(this.pane)
    }
    this.render(true)
  }

  // ---- orders ----

  private setOrderType(t: OrderType): void {
    this.orderType = t
    for (const b of Array.from(this.typeSeg.children) as HTMLElement[]) b.classList.toggle('on', b.dataset.type === t)
    this.priceRow.style.display = t === 'market' ? 'none' : ''
    const mark = this.session?.broker.mark
    if (t !== 'market' && mark !== undefined && isFinite(mark)) this.priceInput.value = String(mark)
    this.renderTicket()
  }

  private num(input: HTMLInputElement): number | null {
    const v = parseFloat(input.value)
    return Number.isFinite(v) && v > 0 ? v : null
  }

  private submit(side: OrderSide): void {
    const s = this.session
    if (!s) return this.flash('Pick a replay start bar first.', 'err')
    const qty = this.num(this.qtyInput)
    if (qty === null) return this.flash('Enter a quantity of at least 1 contract.', 'err')
    const b = s.broker
    const stop = this.num(this.slInput)
    const target = this.num(this.tpInput)
    if (this.orderType === 'market') {
      const ref = b.mark
      const long = side === 'buy'
      if (stop !== null && (long ? stop >= ref : stop <= ref)) return this.flash(`Stop loss must be ${long ? 'below' : 'above'} ${ref}.`, 'err')
      if (target !== null && (long ? target <= ref : target >= ref)) return this.flash(`Take profit must be ${long ? 'above' : 'below'} ${ref}.`, 'err')
      // Blank SL/TP fields leave an existing position's bracket as it is.
      const r = b.market(side, qty, { stop: stop ?? undefined, target: target ?? undefined })
      if (!r.ok) return this.flash(r.error, 'err')
      this.flash(`Market ${side} ${qtyStr(qty)} @ ${ref}`, 'ok')
    } else {
      const price = this.num(this.priceInput)
      if (price === null) return this.flash('Enter an order price.', 'err')
      const r = b.place(side, this.orderType, qty, price)
      if (!r.ok) return this.flash(r.error, 'err')
      this.flash(`${this.orderType === 'limit' ? 'Limit' : 'Stop'} ${side} ${qtyStr(qty)} @ ${price} placed`, 'ok')
    }
    this.render()
  }

  /** True while a paper session (bar replay) is open — chart-menu orders are only offered then. */
  get hasSession(): boolean {
    return this.session !== null
  }

  /**
   * Place a limit order from outside the ticket (the chart's right-click menu).
   * Same broker checks as the ticket; the result is also flashed in the ticket.
   */
  placeLimitAt(side: OrderSide, price: number, qty: number): { ok: true } | { ok: false; error: string } {
    const s = this.session
    if (!s) return { ok: false, error: 'Start Replay and pick a start bar to open a paper session first.' }
    if (!(qty >= 1) || !Number.isFinite(price) || price <= 0) return { ok: false, error: 'Invalid order price or quantity.' }
    const r = s.broker.place(side, 'limit', qty, price)
    if (!r.ok) {
      this.flash(r.error, 'err')
      return { ok: false, error: r.error }
    }
    this.flash(`Limit ${side} ${qtyStr(qty)} @ ${price} placed`, 'ok')
    this.render()
    return { ok: true }
  }

  /** Show a short message under the order buttons. */
  flash(text: string, kind: 'ok' | 'err'): void {
    this.msg.textContent = text
    this.msg.className = `pp-msg ${kind === 'ok' ? 'pp-pos' : 'pp-neg'}`
    if (this.msgTimer !== null) clearTimeout(this.msgTimer)
    this.msgTimer = window.setTimeout(() => (this.msg.textContent = ''), 5000)
  }

  // ---- rendering ----

  private renderAccounts(): void {
    this.acctSel.replaceChildren()
    for (const a of this.store.accounts) {
      const o = el('option', { value: a.id })
      o.textContent = a.name
      this.acctSel.append(o)
    }
    this.acctSel.append(el('option', { value: '__new' }, '+ New account…'))
    this.acctSel.value = this.store.activeId
    this.acctSel.disabled = !!this.session?.broker.hasActivity()
    this.acctSel.title = this.acctSel.disabled ? 'Finish this replay session to switch accounts' : ''
  }

  private render(force = false): void {
    const b = this.session?.broker
    const rev = b ? b.revision : -1
    if (!force && rev === this.renderedRev) return
    this.renderedRev = rev
    this.renderAccounts()
    this.renderStats()
    this.renderTicket()
    this.renderPosition()
    this.renderOrders()
    this.renderSessionBox()
  }

  private renderStats(): void {
    const a = this.account()
    const b = this.session?.broker
    const rows: [string, string, string?][] = b
      ? [
          ['Balance', money(b.balance)],
          ['Equity', money(b.equity()), tone(b.equity() - b.balance)],
          ['Unrealized P&amp;L', money(b.unrealized(), true), tone(b.unrealized())],
          [`Margin used (${b.leverage}×)`, money(b.usedMargin())],
          ['Free margin', money(b.freeMargin())],
          ['Fees this session', money(b.feesPaid)],
        ]
      : [
          ['Balance', money(a.balance)],
          ['Starting capital', money(a.initialCapital)],
          ['Leverage', `${a.leverage}×`],
        ]
    this.stats.innerHTML = rows.map(([k, v, cls]) => `<span>${k}</span><span class="${cls ?? ''}">${v}</span>`).join('')
  }

  private renderTicket(): void {
    const s = this.session
    const b = s?.broker
    const qty = this.num(this.qtyInput) ?? 0
    const px = this.orderType === 'market' ? b?.mark ?? NaN : this.num(this.priceInput) ?? b?.mark ?? NaN
    const p = s?.info.pricePrecision ?? 2
    const label = (side: string): string => `${side}<small>${isFinite(px) ? px.toFixed(p) : '—'}</small>`
    this.buyBtn.innerHTML = label('Buy')
    this.sellBtn.innerHTML = label('Sell')
    this.buyBtn.disabled = this.sellBtn.disabled = !b
    if (!b || !s) {
      this.qtyHint.textContent = this.pane ? 'Pick a replay start bar to begin trading.' : ''
      this.feeHint.textContent = ''
      return
    }
    const cv = b.contractValue
    const base = s.info.base || 'units'
    this.qtyHint.textContent =
      cv === 1
        ? `≈ ${money(b.notional(qty, px))} notional`
        : `${qtyStr(qty)} × ${qtyStr(cv)} ${base} = ${qtyStr(qty * cv)} ${base} ≈ ${money(b.notional(qty, px))}`
    const liq = this.orderType === 'limit' ? 'maker' : 'taker'
    const rate = liq === 'maker' ? b.fees.makerPct : b.fees.takerPct
    this.feeHint.textContent = `Est. fee ${money(b.fee(qty, px, liq))} · ${liq} ${rate}% + ${b.fees.gstPct}% GST · margin ${money(b.notional(qty, px) / b.leverage)}`
  }

  private renderPosition(): void {
    const b = this.session?.broker
    const p = b?.position
    this.positionBox.replaceChildren(el('div', { class: 'pp-sec-head' }, 'Position'))
    if (!b || !p) {
      this.positionBox.append(el('div', { class: 'pp-empty' }, 'Flat'))
      return
    }
    const prec = this.session!.info.pricePrecision
    const u = b.unrealized()
    const row = el('div', { class: 'pp-pos-row' })
    row.innerHTML =
      `<span class="pp-pill ${p.side === 'long' ? 'pp-pill-l' : 'pp-pill-s'}">${p.side.toUpperCase()} ${qtyStr(p.qty)}</span>` +
      `<span>@ ${p.avgPrice.toFixed(prec)}</span><span class="${tone(u)}">${money(u, true)}</span>`
    const sltp = el('div', { class: 'pp-hint' }, `SL ${p.stop?.toFixed(prec) ?? '—'} · TP ${p.target?.toFixed(prec) ?? '—'} · drag the line tags on the chart to move them`)
    const actions = el('div', { class: 'pp-actions' })
    const close = el('button', { type: 'button', class: 'pp-btn' }, 'Close')
    close.addEventListener('click', () => {
      b.closePosition()
      this.flash('Position closed', 'ok')
      this.render()
    })
    const rev = el('button', { type: 'button', class: 'pp-btn' }, 'Reverse')
    rev.addEventListener('click', () => {
      const r = b.reverse()
      if (!r.ok) this.flash(r.error, 'err')
      this.render()
    })
    const setBr = el('button', { type: 'button', class: 'pp-btn', title: 'Apply the Stop loss / Take profit fields above to this position (blank clears)' }, 'Set SL/TP')
    setBr.addEventListener('click', () => {
      b.setBracket({ stop: this.num(this.slInput), target: this.num(this.tpInput) })
      this.render()
    })
    actions.append(close, rev, setBr)
    this.positionBox.append(row, sltp, actions)
  }

  private renderOrders(): void {
    const b = this.session?.broker
    this.ordersBox.replaceChildren(el('div', { class: 'pp-sec-head' }, 'Working orders'))
    if (!b || !b.orders.length) {
      this.ordersBox.append(el('div', { class: 'pp-empty' }, 'None'))
      return
    }
    const prec = this.session!.info.pricePrecision
    for (const o of b.orders) {
      const row = el('div', { class: 'pp-order' })
      row.append(
        el('span', { class: `pp-pill ${o.side === 'buy' ? 'pp-pill-l' : 'pp-pill-s'}` }, `${o.side.toUpperCase()} ${o.type === 'limit' ? 'LMT' : 'STP'}`),
        el('span', { class: 'pp-grow' }, `${qtyStr(o.qty)} @ ${o.price.toFixed(prec)}`),
      )
      const x = el('button', { type: 'button', class: 'pp-icon', title: 'Cancel order', 'aria-label': 'Cancel order' }, '✕')
      x.addEventListener('click', () => {
        b.cancel(o.id)
        this.render()
      })
      row.append(x)
      this.ordersBox.append(row)
    }
  }

  private renderSessionBox(): void {
    const s = this.session
    this.sessionBox.replaceChildren(el('div', { class: 'pp-sec-head' }, 'This session'))
    if (!s) {
      const last = this.account().sessions[0]
      const t = el('div', { class: 'pp-empty' })
      t.textContent = last ? `Last session: ${last.symbol} ${money(last.endBalance - last.startBalance, true)}` : 'No trades yet'
      this.sessionBox.append(t)
      return
    }
    const b = s.broker
    const closed = b.trades
    const wins = closed.filter((t) => (t.side === 'long' ? 1 : -1) * (t.exitPrice! - t.entryPrice) * (t.qty ?? 0) - (t.fees ?? 0) > 0).length
    const realized = b.balance - s.startBalance
    const kv = el('div', { class: 'pp-kv' })
    kv.innerHTML =
      `<span>Realized (after fees)</span><span class="${tone(realized)}">${money(realized, true)}</span>` +
      `<span>Closed trades</span><span>${closed.length}</span>` +
      `<span>Win rate</span><span>${closed.length ? ((wins / closed.length) * 100).toFixed(1) + '%' : '—'}</span>`
    const end = el('button', { type: 'button', class: 'pp-btn pp-wide' }, 'End session & summarize')
    end.disabled = !b.hasActivity()
    end.addEventListener('click', () => this.endSession('Session end'))
    this.sessionBox.append(kv, end)
  }

  // ---- chart lines ----

  private positionLines(): void {
    this.raf = requestAnimationFrame(() => this.positionLines())
    const s = this.session
    const pane = this.pane
    const conv = pane?.engine.getMainConverters()
    const rect = pane?.engine.getMainPaneRect()
    this.render() // cheap unless the broker changed
    if (!s || !pane || !conv || !rect) {
      if (this.lines.firstChild) this.lines.replaceChildren()
      return
    }
    const b = s.broker
    const prec = s.info.pricePrecision
    const want: { key: string; price: number; cls: string; text: string; drag?: (p: number) => void }[] = []
    const p = b.position
    if (p) {
      want.push({ key: 'entry', price: p.avgPrice, cls: 'pp-line-entry', text: `${p.side === 'long' ? 'LONG' : 'SHORT'} ${qtyStr(p.qty)}  ${money(b.unrealized(), true)}` })
      if (p.stop !== null) want.push({ key: 'sl', price: p.stop, cls: 'pp-line-sl', text: `SL ${p.stop.toFixed(prec)}`, drag: (v) => b.setBracket({ stop: v }) })
      if (p.target !== null) want.push({ key: 'tp', price: p.target, cls: 'pp-line-tp', text: `TP ${p.target.toFixed(prec)}`, drag: (v) => b.setBracket({ target: v }) })
    }
    for (const o of b.orders) {
      want.push({
        key: `o${o.id}`,
        price: o.price,
        cls: o.side === 'buy' ? 'pp-line-buy' : 'pp-line-sell',
        text: `${o.side.toUpperCase()} ${o.type === 'limit' ? 'LMT' : 'STP'} ${qtyStr(o.qty)} @ ${o.price.toFixed(prec)}`,
        drag: (v) => b.modifyOrder(o.id, v),
      })
    }

    const existing = new Map<string, HTMLElement>()
    for (const n of Array.from(this.lines.children) as HTMLElement[]) existing.set(n.dataset.key!, n)
    for (const w of want) {
      let n = existing.get(w.key)
      existing.delete(w.key)
      if (!n) {
        n = el('div', { 'data-key': w.key })
        n.append(el('span', { class: 'pp-line-tag' }))
        this.lines.append(n)
      }
      const cls = `pp-line ${w.cls}${w.drag ? ' pp-draggable' : ''}`
      if (n.className !== cls) n.className = cls
      const price = this.drag?.key === w.key ? this.drag.price : w.price
      const y = conv.priceToY(price)
      const visible = y >= rect.y && y <= rect.y + rect.height
      Object.assign(n.style, { display: visible ? 'block' : 'none', top: `${y}px`, left: `${rect.x}px`, width: `${rect.width}px` })
      const tag = n.firstChild as HTMLElement
      const text = this.drag?.key === w.key ? `${w.text.split(' ')[0]} ${price.toFixed(prec)}` : w.text
      if (tag.textContent !== text) tag.textContent = text
      if (w.drag) this.bindDrag(tag, w.key, w.drag)
    }
    for (const n of existing.values()) n.remove()
  }

  private bindDrag(tag: HTMLElement, key: string, apply: (p: number) => void): void {
    tag.onpointerdown = (e) => {
      const conv = this.pane?.engine.getMainConverters()
      if (!conv) return
      e.preventDefault()
      e.stopPropagation()
      tag.setPointerCapture(e.pointerId)
      const hostTop = (this.lines.parentElement ?? tag).getBoundingClientRect().top
      const at = (ev: PointerEvent): number => conv.yToPrice(ev.clientY - hostTop)
      this.drag = { key, price: at(e) }
      tag.onpointermove = (ev) => {
        if (this.drag) this.drag.price = at(ev)
      }
      tag.onpointerup = () => {
        tag.onpointermove = null
        tag.onpointerup = null
        const d = this.drag
        this.drag = null
        const prec = this.session?.info.pricePrecision ?? 2
        if (d && d.price > 0) apply(+d.price.toFixed(prec))
        this.render()
      }
    }
  }

  // ---- summary ----

  private showSummary(rec: PaperSessionRecord, pane: ChartPane, prec: number): void {
    const first = rec.trades[0]
    const report: StrategyReport = computeReport({
      trades: rec.trades,
      candles: pane.candles,
      from: rec.from,
      to: rec.to,
      props: { ...DEFAULT_STRATEGY_PROPERTIES, initialCapital: rec.startBalance, qty: first?.qty ?? 1 },
    })
    const a = report.all

    const backdrop = el('div', { class: 'modal-backdrop' })
    const modal = el('div', { class: 'modal pp-summary', role: 'dialog', 'aria-label': 'Replay session summary' })
    const close = (): void => backdrop.remove()
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close()
    })

    const head = el('div', { class: 'pp-sum-head' })
    const title = el('h3', { class: 'modal-title' })
    title.textContent = `Replay session · ${rec.symbol} ${rec.interval}`
    const sub = el('span', { class: 'pp-hint' })
    sub.textContent = `${fmtTime(rec.from)} → ${fmtTime(rec.to)} · ${this.account().name}`
    head.append(title, sub)

    const tiles: [string, string, string?][] = [
      ['Net P&amp;L', money(a.netProfit, true), tone(a.netProfit)],
      ['Return', pct(a.netPct), tone(a.netPct)],
      ['Win rate', isFinite(a.winRate) ? `${a.winRate.toFixed(1)}% · ${a.wins}/${a.closed}` : '—'],
      ['Max drawdown', `${money(report.maxDrawdown)} (${pct(report.maxDrawdownPct)})`, report.maxDrawdown < 0 ? 'pp-neg' : ''],
      ['Profit factor', a.profitFactor === Infinity ? '∞' : isFinite(a.profitFactor) ? a.profitFactor.toFixed(2) : '—'],
      ['Fees paid', money(rec.fees)],
      ['Avg R', a.avgR === null ? '—' : `${a.avgR < 0 ? '−' : ''}${Math.abs(a.avgR).toFixed(2)}R`, tone(a.avgR ?? 0)],
      ['Buy &amp; hold', pct(report.buyHoldPct)],
      ['Avg trade', money(a.avgTrade, true), tone(a.avgTrade)],
      ['Largest win / loss', `${money(a.largestWin)} / ${money(a.largestLoss)}`],
      ['Balance', `${money(rec.startBalance)} → ${money(rec.endBalance)}`],
      ['Long / short trades', `${report.long.closed} / ${report.short.closed}`],
    ]
    const grid = el('div', { class: 'pp-tiles' })
    grid.innerHTML = tiles.map(([k, v, c]) => `<div><span>${k}</span><b class="${c ?? ''}">${v}</b></div>`).join('')

    const eq = el('div', { class: 'pp-eq' })
    eq.innerHTML = equitySvg(report)

    const tbl = el('div', { class: 'pp-trades' })
    const rows = report.rows
      .map((r) => {
        const t = r.trade
        return `<tr><td>${r.n}</td><td class="${t.side === 'long' ? 'pp-pos' : 'pp-neg'}">${t.side}</td><td>${fmtTime(t.entryTime)}</td><td>${t.entryPrice.toFixed(prec)}</td><td>${t.exitTime ? fmtTime(t.exitTime) : '—'}</td><td>${t.exitPrice?.toFixed(prec) ?? '—'}</td><td>${esc(t.exitReason ?? '')}</td><td>${qtyStr(r.qty)}</td><td>${money(r.commission)}</td><td class="${tone(r.pnl)}">${money(r.pnl, true)}</td></tr>`
      })
      .join('')
    tbl.innerHTML = `<table><thead><tr><th>#</th><th>Side</th><th>Entry</th><th>Price</th><th>Exit</th><th>Price</th><th>Reason</th><th>Qty (base)</th><th>Fees</th><th>Net P&amp;L</th></tr></thead><tbody>${rows || '<tr><td colspan="10">No closed trades</td></tr>'}</tbody></table>`

    const foot = el('div', { class: 'pp-sum-foot' })
    const csv = el('button', { type: 'button', class: 'pp-btn' }, 'Export CSV')
    csv.addEventListener('click', () => {
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([tradesCsv(report, 'Paper trades', rec.symbol)], { type: 'text/csv' }))
      link.download = `paper-${rec.symbol}-${new Date(rec.from).toISOString().slice(0, 10)}.csv`
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 1000)
    })
    const tester = el('button', { type: 'button', class: 'pp-btn' }, 'Open in Strategy Tester')
    tester.addEventListener('click', () => {
      close()
      this.host.openStrategyTester(PAPER_SOURCE_ID)
    })
    const done = el('button', { type: 'button', class: 'btn btn-primary' }, 'Done')
    done.addEventListener('click', close)
    foot.append(csv, tester, el('span', { class: 'pp-grow' }), done)

    modal.append(head, grid, eq, tbl, foot)
    backdrop.append(modal)
    document.body.append(backdrop)
    done.focus()
  }

  // ---- accounts ----

  private openAccountSettings(acct: PaperAccount | null): void {
    const isNew = acct === null
    const a = acct ?? defaultAccount(`Demo ${this.store.accounts.length + 1}`)
    const live = !isNew && a.id === this.store.activeId && !!this.session

    const backdrop = el('div', { class: 'modal-backdrop' })
    const modal = el('div', { class: 'modal pp-settings', role: 'dialog', 'aria-label': 'Demo account' })
    const close = (): void => backdrop.remove()
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close()
    })
    modal.append(el('h3', { class: 'modal-title' }, isNew ? 'New demo account' : 'Demo account'))

    const field = (label: string, value: string, attrs: Record<string, string> = {}): HTMLInputElement => {
      const row = el('label', { class: 'field' })
      const input = el('input', { class: 'field-input', ...attrs }) as HTMLInputElement
      input.value = value
      row.append(el('span', { class: 'field-label' }, label), input)
      modal.append(row)
      return input
    }
    const name = field('Name', a.name, { maxlength: '40' })
    const capital = field('Starting capital (USD)', String(a.initialCapital), { type: 'number', min: '1', step: 'any' })
    const lev = field('Leverage (×)', String(a.leverage), { type: 'number', min: '1', max: '200', step: '1' })
    const taker = field('Taker fee %', String(a.fees.takerPct), { type: 'number', min: '0', step: '0.001' })
    const maker = field('Maker fee %', String(a.fees.makerPct), { type: 'number', min: '0', step: '0.001' })
    const gst = field('GST on fees %', String(a.fees.gstPct), { type: 'number', min: '0', step: '0.1' })
    modal.append(
      el(
        'div',
        { class: 'pp-hint' },
        `Defaults are Delta Exchange India futures: taker ${DELTA_INDIA_FEES.takerPct}%, maker ${DELTA_INDIA_FEES.makerPct}%, plus ${DELTA_INDIA_FEES.gstPct}% GST on the fee.${live ? ' Changes apply from the next replay session.' : ''}`,
      ),
    )

    if (!isNew && a.sessions.length) {
      const hist = el('div', { class: 'pp-history' })
      hist.innerHTML =
        '<div class="pp-sec-head">Session history</div>' +
        a.sessions
          .slice(0, 10)
          .map((s) => {
            const d = s.endBalance - s.startBalance
            return `<div><span>${fmtTime(s.from)} · ${esc(s.symbol)} ${esc(s.interval)} · ${s.trades.length} trades</span><span class="${tone(d)}">${money(d, true)}</span></div>`
          })
          .join('')
      modal.append(hist)
    }

    const foot = el('div', { class: 'pp-sum-foot' })
    if (!isNew) {
      const reset = el('button', { type: 'button', class: 'pp-btn' }, 'Reset balance')
      reset.title = live ? 'Finish the replay session first' : 'Set the balance back to the starting capital and clear the session history'
      reset.disabled = live
      reset.addEventListener('click', () => {
        if (!confirm(`Reset "${a.name}" to ${money(a.initialCapital)} and clear its history?`)) return
        a.balance = a.initialCapital
        a.sessions = []
        this.save()
        this.render(true)
        close()
      })
      foot.append(reset)
      if (this.store.accounts.length > 1) {
        const del = el('button', { type: 'button', class: 'pp-btn pp-danger' }, 'Delete')
        del.disabled = live
        del.addEventListener('click', () => {
          if (!confirm(`Delete "${a.name}" and its history?`)) return
          this.store.accounts = this.store.accounts.filter((x) => x.id !== a.id)
          if (this.store.activeId === a.id) this.store.activeId = this.store.accounts[0].id
          this.save()
          this.render(true)
          close()
        })
        foot.append(del)
      }
    }
    const cancel = el('button', { type: 'button', class: 'pp-btn' }, 'Cancel')
    cancel.addEventListener('click', close)
    const ok = el('button', { type: 'button', class: 'btn btn-primary' }, isNew ? 'Create' : 'Save')
    ok.addEventListener('click', () => {
      const n = (i: HTMLInputElement, min: number, fallback: number): number => {
        const v = parseFloat(i.value)
        return Number.isFinite(v) && v >= min ? v : fallback
      }
      const newCapital = n(capital, 1, a.initialCapital)
      // A new account, or one that never traded, starts at the new capital.
      if (isNew || a.sessions.length === 0) a.balance = newCapital
      a.initialCapital = newCapital
      a.name = name.value.trim() || a.name
      a.leverage = Math.round(n(lev, 1, a.leverage))
      a.fees = { takerPct: n(taker, 0, a.fees.takerPct), makerPct: n(maker, 0, a.fees.makerPct), gstPct: n(gst, 0, a.fees.gstPct) }
      if (isNew) this.store.accounts.push(a)
      this.save()
      close()
      if (isNew && !this.session?.broker.hasActivity()) this.switchAccount(a.id)
      else this.render(true)
    })
    foot.append(el('span', { class: 'pp-grow' }), cancel, ok)
    modal.append(foot)
    backdrop.append(modal)
    document.body.append(backdrop)
    name.focus()
  }
}

/** Closed-trade equity curve with the starting balance as a dashed baseline. */
function equitySvg(r: StrategyReport): string {
  const pts = r.equity
  const w = 640
  const h = 120
  if (pts.length < 2) return `<div class="pp-empty">The equity curve appears after the first closed trade.</div>`
  const vals = pts.map((p) => p.equity)
  const lo = Math.min(...vals, r.initialCapital)
  const hi = Math.max(...vals, r.initialCapital)
  const span = hi - lo || 1
  // Equal spacing per point keeps trades closed on the same bar readable.
  const x = (i: number): number => (i / (pts.length - 1)) * w
  const y = (v: number): number => h - 6 - ((v - lo) / span) * (h - 12)
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ')
  const color = vals[vals.length - 1] >= r.initialCapital ? 'var(--up)' : 'var(--down)'
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" aria-label="Equity curve">
    <line x1="0" x2="${w}" y1="${y(r.initialCapital)}" y2="${y(r.initialCapital)}" stroke="var(--border)" stroke-dasharray="4 4"/>
    <polygon points="0,${h} ${line} ${w},${h}" fill="${color}" fill-opacity="0.12"/>
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>
  </svg>`
}
