/**
 * Strategy Tester metrics — pure functions over the common StrategyTrade
 * shape, so every strategy (and every future one) gets the same report.
 *
 * Conventions (close to TradingView's Strategy Tester):
 *  - A trade belongs to the selected range when its ENTRY time is inside it.
 *  - Fills: slippage moves both fills against the trade; commission is a % of
 *    traded value on entry and exit, unless the trade carries its own `fees`
 *    (paper trading: maker/taker + GST). Quantity = the trade's own `qty`, else the
 *    Properties quantity.
 *  - Equity is closed-trade equity: initial capital plus each closed trade's
 *    net P&L at its exit time. Max drawdown / run-up are measured on it.
 *  - Sharpe / Sortino are per trade (mean ÷ stdev of each trade's return on
 *    the equity before it), not annualised.
 *  - R multiples need a stop: gross price move ÷ |entry − stop|, before costs.
 *  - Open trades are marked to the last candle close and reported separately.
 */
import type { Candle } from '../core/types'
import type { StrategyProperties, StrategyTrade } from './types'

export interface TradeRow {
  /** 1-based number in entry order within the selection. */
  n: number
  trade: StrategyTrade
  open: boolean
  qty: number
  entryFill: number
  /** Exit fill, or the mark price for an open trade. */
  exitFill: number
  commission: number
  /** Net P&L in quote currency (price × qty), after costs. */
  pnl: number
  /** Net P&L as % of the trade's entry value. */
  pnlPct: number
  /** null when the trade has no stop. */
  r: number | null
  /** Cumulative net P&L of closed trades up to and including this one (null for an open trade). */
  cumPnl: number | null
  /** Max favourable / adverse excursion while in the trade, in quote currency (≥ 0). */
  runUp: number
  drawdown: number
  bars: number
}

export interface SideStats {
  closed: number
  open: number
  openPnl: number
  wins: number
  losses: number
  /** % of closed trades with net P&L > 0; NaN with no closed trades. */
  winRate: number
  netProfit: number
  netPct: number // of initial capital
  grossProfit: number
  grossLoss: number // ≤ 0
  commission: number
  profitFactor: number // NaN = no trades, Infinity = no losses
  avgTrade: number
  avgTradePct: number
  avgWin: number
  avgLoss: number // ≤ 0
  winLossRatio: number
  largestWin: number
  largestLoss: number
  maxConsecWins: number
  maxConsecLosses: number
  avgBars: number
  avgBarsWin: number
  avgBarsLoss: number
  /** null when no closed trade in this group has a stop. */
  netR: number | null
  avgR: number | null
}

export interface EquityPoint {
  time: number
  equity: number
  /** Distance below the running peak (≤ 0). */
  drawdown: number
}

export interface StrategyReport {
  from: number
  to: number
  initialCapital: number
  rows: TradeRow[]
  all: SideStats
  long: SideStats
  short: SideStats
  equity: EquityPoint[]
  maxDrawdown: number // ≤ 0
  maxDrawdownPct: number // ≤ 0, of the peak
  maxRunUp: number // ≥ 0
  maxRunUpPct: number // ≥ 0, of the trough
  sharpe: number | null
  sortino: number | null
  /** Buy & hold over the candles inside the range, % — null without candles there. */
  buyHoldPct: number | null
  /** Buy & hold equity (Properties quantity from the range's first open), for the equity chart. */
  buyHold: { time: number; equity: number }[]
}

export function medianBarMs(candles: Candle[]): number {
  const diffs: number[] = []
  for (let i = Math.max(1, candles.length - 200); i < candles.length; i++) diffs.push(candles[i].time - candles[i - 1].time)
  if (diffs.length === 0) return 60_000
  diffs.sort((a, b) => a - b)
  return diffs[Math.floor(diffs.length / 2)] || 60_000
}

/** First index with candles[i].time >= t. */
export function lowerBound(candles: Candle[], t: number): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].time < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

function excursion(candles: Candle[], t: StrategyTrade, mark: number, until: number, qty: number): { runUp: number; drawdown: number } {
  let hi = Math.max(t.entryPrice, mark)
  let lo = Math.min(t.entryPrice, mark)
  for (let i = lowerBound(candles, t.entryTime); i < candles.length && candles[i].time <= until; i++) {
    if (candles[i].high > hi) hi = candles[i].high
    if (candles[i].low < lo) lo = candles[i].low
  }
  const up = t.side === 'long' ? hi - t.entryPrice : t.entryPrice - lo
  const down = t.side === 'long' ? t.entryPrice - lo : hi - t.entryPrice
  return { runUp: Math.max(0, up) * qty, drawdown: Math.max(0, down) * qty }
}

function sideStats(rows: TradeRow[], initialCapital: number): SideStats {
  const closed = rows.filter((r) => !r.open)
  const open = rows.filter((r) => r.open)
  const wins = closed.filter((r) => r.pnl > 0)
  const losses = closed.filter((r) => r.pnl <= 0)
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
  const avg = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : NaN)
  const grossProfit = sum(wins.map((r) => r.pnl))
  const grossLoss = sum(losses.map((r) => r.pnl))
  const netProfit = grossProfit + grossLoss
  let maxConsecWins = 0
  let maxConsecLosses = 0
  let w = 0
  let l = 0
  for (const r of [...closed].sort((a, b) => (a.trade.exitTime ?? 0) - (b.trade.exitTime ?? 0))) {
    if (r.pnl > 0) {
      w++
      l = 0
    } else {
      l++
      w = 0
    }
    maxConsecWins = Math.max(maxConsecWins, w)
    maxConsecLosses = Math.max(maxConsecLosses, l)
  }
  const withR = closed.filter((r) => r.r !== null)
  const avgWin = avg(wins.map((r) => r.pnl))
  const avgLoss = avg(losses.map((r) => r.pnl))
  return {
    closed: closed.length,
    open: open.length,
    openPnl: sum(open.map((r) => r.pnl)),
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : NaN,
    netProfit,
    netPct: initialCapital > 0 ? (netProfit / initialCapital) * 100 : NaN,
    grossProfit,
    grossLoss,
    commission: sum(closed.map((r) => r.commission)),
    profitFactor: grossLoss < 0 ? grossProfit / -grossLoss : grossProfit > 0 ? Infinity : NaN,
    avgTrade: avg(closed.map((r) => r.pnl)),
    avgTradePct: avg(closed.map((r) => r.pnlPct)),
    avgWin,
    avgLoss,
    winLossRatio: wins.length && losses.length && avgLoss < 0 ? avgWin / -avgLoss : NaN,
    largestWin: wins.length ? Math.max(...wins.map((r) => r.pnl)) : NaN,
    largestLoss: losses.length ? Math.min(...losses.map((r) => r.pnl)) : NaN,
    maxConsecWins,
    maxConsecLosses,
    avgBars: avg(closed.map((r) => r.bars)),
    avgBarsWin: avg(wins.map((r) => r.bars)),
    avgBarsLoss: avg(losses.map((r) => r.bars)),
    netR: withR.length ? sum(withR.map((r) => r.r!)) : null,
    avgR: withR.length ? sum(withR.map((r) => r.r!)) / withR.length : null,
  }
}

export interface ReportInput {
  trades: StrategyTrade[]
  /** The pane's candles, ascending — used for open-trade marks, excursions, bars and buy & hold. */
  candles: Candle[]
  from: number
  to: number
  props: StrategyProperties
}

export function computeReport({ trades, candles, from, to, props }: ReportInput): StrategyReport {
  const barMs = medianBarMs(candles)
  const lastClose = candles.length ? candles[candles.length - 1].close : NaN
  const lastTime = candles.length ? candles[candles.length - 1].time : to
  const selected = trades.filter((t) => t.entryTime >= from && t.entryTime <= to).sort((a, b) => a.entryTime - b.entryTime)

  const rows: TradeRow[] = selected.map((t, i) => {
    const open = t.exitTime === null || t.exitPrice === null
    const dir = t.side === 'long' ? 1 : -1
    const qty = t.qty ?? props.qty
    const entryFill = t.entryPrice + dir * props.slippage
    const mark = open ? (isFinite(lastClose) ? lastClose : t.entryPrice) : t.exitPrice!
    const exitFill = open ? mark : mark - dir * props.slippage
    const fee = props.commissionPct / 100
    const commission = t.fees ?? (Math.abs(entryFill) + (open ? 0 : Math.abs(exitFill))) * qty * fee
    const pnl = dir * (exitFill - entryFill) * qty - commission
    const risk = t.stop !== undefined ? Math.abs(t.entryPrice - t.stop) : 0
    const until = open ? lastTime : t.exitTime!
    const exc = excursion(candles, t, mark, until, qty)
    return {
      n: i + 1,
      trade: t,
      open,
      qty,
      entryFill,
      exitFill,
      commission,
      pnl,
      pnlPct: entryFill !== 0 ? (pnl / (Math.abs(entryFill) * qty)) * 100 : 0,
      r: risk > 0 ? (dir * (mark - t.entryPrice)) / risk : null,
      cumPnl: null,
      runUp: exc.runUp,
      drawdown: exc.drawdown,
      bars: Math.max(0, Math.round((until - t.entryTime) / barMs)),
    }
  })

  // Closed-trade equity curve, in exit order.
  const closed = rows.filter((r) => !r.open).sort((a, b) => a.trade.exitTime! - b.trade.exitTime!)
  const firstCandle = lowerBound(candles, from)
  const startTime = Math.min(
    firstCandle < candles.length ? candles[firstCandle].time : from,
    rows.length ? rows[0].trade.entryTime : Infinity,
  )
  const equity: EquityPoint[] = [{ time: startTime, equity: props.initialCapital, drawdown: 0 }]
  let eq = props.initialCapital
  let peak = eq
  let trough = eq
  let maxDrawdown = 0
  let maxDrawdownPct = 0
  let maxRunUp = 0
  let maxRunUpPct = 0
  let cum = 0
  const tradeReturns: number[] = []
  for (const r of closed) {
    tradeReturns.push(eq !== 0 ? r.pnl / eq : 0)
    eq += r.pnl
    cum += r.pnl
    r.cumPnl = cum
    if (eq > peak) peak = eq
    if (eq < trough) trough = eq
    const dd = eq - peak
    if (dd < maxDrawdown) {
      maxDrawdown = dd
      maxDrawdownPct = peak !== 0 ? (dd / peak) * 100 : 0
    }
    const ru = eq - trough
    if (ru > maxRunUp) {
      maxRunUp = ru
      maxRunUpPct = trough !== 0 ? (ru / trough) * 100 : 0
    }
    equity.push({ time: r.trade.exitTime!, equity: eq, drawdown: dd })
  }

  let sharpe: number | null = null
  let sortino: number | null = null
  if (tradeReturns.length >= 2) {
    const mean = tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length
    const sd = Math.sqrt(tradeReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (tradeReturns.length - 1))
    sharpe = sd > 0 ? mean / sd : null
    const dsd = Math.sqrt(tradeReturns.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / tradeReturns.length)
    sortino = dsd > 0 ? mean / dsd : null
  }

  let buyHoldPct: number | null = null
  const buyHold: { time: number; equity: number }[] = []
  const i0 = firstCandle
  const i1 = Math.min(candles.length, lowerBound(candles, to + 1)) - 1
  if (i0 <= i1 && candles[i0].open > 0) {
    const base = candles[i0].open
    buyHoldPct = ((candles[i1].close - base) / base) * 100
    const step = Math.max(1, Math.floor((i1 - i0 + 1) / 400))
    for (let i = i0; i <= i1; i += step) buyHold.push({ time: candles[i].time, equity: props.initialCapital + (candles[i].close - base) * props.qty })
    if (buyHold[buyHold.length - 1].time !== candles[i1].time) {
      buyHold.push({ time: candles[i1].time, equity: props.initialCapital + (candles[i1].close - base) * props.qty })
    }
  }

  return {
    from,
    to,
    initialCapital: props.initialCapital,
    rows,
    all: sideStats(rows, props.initialCapital),
    long: sideStats(rows.filter((r) => r.trade.side === 'long'), props.initialCapital),
    short: sideStats(rows.filter((r) => r.trade.side === 'short'), props.initialCapital),
    equity,
    maxDrawdown,
    maxDrawdownPct,
    maxRunUp,
    maxRunUpPct,
    sharpe,
    sortino,
    buyHoldPct,
    buyHold,
  }
}

/** CSV of the trades list (one row per trade), for Export. */
export function tradesCsv(report: StrategyReport, strategyName: string, symbol: string): string {
  const iso = (t: number | null): string => (t === null ? '' : new Date(t).toISOString())
  const head = ['#', 'Strategy', 'Symbol', 'Side', 'Entry time', 'Entry price', 'Exit time', 'Exit price', 'Exit reason', 'Qty', 'Commission', 'Net P&L', 'Net P&L %', 'R', 'Cum P&L', 'Run-up', 'Drawdown', 'Bars', 'Open']
  const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const lines = [head.join(',')]
  for (const r of report.rows) {
    const t = r.trade
    lines.push(
      [
        String(r.n), strategyName, symbol, t.side, iso(t.entryTime), String(t.entryPrice), iso(t.exitTime),
        t.exitPrice === null ? '' : String(t.exitPrice), t.exitReason ?? '', String(r.qty), r.commission.toFixed(6),
        r.pnl.toFixed(6), r.pnlPct.toFixed(4), r.r === null ? '' : r.r.toFixed(4), r.cumPnl === null ? '' : r.cumPnl.toFixed(6),
        r.runUp.toFixed(6), r.drawdown.toFixed(6), String(r.bars), r.open ? 'yes' : 'no',
      ]
        .map(esc)
        .join(','),
    )
  }
  return lines.join('\n')
}
