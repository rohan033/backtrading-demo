import { useWatchlistStream } from '../../context/WatchlistStreamContext'
import { formatBrokerMoney } from '../../lib/currency'
import type { MomentumQueueEntry } from '../../lib/momentumQueue'

function statusLabel(status: MomentumQueueEntry['status']): string {
  switch (status) {
    case 'watching':
      return 'Watching'
    case 'triggered':
      return 'Triggered'
    case 'awaiting_approval':
      return 'Approve live'
    case 'queued':
      return 'Queued'
    case 'deploying':
      return 'Placing…'
    case 'placed':
      return 'Placed'
    case 'failed':
      return 'Failed'
    case 'skipped':
      return 'Skipped'
    default:
      return status
  }
}

function statusClass(status: MomentumQueueEntry['status']): string {
  return `ms-mom-queue__status--${status}`
}

function QueueRow({
  entry,
  onCancel,
}: {
  entry: MomentumQueueEntry
  onCancel?: (tickKey: string) => void
}) {
  const priceLabel = entry.currentPrice != null
    ? formatBrokerMoney(entry.broker, entry.currentPrice)
    : '—'
  const canCancel = entry.status === 'watching' && onCancel

  return (
    <div className={`ms-mom-queue__row ms-mom-queue__row--${entry.status}`}>
      <div className="ms-mom-queue__top">
        <span className={`ms-mom-queue__env ms-mom-queue__env--${entry.tradeEnv}`}>
          {entry.tradeEnv}
        </span>
        <span className={`ms-mom-queue__status ${statusClass(entry.status)}`}>
          {statusLabel(entry.status)}
        </span>
        {canCancel ? (
          <button
            type="button"
            className="ms-mom-queue__cancel"
            onClick={() => onCancel(entry.tickKey)}
          >
            Cancel
          </button>
        ) : null}
      </div>
      <div className="ms-mom-queue__symbol">{entry.tradingsymbol}</div>
      <div className="ms-mom-queue__meta">
        LTP {priceLabel}
        {entry.noTakeProfit ? ' · no TP' : ' · 5% TP'}
      </div>
      {entry.signalHeadline ? (
        <div className="ms-mom-queue__signal">{entry.signalHeadline}</div>
      ) : null}
      {entry.errorMessage ? (
        <div className="ms-mom-queue__error">{entry.errorMessage}</div>
      ) : null}
    </div>
  )
}

export default function MomentumQueuePanel({ filterText }: { filterText: string }) {
  const { momentumQueue, momentumConfig, disarmMomentumSymbol } = useWatchlistStream()

  const query = filterText.trim().toLowerCase()
  const rows = momentumQueue.filter(entry => {
    if (!query) return true
    return entry.tradingsymbol.toLowerCase().includes(query)
  })

  const watching = rows.filter(r => r.status === 'watching')
  const active = rows.filter(r => r.status !== 'watching' && r.status !== 'placed')

  if (!watching.length && !active.length) {
    return (
      <div className="ms-news-empty">
        No queued symbols. Press ⚡ on a row in Watch &amp; Trade to scan for momentum.
      </div>
    )
  }

  return (
    <div className="ms-mom-queue">
      {!momentumConfig.enabled ? (
        <div className="ms-mom-queue__banner">
          Momentum alerts are off — queue is visible but auto-scan will not run until enabled.
        </div>
      ) : null}

      {active.length > 0 ? (
        <section className="ms-mom-queue__section">
          <div className="ms-mom-queue__section-head">
            <strong>Active</strong>
            <span>{active.length}</span>
          </div>
          <div className="ms-mom-queue__list">
            {active.map(entry => (
              <QueueRow key={`${entry.id}-${entry.status}`} entry={entry} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="ms-mom-queue__section">
        <div className="ms-mom-queue__section-head">
          <strong>Scan queue</strong>
          <span>{watching.length} queued</span>
        </div>
        <div className="ms-mom-queue__list">
          {watching.map(entry => (
            <QueueRow
              key={entry.id}
              entry={entry}
              onCancel={disarmMomentumSymbol}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
