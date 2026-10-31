import { describe, expect, it } from 'vitest'
import { encodeBook, encodeGap, encodeMeta, encodeTrade, hourKey, parseLine } from './bookTape'

describe('Book tape — line format', () => {
  it('round-trips every record kind', () => {
    expect(parseLine(encodeMeta(1000, 'XAUTUSD', 0.001))).toEqual({ kind: 'meta', recvMs: 1000, symbol: 'XAUTUSD', contractValue: 0.001 })
    expect(parseLine(encodeBook(2000, 1990, 'snapshot', [[3949.03, 1.313]], [[3949.1, 0.5]]))).toEqual({
      kind: 'book', recvMs: 2000, exchMs: 1990, action: 'snapshot', bids: [[3949.03, 1.313]], asks: [[3949.1, 0.5]],
    })
    expect(parseLine(encodeBook(2001, 1991, 'update', [[3949.03, 0]], []))).toMatchObject({ action: 'update', bids: [[3949.03, 0]] })
    expect(parseLine(encodeTrade(3000, 2_999_500, 3949.1, 0.25, false))).toEqual({ kind: 'trade', recvMs: 3000, timeUs: 2_999_500, price: 3949.1, qty: 0.25, buy: false })
    expect(parseLine(encodeGap(4000, 'sequence gap'))).toEqual({ kind: 'gap', recvMs: 4000, reason: 'sequence gap' })
  })

  it('skips blank, torn and unknown lines instead of failing the replay', () => {
    expect(parseLine('')).toBeNull()
    expect(parseLine('["b",2000,1990,"u",[[3949.03,1.3')).toBeNull() // a crash mid-write
    expect(parseLine('["x",1]')).toBeNull()
    expect(parseLine('["b",2000,1990,"u","oops",[]]')).toBeNull()
  })

  it('files lines by UTC day and hour of receipt', () => {
    expect(hourKey(Date.UTC(2026, 9, 30, 13, 59, 59))).toEqual({ day: '2026-10-30', hour: '13' })
    expect(hourKey(Date.UTC(2026, 9, 31, 0, 0, 0))).toEqual({ day: '2026-10-31', hour: '00' })
  })
})
