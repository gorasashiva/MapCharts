// Renko Exhaustion Fade — the one Renko rule set that stayed profitable out of
// sample on both XAUTUSD and PAXGUSD (Apr–Oct 2026 research, 1m data, no fees).
//
// Rules, on standard Renko bricks (1 box to continue, 2 boxes to reverse —
// the chart's renkoBuilder, so the bricks are the ones drawn on a Renko chart):
//  - Signal: after a run of >= N same-direction bricks, the first reversal brick.
//  - Entry: in the reversal brick's direction, at the open of the bar AFTER the
//    bar that completed it (no look-ahead; bar replay shows the state at the cursor).
//  - Exit: once a brick closes T boxes in favour (target) or S boxes against
//    (stop), measured from the reversal brick's close; filled at the next bar's open.
//  - Optional weekend rule (gold): no entries on Sat/Sun (UTC) and any open
//    trade is closed at the open of the first weekend bar (≈ Friday close).
//
// Every trade carries both candle times (Strategy Tester, time-axis charts)
// and brick indices (drawing on a Renko chart, whose x axis is bricks).

import type { Candle } from '../core/types'
import { renkoBuilder } from '../chart/chartTransforms'

export interface RenkoFadeOptions {
  /** Box size in price units (> 0). */
  box: number
  /** Minimum same-direction run before a reversal brick is faded. */
  minRun: number
  /** Target, in boxes from the reversal brick's close. */
  targetBoxes: number
  /** Stop, in boxes from the reversal brick's close. */
  stopBoxes: number
  direction: 'both' | 'long' | 'short'
  skipWeekends: boolean
  qty: number
}

export const RENKO_FADE_DEFAULTS: RenkoFadeOptions = {
  box: 4,
  minRun: 8,
  targetBoxes: 2,
  stopBoxes: 3,
  direction: 'both',
  skipWeekends: true,
  qty: 1,
}

export type RenkoFadeExit = 'TP' | 'SL' | 'Weekend'

export interface RenkoFadeTrade {
  dir: 1 | -1
  /** Length of the run that was faded. */
  run: number
  /** Brick that gave the signal (the first reversal brick) and its close. */
  signalBrick: number
  signalTime: number
  signalClose: number
  /** Trigger levels: a brick closing at/through these schedules the exit. */
  target: number
  stop: number
  entryTime: number
  entryPrice: number
  /** Last brick on the chart when the entry filled (where the position line starts). */
  entryBrick: number
  exitTime: number | null
  exitPrice: number | null
  exitBrick: number | null
  exitReason: RenkoFadeExit | null
  /** Price P&L × qty (null while open). */
  pnl: number | null
  qty: number
}

export interface RenkoFadeResult {
  bricks: Candle[]
  trades: RenkoFadeTrade[]
  /** Signal waiting for the next bar's open (shown as "pending" on the right edge). */
  pending: { dir: 1 | -1; ref: number; target: number; stop: number } | null
}

const DAY_MS = 86_400_000
/** Saturday or Sunday in UTC. */
function isWeekend(time: number): boolean {
  const dow = (Math.floor(time / DAY_MS) + 4) % 7 // 1970-01-01 was a Thursday
  return dow === 0 || dow === 6
}

const brickDir = (b: Candle): 1 | -1 => (b.close > b.open ? 1 : -1)

export function computeRenkoFade(candles: Candle[], opts: RenkoFadeOptions): RenkoFadeResult {
  const out: RenkoFadeResult = { bricks: [], trades: [], pending: null }
  const { box, minRun, targetBoxes, stopBoxes, direction, skipWeekends, qty } = opts
  if (candles.length < 2 || !(box > 0) || !isFinite(box)) return out

  const builder = renkoBuilder(box)
  const state = builder.createState(candles[0])
  const bricks = out.bricks

  // Signal state, decided on brick closes.
  let run = 0
  let wantPos: 0 | 1 | -1 = 0 // desired position after the latest brick
  let ref = 0 // reversal brick close the target / stop are measured from
  let sigRun = 0
  let sigBrick = -1
  let sigTime = 0
  // Order for the next bar's open: the desired position at the end of a bar.
  let order: { pos: 0 | 1 | -1; reason: RenkoFadeExit | null } | null = null
  let open: RenkoFadeTrade | null = null

  const allowed = (d: 1 | -1): boolean => direction === 'both' || (direction === 'long' ? d === 1 : d === -1)

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const weekend = skipWeekends && isWeekend(c.time)

    // 1) Fill the previous bar's order at this bar's open.
    if (order) {
      const target = weekend ? 0 : order.pos
      const cur: number = open ? (open as RenkoFadeTrade).dir : 0
      if (target !== cur) {
        if (open) closeTrade(open, c.time, c.open, bricks.length - 1, order.reason ?? 'SL')
        open = null
        if (target !== 0) {
          open = {
            dir: target,
            run: sigRun,
            signalBrick: sigBrick,
            signalTime: sigTime,
            signalClose: ref,
            target: ref + target * targetBoxes * box,
            stop: ref - target * stopBoxes * box,
            entryTime: c.time,
            entryPrice: c.open,
            entryBrick: Math.max(sigBrick, bricks.length - 1),
            exitTime: null,
            exitPrice: null,
            exitBrick: null,
            exitReason: null,
            pnl: null,
            qty,
          }
          out.trades.push(open)
        }
      }
      order = null
    }

    // 2) Weekend: flat at the first weekend bar's open, and no new positions.
    if (weekend) {
      if (open) {
        closeTrade(open, c.time, c.open, bricks.length - 1, 'Weekend')
        open = null
      }
      wantPos = 0
    }

    // 3) Bricks completed by this bar's close.
    const before = bricks.length
    builder.step(state, bricks, c)
    let changed = false
    let reason: RenkoFadeExit | null = null
    for (let j = before; j < bricks.length; j++) {
      const d = brickDir(bricks[j])
      const prevDir = j > 0 ? brickDir(bricks[j - 1]) : 0
      const prevRun = run
      run = j > 0 && d === prevDir ? run + 1 : 1
      if (wantPos !== 0) {
        const moved = ((bricks[j].close - ref) / box) * wantPos
        if (moved >= targetBoxes - 1e-9 || moved <= -stopBoxes + 1e-9) {
          reason = moved > 0 ? 'TP' : 'SL'
          wantPos = 0
          changed = true
        }
        continue
      }
      if (j > 0 && d !== prevDir && prevRun >= minRun && !weekend && allowed(d)) {
        wantPos = d
        ref = bricks[j].close
        sigRun = prevRun
        sigBrick = j
        sigTime = c.time
        reason = null
        changed = true
      }
    }
    if (changed) order = { pos: wantPos, reason }
  }

  if (order && order.pos !== 0 && !open) {
    out.pending = { dir: order.pos, ref, target: ref + order.pos * targetBoxes * box, stop: ref - order.pos * stopBoxes * box }
  }
  return out
}

function closeTrade(t: RenkoFadeTrade, time: number, price: number, brick: number, reason: RenkoFadeExit): void {
  t.exitTime = time
  t.exitPrice = price
  t.exitBrick = Math.max(t.entryBrick, brick)
  t.exitReason = reason
  t.pnl = (price - t.entryPrice) * t.dir * t.qty
}
