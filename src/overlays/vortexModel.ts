// Vortex Indicator — port of vortexindicator.txt. Pure OHLC math, no drawing.
//
//   VI+ = Σ|high − low[1]| / Σ true range
//   VI− = Σ|low − high[1]| / Σ true range
// both summed over the last `length` bars. Values are null until a full window exists.

export interface VortexBar {
  high: number
  low: number
  close: number
}

export function computeVortex(bars: VortexBar[], length: number): { plus: (number | null)[]; minus: (number | null)[] } {
  const n = bars.length
  const plus: (number | null)[] = new Array(n).fill(null)
  const minus: (number | null)[] = new Array(n).fill(null)
  let sp = 0
  let sm = 0
  let st = 0
  for (let i = 1; i < n; i++) {
    const b = bars[i]
    const p = bars[i - 1]
    sp += Math.abs(b.high - p.low)
    sm += Math.abs(b.low - p.high)
    st += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close))
    if (i > length) {
      // drop the bar that left the window
      const o = bars[i - length]
      const op = bars[i - length - 1]
      sp -= Math.abs(o.high - op.low)
      sm -= Math.abs(o.low - op.high)
      st -= Math.max(o.high - o.low, Math.abs(o.high - op.close), Math.abs(o.low - op.close))
    }
    if (i >= length && st > 0) {
      plus[i] = sp / st
      minus[i] = sm / st
    }
  }
  return { plus, minus }
}
