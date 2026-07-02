import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  getThreadBrokerContext,
  getThreadUiPhase,
  isMonitorCompleted,
  listAllAgentThreadMessages,
  updateAgentThread,
  type AgentThread,
} from '@/lib/agentThreads'
import {
  compactSurfacesAfterDeploy,
  observationSurface,
  surfacesFromThreadMessages,
} from '@/lib/agentA2uiHydrate'
import type { AgentInteractionMode } from '@/lib/useAgentAguiChat'
import { useAgentAguiChat } from '@/lib/useAgentAguiChat'
import { useAgentClientMonitor } from '@/hooks/useAgentClientMonitor'
import { useMultiSymbolLiveFeeds } from '@/hooks/useMultiSymbolLiveFeeds'
import type { AgentMonitorStatus } from '@/lib/agentMonitor'
import { useAgentThreadExecutions } from '@/hooks/useAgentThreadExecutions'
import { useAgentThreadFocus } from '@/hooks/useAgentThreadFocus'
import { useMarketPreviewFeed } from '@/hooks/useMarketPreviewFeed'
import { useResolvedAgentFocus } from '@/hooks/useResolvedAgentFocus'
import { defaultAccountEnv, type WatchlistBroker } from '@/lib/watchlistBrokers'
import {
  buildHomeChartMonitorMarkers,
} from '@/lib/homeChartMonitorMarkers'
import {
  loadClientMonitorCache,
  resetClientMonitorWindow,
  type ClientMonitorMarker,
} from '@/lib/agentClientMonitorCache'
import {
  isAgentStrategyRunning,
  monitorIntervalMs,
  readMonitorIntervalMinutes,
  readMonitorUserEnabled,
  resolveExecutionRuntimeStatus,
  type MonitorIntervalMinutes,
} from '@/lib/agentMonitorControl'

import AgentModeActivityPanel from './AgentModeActivityPanel'
import AgentModeTradingPanel from './AgentModeTradingPanel'
import AgentMonitorQueueStatus from './AgentMonitorQueueStatus'
import { latestTopStockPicks } from '@/lib/agentCandidatePicks'
import type { AgentThreadFocus } from '@/lib/agentThreads'

type Props = {
  thread: AgentThread
  onRunFinished: () => void
  onThreadPatch: (patch: { title?: string; metadata?: Record<string, unknown> }) => void
}

export default function AgentModeActiveWorkspace({
  thread,
  onRunFinished,
  onThreadPatch,
}: Props) {
  const uiPhase = getThreadUiPhase(thread)
  const metadataFocus = useAgentThreadFocus(thread)
  const { primaryExecutionId, primaryExecution, reconciledFocus, executions, linkedRows, refresh } = useAgentThreadExecutions(
    thread,
    metadataFocus,
  )
  const focus = useResolvedAgentFocus(thread, reconciledFocus)
  const [interactionMode, setInteractionMode] = useState<AgentInteractionMode>(
    uiPhase === 'trading' ? 'execute' : 'ask',
  )
  const initialBroker = getThreadBrokerContext(thread)
  const [broker, setBroker] = useState<WatchlistBroker>(initialBroker.broker)
  const [accountEnv, setAccountEnv] = useState<'live' | 'demo'>(initialBroker.accountEnv)

  useEffect(() => {
    const ctx = getThreadBrokerContext(thread)
    setBroker(ctx.broker)
    setAccountEnv(ctx.accountEnv)
  }, [thread])

  const [pnlRefreshKey, setPnlRefreshKey] = useState(0)
  const [monitorStatus, setMonitorStatus] = useState<AgentMonitorStatus | null>(null)
  const [monitorMarkers, setMonitorMarkers] = useState<ClientMonitorMarker[]>(() => {
    const cached = loadClientMonitorCache(thread.thread_id)
    return cached?.markers ?? []
  })

  const [monitorUserEnabled, setMonitorUserEnabled] = useState(
    () => readMonitorUserEnabled(thread.metadata) && !isMonitorCompleted(thread),
  )
  const [monitorSendingNow, setMonitorSendingNow] = useState(false)

  useEffect(() => {
    const next = isMonitorCompleted(thread)
      ? false
      : readMonitorUserEnabled(thread.metadata)
    setMonitorUserEnabled(prev => (prev === next ? prev : next))
  }, [thread.metadata?.monitor_state, thread.metadata?.monitor_user_enabled, thread.thread_id])

  const chartMonitorMarkers = useMemo(
    () => buildHomeChartMonitorMarkers(monitorMarkers),
    [monitorMarkers],
  )

  const handleMonitorStatus = useCallback((payload: Record<string, unknown>) => {
    setMonitorStatus(payload as AgentMonitorStatus)
  }, [])

  const reloadRef = useRef<() => void>(() => {})

  const handleRunFinished = useCallback(() => {
    setPnlRefreshKey(key => key + 1)
    onRunFinished()
    reloadRef.current()
  }, [onRunFinished])

  const runContext = useCallback(
    () => ({ broker, accountEnv }),
    [accountEnv, broker],
  )

  const chat = useAgentAguiChat(
    thread.thread_id,
    interactionMode,
    handleRunFinished,
    onThreadPatch,
    runContext,
  )

  const handleInteractionModeChange = useCallback((mode: AgentInteractionMode) => {
    setInteractionMode(mode)
    void updateAgentThread(thread.thread_id, { interaction_mode: mode })
  }, [thread.thread_id])

  const strategyDeployed = useMemo(
    () => Boolean(
      primaryExecutionId
      || focus?.execution_id
      || executions.some(row => row.executionId)
      || (thread.actions ?? []).some(action => {
        const status = String(action.status || '').toLowerCase()
        return Boolean(action.payload?.execution_id)
          || status === 'running'
          || status === 'active'
          || status === 'starting'
      }),
    ),
    [executions, focus?.execution_id, primaryExecutionId, thread.actions],
  )

  const reloadThreadSurfaces = useCallback(async () => {
    try {
      const messages = await listAllAgentThreadMessages(thread.thread_id)
      const hydrated = surfacesFromThreadMessages(messages, thread.actions || [])
      chat.resetSurfaces(compactSurfacesAfterDeploy(hydrated, strategyDeployed))
    } catch {
      // keep live surfaces if history fetch fails
    }
  }, [chat.resetSurfaces, strategyDeployed, thread.actions, thread.thread_id])

  useEffect(() => {
    reloadRef.current = () => {
      void reloadThreadSurfaces()
    }
  }, [reloadThreadSurfaces])

  const executionStatus = useMemo(() => {
    const id = primaryExecutionId || focus?.execution_id
    if (!id) return primaryExecution?.status || null
    const row = linkedRows.find(item => item.execution_id === id)
    const action = thread.actions?.find(item => String(item.payload?.execution_id || '') === id)
    return resolveExecutionRuntimeStatus(row?.engine?.status, action?.status) || primaryExecution?.status || null
  }, [focus?.execution_id, linkedRows, primaryExecution?.status, primaryExecutionId, thread.actions])

  const strategyRunning = isAgentStrategyRunning(executionStatus)
  const monitorCompleted = isMonitorCompleted(thread)
  const monitorIntervalMinutes = readMonitorIntervalMinutes(thread.metadata)
  const flushIntervalMs = monitorIntervalMs(monitorIntervalMinutes)
  const monitorActive = monitorUserEnabled && !monitorCompleted

  const candidatePicks = useMemo(
    () => latestTopStockPicks(chat.surfaces),
    [chat.surfaces],
  )

  const comparingCandidates = Boolean(!focus?.symbol && candidatePicks?.length)
  const multiSymbolMode = Boolean(
    (candidatePicks?.length ?? 0) > 1
    || executions.filter(row => row.symbol).length > 1,
  )
  const multiFeeds = useMultiSymbolLiveFeeds(
    (comparingCandidates || multiSymbolMode) ? candidatePicks : null,
    broker,
    accountEnv,
  )

  const monitorFocus = useMemo((): AgentThreadFocus | null => {
    if (focus?.symbol) return focus
    const pick = candidatePicks?.[0]
    if (!pick?.symbol) return null
    return {
      symbol: pick.symbol,
      token: pick.token ?? null,
      exchange: pick.exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'),
      broker,
      account_env: accountEnv,
    }
  }, [accountEnv, broker, candidatePicks, focus])

  const hasWatchTarget = comparingCandidates
    ? multiFeeds.watchTargets.length > 0
    : multiSymbolMode
      ? multiFeeds.watchTargets.length > 0 || Boolean(monitorFocus?.symbol)
      : Boolean(monitorFocus?.symbol)
  const watchLabel = comparingCandidates
    ? multiFeeds.watchTargets.map(row => row.focus.symbol?.split('-')[0]).filter(Boolean).join(', ')
    : monitorFocus?.symbol?.split('-')[0] || null

  const priceFocus = useResolvedAgentFocus(null, monitorFocus)
  const feedBroker = (priceFocus?.broker || broker) as WatchlistBroker
  const feedEnv = priceFocus?.account_env || accountEnv || defaultAccountEnv(feedBroker)

  const { ltp: singleLtp, streamStatus: singleStreamStatus } = useMarketPreviewFeed({
    broker: feedBroker,
    token: priceFocus?.token,
    symbol: priceFocus?.symbol,
    exchange: priceFocus?.exchange || (feedBroker === 'etoro' ? 'ETORO' : 'NSE'),
    account_env: feedEnv,
    enabled: Boolean(
      !comparingCandidates
      && priceFocus?.symbol
      && (priceFocus.token || feedBroker === 'angel'),
    ),
  })

  const monitorWatchTargets = comparingCandidates || (multiSymbolMode && !focus?.symbol)
    ? multiFeeds.watchTargets
    : multiSymbolMode && multiFeeds.watchTargets.length
      ? multiFeeds.watchTargets
      : priceFocus
      ? [{
          focus: priceFocus,
          ltp: singleLtp,
          dedicatedSamples: [] as import('@/lib/watchlistChangeColumns').PriceSample[],
        }]
      : []

  const monitorPrimaryFocus = comparingCandidates
    ? multiFeeds.watchTargets[0]?.focus ?? priceFocus
    : priceFocus

  const monitorLtp = comparingCandidates
    ? multiFeeds.watchTargets[0]?.ltp ?? null
    : singleLtp

  const displayLtp = focus?.symbol ? singleLtp : monitorLtp

  const persistMonitorEnabled = useCallback(
    async (enabled: boolean) => {
      setMonitorUserEnabled(enabled)
      onThreadPatch({
        metadata: { ...(thread.metadata || {}), monitor_user_enabled: enabled },
      })
      try {
        await updateAgentThread(thread.thread_id, {
          metadata: { monitor_user_enabled: enabled },
        })
      } catch {
        // keep optimistic local state
      }
    },
    [onThreadPatch, thread.metadata, thread.thread_id],
  )

  const handleMonitorStart = useCallback(() => {
    if (!hasWatchTarget || monitorCompleted) return
    resetClientMonitorWindow(thread.thread_id, Date.now(), flushIntervalMs)
    void persistMonitorEnabled(true)
  }, [flushIntervalMs, hasWatchTarget, monitorCompleted, persistMonitorEnabled, thread.thread_id])

  useEffect(() => {
    if (monitorCompleted || !hasWatchTarget || monitorUserEnabled) return
    if (strategyDeployed || comparingCandidates) {
      resetClientMonitorWindow(thread.thread_id, Date.now(), flushIntervalMs)
      void persistMonitorEnabled(true)
    }
  }, [
    comparingCandidates,
    flushIntervalMs,
    hasWatchTarget,
    monitorCompleted,
    monitorUserEnabled,
    persistMonitorEnabled,
    strategyDeployed,
    thread.thread_id,
  ])

  const handleMonitorIntervalChange = useCallback((minutes: MonitorIntervalMinutes) => {
    onThreadPatch({ metadata: { ...(thread.metadata || {}), monitor_interval_minutes: minutes } })
    void updateAgentThread(thread.thread_id, {
      metadata: { monitor_interval_minutes: minutes },
    })
    if (monitorUserEnabled) {
      resetClientMonitorWindow(thread.thread_id, Date.now(), monitorIntervalMs(minutes))
    }
  }, [monitorUserEnabled, onThreadPatch, thread.metadata, thread.thread_id])

  const handleMonitorStop = useCallback(() => {
    void persistMonitorEnabled(false)
  }, [persistMonitorEnabled])

  const clientMonitor = useAgentClientMonitor({
    threadId: thread.thread_id,
    focus: monitorPrimaryFocus,
    watchTargets: monitorWatchTargets,
    executions,
    ltp: monitorLtp,
    interactionMode,
    enabled: hasWatchTarget,
    monitorActive,
    monitorUserEnabled,
    completed: monitorCompleted,
    flushIntervalMs,
    onAguiEvent: chat.pushAguiEvent,
    onRunFinished: handleRunFinished,
    onMonitorStatus: handleMonitorStatus,
    onMarkersChange: setMonitorMarkers,
  })

  const handleMonitorSendNow = useCallback(async () => {
    setMonitorSendingNow(true)
    try {
      await clientMonitor.sendMonitorNow()
    } finally {
      setMonitorSendingNow(false)
    }
  }, [clientMonitor.sendMonitorNow])

  useEffect(() => {
    void reloadThreadSurfaces()
  }, [reloadThreadSurfaces])

  const activitySeed = useMemo(() => {
    if (!focus?.symbol || uiPhase !== 'trading') return null
    return observationSurface(focus, executionStatus, displayLtp)
  }, [displayLtp, executionStatus, focus, uiPhase])

  const handleDeploySuccess = useCallback(() => {
    setPnlRefreshKey(key => key + 1)
    void refresh()
    onRunFinished()
  }, [onRunFinished, refresh])

  const handleBrokerChange = (nextBroker: WatchlistBroker, nextEnv: 'live' | 'demo') => {
    setBroker(nextBroker)
    setAccountEnv(nextEnv)
    onThreadPatch({ metadata: { ...thread.metadata, broker: nextBroker, account_env: nextEnv } })
  }

  const candidatePicksForUi = candidatePicks

  const monitorBar = (
    <AgentMonitorQueueStatus
      threadId={thread.thread_id}
      enabled={hasWatchTarget}
      liveStatus={monitorStatus}
      monitorUserEnabled={monitorUserEnabled}
      monitorCompleted={monitorCompleted}
      hasWatchTarget={hasWatchTarget}
      watchLabel={watchLabel}
      intervalMinutes={monitorIntervalMinutes}
      onIntervalChange={handleMonitorIntervalChange}
      onStart={handleMonitorStart}
      onStop={handleMonitorStop}
      onSendNow={() => { void handleMonitorSendNow() }}
      sendingNow={monitorSendingNow}
    />
  )

  if (uiPhase === 'chat') {
    const showTradingTabs = Boolean(candidatePicksForUi?.length)
    return (
      <div className="am-active-stack">
        <div className={`am-active-grid ${showTradingTabs ? 'am-active-grid--split' : 'am-active-grid--chat'}`}>
          {showTradingTabs ? (
            <AgentModeTradingPanel
              thread={thread}
              focus={focus}
              ltp={displayLtp}
              streamStatus={singleStreamStatus}
              candidatePicks={candidatePicksForUi}
              feedsBySymbol={multiFeeds.bySymbol}
              broker={broker}
              accountEnv={accountEnv}
              pnlRefreshKey={pnlRefreshKey}
              monitorMarkers={chartMonitorMarkers}
              monitorUserEnabled={monitorUserEnabled}
              executionStatus={executionStatus}
            />
          ) : null}
          <AgentModeActivityPanel
            threadId={thread.thread_id}
            variant="chat"
            focus={focus}
            executionId={primaryExecutionId}
            executionStatus={executionStatus}
            strategyDeployed={strategyDeployed}
            livePrice={displayLtp}
            interactionMode={interactionMode}
            onInteractionModeChange={handleInteractionModeChange}
            broker={broker}
            accountEnv={accountEnv}
            onBrokerChange={handleBrokerChange}
            activitySeed={null}
            chat={chat}
            onRunFinished={onRunFinished}
            onDeploySuccess={handleDeploySuccess}
          />
        </div>
        {monitorBar}
      </div>
    )
  }

  return (
    <div className="am-active-stack">
      <div className="am-active-grid am-active-grid--split">
        <AgentModeTradingPanel
          thread={thread}
          focus={focus}
          ltp={displayLtp}
          streamStatus={singleStreamStatus}
          candidatePicks={candidatePicksForUi}
          feedsBySymbol={multiFeeds.bySymbol}
          broker={broker}
          accountEnv={accountEnv}
          pnlRefreshKey={pnlRefreshKey}
          monitorMarkers={chartMonitorMarkers}
          monitorUserEnabled={monitorUserEnabled}
          executionStatus={executionStatus}
        />
        <AgentModeActivityPanel
          threadId={thread.thread_id}
          variant="activity"
          focus={focus}
          executionId={primaryExecutionId}
          executionStatus={executionStatus}
          strategyDeployed={strategyDeployed}
          livePrice={displayLtp}
          interactionMode={interactionMode}
          onInteractionModeChange={handleInteractionModeChange}
          broker={broker}
          accountEnv={accountEnv}
          onBrokerChange={handleBrokerChange}
          activitySeed={activitySeed}
          chat={chat}
          onRunFinished={handleRunFinished}
          onDeploySuccess={handleDeploySuccess}
        />
      </div>
      {monitorBar}
    </div>
  )
}
