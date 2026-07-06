import type { TradingSessionState } from '@/lib/tradingSessions'
import { SESSION_PIPELINE } from '@/lib/tradingSessions'

type Props = {
  state: TradingSessionState
  stepIdx: number
}

export default function SessionPipelineFlow({ state, stepIdx }: Props) {
  return (
    <details className="am-ts-flow" open>
      <summary className="am-ts-flow__summary" aria-label="Toggle session pipeline">
        <span className="am-ts-flow__summary-compact">
          <span className="am-ts-flow__dots" aria-hidden>
            {SESSION_PIPELINE.map((step, idx) => {
              const done = idx < stepIdx
              const current = idx === stepIdx
              return (
                <span
                  key={step}
                  className={`am-ts-step-dot${done ? ' am-ts-step-dot--done' : ''}${current ? ' am-ts-step-dot--current' : ''}`}
                />
              )
            })}
          </span>
          <span className="am-ts-flow__state">{state}</span>
        </span>
        <span className="am-ts-flow__toggle" aria-hidden>
          <span className="am-ts-flow__toggle-label">Pipeline</span>
          <span className="am-ts-flow__toggle-icon">▾</span>
        </span>
      </summary>

      <div className="am-ts-flow__panel">
        <ol className="am-ts-flow__track" aria-label="Session pipeline">
          {SESSION_PIPELINE.map((step, idx) => {
            const done = idx < stepIdx
            const current = idx === stepIdx
            const pending = idx > stepIdx
            return (
              <li
                key={step}
                className={`am-ts-flow__step${done ? ' am-ts-flow__step--done' : ''}${current ? ' am-ts-flow__step--current' : ''}${pending ? ' am-ts-flow__step--pending' : ''}`}
              >
                {idx > 0 ? <span className="am-ts-flow__line am-ts-flow__line--before" aria-hidden /> : null}
                <span className="am-ts-flow__dot" aria-hidden />
                <span className="am-ts-flow__label">{step}</span>
                {idx < SESSION_PIPELINE.length - 1 ? (
                  <span className="am-ts-flow__line am-ts-flow__line--after" aria-hidden />
                ) : null}
              </li>
            )
          })}
        </ol>
      </div>
    </details>
  )
}
