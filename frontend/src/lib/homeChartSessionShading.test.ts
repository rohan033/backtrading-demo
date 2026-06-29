import { describe, expect, it } from 'vitest'

import { buildChartSessionBands, zonedWallTimeToUnix } from './homeChartSessionShading'

describe('zonedWallTimeToUnix', () => {
  it('maps US session boundaries to expected UTC instants in summer', () => {
    const tz = 'America/New_York'
    const day = { year: 2026, month: 6, day: 29 }

    expect(zonedWallTimeToUnix(day.year, day.month, day.day, 4, 0, tz)).toBe(
      Date.parse('2026-06-29T08:00:00.000Z') / 1000,
    )
    expect(zonedWallTimeToUnix(day.year, day.month, day.day, 9, 30, tz)).toBe(
      Date.parse('2026-06-29T13:30:00.000Z') / 1000,
    )
    expect(zonedWallTimeToUnix(day.year, day.month, day.day, 16, 0, tz)).toBe(
      Date.parse('2026-06-29T20:00:00.000Z') / 1000,
    )
  })
})

describe('buildChartSessionBands', () => {
  it('labels midday UTC as US pre-market before the cash open', () => {
    const open = zonedWallTimeToUnix(2026, 6, 29, 9, 30, 'America/New_York')
    const bands = buildChartSessionBands(open - 2 * 3600, open + 3600, 'US')
    const atNoonUtc = open - 90 * 60

    const active = bands.find(band => atNoonUtc >= band.fromTime && atNoonUtc < band.toTime)
    expect(active?.session).toBe('pre')
  })

  it('labels the US cash open instant as regular session', () => {
    const open = zonedWallTimeToUnix(2026, 6, 29, 9, 30, 'America/New_York')
    const bands = buildChartSessionBands(open - 3600, open + 3600, 'US')

    const active = bands.find(band => open >= band.fromTime && open < band.toTime)
    expect(active?.session).toBe('open')
  })
})
