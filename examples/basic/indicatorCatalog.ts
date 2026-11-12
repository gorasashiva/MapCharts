// Browse metadata for the Indicators dialog: which family each indicator sits
// in and a one-paragraph description for the preview pane. Anything missing
// here still shows up (under "Other") — this file only adds labels.

export const INDICATOR_FAMILIES = ['Trend', 'Momentum', 'Volatility', 'Volume & Flow', 'Structure & Levels', 'Signals & Strategies', 'Other'] as const
export type IndicatorFamily = (typeof INDICATOR_FAMILIES)[number]

interface CatalogEntry {
  family: IndicatorFamily
  description: string
  /** Shown as "Custom" instead of "Built-in" in the dialog. */
  custom?: boolean
}

const CATALOG: Record<string, CatalogEntry> = {
  sma: { family: 'Trend', description: 'Average close of the last N bars, equally weighted. The baseline trend filter: price above a rising SMA is an uptrend.' },
  ema: { family: 'Trend', description: 'Moving average that weights recent bars more heavily, so it turns faster than an SMA of the same length.' },
  wma: { family: 'Trend', description: 'Linearly weighted moving average — between SMA and EMA in responsiveness.' },
  ema_stack: { family: 'Trend', description: 'EMA 9 / 21 / 50 together. A clean fan (9 > 21 > 50 or the reverse) marks a trending market; braided lines mark chop.' },
  vwap: { family: 'Volume & Flow', description: 'Volume-weighted average price for the session — the fair-value line institutions benchmark fills against.' },
  bollinger: { family: 'Volatility', description: 'A moving average with bands two standard deviations either side. Band squeezes precede expansion; tags of the outer band show stretch.' },
  atr: { family: 'Volatility', description: 'Average True Range — the typical bar range including gaps. Used for stop distance and position sizing.' },
  rsi: { family: 'Momentum', description: 'Relative Strength Index (0–100). Above 70 is overbought, below 30 oversold; divergences against price flag weakening moves.' },
  macd: { family: 'Momentum', description: 'Difference of two EMAs with a signal line and histogram. Crosses and histogram slope show momentum shifts.' },
  stochastic: { family: 'Momentum', description: 'Where the close sits within the recent high–low range (0–100), with a smoothed signal line.' },
  volume: { family: 'Volume & Flow', description: 'Traded volume per bar, coloured by bar direction, in its own pane.' },
  obv: { family: 'Volume & Flow', description: 'On-Balance Volume: running total that adds volume on up bars and subtracts it on down bars — confirms or questions a move.' },
  cvd: { family: 'Volume & Flow', description: 'Cumulative Volume Delta — running buy-minus-sell volume, showing which side has been aggressive.' },
  chota_pandit_v3: { family: 'Signals & Strategies', custom: true, description: 'CHOTA pandit V3 buy / sell signal system ported from Pine.' },
  hma31_st: { family: 'Trend', custom: true, description: 'Hull MA 31 combined with a Supertrend — trend direction with fast turn detection.' },
  hma_coppock: { family: 'Signals & Strategies', custom: true, description: 'Hull MA 31 with a Supertrend 2,2 and BUY / SELL signals confirmed by the Coppock curve (probable signals on zero crosses), ported from Pine.' },
  coppock_curve: { family: 'Momentum', custom: true, description: 'Coppock curve: WMA 9 of the 13 and 17 bar rate of change, with the zero line. Crossing above zero is the classic long-term buy trigger.' },
  parabolic_sar: { family: 'Trend', custom: true, description: 'Parabolic SAR (Wilder): trailing stop dots below price in an uptrend and above it in a downtrend. Flips when price trades through the dot.' },
  ema47_st: { family: 'Trend', custom: true, description: 'EMA 47 band with a Supertrend overlay for trend-following entries.' },
  blast_candle: { family: 'Signals & Strategies', custom: true, description: 'Flags unusually large “blast” candles that often start or end impulsive moves.' },
  daddy_home: { family: 'Structure & Levels', custom: true, description: 'Higher-high / lower-low zones combined with VWAP-based order-flow context.' },
  candle_dominance: { family: 'Volume & Flow', custom: true, description: 'Buy vs sell dominance per candle, estimated from where the close sits in the bar and its volume.' },
  lion_50: { family: 'Structure & Levels', custom: true, description: 'Lion levels with the 50% retracement of the active swing — a mean-reversion magnet.' },
  shadow_1sc: { family: 'Structure & Levels', custom: true, description: 'Market-structure shift / break of structure with automatic Fibonacci of the impulse leg.' },
  salaar_macd_ao: { family: 'Signals & Strategies', custom: true, description: 'Continuation signals when MACD and the Awesome Oscillator agree with the trend.' },
  zigzag_fib: { family: 'Structure & Levels', custom: true, description: 'Zigzag swings with a 0.382 pullback level, tuned for the London session.' },
  session_reversal: { family: 'Signals & Strategies', custom: true, description: 'Tests session-open reversals that turn into range expansion, with entry markers.' },
  range_breakout_0530: { family: 'Signals & Strategies', custom: true, description: 'IST 05:30–05:45 opening-range breakout (v2) with stop / target markers.' },
  renko_exhaustion_fade: { family: 'Signals & Strategies', custom: true, description: 'Renko strategy: fades the first reversal brick after a long run (gold research: $4 box, 8 bricks, TP 2 / SL 3). Entry, TP, SL and exit labels.' },
  sessions: { family: 'Structure & Levels', custom: true, description: 'Asia / London / New York session boxes in each city’s local time, plus the previous 1H and 4H high / low.' },
  sessions_v2: { family: 'Volume & Flow', custom: true, description: 'Volume profile for every Asia / London / New York session, with POC, VAH and VAL lines, a histogram, value-area shading and full colour and style options.' },
  market_structure: { family: 'Structure & Levels', custom: true, description: 'Labels HH / HL / LH / LL swings, BOS and CHoCH breaks, and filters trend from chop.' },
  the_map: { family: 'Structure & Levels', custom: true, description: 'THE MAP clone — GEX, open-interest and 0DTE option levels projected onto the chart.' },
  the_map_v2: { family: 'Structure & Levels', custom: true, description: 'MAP V2 — THE MAP with guide rules: true gamma-flip regime, fresh retests only, regime-aware entries, walls on the right side of price.' },
  the_map_v3: { family: 'Structure & Levels', custom: true, description: 'MAP V3 — gold (XAUUSD / XAUT / PAXG) levels built like the original THE MAP: from GLD options (OCC open interest, consolidated volume), computed once per session at 08:15 New York time and locked until the next, scaled to the chart. Needs the MAP recorder (started by npm run demo).' },
  dom_heatmap: { family: 'Volume & Flow', custom: true, description: 'DOM Heatmap — resting limit orders over time, drawn behind the candles in the DeepDOM style, showing only the strongest price levels (count and transparency in settings): columns are time slices, rows are price bands, and brightness is the average resting size in each cell. Green = resting buy limits below mid, purple = resting sell limits above mid. Built from Delta\'s public depth feed (top levels, sampled every 0.5 s, kept for up to one hour while on). Separate from GEX Heatmap (options).' },
  gex_summary: { family: 'Structure & Levels', custom: true, description: 'GEX Summary — net gamma over time as bars in its own pane below the chart (like Volume): green = positive gamma, purple = negative, with the current net GEX and regime. Built from Delta option GEX (BTC, ETH, gold via XAUT), not CBOE data, so it is an analogue of DeepCharts\' Option Summary GEX. Samples are collected while the chart is open; they are not saved.' },
  gex_heatmap: { family: 'Structure & Levels', custom: true, description: 'GEX Heatmap — one horizontal block per strike, width and opacity scaled to the strike\'s |net GEX| relative to the largest strike; teal = call-dominant, orange = put-dominant. Hides blocks below a cut-off. Delta options: BTC, ETH, gold (XAUT). Analogue of DeepCharts\' Option GEX Heatmap, not the same data.' },
  gex_profile_split: { family: 'Structure & Levels', custom: true, description: 'GEX Profile (split) — per-strike GEX bars on the right edge: calls to the right of a centre line, puts to the left (or one net bar per strike), with dashed lines at the peak call and peak put strikes and the net total. Delta options: BTC, ETH, gold (XAUT). Analogue of DeepCharts\' Option GEX Profile; the Hedging classification is not included yet.' },
  gex_sabers: { family: 'Structure & Levels', custom: true, description: 'GEX Sabers — a pure GEX study as glowing light-saber levels on the right of the chart, for the option expiries you choose: red resistance (largest call GEX above price), green support (largest put GEX below), purple liquidity (largest total gamma), white zero gamma. Blade length and number = strength 0–100, plus $ GEX per 1% move and the dominant expiry. Sized by open interest or today\'s volume. Delta options: BTC, ETH, gold (XAUT).' },
  mtf_cisd_mss: { family: 'Structure & Levels', custom: true, description: 'MTF CISD + MSS (ported from mtf.pine): market-structure shifts, change-in-state-of-delivery levels and liquidity sweeps on the chart, plus a 10-timeframe dashboard and the latest higher-timeframe levels.' },
  hl_blocks_1h_4h: { family: 'Structure & Levels', custom: true, description: '1H/4H Block (ported from "1h/4h blocks.pine"): red / green zones where the last closed 1H and 4H highs (or lows) line up within a % or ATR tolerance; the newest zone of each side extends right. Chart timeframe must be 1H or lower.' },
  ai_trades: { family: 'Signals & Strategies', custom: true, description: 'AI Trades (ported from "AI trades.pine", SUNDARI AI v5.8): EMA 34 − EMA 55 crossing its EMA 13 gives BUY (with a higher high) / SELL (with a lower low) triangles, a step line at the signal candle, T1–T4 extension targets and an ATR trailing stop.' },
  tpo_tv: { family: 'Volume & Flow', custom: true, description: "TPO (Time Price Opportunity), after TradingView's indicator: one letter profile per day / week / month (A–Z then a–z per time block), Auto row size by TradingView's rule, POC, value area (TradingView's row-by-row rule), Initial Balance, midpoint, open / close, single prints, poor high / low — levels extendable until price trades through them — an optional volume profile with its own POC / VA, day-type labels and alerts on crosses of extended levels." },
  fvg_midpoints: { family: 'Structure & Levels', custom: true, description: 'FVG Midpoints (ported from FVG-mid.pine): a line at the midpoint of every bullish (low > high two bars back) and bearish (high < low two bars back) fair value gap, removed once price trades through it. Up to 200 per side; optional right-edge extension, faint mitigated lines and price tags.' },
  ny_first_hour_fade: { family: 'Signals & Strategies', custom: true, description: "NY First-Hour Fade (gold 1m session research): New York's first hour (08:00-09:00 NY, daylight saving automatic) usually fakes the session's direction, so at 09:00 NY (18:30 IST while New York is on summer time, 19:30 IST in winter) it trades against that hour. Stop 0.25x the typical day range (or beyond the hour's extreme), TP1 at the hour's open, TP2 at 2R, exit by 17:00 NY — or hold to the close, the backtest's best. Asia / London / NY shading, BUY / SELL with entry / SL / TP lines, plan dashboard in IST, live alerts and Strategy Tester trades." },
  tpo_va_fade: { family: 'Signals & Strategies', custom: true, description: 'TPO VA Fade (gold 5m research): previous-session TPO VAH / POC / VAL; at 07:00 UTC places limit orders 0.5 ATR past VAH (sell) / VAL (buy) with a 2×ATR (≥$8) stop and a target just short of the POC, skipping sides under 1:2 R:R. One loss per day, risk sized by the volatility regime. Trade boxes, plan dashboard, live alerts and Strategy Tester trades.' },
  flying_cpr: { family: 'Signals & Strategies', custom: true, description: 'Flying CPR Signals (ported from "Flying CPR.pine"): 09:31–09:59 IST opening-range high / low with ±2.07 / 2.57 / 4.07 / 4.57 / 10.07 / 10.57 Fibonacci extensions, A–D setups (range breakout, Fib rejection, NY-reversal fade, extreme capitulation) with time / day filters and a dashboard. Every line, fill and label is styleable.' },
  bulb_and_arrow: { family: 'Signals & Strategies', custom: true, description: 'Bulb and arrow (ported from bulbandarrow.pine): RSI(14) crossing its SMA(14) gives buy / sell arrows; Oikio bulbs (RSI 7) and confirm arrows (RSI 15) mark each overbought / oversold swing extreme, with optional Reversal Zone labels and zigzag.' },
  vwap_ema_angle: { family: 'Trend', custom: true, description: 'VWAP Angle (ported from "VWAP and EMA Angle Confluence"): anchored VWAP with up to 3 stdev / % bands, and an EMA whose slope angle gives BUY (above +threshold), SELL (below −threshold) or WAIT, coloured on the line. Combines both into one of 11 confluence setups (trend, pullback, extension, mean reversion) shown in a status label and a dashboard. Optional ATR-measured angle, flip markers and alerts; every line, band and fill is styleable.' },
  dc_cpr_bb: { family: 'Structure & Levels', custom: true, description: 'DC CPR BB (ported from "Donchian + CPR (D/W/M) + Bollinger Bands"): Donchian channel, Bollinger Bands (SMA / EMA / WMA / VWMA basis), daily / weekly / monthly CPR with R1–S2 from the previous period, day open and SMA 21 / 34. BUY / SELL when one candle opens below and closes above every line (and the day open), or the reverse. Backgrounds can be hidden; every part is styleable, with alerts.' },
  vortex: { family: 'Trend', custom: true, description: 'Vortex Indicator: VI+ (blue) measures upward movement, VI− (pink) downward, each as a share of true range over N bars. VI+ above VI− = up-trend; a cross marks a possible trend change.' },
  shanky_combo: { family: 'Signals & Strategies', custom: true, description: 'CPR + auto buy / sell signals + rainbow EMA ribbon, combined in one overlay.' },
}

export function indicatorFamily(id: string): IndicatorFamily {
  return CATALOG[id]?.family ?? 'Other'
}

export function indicatorDescription(id: string): string {
  return CATALOG[id]?.description ?? 'No description yet.'
}

export function isCustomIndicator(id: string): boolean {
  return !!CATALOG[id]?.custom
}
