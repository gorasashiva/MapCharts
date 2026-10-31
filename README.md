# CandL Charts

A **data-agnostic** canvas charting library — the charting core behind
[candl.live](https://candl.live), released open-source. It gives you a fast
in-house canvas engine, a deep drawing-tool set, technical indicators, and the
experimental **CandLlabs** tools. It ships **no data feed** — you bring the
candles (from any exchange, broker, CSV, or your own backend).

> Think of it as the rendering + analysis core, decoupled from data — you supply
> the candles, and CandL Charts draws and analyzes them.

## Features

- ⚡ **Chart engine** — in-house HTML canvas (zero charting dependencies),
  19 chart types (candles, Heikin Ashi, hollow, bars, line, area, Renko-style
  re-binned types, and more), pan/zoom, log scale, replay.
- ✏️ **Drawing tools** — trend lines & channels, the full **Fibonacci suite with
  editable levels**, harmonic & **Elliott-wave** patterns (with degree labels),
  shapes, annotations, measurements, and data-aware "smart" tools.
- 📊 **Indicators** — moving averages, RSI, MACD, Bollinger Bands, ATR,
  Stochastic, VWAP, OBV, CVD, volume.
- 🧪 **CandLlabs** — Echoes (historical similarity search), the Oracle
  (probabilistic outcome model), the Market Clock, and a live trade sonifier.
- 🔌 **Data-agnostic** — `setData(candles)` / `updateLast(candle)`, or implement
  the optional `DataProvider` contract for richer integrations. Ready-made
  providers for **Delta Exchange India** and Binance are included.

## Install

```bash
npm install @candllabs/charts
```

`react` is an optional peer dependency — it's only needed (type-only) if you use
the drawing-tool **icon** exports. The chart engine itself is framework-free.

## Quick start

```ts
import { createChartEngine, type Candle } from '@candllabs/charts'

const engine = createChartEngine(document.getElementById('chart')!, {
  theme: 'dark',
  pricePrecision: 2,
  chartType: 'candles',
})

const candles: Candle[] = await myFeed.history('BTCUSD', '1m')
engine.setData(candles)

myFeed.onTick((c) => engine.updateLast(c)) // live updates
window.addEventListener('resize', () => engine.resize())
```

## Bring your own data

The library never makes network calls. Your only obligation is to produce
`Candle[]`:

```ts
interface Candle {
  time: number // epoch ms
  open: number
  high: number
  low: number
  close: number
  volume: number
}
```

Indicators, drawings, and the CandLlabs tools are pure functions over candles, so
no provider is needed for the core. For app-level integrations you can implement
the exported `DataProvider` interface (`fetchCandles`, `subscribeCandles`,
`searchSymbols`, …) and feed its output into `setData` / `updateLast`.

### Ready-made providers

Two implementations ship with the library, both public-endpoint-only (no API
key) and usable straight from the browser:

```ts
import { DeltaDataProvider, BinanceDataProvider } from '@candllabs/charts'

const provider = new DeltaDataProvider() // Delta Exchange India
const candles = await provider.fetchCandles('BTCUSD', '5m', 500)
const stop = provider.subscribeCandles('BTCUSD', '5m', (c) => engine.updateLast(c))
```

`DeltaDataProvider` covers Delta Exchange India — USD-quoted perpetuals
(`BTCUSD`), options (`C-BTC-88000-280826`), INR spot pairs (`BTC_INR`) and
mark-price series (`MARK:BTCUSD`) — over `api.india.delta.exchange` and its
WebSocket. Two venue details it normalises for you:

- **Sizes are contracts.** Delta quotes candle/trade/book sizes in contracts
  (one `BTCUSD` contract is 0.001 BTC). The provider multiplies by each
  product's contract size, so volume reaches you in base units.
- **History has no taker split.** Delta's candles carry total volume only.
  Historical bars therefore have no `buyVolume` / `tradeCount` (both optional),
  but LIVE bars do get a real `buyVolume`: `subscribeCandles` rebuilds it from
  the trade tape, which reports the true aggressor side per trade. One tape is
  shared per symbol across every interval you subscribe to. Buy/sell-pressure
  tools are thus exact for bars watched live and absent for older history —
  never estimated.

`BinanceDataProvider` covers Binance spot (`BTCUSDT`) and does report the taker
split on historical klines.

## Price alerts

`checkAndFireAlerts` evaluates the alerts for one symbol against its latest price
and fires (a browser notification + optional sound) any that just crossed. Call
it per symbol you have a price for — so alerts fire for **any number of symbols
at once**, independent of what's on screen:

```ts
import { checkAndFireAlerts, type Alert } from '@candllabs/charts'

const alerts: Alert[] = [/* your alerts, across any symbols */]
const last = new Map<string, number>() // last price seen per symbol

function onTick(symbol: string, price: number) {
  checkAndFireAlerts({
    symbol,
    price,
    prevPrice: last.get(symbol) ?? null,
    alerts,
    soundOn: true,
    tune: 0,
    tuneDurationSec: 3,
    onTriggered: (id) => {/* mark it triggered in your own state */},
  })
  last.set(symbol, price)
}
```

## Demo

```bash
npm install
npm run demo              # starts the demo and local tape recorder
```

The demo is a TradingView-style shell — multi-chart grid, drawing rail,
indicators, saved layouts — running on **Delta Exchange India** live public
data: perpetuals, an options chain with exchange-published greeks, a GEX
dashboard, order-flow overlays and the trade tape. No API key and no proxy are
needed; Delta's market-data API is CORS-open. If the feed can't be reached the
demo falls back to a deterministic synthetic series so the UI still works
offline. The local recorder provides historical Big Trades / Deep Trades data;
it starts with the demo, and retries Delta metadata lookups if the exchange is
temporarily unavailable. To run it separately, use `npm run recorder`.

## Deploying the site

`site/index.html` is a landing page for the charting app. Assemble both into one
static bundle:

```bash
npm run preview:site     # build + serve at http://localhost:8000
npm run build:site       # build only, into dist-site/
```

```
dist-site/
  index.html        # landing page
  charts/           # the app
```

Upload the **contents** of `dist-site/` to any static host — there is no server
side. Set `SITE_ROOT` to the public path it will be served from, so the app's
asset URLs are correct:

```bash
./site/build.sh                        # https://example.com/
SITE_ROOT=/trade/ ./site/build.sh      # https://example.com/trade/
SITE_ROOT=/CandlV2/ ./site/build.sh    # GitHub Pages project site
```

Serve it over **HTTPS** — price alerts use the browser Notification API, which
browsers only expose in a secure context.

## Build

```bash
npm run build      # type-check + bundle (ES + CJS) with .d.ts into dist/
```

## License

[Apache-2.0](./LICENSE) © Rahul Sangam. Contributions welcome — see
[CONTRIBUTING.md](./CONTRIBUTING.md).
