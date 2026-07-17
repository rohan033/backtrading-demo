import { describe, expect, it } from 'vitest'

import { DEFAULT_POSITION_BRACKETS } from './positionBrackets'
import { checkBracketOnTick, isBrokerClosablePosition } from './positionBracketMonitor'
import { resolveBrokerPositionId, type EtoroPositionRow } from './etoroPositions'

function sampleRow(overrides: Partial<EtoroPositionRow> = {}): EtoroPositionRow {
  return {
    rowKey: 'pos-1',
    positionId: 'pos-1',
    brokerPositionId: '987654321',
    tradingsymbol: 'AAPL',
    displayName: 'Apple',
    symboltoken: '1001',
    quantity: 10,
    openRate: 100,
    isBuy: true,
    brokerLtp: 100,
    brokerPnl: 0,
    raw: {},
    ...overrides,
  }
}

describe('checkBracketOnTick', () => {
  it('closes on take profit when profit exceeds target', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: true,
      takeProfitMode: 'amount' as const,
      takeProfitValue: '50',
    }
    expect(checkBracketOnTick(row, brackets, 105)).toBe('take_profit')
    expect(checkBracketOnTick(row, brackets, 104)).toBeNull()
  })

  it('closes on stop loss when loss exceeds limit', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      stopLossEnabled: true,
      stopLossMode: 'amount' as const,
      stopLossValue: '25',
    }
    expect(checkBracketOnTick(row, brackets, 97.4)).toBe('stop_loss')
    expect(checkBracketOnTick(row, brackets, 97.6)).toBeNull()
  })

  it('does not trigger stop loss when in profit', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      stopLossEnabled: true,
      stopLossMode: 'amount' as const,
      stopLossValue: '25',
    }
    expect(checkBracketOnTick(row, brackets, 105)).toBeNull()
  })

  it('does not trigger take profit when in loss', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: true,
      takeProfitMode: 'amount' as const,
      takeProfitValue: '50',
    }
    expect(checkBracketOnTick(row, brackets, 95)).toBeNull()
  })
})

describe('resolveBrokerPositionId', () => {
  it('rejects instrument id used as position id', () => {
    expect(resolveBrokerPositionId(
      { positionID: '1048640', instrumentID: 1048640 },
      { position_id: '1048640', symboltoken: '1048640' },
      '1048640',
    )).toBeNull()
  })
})

describe('isBrokerClosablePosition', () => {
  it('requires verified broker position id', () => {
    expect(isBrokerClosablePosition(sampleRow())).toBe(true)
    expect(isBrokerClosablePosition(sampleRow({ brokerPositionId: null }))).toBe(false)
  })
})
