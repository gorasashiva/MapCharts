import { afterEach, describe, expect, it } from 'vitest'
import { displayZoneOffset, formatFullTime, getDisplayTimeZone, setDisplayTimeZone } from './scales'

const MIN = 60_000
const H = 60 * MIN

describe('display time zone', () => {
  afterEach(() => setDisplayTimeZone('Asia/Kolkata'))

  it('defaults to IST', () => {
    expect(getDisplayTimeZone()).toBe('Asia/Kolkata')
    expect(formatFullTime(Date.UTC(2024, 0, 1, 0, 0), MIN)).toBe("Mon 1 Jan '24  05:30")
  })

  it('switches the axis/crosshair labels to UTC', () => {
    setDisplayTimeZone('UTC')
    expect(displayZoneOffset(Date.UTC(2024, 0, 1))).toBe(0)
    expect(formatFullTime(Date.UTC(2024, 0, 1, 0, 0), MIN)).toBe("Mon 1 Jan '24  00:00")
  })

  it('follows daylight saving for DST zones', () => {
    setDisplayTimeZone('America/New_York')
    expect(displayZoneOffset(Date.UTC(2024, 0, 15, 12))).toBe(-5 * H) // EST
    expect(displayZoneOffset(Date.UTC(2024, 6, 15, 12))).toBe(-4 * H) // EDT
    expect(formatFullTime(Date.UTC(2024, 6, 15, 12, 0), MIN)).toBe("Mon 15 Jul '24  08:00")
  })

  it('ignores an unknown zone', () => {
    setDisplayTimeZone('Not/AZone')
    expect(getDisplayTimeZone()).toBe('Asia/Kolkata')
  })
})
