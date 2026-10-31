/**
 * INTEGRATION GUIDE: OrderFlow Analysis Overlay
 * 
 * This document shows the exact changes needed to add OrderFlowOverlay to ChartPane
 */

// ============================================================================
// STEP 1: Update imports in examples/basic/pane.ts
// ============================================================================

// Add this import at the top with other overlay imports:
import OrderFlowOverlay from '../../src/overlays/orderflow'

// ============================================================================
// STEP 2: Add properties to ChartPane class
// ============================================================================

export class ChartPane {
  // ... existing properties ...

  private readonly orderflow: OrderFlowOverlay // ADD THIS
  private orderflowToggleBtn: HTMLButtonElement // ADD THIS

  constructor(provider: PaneProvider, theme: Theme, initial: PaneState) {
    // ... existing code ...

    // After creating rainToggleBtn, add this:
    this.orderflowToggleBtn = document.createElement('button')
    this.orderflowToggleBtn.className = 'tv-btn'
    this.orderflowToggleBtn.textContent = '📊'
    this.orderflowToggleBtn.title = 'Toggle Order Flow Analysis'
    this.orderflowToggleBtn.addEventListener('click', (event) => {
      event.stopPropagation()
      this.setOrderFlowEnabled(!this.state.orderFlow)
    })
    head.append(this.orderflowToggleBtn)

    // Initialize OrderFlow overlay (after rain initialization):
    this.orderflow = new OrderFlowOverlay(this.canvasHost, this.engine, {
      showLevels: true,
      showAbsorption: true,
      showFootprints: true,
      levelPrecision: 100, // Adjust based on instrument
      maxLevelsDisplay: 10,
    })
    this.orderflow.start()
    this.setOrderFlowEnabled(this.state.orderFlow ?? false)

    // ... rest of constructor ...
  }

  // =========================================================================
  // STEP 3: Add OrderFlow methods
  // =========================================================================

  private setOrderFlowEnabled(on: boolean): void {
    this.state.orderFlow = on
    this.orderflowToggleBtn.classList.toggle('active', on)
    this.orderflowToggleBtn.title = on ? 'Disable Order Flow' : 'Enable Order Flow'

    if (!on) {
      this.orderflow.reset()
    }
  }

  // =========================================================================
  // STEP 4: Update subscribeTradeFeed to feed orderflow
  // =========================================================================

  private subscribeTradeFeed(): void {
    this.unsubscribeTradeFeed()
    this.startTradeRainFallback()
    try {
      this.tradeUnsub = this.provider.subscribeTrades(
        this.state.symbol,
        (trade: { time: number; price: number; qty: number; side: 'buy' | 'sell' }) => {
          this.lastTradeAt = performance.now()
          this.rain.addTrade({
            timestamp: trade.time,
            price: trade.price,
            volume: trade.qty,
            side: trade.side,
          })

          // ADD THIS: Feed to orderflow analysis
          if (this.state.orderFlow) {
            this.orderflow.onTrade({
              time: trade.time,
              price: trade.price,
              qty: trade.qty,
              side: trade.side,
            })
          }
        }
      )
    } catch {
      this.tradeUnsub = null
    }
  }

  // =========================================================================
  // STEP 5: Update candle subscription to feed orderflow
  // =========================================================================

  // Find the existing candle subscription code and update it:

  private subscribeCandles(): void {
    // ... existing unsubscribe code ...

    try {
      this.unsub = this.provider.subscribeCandles(this.state.symbol, this.state.interval, (candle: Candle) => {
        this.candles[this.candles.length - 1] = candle // update or add
        this.engine.setData(this.candles)

        // ADD THIS: Feed to orderflow analysis
        if (this.state.orderFlow) {
          this.orderflow.onCandle(candle)
        }

        // ... rest of existing code ...
      })
    } catch (err) {
      // ... existing error handling ...
    }
  }

  // =========================================================================
  // STEP 6: Update PaneState interface
  // =========================================================================

  // In the PaneState interface definition, add:
  export interface PaneState {
    symbol: string
    interval: Interval
    chartType: ChartType
    indicators: IndicatorInstance[]
    drawings: Drawing[]
    tradeRain?: boolean
    orderFlow?: boolean  // ADD THIS
  }

  // =========================================================================
  // STEP 7: Add cleanup for orderflow in destroy
  // =========================================================================

  destroy(): void {
    // ... existing cleanup code ...

    this.orderflow.destroy() // ADD THIS
    this.unsubscribeTradeFeed()
    this.ro.disconnect()
  }

  // =========================================================================
  // STEP 8: Handle resize
  // =========================================================================

  public refresh(): void {
    this.engine.resize()
    this.resizeOverlay()
    this.rain.resize()
    // orderflow resize happens automatically via ResizeObserver
  }

  // =========================================================================
  // OPTIONAL: Expose analysis stats
  // =========================================================================

  getOrderFlowStats() {
    return this.orderflow.getStats()
  }

  // =========================================================================
  // OPTIONAL: Add display of analysis stats in UI
  // =========================================================================

  // Add to the pane header to show live analysis metrics:
  private updateOrderFlowDisplay(): void {
    const stats = this.orderflow.getStats()
    const statusText = [
      `Levels: ${stats.levels.totalLevels}`,
      `Inst: ${(stats.institutionalBalance * 100).toFixed(0)}%`,
      `Conf: ${(stats.confidence * 100).toFixed(0)}%`,
    ].join(' | ')

    console.log('Order Flow:', statusText)
    // Or update a UI element with this text
  }
}

// ============================================================================
// COMPLETE MINIMAL EXAMPLE (add to your chart pane)
// ============================================================================

/*
Constructor snippet for minimal integration:

  constructor(provider: PaneProvider, theme: Theme, initial: PaneState) {
    // ... existing engine setup ...

    // Add OrderFlow overlay
    this.orderflow = new OrderFlowOverlay(this.canvasHost, this.engine)
    this.orderflow.start()

    // Rest of constructor...
    this.subscribeTradeFeed()
    this.subscribeCandles()
  }

In subscribeTradeFeed():

  this.tradeUnsub = this.provider.subscribeTrades(this.state.symbol, (trade) => {
    this.rain.addTrade({ timestamp: trade.time, price: trade.price, volume: trade.qty, side: trade.side })
    this.orderflow.onTrade(trade)  // Add this line
  })

In subscribeCandles():

  this.unsub = this.provider.subscribeCandles(
    this.state.symbol,
    this.state.interval,
    (candle: Candle) => {
      this.candles[this.candles.length - 1] = candle
      this.engine.setData(this.candles)
      this.orderflow.onCandle(candle)  // Add this line
    }
  )
*/
