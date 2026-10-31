import type { Theme } from '../core/types'

/** Resolved color palette used by the renderers. */
export interface ChartColors {
  bg: string
  text: string
  mutedText: string
  grid: string
  separator: string
  axisLine: string
  up: string
  down: string
  /** Default series/accent color (line + area chart, new drawings). */
  accent: string
  crosshair: string
  crosshairTagBg: string
  crosshairTagText: string
  /** Dashed guide lines (e.g. RSI 30/70). */
  guide: string
}

export const THEMES: Record<Theme, ChartColors> = {
  dark: {
    bg: '#0a0d13',
    text: '#e6e9ef',
    mutedText: '#8a93a3',
    grid: 'rgba(255, 255, 255, 0.045)',
    separator: 'rgba(255, 255, 255, 0.10)',
    axisLine: 'rgba(255, 255, 255, 0.08)',
    up: '#16c784',
    down: '#ea3943',
    accent: '#4c7dff',
    crosshair: 'rgba(138, 147, 163, 0.85)',
    crosshairTagBg: '#262e3b',
    crosshairTagText: '#e6e9ef',
    guide: 'rgba(138, 147, 163, 0.45)',
  },
  light: {
    bg: '#ffffff',
    text: '#131722',
    mutedText: '#6a6d78',
    grid: 'rgba(0, 0, 0, 0.06)',
    separator: 'rgba(0, 0, 0, 0.14)',
    axisLine: 'rgba(0, 0, 0, 0.14)',
    up: '#089981',
    down: '#f23645',
    accent: '#4c7dff',
    crosshair: 'rgba(105, 109, 120, 0.9)',
    crosshairTagBg: '#5d606b',
    crosshairTagText: '#ffffff',
    guide: 'rgba(120, 123, 134, 0.5)',
  },
}

/**
 * Built-in candle colour pairings. These are deliberately independent from
 * the light/dark canvas themes: a workspace can use any candle treatment on
 * either surface, and the host can still offer a custom pair.
 */
export type BuiltInCandlePaletteId = 'classic' | 'ocean' | 'aurora' | 'ember'
export type CandlePaletteId = BuiltInCandlePaletteId | 'custom'

export interface CandleColorPalette {
  id: BuiltInCandlePaletteId
  label: string
  description: string
  up: string
  down: string
}

/** Four curated, high-contrast candle palettes exposed by the workspace UI. */
export const CANDLE_PALETTES: readonly CandleColorPalette[] = [
  {
    id: 'classic',
    label: 'Classic',
    description: 'Emerald + crimson',
    up: '#16c784',
    down: '#ea3943',
  },
  {
    id: 'ocean',
    label: 'Ocean',
    description: 'Cyan + rose',
    up: '#22d3ee',
    down: '#fb7185',
  },
  {
    id: 'aurora',
    label: 'Aurora',
    description: 'Lime + violet',
    up: '#a3e635',
    down: '#a78bfa',
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Amber + berry',
    up: '#f59e0b',
    down: '#db2777',
  },
]

export const CANDLE_PALETTE_IDS: readonly BuiltInCandlePaletteId[] = CANDLE_PALETTES.map(({ id }) => id)

const CANDLE_PALETTE_BY_ID = new Map(CANDLE_PALETTES.map((palette) => [palette.id, palette]))

/** Return whether a persisted palette id is safe to use. */
export function isCandlePaletteId(value: unknown): value is CandlePaletteId {
  return value === 'custom' || (typeof value === 'string' && CANDLE_PALETTE_BY_ID.has(value as BuiltInCandlePaletteId))
}

/** Resolve a built-in palette, falling back to the stable default for bad data. */
export function getCandlePalette(id: unknown): CandleColorPalette {
  return CANDLE_PALETTE_BY_ID.get(id as BuiltInCandlePaletteId) ?? CANDLE_PALETTE_BY_ID.get('classic')!
}

/** Infer the palette marker used for legacy settings that had only two colours. */
export function inferCandlePalette(up: unknown, down: unknown): CandlePaletteId {
  if (typeof up !== 'string' || typeof down !== 'string') return 'custom'
  const normalizedUp = up.trim().toLowerCase()
  const normalizedDown = down.trim().toLowerCase()
  return CANDLE_PALETTES.find((palette) => palette.up === normalizedUp && palette.down === normalizedDown)?.id ?? 'custom'
}

/** Single font used everywhere on the canvas. */
export const FONT =
  '11px "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

export const SMALL_FONT =
  '10px "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
