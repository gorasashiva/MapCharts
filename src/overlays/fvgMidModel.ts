/**
 * FVG Midpoints — port of "FVG-mid.pine" (FVG Midpoints, Clean & Stable).
 *
 *   bullish FVG at bar i: low[i] > high[i-2], midpoint (low[i] + high[i-2]) / 2
 *   bearish FVG at bar i: high[i] < low[i-2], midpoint (high[i] + low[i-2]) / 2
 *
 * Each midpoint is a line from its bar, `extendBars` long (the chart side).
 * With removeOnMitigation, the first bar whose range touches the price
 * (including the bar it formed on, as in Pine) removes it. At most `maxLines`
 * per side are kept; the oldest goes first. Pine shows only what survives at
 * the last bar; `mitigatedAt` / `droppedAt` keep when each one went, so the
 * chart can optionally show those too.
 *
 * Pure — no DOM / engine. Bar i uses bars <= i only.
 */

export interface FvgBar {
  high: number
  low: number
}

export interface FvgMidOptions {
  bullish: boolean
  bearish: boolean
  maxLines: number
  removeOnMitigation: boolean
}

export const FVG_MID_DEFAULTS: FvgMidOptions = {
  bullish: true,
  bearish: true,
  maxLines: 200,
  removeOnMitigation: true,
}

export interface FvgMid {
  /** Bar the gap completed on. */
  index: number
  price: number
  side: 1 | -1
  /** Bar whose range first touched the midpoint (null = untouched so far, or mitigation off). */
  mitigatedAt: number | null
  /** Pushed out by the maxLines cap at this bar (Pine deletes it). */
  droppedAt: number | null
}

export interface FvgMidResult {
  /** Every midpoint ever formed, oldest first. */
  all: FvgMid[]
  /** Pine's on-chart set at the last bar: neither mitigated nor dropped. */
  active: FvgMid[]
}

export function computeFvgMid(bars: FvgBar[], opts: Partial<FvgMidOptions> = {}): FvgMidResult {
  const o: FvgMidOptions = { ...FVG_MID_DEFAULTS, ...opts }
  const all: FvgMid[] = []
  // live lines per side, newest first (Pine's unshift / pop)
  const live: Record<1 | -1, FvgMid[]> = { 1: [], [-1]: [] }
  const cap = Math.max(1, Math.round(o.maxLines))
  const add = (m: FvgMid, i: number): void => {
    all.push(m)
    const arr = live[m.side]
    arr.unshift(m)
    if (arr.length > cap) (arr.pop() as FvgMid).droppedAt = i
  }

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    if (i >= 2) {
      if (o.bullish && b.low > bars[i - 2].high) add({ index: i, price: (b.low + bars[i - 2].high) / 2, side: 1, mitigatedAt: null, droppedAt: null }, i)
      if (o.bearish && b.high < bars[i - 2].low) add({ index: i, price: (b.high + bars[i - 2].low) / 2, side: -1, mitigatedAt: null, droppedAt: null }, i)
    }
    if (o.removeOnMitigation) {
      for (const side of [1, -1] as const) {
        const arr = live[side]
        for (let k = arr.length - 1; k >= 0; k--) {
          if (b.low <= arr[k].price && b.high >= arr[k].price) {
            arr[k].mitigatedAt = i
            arr.splice(k, 1)
          }
        }
      }
    }
  }
  return { all, active: [...live[1], ...live[-1]].sort((a, b) => a.index - b.index) }
}
