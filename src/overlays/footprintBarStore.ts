// Per-bar order flow the Volume Footprint publishes (footprint.ts → footprintSignalsLayer.ts)
// for other studies to confirm with — MAP V3's trade suggestions read it. Keyed by
// "<symbol>|<interval>"; only bars built from exact trades are in it.

export interface FpBarFlow {
  delta: number
  vol: number
  /** Share of the bar's selling printed in its bottom two rows (absorbed at the low if it closed up). */
  sellLowShare: number
  /** Share of the bar's buying printed in its top two rows. */
  buyHighShare: number
  /** Price per footprint row (row r spans r·rowSize … (r+1)·rowSize). */
  rowSize?: number
  /** Footprint rows of the bar: row index -> [bought, sold] (taker side), from exact trades. */
  rows?: Map<number, [number, number]>
}

const store = new Map<string, Map<number, FpBarFlow>>()

export function publishFootprintBars(key: string, bars: Map<number, FpBarFlow>): void {
  store.set(key, bars)
}

/** bar open time -> flow, or undefined when no footprint has been built for this chart. */
export function footprintBars(key: string): Map<number, FpBarFlow> | undefined {
  return store.get(key)
}
