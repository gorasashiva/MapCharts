/**
 * Integration Example: OrderFlow Analysis on Chart
 * 
 * This shows how to wire up the OrderFlowOverlay with live trade/candle data
 */

import OrderFlowOverlay from '../src/overlays/orderflow'
import TradeRainOverlay from '../src/overlays/tradeRain'
import type { IChartEngine } from '../src/chart/types'
import type { Candle, TradeEvent } from '../src/index'

/**
 * Example 1: Basic Integration in Chart Pane
 * Add this to your ChartPane constructor after creating the engine
 */
export function setupOrderFlowOverlay(
  canvasContainer: HTMLElement,
  engine: IChartEngine,
  onCandleUpdate?: (candle: Candle) => void,
  onTradeUpdate?: (trade: TradeEvent) => void
) {
  // Initialize OrderFlow overlay with defaults
  const orderflow = new OrderFlowOverlay(canvasContainer, engine, {
    showLevels: true,
    showAbsorption: true,
    showFootprints: true,
    levelPrecision: 100, // Adjust per instrument (100 for BTC, 0.01 for alts)
    maxLevelsDisplay: 10,
    opacityAlpha: 0.15,
  })

  // Start rendering loop
  orderflow.start()

  // Wire up candle stream
  const originalOnCandle = onCandleUpdate
  const handleCandle = (candle: Candle) => {
    orderflow.onCandle(candle)
    originalOnCandle?.(candle)
  }

  // Wire up trade stream
  const originalOnTrade = onTradeUpdate
  const handleTrade = (trade: TradeEvent) => {
    orderflow.onTrade(trade)
    originalOnTrade?.(trade)
  }

  // Return control methods
  return {
    overlay: orderflow,
    handleCandle,
    handleTrade,
    getStats: () => orderflow.getStats(),
    setVisibility: (opts: any) => orderflow.setVisibility(opts),
    destroy: () => orderflow.destroy(),
  }
}

/**
 * Example 2: Full Integration in ChartPane
 * Replace the rain-related code in examples/basic/pane.ts with this:
 */
export function createAnalysisOverlays(
  canvasHost: HTMLElement,
  engine: IChartEngine
) {
  // Create both overlays
  const rain = new TradeRainOverlay(canvasHost, engine)
  const orderflow = new OrderFlowOverlay(canvasHost, engine, {
    showLevels: true,
    showAbsorption: true,
    showFootprints: true,
  })

  rain.start()
  orderflow.start()

  return {
    rain,
    orderflow,
    onCandle: (candle: Candle) => {
      orderflow.onCandle(candle)
    },
    onTrade: (trade: TradeEvent) => {
      rain.addTrade({ timestamp: trade.time, price: trade.price, volume: trade.qty, side: trade.side })
      orderflow.onTrade(trade)
    },
    getAnalysis: () => ({
      levels: orderflow.getStats().levels,
      footprints: orderflow.getStats().footprints,
      institutionalBalance: orderflow.getStats().institutionalBalance,
    }),
    destroy: () => {
      rain.stop()
      orderflow.destroy()
    },
  }
}

/**
 * Example 3: Standalone Usage with Custom Data
 */
export function exampleStandaloneUsage() {
  // Assume you have a container and engine
  const container = document.getElementById('chart-container')!
  const engine = null as any // Your chart engine

  // Initialize
  const overlay = new OrderFlowOverlay(container, engine)
  overlay.start()

  // Simulate trade stream
  const trades: TradeEvent[] = [
    {
      time: Date.now(),
      price: 45000,
      qty: 0.5,
      side: 'buy',
    },
    {
      time: Date.now() + 100,
      price: 45020,
      qty: 1.5,
      side: 'sell',
    },
  ]

  // Simulate candle stream
  const candles: Candle[] = [
    {
      time: Date.now() - 60000,
      open: 44900,
      high: 45100,
      low: 44800,
      close: 45000,
      volume: 100,
    },
  ]

  // Feed data
  for (const trade of trades) {
    overlay.onTrade(trade)
  }

  for (const candle of candles) {
    overlay.onCandle(candle)
  }

  // Read results
  console.log(overlay.getStats())
}
