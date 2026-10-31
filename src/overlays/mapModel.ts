/**
 * THE MAP (clone) — port of "map.pine", itself a rebuild of "THE MAP by SYNDICATE".
 *
 * The original reads an external options scan (GEX / OI / 0DTE). Neither Pine nor this
 * chart can, so the levels are the SNAPSHOT pasted into map.pine ("Updated 9 Oct 2026
 * 07:51 GMT"); refresh MAP_DATA when the source updates. Per ticker:
 *   GEX levels  VU trigger, call wall, GEX flip, HVL, max pain, put wall, VD trigger
 *   0DTE        call, put, zero-gamma
 *   OI walls    max call / put OI for every expiry combined, 1st, 2nd, 3rd expiry
 *   heatmap     strike : bar length : sign (+ call / − put)
 * plus the status table (gamma regime, day bias) and the engulfing-retest bar colour.
 *
 * map.pine matches the chart ticker exactly. Delta's symbols differ, so ALIASES maps them
 * (PAXGUSD / XAUTUSD -> XAUUSD, BTCUSD -> BTCUSDT.P); a ticker can also be picked by hand.
 *
 * Pure — no DOM / engine.
 */

export interface MapBar {
  open: number
  high: number
  low: number
  close: number
}

export const MAP_UPDATED = 'Updated 9 Oct 2026 07:51 GMT'
export const MAP_UPDATED_0DTE = '(last update HKT 9 Oct 15:50)'

/** Row format (verbatim from map.pine): "VU,CW,FLIP,HVL,MAXPAIN,PW,VD | 0DTE call,put,0γ | OI every c,p, 1st c,p, 2nd c,p, 3rd c,p | heat strike:len:sign;…" */
export const MAP_DATA: Record<string, string> = {
  AAPL: '341.5,340,332.5,340,335,330,328.5|340,335,332.28|340,330,340,330,335,335,340,330|330:2:-1;335:2:1;337.5:11:1;340:30:1;342.5:11:1;345:17:1;347.5:9:1;350:2:1',
  AMD: '643,640,634,640,625,607.5,604.5|640,607.5,633.78|640,600,640,600,672.5,600,670,625|590:5:-1;595:4:-1;600:16:-1;605:10:-1;607.5:22:-1;610:7:-1;615:5:-1;620:13:-1;622.5:6:-1;627.5:7:1;640:30:1;645:6:1',
  AMZN: '254,252.5,248.5,252.5,250,245,244|252.5,245,248.57|265,250,265,240,252.5,255,275,242.5|245:2:-1;252.5:30:1;255:13:1;257.5:23:1;260:27:1;262.5:10:1;265:10:1;267.5:3:1;270:2:1;275:2:1',
  'BTCUSDT.P':
    '84693.3331,84693.3331,83811.1109,82928.8887,83811.1109,81164.4442,81164.4442|84693.3331,82928.8887,83634.6665|88222.222,82928.8887,88222.222,81164.4442,85575.5553,82928.8887,86457.7776,84693.3331|79399.9998:2:-1;80282.222:2:-1;81164.4442:24:-1;82046.6665:5:-1;82928.8887:30:-1;83811.1109:5:1;84693.3331:5:1;85575.5553:5:1;86457.7776:6:1;88222.222:4:1',
  GLD: '382,380,381,382,381,378,376|382,378,381.04|400,350,400,350,391,355,380,376|365:6:-1;368:8:-1;370:5:-1;371:5:-1;374:7:-1;375:18:-1;376:7:-1;377:8:-1;378:27:-1;380:21:1;382:30:1;383:9:1',
  GOOGL: '351.5,350,343,350,342.5,340,338.5|350,340,342.81|415,340,415,340,360,315,372.5,345|340:6:-1;345:4:1;347.5:10:1;350:30:1;352.5:11:1;355:23:1;357.5:9:1;360:7:1',
  IWM: '281.5,280,281,277,280,277,275.5|280,279,281.12|285,279,285,279,283,275,285,267|270:2:-1;271:2:-1;272:5:-1;273:6:-1;274:6:-1;275:22:-1;276:17:-1;277:30:-1;278:5:-1;279:30:-1;280:2:-1;283:5:1',
  META: '728.5,725,720.5,722.5,722.5,700,696.5|722.5,720,720.5|750,700,780,700,750,730,735,735|700:27:-1;705:11:-1;707.5:8:-1;710:14:-1;712.5:10:-1;715:17:-1;722.5:30:1;725:21:1;730:15:1;735:14:1;737.5:19:1;740:27:1',
  MSFT: '532.5,530,528.5,530,520,517.5,515|530,527.5,528.3|530,510,530,510,550,515,525,517.5|510:5:-1;512.5:3:-1;515:3:-1;517.5:6:-1;520:3:-1;525:10:1;527.5:14:-1;530:30:1;532.5:4:1;535:6:1;540:5:1;545:3:1',
  NVDA: '236,235,234.5,230,232.5,230,229|235,230,234.54|240,230,240,230,240,237.5,250,237.5|217.5:2:-1;220:5:-1;222.5:8:-1;225:11:-1;227.5:11:-1;230:30:-1;232.5:14:-1;235:2:1;237.5:6:1;240:13:1;242.5:3:1;245:4:1',
  QQQ: '758,754,733.5,750,750,740,736.5|754,744,733.5|754,730,754,730,780,738,785,740|730:12:-1;735:5:-1;738:17:-1;740:22:-1;742:20:-1;744:18:-1;745:10:-1;748:6:1;749:8:-1;750:30:-1;751:5:-1;752:8:-1',
  SPX: '7839,7800,7766.5,7825,7725,7750,7711|7800,7750,7766.44|7900,6300,7900,6300,8025,6300,7825,6300|7650:11:-1;7700:12:-1;7730:11:-1;7750:29:-1;7790:11:-1;7795:11:1;7800:24:1;7805:20:1;7810:10:1;7815:18:1;7820:17:1;7825:30:1',
  SPX500USD: '7866.4,7826.3,7796.2,7695.8,7766.1,7695.8,7655.7|7826.3,7695.8,7796.9|7876.4,7695.8,7876.4,7695.8,7876.4,6822.9,7926.6,7023.6|7675.8:5:-1;7695.8:30:-1;7705.9:3:-1;7725.9:6:-1;7746:4:-1;7756:7:-1;7776.1:6:-1;7786.1:3:-1;7806.2:4:1;7826.3:21:1;7836.3:4:1;7846.3:4:1',
  SPY: '784,780,777,767,774,767,763|780,767,777.07|785,767,785,767,785,680,790,700|765:5:-1;767:30:-1;768:3:-1;770:6:-1;772:4:-1;773:7:-1;775:6:-1;776:3:-1;778:4:1;780:21:1;781:4:1;782:4:1',
  TSLA: '374.5,372.5,361,372.5,370,370,368|372.5,370,361.23|400,370,400,370,400,310,400,370|360:3:-1;365:5:-1;367.5:4:-1;370:11:-1;372.5:30:1;375:24:1;380:25:1;382.5:21:1;385:15:1;387.5:4:1;390:11:1;392.5:2:1',
  XAUUSD: '4167.6,4145.8,4156.7,4167.6,4156.7,4124,4102.2|4167.6,4124,4157.1|4364,3818.5,4364,3818.5,4265.8,3873.1,4145.8,4102.2|3982.2:6:-1;4014.9:8:-1;4036.7:5:-1;4047.6:5:-1;4080.3:7:-1;4091.2:18:-1;4102.2:7:-1;4113.1:8:-1;4124:27:-1;4145.8:21:1;4167.6:30:1;4178.5:9:1',
}
export const MAP_TICKERS = Object.keys(MAP_DATA)

/** Delta / Binance symbols -> the snapshot row they track. */
const ALIASES: Record<string, string> = {
  PAXGUSD: 'XAUUSD',
  PAXGUSDT: 'XAUUSD',
  XAUTUSD: 'XAUUSD',
  XAUTUSDT: 'XAUUSD',
  XAUUSDT: 'XAUUSD',
  BTCUSD: 'BTCUSDT.P',
  BTCUSDT: 'BTCUSDT.P',
}

/** The snapshot ticker used for a chart symbol ('' = none). */
export function mapTickerFor(symbol: string): string {
  const s = symbol.toUpperCase().replace(/^.*:/, '')
  if (MAP_DATA[s]) return s
  return ALIASES[s] ?? ''
}

export type MapOiExpiry = 'Every Expiry' | '1st Expiry' | '2nd Expiry' | '3rd Expiry'
export interface MapLevels {
  ticker: string
  vu: number
  callWall: number
  flip: number
  hvl: number
  maxPain: number
  putWall: number
  vd: number
  z: { call: number; put: number; zero: number }
  oiCall: number
  oiPut: number
  heat: { strike: number; len: number; sign: 1 | -1 }[]
  /** Total net GEX (live chain only; NaN for the snapshot) — the regime when there is no flip. */
  netGex: number
}

const num = (s: string | undefined): number => (s === undefined || s === '' || s === 'na' ? Number.NaN : Number(s))

export function parseMapRow(ticker: string, oiExpiry: MapOiExpiry): MapLevels | null {
  const row = MAP_DATA[ticker]
  if (!row) return null
  const parts = row.split('|')
  const g = parts[0].split(',')
  const z = parts[1].split(',')
  const o = parts[2].split(',')
  const k = oiExpiry === '1st Expiry' ? 1 : oiExpiry === '2nd Expiry' ? 2 : oiExpiry === '3rd Expiry' ? 3 : 0
  const heat =
    parts.length > 3 && parts[3] !== ''
      ? parts[3].split(';').map((h) => {
          const f = h.split(':')
          return { strike: num(f[0]), len: Math.round(num(f[1])), sign: (num(f[2]) > 0 ? 1 : -1) as 1 | -1 }
        })
      : []
  return {
    ticker,
    vu: num(g[0]),
    callWall: num(g[1]),
    flip: num(g[2]),
    hvl: num(g[3]),
    maxPain: num(g[4]),
    putWall: num(g[5]),
    vd: num(g[6]),
    z: { call: num(z[0]), put: num(z[1]), zero: num(z[2]) },
    oiCall: num(o[2 * k]),
    oiPut: num(o[2 * k + 1]),
    heat,
    netGex: Number.NaN,
  }
}

// ---------------------------------------------------------------------------
// Live levels from an option chain (Delta India publishes XAUT / BTC / ETH options
// with its own gamma and open interest). Same dollar-gamma convention as gex.ts:
// gamma × OI (base units) × spot² × 1%, calls positive, puts negative.
// ---------------------------------------------------------------------------
export interface MapChainRow {
  side: 'CALL' | 'PUT'
  strike: number
  expiry: number // epoch ms
  gamma: number
  openInterest: number // base units
}

interface StrikeAgg {
  strike: number
  callGex: number
  putGex: number
  net: number
  callOI: number
  putOI: number
}

function aggregate(rows: MapChainRow[], spot: number): StrikeAgg[] {
  const m = new Map<number, StrikeAgg>()
  for (const r of rows) {
    const a = m.get(r.strike) ?? { strike: r.strike, callGex: 0, putGex: 0, net: 0, callOI: 0, putOI: 0 }
    const gex = (r.gamma || 0) * (r.openInterest || 0) * spot * spot * 0.01
    if (r.side === 'CALL') {
      a.callGex += gex
      a.callOI += r.openInterest || 0
    } else {
      a.putGex -= gex
      a.putOI += r.openInterest || 0
    }
    a.net = a.callGex + a.putGex
    m.set(r.strike, a)
  }
  return [...m.values()].sort((x, y) => x.strike - y.strike)
}

/** A cumulative minimum smaller than this share of the largest |cumulative| is noise
 *  (e.g. a far-OTM strike holding ~$0 of GEX), not a negative-gamma region. */
const FLIP_NOISE = 0.01

/**
 * Zero gamma (map.pine's tooltip): walk strikes upward accumulating net GEX; the first
 * strike where the cumulative turns from negative to positive after its global minimum,
 * linearly interpolated. NaN when there is none — the book is net positive at every
 * strike (minimum not meaningfully negative) or never recovers above zero. Callers then
 * read the regime from the sign of total net GEX. Shared by GEX (gex.ts) and THE MAP.
 */
export function gexFlip(levels: { strike: number; net: number }[]): number {
  const cum: number[] = []
  let c = 0
  for (const l of levels) cum.push((c += l.net))
  const maxAbs = cum.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  if (!(maxAbs > 0)) return Number.NaN
  let minI = 0
  cum.forEach((v, i) => {
    if (v < cum[minI]) minI = i
  })
  if (cum[minI] > -FLIP_NOISE * maxAbs) return Number.NaN
  for (let i = minI + 1; i < cum.length; i++) {
    if (cum[i - 1] < 0 && cum[i] >= 0) {
      const t = -cum[i - 1] / (cum[i] - cum[i - 1])
      return levels[i - 1].strike + (levels[i].strike - levels[i - 1].strike) * t
    }
  }
  return Number.NaN
}

/** Strike where the total payout to option holders (all expiries) is smallest. */
export function maxPain(levels: { strike: number; callOI: number; putOI: number }[]): number {
  let best = Number.NaN
  let bestPay = Infinity
  for (const k of levels) {
    let pay = 0
    for (const l of levels) {
      if (k.strike > l.strike) pay += l.callOI * (k.strike - l.strike)
      if (k.strike < l.strike) pay += l.putOI * (l.strike - k.strike)
    }
    if (pay < bestPay) {
      bestPay = pay
      best = k.strike
    }
  }
  return best
}

const argmax = <T,>(xs: T[], f: (x: T) => number): T | undefined => xs.reduce<T | undefined>((b, x) => (b === undefined || f(x) > f(b) ? x : b), undefined)

export interface MapLiveMeta {
  contracts: number
  expiries: number[]
  zeroDteExpiry: number | null
  totalOI: number
  spot: number
}

/**
 * MAP levels from a live chain. VU / VD triggers follow map.pine's descriptions (the
 * original's method is not public) as mirror images: VU = the strike above the call wall
 * where net GEX jumps up most on the way UP; VD = the strike below the put wall where it
 * drops most on the way DOWN (to the next strike below). This reproduces the snapshot's
 * VD on every row whose heatmap shows the neighbouring strikes (XAUUSD, GLD, BTC).
 */
export function computeMapLevelsFromChain(
  rows: MapChainRow[],
  spot: number,
  now: number,
  oiExpiry: MapOiExpiry,
  ticker: string,
): { levels: MapLevels; meta: MapLiveMeta } | null {
  const live = rows.filter((r) => r.expiry > now && Number.isFinite(r.strike))
  if (!live.length || !(spot > 0)) return null
  const expiries = [...new Set(live.map((r) => r.expiry))].sort((a, b) => a - b)
  const all = aggregate(live, spot)
  if (!all.length) return null

  const cw = argmax(all, (l) => l.callGex)!
  const pw = argmax(all, (l) => -l.putGex)!
  const callWall = cw.callGex > 0 ? cw.strike : Number.NaN
  const putWall = pw.putGex < 0 ? pw.strike : Number.NaN
  const flip = gexFlip(all)
  const hvl = argmax(all, (l) => l.callOI + l.putOI)!.strike
  const mp = maxPain(all)

  let vu = callWall
  let bestUp = 0
  let vd = putWall
  let bestDn = 0
  for (let i = 1; i < all.length; i++) {
    const step = all[i].net - all[i - 1].net
    if (Number.isFinite(callWall) && all[i].strike > callWall && step > bestUp) {
      bestUp = step
      vu = all[i].strike
    }
    if (Number.isFinite(putWall) && all[i].strike < putWall && step > bestDn) {
      bestDn = step
      vd = all[i].strike
    }
  }

  // 0DTE = the nearest expiry only
  const z0 = expiries[0]
  const zAll = aggregate(live.filter((r) => r.expiry === z0), spot)
  const zc = argmax(zAll, (l) => l.callGex)
  const zp = argmax(zAll, (l) => -l.putGex)
  const z = {
    call: zc && zc.callGex > 0 ? zc.strike : Number.NaN,
    put: zp && zp.putGex < 0 ? zp.strike : Number.NaN,
    zero: gexFlip(zAll),
  }

  // OI walls for the chosen expiry set
  const k = oiExpiry === '1st Expiry' ? 0 : oiExpiry === '2nd Expiry' ? 1 : oiExpiry === '3rd Expiry' ? 2 : -1
  const oiRows = k < 0 ? live : live.filter((r) => r.expiry === expiries[k])
  const oiAgg = aggregate(oiRows, spot)
  const oc = argmax(oiAgg, (l) => l.callOI)
  const op = argmax(oiAgg, (l) => l.putOI)

  // Heatmap: the 12 strikes with the largest |net GEX|, bar length scaled to 30
  const top = [...all].filter((l) => l.net !== 0).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 12)
  const maxAbs = Math.max(...top.map((l) => Math.abs(l.net)), 0)
  const heat = top
    .map((l) => ({ strike: l.strike, len: Math.max(1, Math.round((30 * Math.abs(l.net)) / maxAbs)), sign: (l.net > 0 ? 1 : -1) as 1 | -1 }))
    .sort((a, b) => a.strike - b.strike)

  return {
    levels: {
      ticker,
      vu,
      callWall,
      flip,
      hvl,
      maxPain: mp,
      putWall,
      vd,
      z,
      oiCall: oc && oc.callOI > 0 ? oc.strike : Number.NaN,
      oiPut: op && op.putOI > 0 ? op.strike : Number.NaN,
      heat,
      netGex: all.reduce((s, l) => s + l.net, 0),
    },
    meta: { contracts: live.length, expiries, zeroDteExpiry: z0 ?? null, totalOI: live.reduce((a, r) => a + (r.openInterest || 0), 0), spot },
  }
}

/** GEX levels in the original's creation order. */
export function gexLevels(l: MapLevels): { name: string; price: number }[] {
  return [
    { name: 'VU TRIGGER', price: l.vu },
    { name: 'CALL WALL', price: l.callWall },
    { name: 'GEX FLIP', price: l.flip },
    { name: 'HVL', price: l.hvl },
    { name: 'MAX PAIN', price: l.maxPain },
    { name: 'PUT WALL', price: l.putWall },
    { name: 'VD TRIGGER', price: l.vd },
  ]
}

/** Status table state (inferred in map.pine — the original's source is protected). */
export function mapStatus(l: MapLevels, close: number): { posGamma: boolean; regime: string; bias: string; biasSide: 1 | -1 | 0 } {
  // No flip: the whole book is one sign — take it from total net GEX (snapshot: NaN -> negative, as map.pine's na compare).
  const posGamma = Number.isFinite(l.flip) ? close >= l.flip : l.netGex > 0
  const bias =
    close > l.vu ? 'VU SQUEEZE ^^' : close > l.callWall ? 'ABOVE CALL +' : close < l.vd ? 'VD BREAK vv' : close < l.putWall ? 'PUT BREAK --' : posGamma ? 'RANGE DAY' : 'VOLATILE !'
  return { posGamma, regime: posGamma ? 'POS  PINNED' : 'NEG  TRENDING', bias, biasSide: close > l.callWall ? 1 : close < l.putWall ? -1 : 0 }
}

export interface MapAction {
  /** BUY / SELL = confirmed entry; WAIT = level in play, no confirmation; HOLD OFF = don't fade a breakout; NONE = no level in play. */
  kind: 'BUY' | 'SELL' | 'WAIT' | 'HOLD OFF' | 'NONE'
  text: string
}

const fmtLevel = (p: number): string => (p >= 1000 ? p.toFixed(0) : p >= 10 ? p.toFixed(2) : p.toPrecision(5))

/**
 * Entry rules at the 0DTE walls (falls back to the all-expiry call / put wall when the
 * nearest expiry has none), judged on CLOSED bars only so the advice doesn't flicker
 * with the forming candle. Exactly one rule is reported, in this priority:
 *   1. broke above the Call Wall, retested it and printed a bullish candle → BUY breakout
 *      (broke below the Put Wall, retested, bearish candle → SELL breakdown)
 *   2. broke a wall and is still running (> 1 ATR beyond, no retest) → HOLD OFF: don't trade against it
 *      (broke but not yet retested / retest without confirmation → WAIT)
 *   3. Put Wall touched and held + bullish candle → BUY; Call Wall held + bearish candle → SELL
 *   4. a wall touched without that confirmation candle → WAIT
 *   5. otherwise NONE (price between the walls)
 * "Touch" = within 0.25 ATR(14) of the level; the hold / retest window is the last 3 closed bars,
 * a breakout is looked for in the last 20.
 */
export function zeroDteAction(bars: MapBar[], l: MapLevels): MapAction {
  const closed = bars.slice(0, -1) // the last bar is still forming
  const n = closed.length
  const zc = Number.isFinite(l.z.call)
  const zp = Number.isFinite(l.z.put)
  const C = zc ? l.z.call : l.callWall
  const P = zp ? l.z.put : l.putWall
  const cName = `${zc ? '0DTE ' : ''}Call Wall ${fmtLevel(C)}`
  const pName = `${zp ? '0DTE ' : ''}Put Wall ${fmtLevel(P)}`
  if (n < 16 || (!Number.isFinite(C) && !Number.isFinite(P))) return { kind: 'NONE', text: 'No 0DTE levels yet' }

  let trSum = 0
  for (let i = n - 14; i < n; i++) {
    const b = closed[i]
    const pc = closed[i - 1].close
    trSum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc))
  }
  const atr = trSum / 14
  const last = closed[n - 1]
  const tol = Math.max(0.25 * atr, last.close * 0.0002)
  const bull = last.close > last.open
  const bear = last.close < last.open
  const recent = closed.slice(n - 3)

  // 1–2. Breakouts: the most recent close through the wall within 20 bars that hasn't failed since.
  const breakout = (lvl: number, dir: 1 | -1): MapAction | null => {
    if (!Number.isFinite(lvl)) return null
    let b = -1
    for (let i = n - 1; i >= Math.max(1, n - 20); i--) {
      if (dir * (closed[i].close - lvl) > 0 && dir * (closed[i - 1].close - lvl) <= 0) {
        b = i
        break
      }
    }
    if (b < 0) return null
    for (let i = b; i < n; i++) if (dir * (closed[i].close - lvl) < -tol) return null // closed back through: failed
    const name = dir > 0 ? cName : pName
    let retest = false
    for (let i = b + 1; i < n; i++) if (dir > 0 ? closed[i].low <= lvl + tol : closed[i].high >= lvl - tol) retest = true
    if (retest && (dir > 0 ? bull : bear) && dir * (last.close - lvl) > 0) {
      return dir > 0 ? { kind: 'BUY', text: `BUY breakout · ${name} retest held` } : { kind: 'SELL', text: `SELL breakdown · ${name} retest held` }
    }
    if (retest) return { kind: 'WAIT', text: `WAIT · retesting broken ${name}, needs ${dir > 0 ? 'bullish' : 'bearish'} candle` }
    if (dir * (last.close - lvl) > atr) return { kind: 'HOLD OFF', text: `Strong break ${dir > 0 ? 'above' : 'below'} ${name} · don't ${dir > 0 ? 'sell' : 'buy'} against it` }
    return { kind: 'WAIT', text: `WAIT · broke ${dir > 0 ? 'above' : 'below'} ${name}, wait for retest` }
  }
  const up = breakout(C, 1)
  const dn = breakout(P, -1)
  for (const a of [up, dn]) if (a && (a.kind === 'BUY' || a.kind === 'SELL')) return a
  if (up || dn) return (up ?? dn)!

  // 3–4. Walls holding.
  if (Number.isFinite(P) && recent.some((b) => b.low <= P + tol) && last.close > P) {
    return bull ? { kind: 'BUY', text: `BUY · ${pName} held, bullish confirmation` } : { kind: 'WAIT', text: `WAIT · at ${pName}, no bullish confirmation yet` }
  }
  if (Number.isFinite(C) && recent.some((b) => b.high >= C - tol) && last.close < C) {
    return bear ? { kind: 'SELL', text: `SELL · ${cName} held, bearish confirmation` } : { kind: 'WAIT', text: `WAIT · at ${cName}, no bearish confirmation yet` }
  }
  return {
    kind: 'NONE',
    text: Number.isFinite(P) && Number.isFinite(C) ? `No setup · price between ${fmtLevel(P)} and ${fmtLevel(C)}` : 'No setup · no 0DTE level in play',
  }
}

/**
 * Engulfing retest at a GEX level, per bar (1 bull / −1 bear / 0): the previous bar closed within
 * 0.05% of a level on the same side, this bar trades through it, closes away from it and beyond
 * the previous bar's body. Levels are tried in order; the first that qualifies decides.
 */
export function engulfingRetest(bars: MapBar[], l: MapLevels): (1 | -1 | 0)[] {
  const levels = gexLevels(l).map((x) => x.price).filter((p) => Number.isFinite(p))
  return bars.map((b, i) => {
    if (i === 0) return 0
    const p = bars[i - 1]
    for (const lv of levels) {
      if (Math.abs(p.close - lv) > b.close * 0.0005 || b.low > lv || b.high < lv) continue
      if (b.close > lv && p.close > lv && b.close > b.open && b.close > Math.max(p.open, p.close)) return 1
      if (b.close < lv && p.close < lv && b.close < b.open && b.close < Math.min(p.open, p.close)) return -1
    }
    return 0
  })
}
