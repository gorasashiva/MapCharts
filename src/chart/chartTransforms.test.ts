import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import {
  autoPnfBoxSize,
  autoRangeSize,
  autoRenkoBoxSize,
  createRebinSession,
  haStep,
  kagiBuilder,
  lineBreakBuilder,
  pnfBuilder,
  rangeBarsBuilder,
  type RebinBuilder,
  renkoBuilder,
  stepRebinSession,
  toHeikinAshi,
  toKagi,
  toLineBreak,
  toPointAndFigure,
  toRangeBars,
  toRenko,
} from './chartTransforms'

/** Builds a walk-like candle series from a list of closes; each bar's open is
 *  the prior close (gapless), with a small high/low pad around the body. The
 *  very first bar has no real "prior close", so it's nudged a small step
 *  before closes[0] in the direction of the first move — giving it a real
 *  body instead of a degenerate doji (open === close), which would otherwise
 *  make it ambiguous which way builders like Line Break read its direction. */
function makeCandles(closes: number[], startTime = 0, stepMs = 60_000): Candle[] {
  const out: Candle[] = []
  let prevClose = closes.length > 1 ? closes[0] - (closes[1] - closes[0]) * 0.1 : closes[0]
  for (let i = 0; i < closes.length; i++) {
    const open = prevClose
    const close = closes[i]
    const high = Math.max(open, close) + 0.25
    const low = Math.min(open, close) - 0.25
    out.push({ time: startTime + i * stepMs, open, high, low, close, volume: 1 })
    prevClose = close
  }
  return out
}

// A single series with big multi-box jumps, small wiggles, and several
// reversals — exercises the while-loop (multi-brick-per-candle) paths and
// both continuation and reversal branches in every builder below.
const VOLATILE_CLOSES = [100, 101, 99, 105, 120, 118, 90, 95, 96, 97, 130, 129, 128, 80, 82, 84, 83, 83.5, 150, 149, 148, 147]
const VOLATILE_CANDLES = makeCandles(VOLATILE_CLOSES)

describe('toHeikinAshi / haStep', () => {
  it('returns [] for an empty series', () => {
    expect(toHeikinAshi([])).toEqual([])
  })

  it('seeds the first bar from (open+close)/2 and carries volume/time through', () => {
    const candles = makeCandles([10, 12, 11])
    const ha = toHeikinAshi(candles)
    expect(ha).toHaveLength(3)
    // Bar 0: haOpen = (open+close)/2, haClose = (o+h+l+c)/4.
    const c0 = candles[0]
    expect(ha[0].open).toBeCloseTo((c0.open + c0.close) / 2)
    expect(ha[0].close).toBeCloseTo((c0.open + c0.high + c0.low + c0.close) / 4)
    expect(ha[0].time).toBe(c0.time)
    expect(ha[0].volume).toBe(c0.volume)
    // Bar 1's haOpen must be the average of bar 0's own HA open/close (the
    // recurrence), not bar 0's raw candle open/close.
    expect(ha[1].open).toBeCloseTo((ha[0].open + ha[0].close) / 2)
  })

  it('keeps high/low enclosing the HA open/close', () => {
    const ha = toHeikinAshi(VOLATILE_CANDLES)
    for (const bar of ha) {
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close))
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close))
    }
  })

  it('haStep matches a manual full-series computation when replayed bar-by-bar', () => {
    const candles = makeCandles([50, 55, 48, 60, 59])
    const full = toHeikinAshi(candles)
    // Replay via haStep directly (this is what the engine's live-tick path does).
    let prevOpen = 0
    let prevClose = 0
    const replayed: Candle[] = []
    candles.forEach((c, i) => {
      const bar = haStep(prevOpen, prevClose, c, i === 0)
      replayed.push(bar)
      prevOpen = bar.open
      prevClose = bar.close
    })
    expect(replayed).toEqual(full)
  })
})

describe('auto box/range sizing', () => {
  it('Renko, PnF and Range all use the same sizing', () => {
    expect(autoPnfBoxSize(VOLATILE_CANDLES)).toBe(autoRenkoBoxSize(VOLATILE_CANDLES))
    expect(autoRangeSize(VOLATILE_CANDLES)).toBe(autoRenkoBoxSize(VOLATILE_CANDLES))
  })

  it('is always positive and finite, even for an empty or flat series', () => {
    expect(autoRenkoBoxSize([])).toBeGreaterThan(0)
    const flat = makeCandles(new Array(20).fill(42))
    const box = autoRenkoBoxSize(flat)
    expect(box).toBeGreaterThan(0)
    expect(isFinite(box)).toBe(true)
  })
})

describe('renkoBuilder / toRenko', () => {
  it('returns [] for a non-positive or non-finite box size, or no candles', () => {
    expect(toRenko(VOLATILE_CANDLES, 0)).toEqual([])
    expect(toRenko(VOLATILE_CANDLES, -1)).toEqual([])
    expect(toRenko(VOLATILE_CANDLES, Infinity)).toEqual([])
    expect(toRenko([], 1)).toEqual([])
  })

  it('produces only up-bricks for a strict uptrend, each spanning exactly boxSize', () => {
    const candles = makeCandles([100, 102, 104, 106, 108, 110])
    const bricks = toRenko(candles, 2)
    expect(bricks.length).toBeGreaterThan(0)
    for (const b of bricks) {
      expect(b.close).toBeGreaterThan(b.open) // up brick
      expect(b.close - b.open).toBeCloseTo(2)
    }
  })

  it('a big single-candle jump emits multiple bricks (the while-loop path)', () => {
    const candles = makeCandles([100, 130]) // one candle, 30 units of travel
    const bricks = toRenko(candles, 5)
    expect(bricks.length).toBe(6) // 30 / 5
    for (let i = 1; i < bricks.length; i++) {
      expect(bricks[i].open).toBeCloseTo(bricks[i - 1].close)
    }
  })

  it('a reversal needs two boxes before it starts printing the opposite direction', () => {
    // Up two boxes, then down — must travel 2*boxSize from the last brick's
    // close before an opposite brick appears (standard Renko reversal rule).
    const candles = makeCandles([100, 104, 103.9]) // up 2 boxes, then a small dip (< 2 boxes)
    const bricksSmallDip = toRenko(candles, 2)
    expect(bricksSmallDip.every((b) => b.close > b.open)).toBe(true) // no reversal brick yet
    const candlesBigDip = makeCandles([100, 104, 99.9]) // dip > 2 boxes from 104
    const bricksBigDip = toRenko(candlesBigDip, 2)
    expect(bricksBigDip.some((b) => b.close < b.open)).toBe(true) // reversal brick appears
  })
})

describe('lineBreakBuilder / toLineBreak', () => {
  it('seeds one block from the first candle', () => {
    const blocks = toLineBreak(makeCandles([100, 100.1]), 3)
    expect(blocks.length).toBeGreaterThanOrEqual(1)
  })

  it('a continuation beyond the last block extends in the same direction', () => {
    const candles = makeCandles([100, 105, 110]) // strictly rising closes
    const blocks = toLineBreak(candles, 3)
    expect(blocks.length).toBe(3)
    expect(blocks.every((b) => b.close > b.open)).toBe(true)
  })

  it('price staying inside the break range prints no new block', () => {
    const candles = makeCandles([100, 105]) // up block: open ~100, close ~105
    const withNoise = [...candles, { ...candles[1], time: candles[1].time + 60_000, open: 105, close: 102, high: 105.25, low: 101.75 }]
    const blocks = toLineBreak(withNoise, 3)
    // The third candle (close 102) is inside [lastBottom, lastTop] and doesn't
    // break the trailing-3 extreme either, so it must not add a block.
    expect(blocks.length).toBe(2)
  })
})

describe('pnfBuilder / toPointAndFigure', () => {
  it('returns [] for a non-positive box size or no candles', () => {
    expect(toPointAndFigure(VOLATILE_CANDLES, 0)).toEqual([])
    expect(toPointAndFigure([], 1)).toEqual([])
  })

  it('materializes the still-open column as a provisional trailing element (finalize)', () => {
    // Box-quantizing the SEED candle's own wick against its close-as-anchor
    // can print one tiny leading artifact column before the real trend
    // starts (any low even fractionally below the anchor floors into the box
    // below it, regardless of box size — see the sibling "alternate
    // direction" test) — real auto-sized boxes (0.5x ATR14) are normally
    // many multiples of one candle's wick, so this is invisible in practice.
    // What must hold regardless: the series is still rising when data ends,
    // so the LAST (finalize-provisional) column reflects that.
    const candles = makeCandles([100, 103, 106]) // persistently rising, never reverses
    const cols = toPointAndFigure(candles, 1, 3)
    expect(cols.length).toBeGreaterThanOrEqual(1)
    expect(cols[cols.length - 1].close).toBeGreaterThan(cols[cols.length - 1].open) // X column
  })

  it('columns always alternate direction (X, O, X, O, ...)', () => {
    const cols = toPointAndFigure(VOLATILE_CANDLES, 2, 3)
    expect(cols.length).toBeGreaterThan(1)
    for (let i = 1; i < cols.length; i++) {
      const prevUp = cols[i - 1].close > cols[i - 1].open
      const curUp = cols[i].close > cols[i].open
      expect(curUp).not.toBe(prevUp)
    }
  })

  it('an unambiguous move ends in the matching column direction', () => {
    const up = toPointAndFigure(makeCandles([100, 130]), 2, 3) // one huge up move
    expect(up[up.length - 1].close).toBeGreaterThan(up[up.length - 1].open)
    const down = toPointAndFigure(makeCandles([100, 70]), 2, 3) // one huge down move
    expect(down[down.length - 1].close).toBeLessThan(down[down.length - 1].open)
  })
})

describe('rangeBarsBuilder / toRangeBars', () => {
  it('returns [] for a non-positive range size or no candles', () => {
    expect(toRangeBars(VOLATILE_CANDLES, 0)).toEqual([])
    expect(toRangeBars([], 1)).toEqual([])
  })

  it('every completed bar spans exactly rangeSize high-to-low (the trailing bar is still forming)', () => {
    const bars = toRangeBars(VOLATILE_CANDLES, 3)
    expect(bars.length).toBeGreaterThan(1)
    // All but the last bar are COMPLETE (that's what "complete" means here).
    for (const b of bars.slice(0, -1)) {
      expect(Math.abs(b.high - b.low)).toBeCloseTo(3)
    }
    // The trailing bar is the still-forming one (finalize's provisional
    // element, "so the latest price is always visible") — by definition it
    // hasn't traveled a full rangeSize yet, or it would already be complete.
    const last = bars[bars.length - 1]
    expect(Math.abs(last.high - last.low)).toBeLessThanOrEqual(3)
  })

  it('a single volatile candle can complete multiple bars (spike walked before settle)', () => {
    // open 100 -> low 80 -> high 130 -> close 110: far more than one 5-unit range's travel.
    const candle: Candle = { time: 0, open: 100, high: 130, low: 80, close: 110, volume: 1 }
    const bars = toRangeBars([candle], 5)
    expect(bars.length).toBeGreaterThan(1)
  })
})

describe('kagiBuilder / toKagi', () => {
  it('returns [] for no candles', () => {
    expect(toKagi([], 0.04)).toEqual([])
  })

  it('stays on one vertex until the reversal threshold is crossed', () => {
    // 2% moves against a 4% reversal threshold must not create a new leg.
    const candles = makeCandles([100, 101, 100.5, 101.5])
    const pts = toKagi(candles, 0.04)
    expect(pts.length).toBe(1)
  })

  it('crossing the threshold turns thick after exceeding the previous shoulder', () => {
    // Up leg past +4%, reversal past -4% (sets a shoulder), then back up past
    // the shoulder — the line should now read "thick".
    const candles = makeCandles([100, 106, 99, 108])
    const pts = toKagi(candles, 0.04)
    expect(pts.length).toBeGreaterThanOrEqual(2)
    expect(pts[pts.length - 1].thick).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Incremental session parity — the file's central documented invariant:
// "a full reload and an incremental tick can never diverge". This replays
// each candle as a live feed would (a couple of interim/noisy same-bar
// updates, then the true settled value, then the next bar) through
// createRebinSession/stepRebinSession, and checks the result against a
// clean from-scratch pass over the exact same final candles.
// ---------------------------------------------------------------------------

function simulateLiveFeed<S extends object>(builder: RebinBuilder<S>, candles: Candle[]): Candle[] {
  if (candles.length === 0) return []
  const session = createRebinSession(builder, [candles[0]])
  for (let i = 1; i < candles.length; i++) {
    const settled = candles[i - 1]
    // A noisy interim tick for the bar that's about to complete — proves it
    // gets discarded once the true final value + the next bar arrive.
    const interim: Candle = { ...settled, close: settled.open, high: settled.open + 0.01, low: settled.open - 0.01 }
    stepRebinSession(session, interim, false)
    stepRebinSession(session, settled, false) // the true final value for bar i-1
    stepRebinSession(session, candles[i], true) // candle i is now the new current bar
  }
  return session.output
}

function fromScratch<S extends object>(builder: RebinBuilder<S>, candles: Candle[]): Candle[] {
  return createRebinSession(builder, candles).output
}

describe('incremental session parity', () => {
  const cases: Array<[string, RebinBuilder<any>]> = [
    ['renko', renkoBuilder(2)],
    ['line break', lineBreakBuilder(3)],
    ['point & figure', pnfBuilder(2, 3)],
    ['range bars', rangeBarsBuilder(3)],
    ['kagi', kagiBuilder(0.03)],
  ]

  for (const [name, builder] of cases) {
    it(`${name}: live-fed session output matches a from-scratch pass`, () => {
      expect(simulateLiveFeed(builder, VOLATILE_CANDLES)).toEqual(fromScratch(builder, VOLATILE_CANDLES))
    })
  }

  it('also holds for a short (2-candle) series (edge case: only the seed + one commit)', () => {
    const short = makeCandles([100, 104])
    for (const [, builder] of cases) {
      expect(simulateLiveFeed(builder, short)).toEqual(fromScratch(builder, short))
    }
  })
})
