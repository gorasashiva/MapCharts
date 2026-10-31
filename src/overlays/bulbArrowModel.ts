// "Bulb and arrow" — port of bulbandarrow.pine. Pure OHLC math, no drawing.
//
// 1. RSI SMA cross: RSI(14) crossing its own SMA(14) → buy / sell arrow.
// 2. Oikio Bulb: an RSI overbought (≥ 65) / oversold (≤ 35) state machine. Each
//    switch from oversold to overbought opens a new swing HIGH marker (and vice
//    versa); while the state holds, the marker is moved to the most extreme bar
//    (Pine's label.set_x / set_y), so every marker ends on its swing's high / low.
//      bulb     RSI(7)  — translucent dot at the swing price
//      arrow    RSI(15) — triangle above / below the swing bar
//      reversal RSI(15) — "Reversal Zone" label + zigzag line to the previous swing
//    (The script's "arrow" and "reversal" machines read the same RSI(15) series,
//    so they produce the same swings; they differ only in how they are drawn.)

export interface BulbBar {
  high: number
  low: number
  close: number
}

export interface BulbArrowOptions {
  rsiLength: number
  smaLength: number
  bulbRsiLength: number
  zoneRsiLength: number
  overbought: number
  oversold: number
}

export const BULB_ARROW_DEFAULTS: BulbArrowOptions = {
  rsiLength: 14,
  smaLength: 14,
  bulbRsiLength: 7,
  zoneRsiLength: 15,
  overbought: 65,
  oversold: 35,
}

/** A swing marker: `dir` 1 = swing high (overbought side), −1 = swing low. */
export interface SwingPoint {
  dir: 1 | -1
  index: number
  price: number
}

export interface BulbArrowResult {
  /** Bar indexes of RSI-over-SMA (buy) / RSI-under-SMA (sell) crosses. */
  buys: number[]
  sells: number[]
  /** RSI(bulbRsiLength) swings — bulbs. */
  bulbs: SwingPoint[]
  /** RSI(zoneRsiLength) swings — arrows, reversal labels and zigzag. */
  zones: SwingPoint[]
}

/** Pine ta.rsi: RMA of gains / losses (seeded with their SMA), NaN until `len` changes exist. */
export function rsi(values: number[], len: number): Float64Array {
  const n = values.length
  const out = new Float64Array(n).fill(NaN)
  let up = 0
  let dn = 0
  for (let i = 1; i < n; i++) {
    const ch = values[i] - values[i - 1]
    const g = Math.max(ch, 0)
    const l = Math.max(-ch, 0)
    if (i <= len) {
      up += g
      dn += l
      if (i < len) continue
      up /= len
      dn /= len
    } else {
      up = (up * (len - 1) + g) / len
      dn = (dn * (len - 1) + l) / len
    }
    out[i] = dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn)
  }
  return out
}

/** Pine ta.sma over a series with leading NaNs (NaN until `len` valid values). */
function sma(values: Float64Array, len: number): Float64Array {
  const n = values.length
  const out = new Float64Array(n).fill(NaN)
  let sum = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(values[i])) continue
    sum += values[i]
    count++
    if (count > len) sum -= values[i - len]
    if (count >= len) out[i] = sum / len
  }
  return out
}

/** The Oikio Bulb state machine for one RSI series. */
export function swings(bars: BulbBar[], r: Float64Array, ob: number, os: number): SwingPoint[] {
  const pts: SwingPoint[] = []
  let state = 0 // 0 = init, 1 = overbought, 2 = oversold
  let hh = bars.length ? bars[0].low : 0
  let ll = bars.length ? bars[0].high : 0
  let hi: SwingPoint | null = null // Pine's labelhh (latest swing-high marker)
  let lo: SwingPoint | null = null // Pine's labelll
  const moveHi = (i: number): void => {
    if (hi) {
      hi.index = i
      hi.price = bars[i].high
    }
  }
  const moveLo = (i: number): void => {
    if (lo) {
      lo.index = i
      lo.price = bars[i].low
    }
  }
  for (let i = 0; i < bars.length; i++) {
    const { high, low } = bars[i]
    const isOb = r[i] >= ob // NaN compares false, like Pine's na
    const isOs = r[i] <= os
    // oversold → overbought (and the reverse) opens a new marker
    if (state === 2 && isOb) {
      hh = high
      hi = { dir: 1, index: i, price: high }
      pts.push(hi)
    }
    if (state === 1 && isOs) {
      ll = low
      lo = { dir: -1, index: i, price: low }
      pts.push(lo)
    }
    if (isOb) {
      if (high >= hh) {
        hh = high
        moveHi(i)
      }
      state = 1
    }
    if (isOs) {
      if (low <= ll) {
        ll = low
        moveLo(i)
      }
      state = 2
    }
    // still in the last state: keep the marker on the extreme
    if (state === 1 && hh <= high) {
      hh = high
      moveHi(i)
    }
    if (state === 2 && ll >= low) {
      ll = low
      moveLo(i)
    }
  }
  return pts
}

export function computeBulbArrow(bars: BulbBar[], o: BulbArrowOptions = BULB_ARROW_DEFAULTS): BulbArrowResult {
  const close = bars.map((b) => b.close)
  const r = rsi(close, o.rsiLength)
  const s = sma(r, o.smaLength)
  const buys: number[] = []
  const sells: number[] = []
  for (let i = 1; i < bars.length; i++) {
    if ([r[i], s[i], r[i - 1], s[i - 1]].some(Number.isNaN)) continue
    if (r[i] > s[i] && r[i - 1] <= s[i - 1]) buys.push(i)
    else if (r[i] < s[i] && r[i - 1] >= s[i - 1]) sells.push(i)
  }
  return {
    buys,
    sells,
    bulbs: swings(bars, rsi(close, o.bulbRsiLength), o.overbought, o.oversold),
    zones: swings(bars, rsi(close, o.zoneRsiLength), o.overbought, o.oversold),
  }
}
