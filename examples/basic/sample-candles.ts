import type { Candle } from '../../src/core/types'

/**
 * Deterministic synthetic OHLCV (a seeded random walk) — no network, purely so
 * the demo (and a smoke test) has data to render. Replace this with your own
 * feed in a real app.
 */
export function sampleCandles(count = 400, startTime = 1_700_000_000_000): Candle[] {
  let seed = 0x1a2b3c4d
  const rnd = (): number => {
    // LCG — stable across runs so the demo always looks the same.
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const out: Candle[] = []
  let price = 100
  const step = 60_000 // 1-minute bars
  for (let i = 0; i < count; i++) {
    const open = price
    const close = Math.max(1, open + (rnd() - 0.5) * 2)
    const high = Math.max(open, close) + rnd() * 1.5
    const low = Math.min(open, close) - rnd() * 1.5
    out.push({
      time: startTime + i * step,
      open,
      high,
      low,
      close,
      volume: Math.round(100 + rnd() * 900),
    })
    price = close
  }
  return out
}
