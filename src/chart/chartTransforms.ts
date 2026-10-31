/**
 * Price-series transforms for the re-binned and derived chart types.
 *
 * Two families live here:
 *  - toHeikinAshi: a 1:1 OHLC smoothing (same bar count as the source, so it
 *    renders on the normal time axis exactly like candles).
 *  - toRenko / toLineBreak / toKagi / toPointAndFigure / toRangeBars:
 *    RE-BINNED series whose element count is independent of time. Each
 *    produces a synthetic `Candle[]` (or a polyline, for Kagi). The engine
 *    draws these on the bar-INDEX axis — one synthetic element per index
 *    slot — and the time axis only approximates: each synthetic bar carries
 *    the `time` of the SOURCE candle that completed it, so crosshair time
 *    labels stay roughly meaningful.
 *
 * All five re-binned transforms are single forward passes over the source
 * candles, expressed as a small `RebinBuilder<S>`: a `step` that folds one
 * candle into a (state, output) pair, plus an optional `finalize` for the
 * types that show a still-forming column/bar as a provisional trailing
 * element (Point & Figure, Range bars). `toX(candles, ...)` is just
 * `runBuilder(xBuilder(...), candles)` — a full pass from scratch.
 *
 * The engine's live-tick path (`createRebinSession` / `stepRebinSession`)
 * reuses the exact same `step`/`finalize` so a full reload and an
 * incremental tick can never diverge: it keeps a "commit point" — the
 * (state, output length) as of just before the CURRENT (possibly still
 * in-progress) source candle — and replays only that one candle from the
 * commit point on every tick. Repeated updates to the same still-forming
 * candle (the common case for a live feed) therefore cost O(one candle),
 * not O(history). The commit point only advances when a genuinely new
 * candle appears.
 */
import type { Candle } from '../core/types'

/**
 * Heikin-Ashi candles, 1:1 with the source. The classic recurrence:
 *   haClose = (o + h + l + c) / 4
 *   haOpen  = (prevHaOpen + prevHaClose) / 2  (seed: (o + c) / 2 for bar 0)
 *   haHigh  = max(h, haOpen, haClose)
 *   haLow   = min(l, haOpen, haClose)
 * Volume/time are carried through unchanged so indicators and the time axis
 * stay aligned bar-for-bar. `haStep` is the per-bar recurrence in isolation
 * (exported so the engine can redo just the last bar on a live tick — the
 * recurrence only ever reads the PREVIOUS bar's open/close, so that's an O(1)
 * update, not a rescan).
 */
export function haStep(prevOpen: number, prevClose: number, c: Candle, isFirst: boolean): Candle {
  const haClose = (c.open + c.high + c.low + c.close) / 4
  const haOpen = isFirst ? (c.open + c.close) / 2 : (prevOpen + prevClose) / 2
  const haHigh = Math.max(c.high, haOpen, haClose)
  const haLow = Math.min(c.low, haOpen, haClose)
  return { time: c.time, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: c.volume, buyVolume: c.buyVolume }
}

export function toHeikinAshi(candles: Candle[]): Candle[] {
  const n = candles.length
  if (n === 0) return []
  const out: Candle[] = new Array(n)
  let prevOpen = (candles[0].open + candles[0].close) / 2
  let prevClose = candles[0].close
  for (let i = 0; i < n; i++) {
    const bar = haStep(prevOpen, prevClose, candles[i], i === 0)
    out[i] = bar
    prevOpen = bar.open
    prevClose = bar.close
  }
  return out
}

/**
 * Simple ATR(period) on close-to-close-aware true range; used to size Renko
 * boxes. Only scans the trailing `period` true ranges (O(period), not O(n)):
 * the full-history fallback (used only if fewer than `period` finite TRs
 * exist at all — degenerate/short series) is computed lazily, so a normal
 * long history never pays for it.
 */
function atr(candles: Candle[], period: number): number {
  const n = candles.length
  if (n === 0) return 0
  let tail = 0
  let taken = 0
  for (let i = n - 1; i >= 1 && taken < period; i--) {
    const c = candles[i]
    const prevClose = candles[i - 1].close
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
    if (isFinite(tr)) {
      tail += tr
      taken++
    }
  }
  if (taken > 0) return tail / taken
  // Lazy fallback: no finite TR found in the tail scan at all (e.g. n < 2, or
  // every candle degenerate) — fall back to the full-history average.
  let sum = 0
  let count = 0
  for (let i = 1; i < n; i++) {
    const c = candles[i]
    const prevClose = candles[i - 1].close
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
    if (isFinite(tr)) {
      sum += tr
      count++
    }
  }
  return count > 0 ? sum / count : 0
}

/**
 * Auto box size for Renko: 0.5 x ATR(14), floored to a small fraction of price
 * so flat/degenerate series still produce a sane, finite box. Never returns 0.
 */
export function autoRenkoBoxSize(candles: Candle[]): number {
  const n = candles.length
  if (n === 0) return 1
  const lastClose = candles[n - 1].close
  const priceFloor = Math.abs(lastClose) * 0.005 || 1 // ~0.5% of price as a safety floor
  const a = atr(candles, 14) * 0.5
  const box = a > 0 ? a : priceFloor
  return box > 0 ? box : priceFloor
}

/**
 * Auto box size for Point & Figure: identical sizing to Renko (0.5 x ATR(14)
 * with a ~0.5% price floor) so the two re-binned price-quantizing types share a
 * consistent scale. Never returns 0.
 */
export function autoPnfBoxSize(candles: Candle[]): number {
  return autoRenkoBoxSize(candles)
}

/**
 * Auto range size for Range bars: same scale as a single Renko box
 * (0.5 x ATR(14) with a ~0.5% price floor). Never returns 0.
 */
export function autoRangeSize(candles: Candle[]): number {
  return autoRenkoBoxSize(candles)
}

/**
 * One forward-pass re-binning algorithm, split into its natural two phases:
 *  - `step` folds one source candle into (state, output), pushing zero or
 *    more COMMITTED synthetic elements (never rewriting already-pushed ones,
 *    except where the algorithm itself always did that — Kagi's live vertex).
 *  - `finalize` (optional) appends/overwrites a single PROVISIONAL trailing
 *    element representing an in-progress column/bar, given the state after
 *    the last `step` and that last source candle. No-op for algorithms with
 *    no such concept (Renko, Line Break, Kagi).
 * `state` must be a flat, JSON-plain object (only primitive fields) — the
 * incremental session snapshots it with a shallow `{...state}` copy.
 */
export interface RebinBuilder<S extends object> {
  createState(seed: Candle): S
  step(state: S, output: Candle[], c: Candle): void
  finalize?(state: S, output: Candle[], last: Candle): void
}

function runBuilder<S extends object>(builder: RebinBuilder<S>, candles: Candle[]): Candle[] {
  const n = candles.length
  if (n === 0) return []
  const output: Candle[] = []
  const state = builder.createState(candles[0])
  for (let i = 0; i < n; i++) builder.step(state, output, candles[i])
  builder.finalize?.(state, output, candles[n - 1])
  return output
}

// ---------------------------------------------------------------------------
// Renko
// ---------------------------------------------------------------------------

interface RenkoState {
  base: number // price anchor of the current brick lattice
  dir: 0 | 1 | -1
}

/**
 * Renko bricks as synthetic candles. Each brick spans exactly `boxSize` in
 * price; up bricks have close > open, down bricks close < open. A reversal
 * needs 2 boxes (standard Renko). `time` on each brick is the source candle's
 * time that produced it.
 */
export function renkoBuilder(boxSize: number): RebinBuilder<RenkoState> {
  return {
    createState(seed) {
      return { base: seed.close, dir: 0 }
    },
    step(state, bricks, c) {
      if (!(boxSize > 0) || !isFinite(boxSize)) return
      const price = c.close
      let { base, dir } = state
      if (dir >= 0) {
        while (price >= base + boxSize) {
          bricks.push({ time: c.time, open: base, high: base + boxSize, low: base, close: base + boxSize, volume: c.volume })
          base += boxSize
          dir = 1
        }
      }
      if (dir <= 0) {
        while (price <= base - boxSize) {
          bricks.push({ time: c.time, open: base, high: base, low: base - boxSize, close: base - boxSize, volume: c.volume })
          base -= boxSize
          dir = -1
        }
      }
      if (dir === 1) {
        while (price <= base - 2 * boxSize) {
          const top = base - boxSize
          bricks.push({ time: c.time, open: top, high: top, low: top - boxSize, close: top - boxSize, volume: c.volume })
          base = top - boxSize
          dir = -1
        }
      } else if (dir === -1) {
        while (price >= base + 2 * boxSize) {
          const bottom = base + boxSize
          bricks.push({ time: c.time, open: bottom, high: bottom + boxSize, low: bottom, close: bottom + boxSize, volume: c.volume })
          base = bottom + boxSize
          dir = 1
        }
      }
      state.base = base
      state.dir = dir
    },
  }
}

export function toRenko(candles: Candle[], boxSize: number): Candle[] {
  if (candles.length === 0 || !(boxSize > 0) || !isFinite(boxSize)) return []
  return runBuilder(renkoBuilder(boxSize), candles)
}

// ---------------------------------------------------------------------------
// Three-Line-Break
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-interface -- LineBreak's
// decisions read the trailing blocks straight out of `output`; it needs no
// scalar state of its own beyond that.
interface LineBreakState {}

/**
 * Three-Line-Break (default lines=3) blocks as synthetic candles. A new block
 * appears when price closes beyond the extreme of the prior `lines` blocks
 * (continuation needs only the last block; a reversal needs to break the
 * extreme of the last `lines` blocks). Up blocks close > open, down close < open.
 */
export function lineBreakBuilder(lines: number): RebinBuilder<LineBreakState> {
  return {
    createState: () => ({}),
    step(_state, blocks, c) {
      const price = c.close
      if (blocks.length === 0) {
        // Seed from the first candle's own open->close direction.
        const up = c.close >= c.open
        const lo = Math.min(c.open, c.close)
        const hi = Math.max(c.open, c.close)
        blocks.push({ time: c.time, open: up ? lo : hi, high: hi, low: lo, close: up ? hi : lo, volume: c.volume })
        return
      }
      const last = blocks[blocks.length - 1]
      const lastUp = last.close >= last.open
      // Extremes over the trailing `lines` blocks (for reversals).
      let hiN = -Infinity
      let loN = Infinity
      const start = Math.max(0, blocks.length - lines)
      for (let k = start; k < blocks.length; k++) {
        hiN = Math.max(hiN, blocks[k].high)
        loN = Math.min(loN, blocks[k].low)
      }
      const lastTop = Math.max(last.open, last.close)
      const lastBottom = Math.min(last.open, last.close)
      if (price > lastTop) {
        blocks.push({ time: c.time, open: lastTop, high: price, low: lastTop, close: price, volume: c.volume })
      } else if (price < lastBottom) {
        blocks.push({ time: c.time, open: lastBottom, high: lastBottom, low: price, close: price, volume: c.volume })
      } else if (lastUp && price < loN) {
        blocks.push({ time: c.time, open: lastBottom, high: lastBottom, low: price, close: price, volume: c.volume })
      } else if (!lastUp && price > hiN) {
        blocks.push({ time: c.time, open: lastTop, high: price, low: lastTop, close: price, volume: c.volume })
      }
      // Otherwise no new block (price stayed inside the break range).
    },
  }
}

export function toLineBreak(candles: Candle[], lines = 3): Candle[] {
  if (candles.length === 0) return []
  return runBuilder(lineBreakBuilder(lines), candles)
}

// ---------------------------------------------------------------------------
// Point & Figure
// ---------------------------------------------------------------------------

interface PnfState {
  anchor: number // box-index lattice anchor (first close)
  dir: 0 | 1 | -1
  top: number // top box index of the CURRENT (possibly still-open) column
  bottom: number
  time: number
}

/**
 * Point & Figure columns as synthetic candles, one element per COLUMN. Each
 * column quantizes price into `boxSize` boxes: an X (rising) column grows up
 * while price keeps making new box highs; an O (falling) column grows down;
 * a `reversal`-box counter-move starts a new column of the opposite kind.
 *
 * Encoded so it slots into the re-binned `Candle[]` pipeline exactly like Renko:
 *   - `open`  = the column's bottom box edge
 *   - `close` = the column's top box edge
 *   - X (up) columns have close > open; O (down) columns have close < open
 *     (a single-box column nudges close/open by `boxSize` to preserve direction)
 *   - `high`/`low` mirror the top/bottom edges; `time` is the source candle's
 *     time that last extended the column.
 * The still-OPEN column (the one being built) is materialized by `finalize`
 * as a provisional trailing element so the live edge stays visible; it gets
 * replaced (not appended twice) on every subsequent tick until it closes.
 */
export function pnfBuilder(boxSize: number, reversal = 3): RebinBuilder<PnfState> {
  const rev = reversal >= 1 ? Math.floor(reversal) : 3
  const boxOf = (anchor: number, price: number): number => Math.floor((price - anchor) / boxSize)
  return {
    createState(seed) {
      const top = boxOf(seed.close, seed.close) // = 0, kept explicit for clarity
      return { anchor: seed.close, dir: 0, top, bottom: top, time: seed.time }
    },
    step(state, cols, c) {
      if (!(boxSize > 0) || !isFinite(boxSize)) return
      const hiBox = boxOf(state.anchor, c.high)
      const loBox = boxOf(state.anchor, c.low)
      if (state.dir === 0) {
        if (hiBox > state.top) {
          state.dir = 1
          state.top = hiBox
          state.time = c.time
        } else if (loBox < state.bottom) {
          state.dir = -1
          state.bottom = loBox
          state.time = c.time
        }
        return
      }
      if (state.dir === 1) {
        if (hiBox > state.top) {
          state.top = hiBox
          state.time = c.time
        } else if (loBox <= state.top - rev) {
          cols.push(materializePnfCol(state.anchor, boxSize, 1, state.top, state.bottom, state.time))
          state.dir = -1
          state.bottom = loBox
          state.top = state.top - 1
          state.time = c.time
        }
      } else {
        if (loBox < state.bottom) {
          state.bottom = loBox
          state.time = c.time
        } else if (hiBox >= state.bottom + rev) {
          cols.push(materializePnfCol(state.anchor, boxSize, -1, state.top, state.bottom, state.time))
          state.dir = 1
          state.top = hiBox
          state.bottom = state.bottom + 1
          state.time = c.time
        }
      }
    },
    finalize(state, cols) {
      if (state.dir !== 0) cols.push(materializePnfCol(state.anchor, boxSize, state.dir, state.top, state.bottom, state.time))
    },
  }
}

function materializePnfCol(anchor: number, boxSize: number, dir: 1 | -1, top: number, bottom: number, time: number): Candle {
  const lo = anchor + bottom * boxSize
  const hi = anchor + (top + 1) * boxSize
  const open = dir === 1 ? lo : hi
  const close = dir === 1 ? hi : lo
  return { time, open, high: hi, low: lo, close, volume: 0 }
}

export function toPointAndFigure(candles: Candle[], boxSize: number, reversal = 3): Candle[] {
  if (candles.length === 0 || !(boxSize > 0) || !isFinite(boxSize)) return []
  return runBuilder(pnfBuilder(boxSize, reversal), candles)
}

// ---------------------------------------------------------------------------
// Range bars
// ---------------------------------------------------------------------------

interface RangeState {
  open: number // open of the forming bar
  lo: number // running low of the forming bar
  hi: number // running high of the forming bar
}

/**
 * Range bars as synthetic candles: a new bar completes each time price travels a
 * fixed `rangeSize` from the forming bar's OPEN. Each completed bar spans exactly
 * `rangeSize` high-to-low and closes at the breakout edge (top for an up move,
 * bottom for a down move); the next bar opens there. `time` is the source
 * candle's time that completed it. The still-forming bar is materialized by
 * `finalize` with its running extremes so the latest price is always visible.
 *
 * Intra-candle price is modelled as a monotone walk from the candle's open
 * toward its close, touching the far extreme first (low before close on an up
 * candle, high before close on a down candle). This makes the bar count strictly
 * bounded — every completed bar consumes >= `rangeSize` of one-directional travel.
 */
export function rangeBarsBuilder(rangeSize: number): RebinBuilder<RangeState> {
  const push = (state: RangeState, bars: Candle[], price: number, t: number, vol: number): void => {
    if (price > state.hi) state.hi = price
    if (price < state.lo) state.lo = price
    while (price - state.lo >= rangeSize) {
      const top = state.lo + rangeSize
      bars.push({ time: t, open: state.lo, high: top, low: state.lo, close: top, volume: vol })
      state.open = top
      state.lo = top
      state.hi = price > top ? price : top
    }
    while (state.hi - price >= rangeSize) {
      const bottom = state.hi - rangeSize
      bars.push({ time: t, open: state.hi, high: state.hi, low: bottom, close: bottom, volume: vol })
      state.open = bottom
      state.hi = bottom
      state.lo = price < bottom ? price : bottom
    }
  }
  return {
    createState(seed) {
      return { open: seed.open, lo: seed.open, hi: seed.open }
    },
    step(state, bars, c) {
      if (!(rangeSize > 0) || !isFinite(rangeSize)) return
      const upCandle = c.close >= c.open
      // Walk open -> far extreme -> close so a single candle can complete
      // multiple bars in the realistic order (the spike before the settle).
      push(state, bars, c.open, c.time, c.volume)
      push(state, bars, upCandle ? c.low : c.high, c.time, c.volume)
      push(state, bars, upCandle ? c.high : c.low, c.time, c.volume)
      push(state, bars, c.close, c.time, c.volume)
    },
    finalize(state, bars, last) {
      if (state.hi > state.lo || bars.length === 0) {
        const up = last.close >= state.open
        bars.push({ time: last.time, open: state.open, high: state.hi, low: state.lo, close: up ? state.hi : state.lo, volume: last.volume })
      }
    },
  }
}

export function toRangeBars(candles: Candle[], rangeSize: number): Candle[] {
  if (candles.length === 0 || !(rangeSize > 0) || !isFinite(rangeSize)) return []
  return runBuilder(rangeBarsBuilder(rangeSize), candles)
}

// ---------------------------------------------------------------------------
// Kagi
// ---------------------------------------------------------------------------

/** One Kagi vertex: a price turning point plus whether the segment INTO it is "thick" (yang). */
export interface KagiPoint {
  /** Approximate source time of the candle that formed this vertex. */
  time: number
  price: number
  /** Thick (above the prior shoulder) vs thin line for the segment ending here. */
  thick: boolean
}

interface KagiState {
  dir: 0 | 1 | -1
  extreme: number // running high (rising) or low (falling) of the current leg
  prevShoulder: number
  prevWaist: number
  thick: boolean
}

/**
 * Kagi line vertices. The line continues in its current direction while price
 * extends the running extreme, and only reverses after a counter-move of at
 * least `reversalPct` (fraction, e.g. 0.04 = 4%) from that extreme — at which
 * point a new vertex (a "shoulder" at a top, a "waist" at a bottom) is fixed.
 *
 * Thickness (yang/yin): the line turns THICK once price rises above the
 * PREVIOUS shoulder (the prior up-leg's high) and THIN once it falls below the
 * PREVIOUS waist (the prior down-leg's low); otherwise it keeps its thickness.
 * `KagiPoint[]` doubles as the builder's `Candle[]`-shaped output slot even
 * though the elements aren't candles — `RebinBuilder` only requires push/
 * length/index access, which a plain array gives either way. The engine casts
 * at the one call site that needs it (`createRebinSession` for chart type
 * `'kagi'`), same as the pre-incremental code already did.
 */
export function kagiBuilder(reversalPct: number): RebinBuilder<KagiState> {
  const pct = reversalPct > 0 && isFinite(reversalPct) ? reversalPct : 0.04
  const sync = (state: KagiState, pts: KagiPoint[], time: number): void => {
    if (state.extreme >= state.prevShoulder) state.thick = true
    else if (state.extreme <= state.prevWaist) state.thick = false
    pts[pts.length - 1] = { time, price: state.extreme, thick: state.thick }
  }
  return {
    createState(seed) {
      return { dir: 0, extreme: seed.close, prevShoulder: Infinity, prevWaist: -Infinity, thick: true }
    },
    step(state, ptsRaw, c) {
      const pts = ptsRaw as unknown as KagiPoint[]
      if (pts.length === 0) {
        pts.push({ time: c.time, price: c.close, thick: state.thick })
        return
      }
      const price = c.close
      if (state.dir === 0) {
        if (price >= state.extreme * (1 + pct)) {
          state.dir = 1
          state.extreme = price
        } else if (price <= state.extreme * (1 - pct)) {
          state.dir = -1
          state.extreme = price
        } else {
          return
        }
        pts.push({ time: c.time, price: state.extreme, thick: state.thick })
        sync(state, pts, c.time)
      } else if (state.dir === 1) {
        if (price > state.extreme) {
          state.extreme = price
          sync(state, pts, c.time)
        } else if (price <= state.extreme * (1 - pct)) {
          state.prevShoulder = state.extreme
          state.extreme = price
          state.dir = -1
          pts.push({ time: c.time, price: state.extreme, thick: state.thick })
          sync(state, pts, c.time)
        }
      } else {
        if (price < state.extreme) {
          state.extreme = price
          sync(state, pts, c.time)
        } else if (price >= state.extreme * (1 + pct)) {
          state.prevWaist = state.extreme
          state.extreme = price
          state.dir = 1
          pts.push({ time: c.time, price: state.extreme, thick: state.thick })
          sync(state, pts, c.time)
        }
      }
    },
  }
}

export function toKagi(candles: Candle[], reversalPct: number): KagiPoint[] {
  if (candles.length === 0) return []
  return runBuilder(kagiBuilder(reversalPct), candles) as unknown as KagiPoint[]
}

// ---------------------------------------------------------------------------
// Incremental session (engine-facing): live-tick re-binning without a full
// history rescan. See the file-level doc comment for the "commit point" design.
// ---------------------------------------------------------------------------

export interface RebinSession<S extends object> {
  builder: RebinBuilder<S>
  output: Candle[]
  /** state as of right after the last-committed candle's `step` (pre-finalize). */
  state: S
  /** (state, output.length) as of BEFORE the current source candle — i.e. the
   *  point a same-candle interim tick replays from. */
  commitState: S
  commitLen: number
  /** (state, output.length) as of right after the current source candle's
   *  `step` but before `finalize` — becomes the next commit point once a
   *  genuinely new candle arrives. */
  postStepState: S
  postStepLen: number
  lastTime: number
}

/** Full pass from scratch, but leaves the commit point one candle short of the
 *  end so a follow-up `stepRebinSession` can redo just the last candle. */
export function createRebinSession<S extends object>(builder: RebinBuilder<S>, candles: Candle[]): RebinSession<S> {
  const n = candles.length
  const output: Candle[] = []
  const state = builder.createState(candles[0])
  for (let i = 0; i < n - 1; i++) builder.step(state, output, candles[i])
  const commitState = { ...state }
  const commitLen = output.length
  builder.step(state, output, candles[n - 1])
  const postStepState = { ...state }
  const postStepLen = output.length
  builder.finalize?.(state, output, candles[n - 1])
  return { builder, output, state, commitState, commitLen, postStepState, postStepLen, lastTime: candles[n - 1].time }
}

/**
 * Apply one live candle update to an existing session. `isNewBar` must be
 * true only when this candle is a genuinely new bar (later time than the
 * previous last candle) — an interim update to the still-forming bar (same
 * time) must pass `false`, which replays from the commit point instead of
 * advancing it, so a burst of price ticks on one bar costs O(one candle)
 * each, not O(history).
 */
export function stepRebinSession<S extends object>(session: RebinSession<S>, candle: Candle, isNewBar: boolean): void {
  if (isNewBar) {
    session.commitState = session.postStepState
    session.commitLen = session.postStepLen
  }
  session.state = { ...session.commitState }
  session.output.length = session.commitLen
  session.builder.step(session.state, session.output, candle)
  session.postStepState = { ...session.state }
  session.postStepLen = session.output.length
  session.builder.finalize?.(session.state, session.output, candle)
  session.lastTime = candle.time
}
