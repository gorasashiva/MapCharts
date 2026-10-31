/**
 * ORDER FLOW OVERLAY — Visual Reference & Configuration
 */

// ============================================================================
// WHAT YOU'LL SEE ON THE CHART
// ============================================================================

/*
┌─ Support/Resistance Levels (showLevels: true) ─────────────────────────────
│
│  Price ─────────────────────────────────────────── S 45000 (85%)
│         (blue dashed line with label)
│         • Blue = Support
│         • Red = Resistance
│         • Strength 0-100% in label
│         • Thicker line = stronger level
│
│  Price ─────────────────────────────────────────── R 46200 (72%)
│
├─ Absorption Heatmap (showAbsorption: true) ───────────────────────────────
│
│  Small colored bars on left edge:
│         • Green = Buy absorption (buyers absorbed at this level)
│         • Red = Sell absorption (sellers absorbed)
│         • Opacity = absorption strength
│
├─ Institutional Footprints (showFootprints: true) ────────────────────────
│
│  Colored circles on right edge (near price axis):
│         • ▲ Green circle = Institutional BUY
│         • ▼ Pink circle = Institutional SELL
│         • Circle size = confidence (3-6px)
│         • Upper right corner = most recent
│
└─ Configuration Properties ──────────────────────────────────────────────────

  showLevels: boolean              (default: true)
    → Display support/resistance level lines

  showAbsorption: boolean          (default: true)
    → Display absorption heatmap on left

  showFootprints: boolean          (default: true)
    → Display institutional footprints on right

  levelPrecision: number           (default: 100)
    → Price quantization for levels
    → 100 = $100 levels (BTC), 0.01 = $0.01 levels (alt coins)
    → Lower = more sensitive, more levels

  maxLevelsDisplay: number         (default: 10)
    → Maximum number of levels to render
    → Limits draw calls for performance

  opacityAlpha: number             (default: 0.15)
    → Global opacity for overlay elements
    → 0-1 range
*/

// ============================================================================
// QUICK START: THREE WAYS TO INTEGRATE
// ============================================================================

// METHOD 1: Basic (Recommended for starting)
import OrderFlowOverlay from '@src/overlays/orderflow'

const overlay = new OrderFlowOverlay(containerElement, chartEngine)
overlay.start()

// Feed data
provider.subscribeCandles(symbol, interval, candle => overlay.onCandle(candle))
provider.subscribeTrades(symbol, trade => overlay.onTrade(trade))

// ────────────────────────────────────────────────────────────────────────────

// METHOD 2: Custom Configuration
const overlay = new OrderFlowOverlay(containerElement, chartEngine, {
  showLevels: true,
  showAbsorption: true,
  showFootprints: true,
  levelPrecision: 0.01,        // For altcoins with small prices
  maxLevelsDisplay: 15,         // Show more levels
  opacityAlpha: 0.25,           // More visible
})

// ────────────────────────────────────────────────────────────────────────────

// METHOD 3: Toggle Components at Runtime
overlay.setVisibility({
  showLevels: true,
  showAbsorption: false,       // Hide absorption temporarily
  showFootprints: true,
})

// ============================================================================
// READING THE ANALYSIS
// ============================================================================

const stats = overlay.getStats()

console.log(stats)
// {
//   levels: {
//     totalLevels: 8,
//     supportCount: 4,
//     resistanceCount: 4,
//     avgStrength: 0.65,
//     totalAbsorptionEvents: 23,
//     totalTouches: 142
//   },
//   footprints: 15,                          // Count of institutional trades
//   institutionalBalance: 0.35,              // -1 to +1, positive = more buy
//   confidence: 0.68                         // 0-1, average confidence
// }

// ════════════════════════════════════════════════════════════════════════════
// INTERPRETATION GUIDE
// ════════════════════════════════════════════════════════════════════════════

// Support/Resistance Strength (0-1)
  0.2-0.4   → Weak, forming
  0.4-0.6   → Moderate, established
  0.6-0.8   → Strong, well-tested
  0.8-1.0   → Very strong, institutional

// Absorption Events
  • High count at a level = many traders fought there
  • Indicates significant order activity
  • Combined with volume = institutional participation

// Institutional Balance
  +1.0  → 100% institutional BUYs (very bullish)
  +0.5  → 50% more buys than sells (bullish)
   0.0  → Balanced (neutral)
  -0.5  → 50% more sells than buys (bearish)
  -1.0  → 100% institutional SELLs (very bearish)

// Confidence Score
  0.0-0.3  → Low certainty
  0.3-0.6  → Moderate signals
  0.6-1.0  → High institutional presence

// ============================================================================
// TAILORING FOR DIFFERENT INSTRUMENTS
// ============================================================================

// BTC (Large, round prices)
new OrderFlowOverlay(container, engine, {
  levelPrecision: 100,        // $100 levels
  maxLevelsDisplay: 8,
})

// Altcoins (Small prices like $0.50-$5)
new OrderFlowOverlay(container, engine, {
  levelPrecision: 0.01,       // $0.01 levels
  maxLevelsDisplay: 15,
})

// Small caps (Micro prices like $0.001)
new OrderFlowOverlay(container, engine, {
  levelPrecision: 0.0001,     // $0.0001 levels
  maxLevelsDisplay: 20,
})

// High volume (1-min, very noisy)
new OrderFlowOverlay(container, engine, {
  levelPrecision: 50,         // Fewer, larger levels
  maxLevelsDisplay: 5,
  opacityAlpha: 0.25,         // More visible
})

// ============================================================================
// PERFORMANCE TIPS
// ============================================================================

// Disable unused components to reduce CPU:
overlay.setVisibility({
  showLevels: false,      // If already tracking in indicators
  showAbsorption: false,  // Can be noisy
  showFootprints: true,   // Most useful
})

// Adjust for high-frequency data (scalping):
new OrderFlowOverlay(container, engine, {
  levelPrecision: 50,     // Fewer levels = less recalc
  maxLevelsDisplay: 5,    // Render only top 5
})

// ============================================================================
// KEYBOARD SHORTCUTS / UI CONTROLS (Optional)
// ============================================================================

// Toggle each component programmatically:
const components = {
  levels: true,
  absorption: true,
  footprints: true,
}

document.addEventListener('keydown', e => {
  if (e.key === 'L') {
    components.levels = !components.levels
    overlay.setVisibility(components)
  }
  if (e.key === 'A') {
    components.absorption = !components.absorption
    overlay.setVisibility(components)
  }
  if (e.key === 'I') {
    components.footprints = !components.footprints
    overlay.setVisibility(components)
  }
})

// ============================================================================
// COMBINING WITH TRADE RAIN
// ============================================================================

// Use both overlays together for complete order flow visualization:
import TradeRainOverlay from '@src/overlays/tradeRain'
import OrderFlowOverlay from '@src/overlays/orderflow'

const rain = new TradeRainOverlay(container, engine)
const orderflow = new OrderFlowOverlay(container, engine)

rain.start()
orderflow.start()

// Route incoming trades to both
provider.subscribeTrades(symbol, trade => {
  rain.addTrade(trade)           // Visual particles
  orderflow.onTrade(trade)        // Analysis
})

provider.subscribeCandles(symbol, interval, candle => {
  orderflow.onCandle(candle)      // Level detection
})

// ============================================================================
// RESETTING / CLEARING DATA
// ============================================================================

// Reset to clear all analysis (useful for symbol/interval change):
overlay.reset()

// Or destroy completely:
overlay.destroy()

// Then create new for different symbol:
const newOverlay = new OrderFlowOverlay(container, engine)
newOverlay.start()
