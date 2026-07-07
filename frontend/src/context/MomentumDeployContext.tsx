import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import MomentumLiveApproval, {
  type LiveApprovalRequest,
} from '../components/momentum/MomentumLiveApproval'
import {
  type ArmedMomentumEntry,
  type MomentumQueueEntry,
  type MomentumQueueStatus,
  notifyMomentumQueueChanged,
} from '../lib/momentumQueue'
import { showPlatformToast } from '../lib/platform-toast'
import type { MomentumConfig, MomentumSignal } from '../lib/watchlistMomentum'
import { createAndStartMomentumStrategy } from '../lib/watchlistMomentumStrategy'

type MomentumTradeCallback = (params: {
  watchlistId: string
  symboltoken: string
  tradingsymbol: string
  exchange: string
  broker: string
  executionId: string
  entryPrice: number
  accountEnv: 'live' | 'demo'
  noTakeProfit: boolean
}) => void

const LIVE_APPROVAL_MS = 5000
const DEPLOY_GAP_MS = 3100

type DeployJob = {
  id: string
  tickKey: string
  watchlistId: string
  symboltoken: string
  tradingsymbol: string
  broker: string
  exchange: string
  token: string
  tradeEnv: 'live' | 'demo'
  noTakeProfit: boolean
  closePrice: number
  signal?: MomentumSignal
}

type MomentumDeployContextValue = {
  queue: MomentumQueueEntry[]
  armedSymbols: ArmedMomentumEntry[]
  armSymbol: (entry: ArmedMomentumEntry) => void
  armSymbols: (entries: ArmedMomentumEntry[]) => void
  disarmSymbol: (tickKey: string) => void
  disarmSymbols: (tickKeys: string[]) => void
  upsertWatching: (entries: Omit<MomentumQueueEntry, 'status' | 'updatedAt'>[]) => void
  handleMomentumSignal: (args: {
    tickKey: string
    watchlistId: string
    symboltoken: string
    tradingsymbol: string
    broker: string
    exchange: string
    token: string
    tradeEnv: 'live' | 'demo'
    noTakeProfit: boolean
    closePrice: number
    signal: MomentumSignal
    autoDemo: boolean
  }) => void
}

const MomentumDeployContext = createContext<MomentumDeployContextValue | null>(null)

function queueId(tickKey: string): string {
  return tickKey
}

function queueEntryFromArmed(
  entry: ArmedMomentumEntry,
  existing?: MomentumQueueEntry,
): MomentumQueueEntry {
  const keepStatus: MomentumQueueStatus =
    existing && !['watching', 'triggered'].includes(existing.status)
      ? existing.status
      : 'watching'
  return {
    id: entry.tickKey,
    tickKey: entry.tickKey,
    watchlistId: entry.watchlistId,
    symboltoken: entry.symboltoken,
    tradingsymbol: entry.tradingsymbol,
    broker: entry.broker,
    tradeEnv: entry.tradeEnv,
    noTakeProfit: entry.noTakeProfit,
    status: keepStatus,
    currentPrice: existing?.currentPrice ?? null,
    updatedAt: Date.now(),
  }
}

export function MomentumDeployProvider({
  children,
  config,
  onMomentumTrade,
}: {
  children: ReactNode
  config: MomentumConfig
  onMomentumTrade?: MomentumTradeCallback
}) {
  const [queueMap, setQueueMap] = useState<Record<string, MomentumQueueEntry>>({})
  const [armedMap, setArmedMap] = useState<Record<string, ArmedMomentumEntry>>({})
  const armedMapRef = useRef(armedMap)
  useEffect(() => { armedMapRef.current = armedMap }, [armedMap])
  const [approval, setApproval] = useState<LiveApprovalRequest | null>(null)
  const deployQueueRef = useRef<DeployJob[]>([])
  const processingRef = useRef(false)
  const configRef = useRef(config)
  const onTradeRef = useRef(onMomentumTrade)

  useEffect(() => { configRef.current = config }, [config])
  useEffect(() => { onTradeRef.current = onMomentumTrade }, [onMomentumTrade])

  const patchEntry = useCallback((id: string, patch: Partial<MomentumQueueEntry>) => {
    setQueueMap(prev => {
      const current = prev[id]
      if (!current) return prev
      const next = { ...prev, [id]: { ...current, ...patch, updatedAt: Date.now() } }
      notifyMomentumQueueChanged()
      return next
    })
  }, [])

  const disarmSymbol = useCallback((tickKey: string) => {
    setArmedMap(prev => {
      const current = prev[tickKey]
      if (!current) return prev
      const next = { ...prev }
      delete next[tickKey]
      return next
    })
    setQueueMap(prev => {
      const current = prev[tickKey]
      if (!current || current.status !== 'watching') return prev
      const next = { ...prev }
      delete next[tickKey]
      notifyMomentumQueueChanged()
      return next
    })
  }, [])

  const disarmSymbols = useCallback((tickKeys: string[]) => {
    if (tickKeys.length === 0) return
    setArmedMap(prev => {
      let changed = false
      const next = { ...prev }
      for (const tickKey of tickKeys) {
        if (!next[tickKey]) continue
        delete next[tickKey]
        changed = true
      }
      return changed ? next : prev
    })
    setQueueMap(prev => {
      let changed = false
      const next = { ...prev }
      for (const tickKey of tickKeys) {
        const current = next[tickKey]
        if (!current || current.status !== 'watching') continue
        delete next[tickKey]
        changed = true
      }
      if (changed) notifyMomentumQueueChanged()
      return changed ? next : prev
    })
  }, [])

  const armSymbol = useCallback((entry: ArmedMomentumEntry) => {
    const existing = armedMapRef.current[entry.tickKey]
    if (
      existing
      && existing.noTakeProfit === entry.noTakeProfit
      && existing.tradeEnv === entry.tradeEnv
    ) {
      disarmSymbol(entry.tickKey)
      return
    }

    setArmedMap(prev => ({ ...prev, [entry.tickKey]: entry }))
    setQueueMap(prev => {
      const next = {
        ...prev,
        [entry.tickKey]: queueEntryFromArmed(entry, prev[entry.tickKey]),
      }
      notifyMomentumQueueChanged()
      return next
    })
    const bracket = entry.noTakeProfit ? 'no TP' : '5% TP'
    showPlatformToast({
      variant: 'default',
      title: 'Added to queue',
      message: `${entry.tradingsymbol} · ${entry.tradeEnv.toUpperCase()} · ${bracket}`,
      duration: 4500,
    })
  }, [disarmSymbol])

  const armSymbols = useCallback((entries: ArmedMomentumEntry[]) => {
    if (entries.length === 0) return
    setArmedMap(prev => {
      const next = { ...prev }
      for (const entry of entries) {
        next[entry.tickKey] = entry
      }
      return next
    })
    setQueueMap(prev => {
      const next = { ...prev }
      for (const entry of entries) {
        next[entry.tickKey] = queueEntryFromArmed(entry, prev[entry.tickKey])
      }
      notifyMomentumQueueChanged()
      return next
    })
    const count = entries.length
    const preview = entries.slice(0, 4).map(e => e.tradingsymbol).join(', ')
    const suffix = count > 4 ? ` +${count - 4} more` : ''
    showPlatformToast({
      variant: 'default',
      title: count === 1 ? 'Added to queue' : `${count} symbols added to queue`,
      message: count === 1
        ? `${entries[0].tradingsymbol} · ${entries[0].tradeEnv.toUpperCase()} · ${entries[0].noTakeProfit ? 'no TP' : '5% TP'}`
        : `${preview}${suffix} · ${entries[0].tradeEnv.toUpperCase()} · 5% TP`,
      duration: 4500,
    })
  }, [])

  const upsertWatching = useCallback((entries: Omit<MomentumQueueEntry, 'status' | 'updatedAt'>[]) => {
    setQueueMap(prev => {
      const next: Record<string, MomentumQueueEntry> = { ...prev }
      const incomingIds = new Set(entries.map(e => e.id))
      let changed = false

      for (const entry of entries) {
        const existing = next[entry.id]
        const keepStatus: MomentumQueueStatus =
          existing && !['watching', 'triggered'].includes(existing.status)
            ? existing.status
            : 'watching'
        const currentPrice = entry.currentPrice ?? existing?.currentPrice ?? null
        const candidate: MomentumQueueEntry = {
          ...entry,
          status: keepStatus,
          currentPrice,
          updatedAt: Date.now(),
        }
        if (
          !existing
          || existing.status !== candidate.status
          || existing.currentPrice !== candidate.currentPrice
          || existing.tradingsymbol !== candidate.tradingsymbol
          || existing.tradeEnv !== candidate.tradeEnv
          || existing.noTakeProfit !== candidate.noTakeProfit
        ) {
          next[entry.id] = candidate
          changed = true
        }
      }

      for (const id of Object.keys(next)) {
        if (
          next[id].status === 'watching'
          && !incomingIds.has(id)
          && !armedMapRef.current[id]
        ) {
          delete next[id]
          changed = true
        }
      }

      if (!changed) return prev
      notifyMomentumQueueChanged()
      return next
    })
  }, [])

  const processDeployQueue = useCallback(async () => {
    if (processingRef.current) return
    processingRef.current = true
    try {
      while (deployQueueRef.current.length > 0) {
        const job = deployQueueRef.current.shift()!
        patchEntry(queueId(job.tickKey), { status: 'deploying' })

        try {
          const executionId = await createAndStartMomentumStrategy(
            {
              broker: job.broker,
              tradingsymbol: job.tradingsymbol,
              token: job.token,
              exchange: job.exchange,
              closePrice: job.closePrice,
              watchlistId: job.watchlistId,
              noTakeProfit: job.noTakeProfit,
            },
            job.tradeEnv,
            configRef.current,
          )

          const bracketLabel = job.noTakeProfit ? 'no TP / 1% SL' : '5% TP / 1% SL'
          showPlatformToast({
            variant: 'success',
            title: job.tradeEnv === 'live' ? 'Live order placed' : 'Demo order placed',
            message: `${job.tradingsymbol} · ${bracketLabel} · ${executionId}`,
            duration: 8000,
          })

          patchEntry(queueId(job.tickKey), {
            status: 'placed',
            executionId,
            entryPrice: job.closePrice,
            errorMessage: undefined,
          })

          onTradeRef.current?.({
            watchlistId: job.watchlistId,
            symboltoken: job.symboltoken,
            tradingsymbol: job.tradingsymbol,
            exchange: job.exchange,
            broker: job.broker,
            executionId,
            entryPrice: job.closePrice,
            accountEnv: job.tradeEnv,
            noTakeProfit: job.noTakeProfit,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Deploy failed'
          showPlatformToast({
            variant: 'error',
            title: job.tradeEnv === 'live' ? 'Live deploy failed' : 'Demo deploy failed',
            message,
            duration: 10_000,
          })
          patchEntry(queueId(job.tickKey), {
            status: 'failed',
            errorMessage: message,
          })
        }

        if (deployQueueRef.current.length > 0) {
          await new Promise(resolve => window.setTimeout(resolve, DEPLOY_GAP_MS))
        }
      }
    } finally {
      processingRef.current = false
    }
  }, [patchEntry])

  const enqueueDeploy = useCallback((job: DeployJob) => {
    patchEntry(queueId(job.tickKey), {
      status: 'queued',
      signalHeadline: job.signal?.headline,
      signalDetail: job.signal?.detail,
      currentPrice: job.closePrice,
    })
    deployQueueRef.current.push(job)
    void processDeployQueue()
  }, [patchEntry, processDeployQueue])

  const requestLiveApproval = useCallback((job: DeployJob) => {
    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (approved: boolean) => {
        if (settled) return
        settled = true
        setApproval(null)
        resolve(approved)
      }

      patchEntry(queueId(job.tickKey), {
        status: 'awaiting_approval',
        signalHeadline: job.signal?.headline,
        signalDetail: job.signal?.detail,
        currentPrice: job.closePrice,
      })

      showPlatformToast({
        variant: 'warning',
        title: 'Live momentum signal',
        message: `${job.tradingsymbol} · approve within 5s`,
        duration: LIVE_APPROVAL_MS,
        highlightTitle: true,
      })

      setApproval({
        id: job.id,
        tradingsymbol: job.tradingsymbol,
        tradeEnv: 'live',
        noTakeProfit: job.noTakeProfit,
        signal: job.signal!,
        currentPrice: job.closePrice,
        onApprove: () => {
          patchEntry(queueId(job.tickKey), { status: 'queued' })
          finish(true)
        },
        onCancel: () => {
          patchEntry(queueId(job.tickKey), { status: 'skipped', errorMessage: 'Approval cancelled' })
          finish(false)
        },
      })
    })
  }, [patchEntry])

  const handleMomentumSignal = useCallback((args: {
    tickKey: string
    watchlistId: string
    symboltoken: string
    tradingsymbol: string
    broker: string
    exchange: string
    token: string
    tradeEnv: 'live' | 'demo'
    noTakeProfit: boolean
    closePrice: number
    signal: MomentumSignal
    autoDemo: boolean
  }) => {
    const job: DeployJob = {
      id: `${args.tickKey}-${Date.now()}`,
      tickKey: args.tickKey,
      watchlistId: args.watchlistId,
      symboltoken: args.symboltoken,
      tradingsymbol: args.tradingsymbol,
      broker: args.broker,
      exchange: args.exchange,
      token: args.token,
      tradeEnv: args.tradeEnv,
      noTakeProfit: args.noTakeProfit,
      closePrice: args.closePrice,
      signal: args.signal,
    }

    patchEntry(queueId(args.tickKey), {
      status: 'triggered',
      signalHeadline: args.signal.headline,
      signalDetail: args.signal.detail,
      currentPrice: args.closePrice,
    })

    setArmedMap(prev => {
      if (!prev[args.tickKey]) return prev
      const next = { ...prev }
      delete next[args.tickKey]
      return next
    })

    if (args.tradeEnv === 'live') {
      void (async () => {
        const approved = await requestLiveApproval(job)
        if (approved) enqueueDeploy(job)
      })()
      return
    }

    if (args.autoDemo) {
      showPlatformToast({
        variant: 'default',
        title: 'Momentum trigger',
        message: `${args.tradingsymbol} · placing DEMO order now`,
        duration: 5000,
        highlightTitle: true,
      })
      enqueueDeploy(job)
      return
    }

    const bracketLabel = args.noTakeProfit ? 'no TP / 1% SL' : '5% TP / 1% SL'
    showPlatformToast({
      variant: 'warning',
      title: 'Fast momentum',
      message: `${args.signal.headline} · Deploy on DEMO (${bracketLabel})?`,
      duration: 30_000,
      highlightTitle: true,
      actions: {
        label: 'Deploy demo',
        variant: 'default',
        onClick: () => {
          enqueueDeploy({ ...job, closePrice: args.closePrice })
        },
      },
    })
  }, [enqueueDeploy, patchEntry, requestLiveApproval])

  const queue = useMemo(
    () => Object.values(queueMap).sort((a, b) => b.updatedAt - a.updatedAt),
    [queueMap],
  )

  const armedSymbols = useMemo(
    () => Object.values(armedMap),
    [armedMap],
  )

  const value = useMemo(
    () => ({
      queue,
      armedSymbols,
      armSymbol,
      armSymbols,
      disarmSymbol,
      disarmSymbols,
      upsertWatching,
      handleMomentumSignal,
    }),
    [queue, armedSymbols, armSymbol, armSymbols, disarmSymbol, disarmSymbols, upsertWatching, handleMomentumSignal],
  )

  return (
    <MomentumDeployContext.Provider value={value}>
      {children}
      {approval ? <MomentumLiveApproval request={approval} /> : null}
    </MomentumDeployContext.Provider>
  )
}

export function useMomentumDeploy() {
  const ctx = useContext(MomentumDeployContext)
  if (!ctx) {
    throw new Error('useMomentumDeploy must be used within MomentumDeployProvider')
  }
  return ctx
}

export function useMomentumDeployOptional() {
  return useContext(MomentumDeployContext)
}
