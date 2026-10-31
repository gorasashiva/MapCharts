import { describe, expect, it } from 'vitest'
import { LiquidityLevelsModel } from './liquidityLevelsModel'

describe('LiquidityLevelsModel', () => {
  it('keeps only the strongest significant levels on each side', () => {
    const model = new LiquidityLevelsModel()
    model.update({
      bids: [[100, 10], [99, 8], [98, 1], [97, 0.5], [96, 0.2]],
      asks: [[101, 12], [102, 7], [103, 1]],
    }, 1_000)

    const levels = model.getLevels(1_000)
    expect(levels.filter((level) => level.side === 'bid').map((level) => level.price)).toEqual([100, 99])
    expect(levels.filter((level) => level.side === 'ask').map((level) => level.price)).toEqual([101, 102])
  })

  it('smooths reductions and fades removed levels before dropping them', () => {
    const model = new LiquidityLevelsModel()
    model.update({ bids: [[100, 10]], asks: [] }, 1_000)
    model.update({ bids: [[100, 2]], asks: [] }, 1_500)
    expect(model.getLevels(1_500)[0].qty).toBeGreaterThan(2)

    model.update({ bids: [], asks: [] }, 2_000)
    expect(model.getLevels(2_000)[0].fade).toBeLessThan(1)
    model.update({ bids: [], asks: [] }, 4_000)
    expect(model.getLevels(4_000)).toHaveLength(0)
  })

  it('ignores invalid depth and clears state on reset', () => {
    const model = new LiquidityLevelsModel()
    model.update({ bids: [[0, 10], [100, Number.NaN]], asks: [[101, -1]] }, 1_000)
    expect(model.getLevels(1_000)).toHaveLength(0)

    model.update({ bids: [[100, 10]], asks: [] }, 1_500)
    model.reset()
    expect(model.getLevels(1_500)).toHaveLength(0)
  })
})
