export type MomentumQueueStatus =
  | 'watching'
  | 'triggered'
  | 'awaiting_approval'
  | 'queued'
  | 'deploying'
  | 'placed'
  | 'failed'
  | 'skipped'

export type ArmedMomentumEntry = {
  tickKey: string
  watchlistId: string
  symboltoken: string
  tradingsymbol: string
  broker: string
  tradeEnv: 'live' | 'demo'
  noTakeProfit: boolean
}

export type MomentumQueueEntry = {
  id: string
  tickKey: string
  watchlistId: string
  symboltoken: string
  tradingsymbol: string
  broker: string
  tradeEnv: 'live' | 'demo'
  noTakeProfit: boolean
  status: MomentumQueueStatus
  signalHeadline?: string
  signalDetail?: string
  currentPrice?: number | null
  entryPrice?: number | null
  executionId?: string
  errorMessage?: string
  updatedAt: number
}

export const MOMENTUM_QUEUE_CHANGED_EVENT = 'momentum-queue-changed'

export function notifyMomentumQueueChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(MOMENTUM_QUEUE_CHANGED_EVENT))
}
