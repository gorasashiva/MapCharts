// "Market Structure" — Indicators-menu entry: zigzag swings with HH / HL / LH / LL
// labels, BOS / CHoCH breaks, liquidity sweeps, a trend / chop ribbon and the
// researched break-quality filter, plus its trades for the Strategy Tester.
// Math: src/overlays/marketStructureModel.ts. Drawn through the canvas-indicator
// hook (see CanvasSource in custom-indicators.ts); computed from the chart's own
// candles with no look-ahead, so it follows ticks and bar replay.

import type { Candle, IndicatorDef, IndicatorParam } from "../../src/index";
import type { Converters } from "../../src/drawings/types";
import type { StrategyTrade } from "../../src/strategy/types";
import {
  MS_DEFAULTS,
  computeMarketStructure,
  type MsOptions,
  type MsResult,
  type MsTrade,
} from "../../src/overlays/marketStructureModel";
import type { CanvasIndicatorContext } from "./shankyCombo";

type Rect = { x: number; y: number; width: number; height: number };

const D = MS_DEFAULTS;
const toggle = (
  key: string,
  label: string,
  def: boolean,
  group: string,
): IndicatorParam => ({
  key,
  label,
  default: def ? 1 : 0,
  toggle: true,
  group,
});
const num = (
  key: string,
  label: string,
  def: number,
  group: string,
  min?: number,
  max?: number,
  step?: number,
): IndicatorParam => ({ key, label, default: def, min, max, step, group });
// Session pickers: valued in UTC hours, labelled in IST (UTC+5:30) with UTC alongside.
const hhmm = (h: number): string =>
  `${String(Math.floor(h)).padStart(2, "0")}:${h % 1 ? "30" : "00"}`;
const halfHours = Array.from({ length: 48 }, (_, i) => ({
  value: i / 2,
  label: `${hhmm((i / 2 + 5.5) % 24)} IST (${hhmm(i / 2)} UTC)`,
}));

const G_SW = "Swings (zigzag)";
const G_Q = "Break quality — trend / chop";
const G_T = "Signals & Strategy Tester";
const G_SHOW = "Display";

export const marketStructure: IndicatorDef = {
  id: "market_structure",
  label: "Market Structure (HH/HL/LH/LL, BOS/CHoCH, trend / chop filter)",
  shortLabel: "Structure",
  placement: "overlay",
  params: [
    {
      key: "swingMode",
      label: "Swing method",
      default: 0,
      group: G_SW,
      options: [
        { value: 0, label: "ATR zigzag (same size on every timeframe)" },
        { value: 1, label: "Pivots (bars each side)" },
      ],
    },
    num(
      "devAtr",
      "Swing size (× ATR) — pivots: min leg, 0 = off",
      D.devAtr,
      G_SW,
      0,
      20,
      0.5,
    ),
    num("depth", "Pivot bars each side", D.depth, G_SW, 1, 50, 1),
    num("atrLen", "ATR length", D.atrLen, G_SW, 2, 200, 1),
    toggle(
      "closeBreaks",
      "Break needs a candle close (wick-only = sweep)",
      D.closeBreaks,
      G_SW,
    ),

    num(
      "volLen",
      "Slow ATR length (volatility ratio)",
      D.volLen,
      G_Q,
      20,
      500,
      1,
    ),
    num("volExpand", "Expansion: ATR ratio ≥", D.volExpand, G_Q, 0.5, 5, 0.05),
    num(
      "volCompress",
      "Compression: ATR ratio <",
      D.volCompress,
      G_Q,
      0.1,
      2,
      0.05,
    ),
    toggle(
      "useSession",
      "Score the session (charts below 1h)",
      D.useSession,
      G_Q,
    ),
    {
      key: "asiaStart",
      label: "Asia (+1) from",
      default: D.asiaStartUTC,
      group: G_Q,
      options: halfHours,
    },
    {
      key: "asiaEnd",
      label: "Asia until",
      default: D.asiaEndUTC,
      group: G_Q,
      options: halfHours,
    },
    {
      key: "nyStart",
      label: "New York (−1) from",
      default: D.nyStartUTC,
      group: G_Q,
      options: halfHours,
    },
    {
      key: "nyEnd",
      label: "New York until",
      default: D.nyEndUTC,
      group: G_Q,
      options: halfHours,
    },

    {
      key: "minScore",
      label: "Trade breaks scoring at least",
      default: D.minScore,
      group: G_T,
      options: [-2, -1, 0, 1, 2].map((v) => ({
        value: v,
        label:
          v === -2
            ? "−2 (every break)"
            : `${v > 0 ? "+" : ""}${v}${v === 2 ? " (researched)" : ""}`,
      })),
    },
    num("targetR", "Target (R multiple)", D.targetR, G_T, 0.5, 10, 0.25),
    toggle("skipWeekends", "No trades Sat / Sun", D.skipWeekends, G_T),

    toggle("showZigzag", "Zigzag", true, G_SHOW),
    toggle("showLabels", "HH / HL / LH / LL labels", true, G_SHOW),
    toggle("showBreaks", "BOS / CHoCH", true, G_SHOW),
    toggle("showSweeps", "Liquidity sweeps", true, G_SHOW),
    toggle("showLevels", "Next break levels", true, G_SHOW),
    toggle("showRibbon", "Trend / chop ribbon", true, G_SHOW),
    toggle("showBg", "Shade chop zones", false, G_SHOW),
    toggle("showTrades", "Trades (entry / SL / TP)", true, G_SHOW),
    toggle("showStats", "Status box", true, G_SHOW),
  ],
  compute: () => [],
};

interface Display {
  zigzag: boolean;
  labels: boolean;
  breaks: boolean;
  sweeps: boolean;
  levels: boolean;
  ribbon: boolean;
  bg: boolean;
  trades: boolean;
  stats: boolean;
}

export interface MarketStructureModel {
  opts: MsOptions;
  display: Display;
  result: MsResult;
}

export function computeMarketStructureModel(
  candles: Candle[],
  p: Record<string, number>,
  _ctx: CanvasIndicatorContext,
): MarketStructureModel {
  const b = (k: string, d: boolean): boolean =>
    p[k] === undefined ? d : p[k] !== 0;
  const n = (k: string, d: number): number =>
    Number.isFinite(p[k]) ? p[k] : d;
  const opts: MsOptions = {
    swingMode: n("swingMode", 0) === 1 ? "pivot" : "atr",
    devAtr: n("devAtr", D.devAtr),
    depth: n("depth", D.depth),
    atrLen: Math.max(2, Math.round(n("atrLen", D.atrLen))),
    closeBreaks: b("closeBreaks", D.closeBreaks),
    volLen: Math.max(2, Math.round(n("volLen", D.volLen))),
    volExpand: n("volExpand", D.volExpand),
    volCompress: n("volCompress", D.volCompress),
    useSession: b("useSession", D.useSession),
    asiaStartUTC: n("asiaStart", D.asiaStartUTC),
    asiaEndUTC: n("asiaEnd", D.asiaEndUTC),
    nyStartUTC: n("nyStart", D.nyStartUTC),
    nyEndUTC: n("nyEnd", D.nyEndUTC),
    minScore: n("minScore", D.minScore),
    targetR: n("targetR", D.targetR),
    skipWeekends: b("skipWeekends", D.skipWeekends),
  };
  return {
    opts,
    display: {
      zigzag: b("showZigzag", true),
      labels: b("showLabels", true),
      breaks: b("showBreaks", true),
      sweeps: b("showSweeps", true),
      levels: b("showLevels", true),
      ribbon: b("showRibbon", true),
      bg: b("showBg", false),
      trades: b("showTrades", true),
      stats: b("showStats", true),
    },
    result: computeMarketStructure(candles, opts),
  };
}

/** Strategy Tester feed: every simulated break trade. */
export function marketStructureTrades(model: unknown): StrategyTrade[] {
  return (model as MarketStructureModel).result.trades.map((t) => ({
    side: t.dir === 1 ? "long" : "short",
    entryTime: t.entryTime,
    entryPrice: t.entry,
    exitTime: t.exitTime,
    exitPrice: t.exitPrice,
    exitReason: t.exitReason ?? undefined,
    stop: t.stop,
  }));
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const C = {
  up: "#089981",
  down: "#f23645",
  upSoft: "38, 166, 154",
  downSoft: "239, 83, 80",
  zigzag: "rgba(120, 123, 134, 0.75)",
  sweep: "#ff9800",
  chop: "rgba(120, 123, 134, 0.75)",
  chopBg: "rgba(120, 123, 134, 0.07)",
  reward: "rgba(8, 153, 129, 0.12)",
  risk: "rgba(242, 54, 69, 0.12)",
  entry: "rgba(209, 212, 220, 0.8)",
  statsBg: "rgba(19, 23, 34, 0.88)",
  text: "#d1d4dc",
  muted: "#9598a1",
};
const FONT =
  "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const SMALL =
  "600 9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const LABEL_RGB: Record<string, string> = {
  HH: C.upSoft,
  HL: C.upSoft,
  LH: C.downSoft,
  LL: C.downSoft,
  H: "149, 152, 161",
  L: "149, 152, 161",
};

function seg(
  g: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 1,
  dash: number[] = [],
): void {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.setLineDash(dash);
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
  g.setLineDash([]);
}

function pill(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  bg: string,
  align: "left" | "right",
): void {
  g.font = FONT;
  const w = g.measureText(text).width + 10;
  const h = 16;
  const x0 = align === "right" ? x - w : x;
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(x0, y - h / 2, w, h, 3);
  g.fill();
  g.fillStyle = "#fff";
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillText(text, x0 + 5, y + 0.5);
}

const fmtPrice = (p: number): string =>
  p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p.toPrecision(5);
const signed = (v: number, d = 0): string =>
  `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;

export function drawMarketStructure(
  g: CanvasRenderingContext2D,
  conv: Converters,
  rect: Rect,
  candles: Candle[],
  model: MarketStructureModel,
  _ctx: CanvasIndicatorContext,
): void {
  const n = candles.length;
  if (n < 3) return;
  const { display: s, result: r, opts } = model;
  const barW =
    Math.abs(
      conv.timeToX(candles[n - 1].time) - conv.timeToX(candles[n - 2].time),
    ) || 6;
  const X = (i: number): number => conv.timeToX(candles[i].time);
  const Y = (p: number): number => conv.priceToY(p);
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const tFirst = conv.xToTime(rect.x - barW);
  const tLast = conv.xToTime(right + barW);
  // first / last candle index in view (binary search on time)
  const lower = (t: number): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (candles[m].time < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const i0 = Math.max(0, lower(tFirst) - 1);
  const i1 = Math.min(n - 1, lower(tLast));
  const inView = (a: number, b: number): boolean => b >= i0 && a <= i1;

  g.save();
  g.beginPath();
  g.rect(rect.x, rect.y, rect.width, rect.height);
  g.clip();

  // ---- chop shading / regime ribbon ----
  if (s.bg || s.ribbon) {
    for (let i = i0; i <= i1; i++) {
      const reg = r.regime[i];
      const xa = X(i) - barW / 2;
      if (s.bg && reg === "chop") {
        g.fillStyle = C.chopBg;
        g.fillRect(xa, rect.y, barW + 0.5, rect.height);
      }
      if (s.ribbon && reg !== "neutral") {
        const tr = r.trend[i];
        g.fillStyle =
          reg === "chop"
            ? C.chop
            : tr === 1
              ? C.up
              : tr === -1
                ? C.down
                : "#2962ff";
        g.fillRect(xa, bottom - 5, barW + 0.5, 5);
      }
    }
  }

  // ---- trades: risk / reward boxes ----
  if (s.trades) {
    for (const t of r.trades) {
      const end = t.exitIdx ?? n - 1;
      if (!inView(t.entryIdx, end)) continue;
      drawTrade(
        g,
        t,
        X,
        Y,
        t.exitIdx === null ? right : X(end) + barW / 2,
        barW,
      );
    }
  }

  // ---- zigzag ----
  const sw = r.swings;
  if (s.zigzag && sw.length > 1) {
    g.strokeStyle = C.zigzag;
    g.lineWidth = 1.25;
    g.beginPath();
    let started = false;
    for (let k = 0; k < sw.length; k++) {
      const a = sw[k];
      const nb = sw[k + 1];
      const pv = sw[k - 1];
      if (!((nb && inView(a.idx, nb.idx)) || (pv && inView(pv.idx, a.idx))))
        continue;
      if (!started) g.moveTo(X(a.idx), Y(a.price));
      else g.lineTo(X(a.idx), Y(a.price));
      started = true;
    }
    g.stroke();
  }

  // ---- BOS / CHoCH and sweeps ----
  // Text is placed newest-first and skipped where it would overlap text already drawn,
  // so quiet stretches with many small swings stay readable at any zoom.
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const place = (x0: number, x1: number, y0: number, y1: number): boolean => {
    if (placed.some((q) => x0 < q.x1 && q.x0 < x1 && y0 < q.y1 && q.y0 < y1))
      return false;
    placed.push({ x0, x1, y0, y1 });
    return true;
  };
  const tradedAt = new Set(r.trades.map((t) => t.signalIdx));
  const texts: { at: number; draw: () => void }[] = [];
  for (const e of r.events) {
    if (!inView(e.fromIdx, e.idx)) continue;
    const y = Y(e.level);
    const xa = X(e.fromIdx);
    const xb = X(e.idx);
    if (e.kind === "SWEEP") {
      if (!s.sweeps) continue;
      seg(g, xa, y, xb, y, "rgba(255, 152, 0, 0.55)", 1, [2, 3]);
      // × at the wick that took the liquidity
      const yw = Y(e.protectedLevel);
      g.strokeStyle = C.sweep;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(xb - 3, yw - 3);
      g.lineTo(xb + 3, yw + 3);
      g.moveTo(xb + 3, yw - 3);
      g.lineTo(xb - 3, yw + 3);
      g.stroke();
      continue;
    }
    if (!s.breaks) continue;
    // breaks the filter would trade are drawn solid; low-quality (chop) breaks faded
    const good = e.score >= r.minScoreEff;
    const rgb = e.dir === 1 ? C.upSoft : C.downSoft;
    const alpha = good ? 0.95 : 0.4;
    seg(
      g,
      xa,
      Math.round(y) + 0.5,
      xb,
      Math.round(y) + 0.5,
      `rgba(${rgb}, ${alpha})`,
      good ? 1.25 : 1,
      e.kind === "CHoCH" ? [5, 3] : [],
    );
    const text = tradedAt.has(e.idx) ? `${e.kind} ●` : e.kind;
    texts.push({
      at: e.idx,
      draw: () => {
        g.font = good ? FONT : SMALL;
        const tw = g.measureText(text).width;
        if (xb - xa < tw + 4) return; // too short to label at this zoom
        const cx = (xa + xb) / 2;
        const ty = e.dir === 1 ? y - 2 : y + 2;
        if (
          !place(
            cx - tw / 2,
            cx + tw / 2,
            e.dir === 1 ? ty - 11 : ty,
            e.dir === 1 ? ty : ty + 11,
          )
        )
          return;
        g.fillStyle = `rgba(${rgb}, ${alpha})`;
        g.textAlign = "center";
        g.textBaseline = e.dir === 1 ? "bottom" : "top";
        g.fillText(text, cx, ty);
      },
    });
  }

  // ---- HH / HL / LH / LL ----
  if (s.labels) {
    for (const w of sw) {
      if (w.idx < i0 || w.idx > i1) continue;
      texts.push({
        at: w.idx,
        draw: () => {
          g.font = FONT;
          const tw = g.measureText(w.label).width;
          const cx = X(w.idx);
          const ty = w.high ? Y(w.price) - 4 : Y(w.price) + 4;
          if (
            !place(
              cx - tw / 2 - 1,
              cx + tw / 2 + 1,
              w.high ? ty - 11 : ty,
              w.high ? ty : ty + 11,
            )
          )
            return;
          g.fillStyle = `rgb(${LABEL_RGB[w.label]})`;
          g.textAlign = "center";
          g.textBaseline = w.high ? "bottom" : "top";
          g.fillText(w.label, cx, ty);
        },
      });
    }
  }
  // newest first: when text collides, the most recent structure wins
  texts.sort((a, b) => b.at - a.at);
  for (const t of texts) t.draw();

  // ---- next break levels (the live, unbroken swing high / low) ----
  if (s.levels) {
    const lastH = [...sw].reverse().find((w) => w.high);
    const lastL = [...sw].reverse().find((w) => !w.high);
    const trend = r.trend[n - 1];
    const unbroken = (w: typeof lastH): boolean => {
      if (!w) return false;
      for (let i = w.confirmIdx + 1; i < n; i++) {
        const px = opts.closeBreaks
          ? candles[i].close
          : w.high
            ? candles[i].high
            : candles[i].low;
        if (w.high ? px > w.price : px < w.price) return false;
      }
      return true;
    };
    const tags: { y: number; text: string; color: string }[] = [];
    if (lastH && unbroken(lastH)) {
      const y = Y(lastH.price);
      seg(
        g,
        Math.max(rect.x, X(lastH.idx)),
        y,
        right,
        y,
        `rgba(${C.upSoft}, 0.6)`,
        1,
        [2, 3],
      );
      tags.push({
        y,
        text: `${trend === -1 ? "CHoCH" : "BOS"} ↑ ${fmtPrice(lastH.price)}`,
        color: C.up,
      });
    }
    if (lastL && unbroken(lastL)) {
      const y = Y(lastL.price);
      seg(
        g,
        Math.max(rect.x, X(lastL.idx)),
        y,
        right,
        y,
        `rgba(${C.downSoft}, 0.6)`,
        1,
        [2, 3],
      );
      tags.push({
        y,
        text: `${trend === 1 ? "CHoCH" : "BOS"} ↓ ${fmtPrice(lastL.price)}`,
        color: C.down,
      });
    }
    tags.sort((a, b) => a.y - b.y);
    for (let k = 1; k < tags.length; k++)
      if (tags[k].y - tags[k - 1].y < 17) tags[k].y = tags[k - 1].y + 17;
    for (const t of tags) pill(g, right - 2, t.y, t.text, t.color, "right");
  }

  // ---- status box ----
  if (s.stats) drawStats(g, rect, r, model, candles);
  g.restore();
}

function drawTrade(
  g: CanvasRenderingContext2D,
  t: MsTrade,
  X: (i: number) => number,
  Y: (p: number) => number,
  xEnd: number,
  barW: number,
): void {
  const xa = X(t.entryIdx) - barW / 2;
  const w = Math.max(2, xEnd - xa);
  const ye = Y(t.entry);
  g.fillStyle = C.reward;
  g.fillRect(xa, Math.min(ye, Y(t.target)), w, Math.abs(Y(t.target) - ye));
  g.fillStyle = C.risk;
  g.fillRect(xa, Math.min(ye, Y(t.stop)), w, Math.abs(Y(t.stop) - ye));
  seg(g, xa, Math.round(ye) + 0.5, xa + w, Math.round(ye) + 0.5, C.entry, 1);
  if (t.exitIdx === null) {
    // live trade: price tags on the right edge
    pill(g, xa + w - 2, Y(t.target), `TP ${fmtPrice(t.target)}`, C.up, "right");
    pill(
      g,
      xa + w - 2,
      ye,
      `${t.dir === 1 ? "Long" : "Short"} ${fmtPrice(t.entry)}`,
      "#2962ff",
      "right",
    );
    pill(g, xa + w - 2, Y(t.stop), `SL ${fmtPrice(t.stop)}`, C.down, "right");
  } else if (t.r !== null) {
    g.font = SMALL;
    g.fillStyle = t.r > 0 ? C.up : C.down;
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(`${signed(t.r, 1)}R`, xa + w + 3, Y(t.exitPrice as number));
  }
}

function drawStats(
  g: CanvasRenderingContext2D,
  rect: Rect,
  r: MsResult,
  model: MarketStructureModel,
  candles: Candle[],
): void {
  const n = candles.length;
  const i = n - 1;
  const trend = r.trend[i];
  const reg = r.regime[i];
  const lastH = [...r.swings].reverse().find((w) => w.high);
  const lastL = [...r.swings].reverse().find((w) => !w.high);
  const pair = [lastH?.label, lastL?.label].filter(Boolean).join(" · ");
  const h =
    new Date(candles[i].time).getUTCHours() +
    new Date(candles[i].time).getUTCMinutes() / 60;
  const o = model.opts;
  const inH = (a: number, b: number): boolean =>
    a <= b ? h >= a && h < b : h >= a || h < b;
  const sess = !r.sessionActive
    ? ""
    : inH(o.asiaStartUTC, o.asiaEndUTC)
      ? " · Asia +1"
      : inH(o.nyStartUTC, o.nyEndUTC)
        ? " · New York −1"
        : "";
  const done = r.trades.filter((t) => t.r !== null);
  const wins = done.filter((t) => (t.r as number) > 0).length;
  const netR = done.reduce((a, t) => a + (t.r as number), 0);
  const gw = done
    .filter((t) => (t.r as number) > 0)
    .reduce((a, t) => a + (t.r as number), 0);
  const gl = -done
    .filter((t) => (t.r as number) < 0)
    .reduce((a, t) => a + (t.r as number), 0);

  const rows: { text: string; color: string }[] = [
    {
      text: `Structure: ${trend === 1 ? "Bullish" : trend === -1 ? "Bearish" : "—"}${pair ? `  (${pair})` : ""}`,
      color: trend === 1 ? C.up : trend === -1 ? C.down : C.text,
    },
    {
      text:
        reg === "trend"
          ? "Regime: TREND — breaks follow through"
          : reg === "chop"
            ? "Regime: CHOP — fakeout / stop-hunt risk"
            : "Regime: NEUTRAL",
      color:
        reg === "trend"
          ? trend === -1
            ? C.down
            : C.up
          : reg === "chop"
            ? C.sweep
            : C.muted,
    },
    {
      text: `Break score ${signed(r.score[i])} (need ${signed(r.minScoreEff)}) · vol ${r.volRatio[i].toFixed(2)}×${sess}`,
      color: C.muted,
    },
    {
      text: done.length
        ? `Trades ${done.length} · win ${Math.round((100 * wins) / done.length)}% · ${signed(netR, 1)}R · PF ${gl > 0 ? (gw / gl).toFixed(2) : "—"}`
        : "Trades: none yet",
      color: C.text,
    },
  ];
  g.font = FONT;
  const w = Math.max(...rows.map((x) => g.measureText(x.text).width)) + 16;
  // bottom-left, above the ribbon (the pane legend owns the top-left)
  const hBox = rows.length * 15 + 8;
  const x = rect.x + 8;
  const y = rect.y + rect.height - hBox - 22;
  g.fillStyle = C.statsBg;
  g.beginPath();
  g.roundRect(x, y, w, hBox, 5);
  g.fill();
  g.textAlign = "left";
  g.textBaseline = "middle";
  rows.forEach((row, k) => {
    g.fillStyle = row.color;
    g.fillText(row.text, x + 8, y + 11 + k * 15);
  });
}
