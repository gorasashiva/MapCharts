# Changelog

## 0.1.0 — initial public release

First open-source release of the CandL charting library, extracted from the
[candl.live](https://candl.live) app:

- High-performance canvas **chart engine** with 19 chart types.
- Large **drawing-tool** registry — trend lines, channels, Fibonacci suite
  (with editable levels), harmonic & Elliott-wave patterns, shapes, annotations,
  measurements, and data-aware "smart" tools.
- **Technical indicators** — moving averages, RSI, MACD, Bollinger Bands, ATR,
  Stochastic, VWAP, OBV, CVD, volume.
- **CandLlabs** experimental tools — Echoes (historical similarity), the Oracle
  (probabilistic outcomes), the Market Clock, and a trade sonifier.
- Data-agnostic: bring your own feed via `setData` / `updateLast` or the
  optional `DataProvider` contract.
