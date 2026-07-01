import type { AgentThreadFocus } from '@/lib/agentThreads'

type Props = {
  focus: AgentThreadFocus
  executionId?: string | null
  executionStatus?: string | null
}

export default function AgentOrderDetailsCard({ focus, executionId, executionStatus }: Props) {
  const fields = [
    ['Symbol', focus.symbol],
    ['Broker', focus.broker || 'angel'],
    ['Exchange', focus.exchange || 'NSE'],
    ['Entry ref', focus.close_price != null ? String(focus.close_price) : '—'],
    ['Target %', focus.long_percent != null ? `${focus.long_percent}%` : '—'],
    ['Stop %', focus.short_percent != null ? `${focus.short_percent}%` : '—'],
    ['Threshold %', focus.initial_threshold != null ? `${focus.initial_threshold}%` : '—'],
    ['Capital', focus.max_available_capital != null ? String(focus.max_available_capital) : '—'],
    ['Execution', executionId || focus.execution_id || '—'],
    ['Status', executionStatus || (executionId || focus.execution_id ? 'Linked' : 'Pending')],
  ] as const

  return (
    <section className="am-order-card">
      <div className="am-order-card__title">Order details</div>
      <dl className="am-order-card__grid">
        {fields.map(([label, value]) => (
          <div key={label} className="am-order-card__row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
