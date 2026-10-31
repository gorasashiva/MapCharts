// Book tape — the line format the book recorder writes and the DOM replay
// reads: Delta's order book and trades for one market, in the order they
// arrived, so a replay sees exactly what a live DOM dashboard saw.
//
// One JSON array per line (ndjson), files per UTC hour, gzipped once the hour
// is over. Every line starts with a tag and the local receive time (ms):
//   ['m', recvMs, {symbol, contractValue}]           file / connection start
//   ['b', recvMs, exchMs, 's'|'u', bids, asks]        book snapshot / update; [price, qtyBase][] (qty 0 = level gone)
//   ['t', recvMs, timeUs, price, qtyBase, side]       trade; side 1 = taker buy, -1 = taker sell
//   ['g', recvMs, reason]                             gap: book continuity lost until the next snapshot
//
// No imports, so the recorder (plain Node) can load this file directly.

export type BookLevels = [number, number][]

export type BookTapeRecord =
  | { kind: 'meta'; recvMs: number; symbol: string; contractValue: number }
  | { kind: 'book'; recvMs: number; exchMs: number; action: 'snapshot' | 'update'; bids: BookLevels; asks: BookLevels }
  | { kind: 'trade'; recvMs: number; timeUs: number; price: number; qty: number; buy: boolean }
  | { kind: 'gap'; recvMs: number; reason: string }

export function encodeMeta(recvMs: number, symbol: string, contractValue: number): string {
  return JSON.stringify(['m', recvMs, { symbol, contractValue }])
}

export function encodeBook(recvMs: number, exchMs: number, action: 'snapshot' | 'update', bids: BookLevels, asks: BookLevels): string {
  return JSON.stringify(['b', recvMs, exchMs, action === 'snapshot' ? 's' : 'u', bids, asks])
}

export function encodeTrade(recvMs: number, timeUs: number, price: number, qty: number, buy: boolean): string {
  return JSON.stringify(['t', recvMs, timeUs, price, qty, buy ? 1 : -1])
}

export function encodeGap(recvMs: number, reason: string): string {
  return JSON.stringify(['g', recvMs, reason])
}

const isLevels = (x: unknown): x is BookLevels =>
  Array.isArray(x) && x.every((l) => Array.isArray(l) && l.length === 2 && typeof l[0] === 'number' && typeof l[1] === 'number')

/** One line back into a record; null for a blank, torn or unknown line (a crash can leave a partial last line). */
export function parseLine(line: string): BookTapeRecord | null {
  if (!line.trim()) return null
  let a: unknown
  try {
    a = JSON.parse(line)
  } catch {
    return null
  }
  if (!Array.isArray(a) || typeof a[1] !== 'number') return null
  switch (a[0]) {
    case 'm':
      return a[2] && typeof a[2].symbol === 'string' ? { kind: 'meta', recvMs: a[1], symbol: a[2].symbol, contractValue: Number(a[2].contractValue) || 1 } : null
    case 'b':
      return (a[3] === 's' || a[3] === 'u') && isLevels(a[4]) && isLevels(a[5])
        ? { kind: 'book', recvMs: a[1], exchMs: Number(a[2]) || a[1], action: a[3] === 's' ? 'snapshot' : 'update', bids: a[4], asks: a[5] }
        : null
    case 't':
      return typeof a[3] === 'number' && typeof a[4] === 'number'
        ? { kind: 'trade', recvMs: a[1], timeUs: Number(a[2]) || a[1] * 1000, price: a[3], qty: a[4], buy: a[5] === 1 }
        : null
    case 'g':
      return { kind: 'gap', recvMs: a[1], reason: String(a[2] ?? '') }
    default:
      return null
  }
}

/** Where a line received at `recvMs` is filed: <YYYY-MM-DD>/<HH> (UTC). */
export function hourKey(recvMs: number): { day: string; hour: string } {
  const iso = new Date(recvMs).toISOString()
  return { day: iso.slice(0, 10), hour: iso.slice(11, 13) }
}
