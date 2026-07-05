import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import AgentCandidateMiniChart from '@/components/charts/AgentCandidateMiniChart'
import type {
  A2uiButton,
  A2uiComponent,
  A2uiComponentName,
  A2uiStockPick,
  A2uiSurfaceMessage,
  A2uiUserAction,
} from '@/lib/agentA2uiCatalog'
import type { WatchlistBroker } from '@/lib/watchlistBrokers'

type BubbleRole = 'user' | 'agent'

type Props = {
  surface: A2uiSurfaceMessage
  className?: string
  onAction?: (action: A2uiUserAction) => void
  broker?: WatchlistBroker
  accountEnv?: 'live' | 'demo'
}

function Bubble({ role, children }: { role: BubbleRole; children: ReactNode }) {
  return (
    <div className={`am-bubble am-bubble--${role}`}>
      {children}
    </div>
  )
}

function MonitorBatch({ props }: { props: Record<string, unknown> }) {
  const symbol = String(props.symbol || '—')
  const count = Number(props.eventCount || 0)
  const items = Array.isArray(props.items) ? props.items as Array<Record<string, unknown>> : []
  const [open, setOpen] = useState(false)

  return (
    <div className="am-monitor-batch">
      <button
        type="button"
        className="am-monitor-batch__toggle"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        <span className="am-monitor-batch__label">Background monitor</span>
        <span className="am-monitor-batch__summary">
          {count} updates for {symbol.split('-')[0]}
        </span>
        <span className="am-monitor-batch__chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="am-monitor-batch__body">
          {items.length ? (
            <ul className="am-monitor-batch__items">
              {items.map(item => {
                const label = String(item.label || item.kind || 'Update')
                const itemCount = Number(item.count || 0)
                const detail = item.detail ? String(item.detail) : ''
                const samples = Array.isArray(item.samples)
                  ? item.samples.map(sample => String(sample)).filter(Boolean)
                  : []
                return (
                  <li key={String(item.kind || label)} className="am-monitor-batch__item">
                    <div className="am-monitor-batch__item-head">
                      <span>{label}</span>
                      <span className="am-monitor-batch__item-count">{itemCount}</span>
                    </div>
                    {detail ? <div className="am-monitor-batch__item-detail">{detail}</div> : null}
                    {samples.length ? (
                      <ul className="am-monitor-batch__samples">
                        {samples.map(sample => (
                          <li key={sample}>{sample}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p>Batch sent to the agent. Detailed breakdown unavailable for this run.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

function StrategySetupForm({
  props,
  onAction,
}: {
  props: Record<string, unknown>
  onAction?: (action: A2uiUserAction) => void
}) {
  const symbol = String(props.symbol || '')
  const broker = String(props.broker || 'angel')
  const [capital, setCapital] = useState(String(props.max_available_capital ?? 1000))
  const [targetPct, setTargetPct] = useState(String(props.long_percent ?? 5))
  const [stopPct, setStopPct] = useState(String(props.short_percent ?? 2.5))
  const [threshold, setThreshold] = useState(String(props.initial_threshold ?? 0.15))
  const entry = props.close_price != null ? Number(props.close_price) : null

  const deploy = () => {
    onAction?.({
      type: 'deploy_strategy',
      payload: {
        symbol,
        token: props.token,
        exchange: props.exchange,
        broker,
        account_env: props.account_env,
        close_price: entry,
        long_percent: Number(targetPct),
        short_percent: Number(stopPct),
        initial_threshold: Number(threshold),
        max_available_capital: Number(capital),
      },
    })
  }

  return (
    <div className="am-a2ui-setup">
      <div className="am-a2ui-setup__head">
        <span className="am-a2ui-setup__symbol">{symbol.split('-')[0]}</span>
        <span className="am-a2ui-setup__title">{String(props.title || 'Strategy setup')}</span>
      </div>
      <div className="am-a2ui-setup__grid">
        <label>
          <span>Capital</span>
          <input
            type="number"
            min={1}
            value={capital}
            onChange={event => setCapital(event.target.value)}
          />
        </label>
        <label>
          <span>Target %</span>
          <input
            type="number"
            step="0.1"
            value={targetPct}
            onChange={event => setTargetPct(event.target.value)}
          />
        </label>
        <label>
          <span>Stop %</span>
          <input
            type="number"
            step="0.1"
            value={stopPct}
            onChange={event => setStopPct(event.target.value)}
          />
        </label>
        <label>
          <span>Threshold %</span>
          <input
            type="number"
            step="0.01"
            value={threshold}
            onChange={event => setThreshold(event.target.value)}
          />
        </label>
      </div>
      {entry != null ? (
        <div className="am-a2ui-setup__entry">Entry ref {entry.toFixed(2)}</div>
      ) : null}
      <div className="am-a2ui-setup__actions">
        <button type="button" className="am-a2ui-btn am-a2ui-btn--primary" onClick={deploy}>
          Deploy strategy
        </button>
        <button
          type="button"
          className="am-a2ui-btn"
          onClick={() => onAction?.({
            type: 'send_prompt',
            prompt: `Save ${symbol} strategy with capital $${capital}, target ${targetPct}%, stop ${stopPct}% — do not deploy yet.`,
          })}
        >
          Save only
        </button>
      </div>
    </div>
  )
}

function InsightCards({ props }: { props: Record<string, unknown> }) {
  const sections = [
    { key: 'highlights', label: 'Highlights' },
    { key: 'lowlights', label: 'Lowlights' },
    { key: 'cautions', label: 'Cautions' },
  ] as const

  return (
    <div className="am-a2ui-insights">
      {sections.map(section => {
        const items = Array.isArray(props[section.key]) ? props[section.key].map(String) : []
        if (!items.length) return null
        return (
          <div key={section.key} className={`am-a2ui-insights__section am-a2ui-insights__section--${section.key}`}>
            <div className="am-a2ui-insights__label">{section.label}</div>
            <ul className="am-a2ui-insights__list">
              {items.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function ButtonRow({
  props,
  onAction,
}: {
  props: Record<string, unknown>
  onAction?: (action: A2uiUserAction) => void
}) {
  const buttons = (Array.isArray(props.buttons) ? props.buttons : []) as A2uiButton[]
  return (
    <div className="am-a2ui-buttons">
      {buttons.map((button, index) => (
        <button
          key={`${button.label}-${index}`}
          type="button"
          className={`am-a2ui-btn${button.variant === 'primary' ? ' am-a2ui-btn--primary' : ''}`}
          onClick={() => onAction?.({ type: 'send_prompt', prompt: button.prompt })}
        >
          {button.label}
        </button>
      ))}
    </div>
  )
}

function renderComponent(
  component: A2uiComponent,
  onAction?: (action: A2uiUserAction) => void,
  context?: { broker?: WatchlistBroker; accountEnv?: 'live' | 'demo' },
) {
  const props = component.props || {}
  switch (component.component) {
    case 'Heading':
      return <div className="am-a2ui-heading">{String(props.text || '')}</div>
    case 'Text':
      return <p className="am-a2ui-text">{String(props.text || '')}</p>
    case 'BulletList': {
      const items = Array.isArray(props.items) ? props.items.map(String) : []
      return (
        <ul className="am-a2ui-list">
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )
    }
    case 'TradeDecision': {
      const confidenceRaw = props.confidence_pct ?? props.confidence
      const confidence = confidenceRaw != null && confidenceRaw !== ''
        ? Math.round(Number(confidenceRaw))
        : null
      const confidenceTone = confidence == null
        ? 'muted'
        : confidence >= 70
          ? 'high'
          : confidence >= 50
            ? 'mid'
            : 'low'
      return (
        <div className="am-a2ui-trade-decision">
          {props.symbol ? (
            <span className="am-a2ui-trade-decision__symbol">{String(props.symbol)}</span>
          ) : null}
          {confidence != null && Number.isFinite(confidence) ? (
            <span className={`am-a2ui-trade-decision__confidence am-a2ui-trade-decision__confidence--${confidenceTone}`}>
              {confidence}% confidence
            </span>
          ) : null}
          <span className="am-a2ui-trade-decision__text">{String(props.text || '')}</span>
        </div>
      )
    }
    case 'ToolStatus':
      return (
        <div className="am-a2ui-tool">
          <span className="am-a2ui-tool__name">{String(props.toolName || 'tool')}</span>
          <span className="am-a2ui-tool__status">{String(props.status || 'running')}</span>
          {props.detail ? (
            <span className="am-a2ui-tool__detail">{String(props.detail)}</span>
          ) : null}
        </div>
      )
    case 'CandidateDebate':
      return (
        <div className="am-a2ui-debate">
          <div className="am-a2ui-debate__label">Thinking</div>
          <p className="am-a2ui-text">{String(props.text || '')}</p>
        </div>
      )
    case 'TopStockPicks': {
      const picks = (Array.isArray(props.picks) ? props.picks : []) as A2uiStockPick[]
      const selected = String(props.selected || '')
      const broker = context?.broker || 'etoro'
      const accountEnv = context?.accountEnv || 'demo'
      const showCharts = props.showCharts !== false && props.hideCharts !== true
      return (
        <div className="am-a2ui-top-picks am-a2ui-top-picks--charts">
          <div className="am-a2ui-top-picks__label">Top 3 candidates — pick one to trade</div>
          <div className="am-a2ui-top-picks__grid">
            {picks.slice(0, 3).map(pick => {
              const symbol = String(pick.symbol || '')
              const name = String(pick.name || symbol)
              const logoUrl = String(pick.logoUrl || '')
              const recommendation = String(pick.recommendation || '')
              const isSelected = selected && symbol.toUpperCase() === selected.toUpperCase()
              return (
                <button
                  type="button"
                  key={symbol}
                  className={`am-a2ui-top-picks__card${isSelected ? ' am-a2ui-top-picks__card--selected' : ''}`}
                  onClick={() => onAction?.({ type: 'pick_symbol', symbol })}
                >
                  <div className="am-a2ui-top-picks__card-head">
                    {logoUrl ? (
                      <img src={logoUrl} alt="" className="am-a2ui-top-picks__logo" />
                    ) : (
                      <span className="am-a2ui-top-picks__letter">{symbol.slice(0, 1)}</span>
                    )}
                    <div className="am-a2ui-top-picks__card-titles">
                      <span className="am-a2ui-top-picks__symbol">{symbol}</span>
                      <span className="am-a2ui-top-picks__name">{name}</span>
                    </div>
                  </div>
                  {showCharts ? (
                    <AgentCandidateMiniChart
                      symbol={symbol}
                      token={pick.token}
                      exchange={pick.exchange}
                      broker={broker}
                      accountEnv={accountEnv}
                    />
                  ) : null}
                  {recommendation ? (
                    <p className="am-a2ui-top-picks__recommendation">{recommendation}</p>
                  ) : null}
                  <span className="am-a2ui-top-picks__select">Select {symbol.split('-')[0]}</span>
                </button>
              )
            })}
          </div>
        </div>
      )
    }
    case 'MonitorBatch':
      return <MonitorBatch props={props} />
    case 'StrategySetupForm':
      return <StrategySetupForm props={props} onAction={onAction} />
    case 'InsightCards':
      return <InsightCards props={props} />
    case 'ButtonRow':
      return <ButtonRow props={props} onAction={onAction} />
    case 'StrategySummary': {
      const status = props.status ? String(props.status) : null
      const entry = props.entry_price != null ? Number(props.entry_price) : null
      const execId = props.execution_id ? String(props.execution_id) : null
      const broker = props.broker ? String(props.broker) : null
      const env = props.account_env ? String(props.account_env) : null
      const strategyHref = execId
        ? `/trade/strategies/${encodeURIComponent(execId)}`
        : null
      return (
        <div className="am-a2ui-strategy am-a2ui-strategy--live">
          <div className="am-a2ui-strategy__head">
            <span className="am-a2ui-strategy__symbol">{String(props.symbol || '—')}</span>
            {status ? <span className="am-a2ui-strategy__status">{status}</span> : null}
          </div>
          <dl className="am-a2ui-strategy__grid">
            {entry != null && Number.isFinite(entry) ? (
              <>
                <dt>Entry</dt>
                <dd>{entry.toFixed(2)}</dd>
              </>
            ) : null}
            {props.long_percent != null ? (
              <>
                <dt>Target</dt>
                <dd>{String(props.long_percent)}%</dd>
              </>
            ) : null}
            {props.short_percent != null ? (
              <>
                <dt>Stop</dt>
                <dd>{String(props.short_percent)}%</dd>
              </>
            ) : null}
            {props.capital != null ? (
              <>
                <dt>Capital</dt>
                <dd>${String(props.capital)}</dd>
              </>
            ) : null}
            {broker ? (
              <>
                <dt>Broker</dt>
                <dd>{broker}{env ? ` · ${env}` : ''}</dd>
              </>
            ) : null}
            {execId ? (
              <>
                <dt>Execution</dt>
                <dd className="am-a2ui-strategy__mono">{execId}</dd>
              </>
            ) : null}
          </dl>
          {strategyHref ? (
            <Link to={strategyHref} className="am-a2ui-strategy__link">
              Open strategy →
            </Link>
          ) : null}
        </div>
      )
    }
    default:
      return null
  }
}

export function A2uiRenderer({ surface, className, onAction, broker, accountEnv }: Props) {
  const role: BubbleRole = surface.role === 'user' ? 'user' : 'agent'
  const renderCtx = { broker, accountEnv }

  if (surface.type === 'a2ui_tool_log') {
    const inner = surface.components.map(component => (
      <div key={component.id}>{renderComponent(component, onAction, renderCtx)}</div>
    ))
    return <div className={`am-tool-log-item ${className || ''}`.trim()}>{inner}</div>
  }

  const items = surface.components.map(component => {
    const child = renderComponent(component, onAction, renderCtx)
    if (!child) return null

    const useChatBubble = CHAT_BUBBLE_COMPONENTS.has(component.component)
    if (useChatBubble) {
      return (
        <div key={component.id} className="am-activity-item__block">
          <Bubble role={role}>{child}</Bubble>
        </div>
      )
    }

    return (
      <div key={component.id} className="am-activity-item__block">
        <div className={`am-a2ui-surface${role === 'user' ? ' am-a2ui-surface--user' : ''}`}>
          {child}
        </div>
      </div>
    )
  })

  return <div className={className}>{items}</div>
}

const CHAT_BUBBLE_COMPONENTS = new Set<A2uiComponentName>([
  'Text',
  'Heading',
  'BulletList',
])

export function userTextSurface(text: string, messageId: string): A2uiSurfaceMessage {
  return {
    type: 'a2ui_surface',
    messageId,
    role: 'user',
    components: [{ id: `${messageId}-text`, component: 'Text', props: { text } }],
  }
}
