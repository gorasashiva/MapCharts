import { describe, expect, it } from 'vitest'
import { zoneQualifies } from './bigTrades'

const green = { open: 100, high: 110, low: 95, close: 105 } // body 100–105, upper wick 105–110, lower wick 95–100
const red = { open: 105, high: 110, low: 95, close: 100 }

describe('zoneQualifies', () => {
  it('reverse = against the candle: a sell in a green candle’s upper wick', () => {
    expect(zoneQualifies(green, 108, 'sell', 'reverse', 'none')).toBe(true)
    expect(zoneQualifies(green, 108, 'buy', 'reverse', 'none')).toBe(false)
  })

  it('trend = with the candle: a buy in a green body', () => {
    expect(zoneQualifies(green, 102, 'buy', 'none', 'trend')).toBe(true)
    expect(zoneQualifies(red, 102, 'buy', 'none', 'trend')).toBe(false)
  })

  it('wick and body modes are independent', () => {
    expect(zoneQualifies(green, 102, 'sell', 'all', 'none')).toBe(false) // body trade, body mode none
    expect(zoneQualifies(green, 97, 'sell', 'all', 'none')).toBe(true) // lower wick
  })

  it('a doji has no direction: only "all" draws', () => {
    const doji = { open: 100, high: 105, low: 95, close: 100 }
    expect(zoneQualifies(doji, 103, 'buy', 'reverse', 'none')).toBe(false)
    expect(zoneQualifies(doji, 103, 'buy', 'all', 'none')).toBe(true)
  })
})
