import type { IndicatorOutput } from '../indicators/types'

/** The range of finite values in an indicator output over an inclusive index range. */
export interface IndicatorValueRange {
  min: number
  max: number
}

interface BlockIndex {
  values: (number | null)[]
  mins: number[]
  maxs: number[]
}

/**
 * Reusable range queries for indicator auto-scales.
 *
 * Indicator values are already computed before they reach the chart engine, but
 * an auto-fit scale used to scan every visible value on every animation frame.
 * A small block index keeps the exact result while changing a wide viewport
 * query from O(visible bars) to O(blocks + edge values). Short ranges still use
 * a direct scan, so normal zoom levels do not pay an indexing cost.
 */
export class IndicatorRangeCache {
  private indexes = new WeakMap<IndicatorOutput, BlockIndex>()

  clear(): void {
    this.indexes = new WeakMap<IndicatorOutput, BlockIndex>()
  }

  range(output: IndicatorOutput, from: number, to: number): IndicatorValueRange | null {
    const first = Math.max(0, Math.ceil(from))
    const last = Math.min(output.values.length - 1, Math.floor(to))
    if (first > last) return null

    // Avoid building an index for the common case: a normal viewport contains
    // only a few hundred values.
    if (last - first < 128) return scanRange(output.values, first, last)

    let index = this.indexes.get(output)
    if (!index || index.values !== output.values) {
      index = buildIndex(output.values)
      this.indexes.set(output, index)
    }

    let min = Infinity
    let max = -Infinity
    let i = first
    while (i <= last) {
      const block = Math.floor(i / BLOCK_SIZE)
      const blockStart = block * BLOCK_SIZE
      const blockEnd = Math.min(output.values.length - 1, blockStart + BLOCK_SIZE - 1)
      if (i === blockStart && blockEnd <= last) {
        if (index.mins[block] < min) min = index.mins[block]
        if (index.maxs[block] > max) max = index.maxs[block]
        i = blockEnd + 1
        continue
      }
      const v = output.values[i]
      if (v != null && isFinite(v)) {
        if (v < min) min = v
        if (v > max) max = v
      }
      i++
    }
    return isFinite(min) && isFinite(max) ? { min, max } : null
  }
}

const BLOCK_SIZE = 64

function buildIndex(values: (number | null)[]): BlockIndex {
  const count = Math.ceil(values.length / BLOCK_SIZE)
  const mins = new Array<number>(count).fill(Infinity)
  const maxs = new Array<number>(count).fill(-Infinity)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v == null || !isFinite(v)) continue
    const block = Math.floor(i / BLOCK_SIZE)
    if (v < mins[block]) mins[block] = v
    if (v > maxs[block]) maxs[block] = v
  }
  return { values, mins, maxs }
}

function scanRange(values: (number | null)[], from: number, to: number): IndicatorValueRange | null {
  let min = Infinity
  let max = -Infinity
  for (let i = from; i <= to; i++) {
    const v = values[i]
    if (v == null || !isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  return isFinite(min) && isFinite(max) ? { min, max } : null
}
