import { describe, expect, it } from 'vitest'

import { DEFAULT_POSITION_BRACKETS } from './positionBrackets'
import {
  bracketPriceCrossed,
  checkBracketOnTick,
  isBrokerClosablePosition,
} from './positionBracketMonitor'
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

describe('bracketPriceCrossed', () => {
  it('long take profit crosses when live is at or above target', () => {
    expect(bracketPriceCrossed(true, 110, 110, 'take_profit')).toBe(true)
    expect(bracketPriceCrossed(true, 111, 110, 'take_profit')).toBe(true)
    expect(bracketPriceCrossed(true, 109, 110, 'take_profit')).toBe(false)
  })

  it('short take profit crosses when live is at or below target', () => {
    expect(bracketPriceCrossed(false, 90, 90, 'take_profit')).toBe(true)
    expect(bracketPriceCrossed(false, 89, 90, 'take_profit')).toBe(true)
    expect(bracketPriceCrossed(false, 91, 90, 'take_profit')).toBe(false)
  })

  it('long stop loss crosses when live is at or below target', () => {
    expect(bracketPriceCrossed(true, 95, 95, 'stop_loss')).toBe(true)
    expect(bracketPriceCrossed(true, 94, 95, 'stop_loss')).toBe(true)
    expect(bracketPriceCrossed(true, 96, 95, 'stop_loss')).toBe(false)
  })

  it('short stop loss crosses when live is at or above target', () => {
    expect(bracketPriceCrossed(false, 105, 105, 'stop_loss')).toBe(true)
    expect(bracketPriceCrossed(false, 106, 105, 'stop_loss')).toBe(true)
    expect(bracketPriceCrossed(false, 104, 105, 'stop_loss')).toBe(false)
  })
})

describe('checkBracketOnTick — take profit', () => {
  it('closes on $ take profit when profit exceeds target', () => {
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

  it('closes on $ take profit when price already ran past implied target (ADGM case)', () => {
    const row = sampleRow({
      quantity: 241,
      openRate: 0.87,
      brokerLtp: 0.98,
    })
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: true,
      takeProfitMode: 'amount' as const,
      takeProfitValue: '20',
    }
    expect(checkBracketOnTick(row, brackets, 0.98)).toBe('take_profit')
  })

  it('closes on % take profit when price already ran past implied target', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: true,
      takeProfitMode: 'percent' as const,
      takeProfitValue: '5',
    }
    expect(checkBracketOnTick(row, brackets, 106)).toBe('take_profit')
    expect(checkBracketOnTick(row, brackets, 104)).toBeNull()
  })

  it('closes on price-mode take profit when live reaches target', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: true,
      takeProfitMode: 'price' as const,
      takeProfitValue: '110',
    }
    expect(checkBracketOnTick(row, brackets, 110)).toBe('take_profit')
    expect(checkBracketOnTick(row, brackets, 115)).toBe('take_profit')
    expect(checkBracketOnTick(row, brackets, 109)).toBeNull()
  })

  it('does not trigger take profit when disabled', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: false,
      takeProfitMode: 'amount' as const,
      takeProfitValue: '50',
    }
    expect(checkBracketOnTick(row, brackets, 110)).toBeNull()
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

  it('does not trigger take profit for invalid or zero targets', () => {
    const row = sampleRow()
    expect(checkBracketOnTick(row, {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: true,
      takeProfitMode: 'amount',
      takeProfitValue: '0',
    }, 110)).toBeNull()
    expect(checkBracketOnTick(row, {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: true,
      takeProfitMode: 'amount',
      takeProfitValue: '',
    }, 110)).toBeNull()
  })

  it('short $ take profit fires when price gapped past implied target', () => {
    const row = sampleRow({ isBuy: false, openRate: 100, quantity: 10 })
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: true,
      takeProfitMode: 'amount' as const,
      takeProfitValue: '50',
    }
    expect(checkBracketOnTick(row, brackets, 94)).toBe('take_profit')
  })

  it('short price-mode take profit fires when live crosses target', () => {
    const row = sampleRow({ isBuy: false, openRate: 100, quantity: 10 })
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: true,
      takeProfitMode: 'price' as const,
      takeProfitValue: '90',
    }
    expect(checkBracketOnTick(row, brackets, 90)).toBe('take_profit')
    expect(checkBracketOnTick(row, brackets, 91)).toBeNull()
  })

  it('triggers at exact $ profit threshold', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: true,
      takeProfitMode: 'amount' as const,
      takeProfitValue: '50',
    }
    expect(checkBracketOnTick(row, brackets, 105)).toBe('take_profit')
  })
})

describe('checkBracketOnTick — stop loss', () => {
  it('closes on $ stop loss when loss exceeds limit', () => {
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

  it('closes on $ stop loss when price gapped past implied stop (deeper loss)', () => {
    const row = sampleRow({ quantity: 241, openRate: 0.87 })
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      stopLossEnabled: true,
      stopLossMode: 'amount' as const,
      stopLossValue: '20',
    }
    expect(checkBracketOnTick(row, brackets, 0.78)).toBe('stop_loss')
  })

  it('closes on % stop loss when price gapped past implied stop', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      stopLossEnabled: true,
      stopLossMode: 'percent' as const,
      stopLossValue: '5',
    }
    expect(checkBracketOnTick(row, brackets, 94)).toBe('stop_loss')
    expect(checkBracketOnTick(row, brackets, 96)).toBeNull()
  })

  it('closes on price-mode stop loss when live reaches target', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      stopLossEnabled: true,
      stopLossMode: 'price' as const,
      stopLossValue: '95',
    }
    expect(checkBracketOnTick(row, brackets, 95)).toBe('stop_loss')
    expect(checkBracketOnTick(row, brackets, 90)).toBe('stop_loss')
    expect(checkBracketOnTick(row, brackets, 96)).toBeNull()
  })

  it('does not trigger stop loss when disabled', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      stopLossEnabled: false,
      stopLossMode: 'amount' as const,
      stopLossValue: '25',
    }
    expect(checkBracketOnTick(row, brackets, 90)).toBeNull()
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

  it('short $ stop loss fires when price gapped past implied stop', () => {
    const row = sampleRow({ isBuy: false, openRate: 100, quantity: 10 })
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      stopLossEnabled: true,
      stopLossMode: 'amount' as const,
      stopLossValue: '25',
    }
    expect(checkBracketOnTick(row, brackets, 103)).toBe('stop_loss')
  })

  it('short price-mode stop loss fires when live crosses target', () => {
    const row = sampleRow({ isBuy: false, openRate: 100, quantity: 10 })
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      stopLossEnabled: true,
      stopLossMode: 'price' as const,
      stopLossValue: '105',
    }
    expect(checkBracketOnTick(row, brackets, 105)).toBe('stop_loss')
    expect(checkBracketOnTick(row, brackets, 104)).toBeNull()
  })

  it('triggers at exact $ loss threshold', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      stopLossEnabled: true,
      stopLossMode: 'amount' as const,
      stopLossValue: '50',
    }
    expect(checkBracketOnTick(row, brackets, 95)).toBe('stop_loss')
  })
})

describe('checkBracketOnTick — combined', () => {
  it('prefers stop loss when losing and take profit when winning', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: true,
      takeProfitMode: 'amount' as const,
      takeProfitValue: '50',
      stopLossEnabled: true,
      stopLossMode: 'amount' as const,
      stopLossValue: '25',
    }
    expect(checkBracketOnTick(row, brackets, 105)).toBe('take_profit')
    expect(checkBracketOnTick(row, brackets, 97)).toBe('stop_loss')
    expect(checkBracketOnTick(row, brackets, 100)).toBeNull()
  })

  it('returns null for invalid live price', () => {
    const row = sampleRow()
    const brackets = {
      ...DEFAULT_POSITION_BRACKETS,
      takeProfitEnabled: true,
      takeProfitMode: 'amount' as const,
      takeProfitValue: '50',
    }
    expect(checkBracketOnTick(row, brackets, 0)).toBeNull()
    expect(checkBracketOnTick(row, brackets, -1)).toBeNull()
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
