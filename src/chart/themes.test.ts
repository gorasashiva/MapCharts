import { describe, expect, it } from 'vitest'
import {
  CANDLE_PALETTES,
  CANDLE_PALETTE_IDS,
  getCandlePalette,
  inferCandlePalette,
  isCandlePaletteId,
} from './themes'

describe('candle colour palettes', () => {
  it('exposes four distinct built-in templates', () => {
    expect(CANDLE_PALETTES).toHaveLength(4)
    expect(CANDLE_PALETTE_IDS).toEqual(['classic', 'ocean', 'aurora', 'ember'])
    expect(new Set(CANDLE_PALETTES.map((palette) => `${palette.up}:${palette.down}`)).size).toBe(4)
  })

  it('resolves valid ids and safely falls back for persisted unknown ids', () => {
    expect(getCandlePalette('ocean').id).toBe('ocean')
    expect(getCandlePalette('removed-palette').id).toBe('classic')
    expect(isCandlePaletteId('custom')).toBe(true)
    expect(isCandlePaletteId('removed-palette')).toBe(false)
  })

  it('recognises legacy colour pairs and keeps custom pairs custom', () => {
    const ocean = getCandlePalette('ocean')
    expect(inferCandlePalette(ocean.up.toUpperCase(), ocean.down)).toBe('ocean')
    expect(inferCandlePalette('#123456', '#abcdef')).toBe('custom')
  })
})
