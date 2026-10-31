import { describe, expect, it } from 'vitest'
import { IndicatorRangeCache } from './indicatorRanges'
import type { IndicatorOutput } from '../indicators/types'

function output(values: (number | null)[]): IndicatorOutput {
  return { name: 'value', values, color: '#fff' }
}

describe('IndicatorRangeCache', () => {
  it('returns exact extrema across block boundaries and ignores gaps', () => {
    const values = Array.from<unknown, number | null>({ length: 200 }, (_, i) => i - 100)
    values[64] = null
    values[129] = Number.NaN
    const cache = new IndicatorRangeCache()

    expect(cache.range(output(values), 3, 190)).toEqual({ min: -97, max: 90 })
  })

  it('does not retain a stale index when an output array is replaced', () => {
    const values = Array.from({ length: 160 }, () => 1)
    const out = output(values)
    const cache = new IndicatorRangeCache()
    expect(cache.range(out, 0, 159)).toEqual({ min: 1, max: 1 })

    out.values = Array.from({ length: 160 }, () => 7)
    expect(cache.range(out, 0, 159)).toEqual({ min: 7, max: 7 })
  })
})
