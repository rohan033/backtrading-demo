import { useCallback, useState } from 'react'

import { dispatchTradingSessionPrompt, sessionOutcomeLabel, type TradingSession } from '@/lib/tradingSessions'

type Props = {
  session: TradingSession
  onSessionUpdate: (session: TradingSession) => void
  compact?: boolean
}

export default function TradingSessionInstructionBar({ session, onSessionUpdate, compact = false }: Props) {
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const outcome = sessionOutcomeLabel(session)

  const handleSubmit = useCallback(async () => {
    const text = prompt.trim()
    if (!text || sending) return
    setSending(true)
    setError('')
    try {
      const row = await dispatchTradingSessionPrompt(session.id, text)
      onSessionUpdate(row)
      setPrompt('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send instruction')
    } finally {
      setSending(false)
    }
  }, [onSessionUpdate, prompt, sending, session.id])

  if (compact) {
    return (
      <div className={`am-ts-instruction am-ts-instruction--compact${outcome === 'success' ? ' am-ts-instruction--success' : ''}`}>
        <span className="am-ts-instruction__badge">
          {outcome === 'success' ? 'Complete' : 'Stopped'}
        </span>
        <div className="am-ts-instruction__row">
          <input
            type="text"
            className="am-ts-instruction__input am-ts-instruction__input--single"
            value={prompt}
            placeholder={
              outcome === 'success'
                ? 'Continue monitoring or adjust…'
                : 'Retry or adjust strategy…'
            }
            disabled={sending}
            onChange={event => setPrompt(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void handleSubmit()
              }
            }}
          />
          <button
            type="button"
            className="am-chat-send am-ts-instruction__send"
            disabled={sending || !prompt.trim()}
            onClick={() => { void handleSubmit() }}
          >
            {sending ? '…' : 'Send'}
          </button>
        </div>
        {error ? <div className="am-ts-instruction__error">{error}</div> : null}
      </div>
    )
  }

  return (
    <div className={`am-ts-instruction${outcome === 'success' ? ' am-ts-instruction--success' : ''}`}>
      <div className="am-ts-instruction__head">
        <span className="am-ts-instruction__title">
          {outcome === 'success' ? 'Session complete' : 'Session stopped'}
        </span>
        <span className="am-ts-instruction__hint">
          {outcome === 'success'
            ? 'Add instructions to continue monitoring, adjust targets, or start a new cycle.'
            : 'Add instructions to retry or adjust — the agent will resume from the failed phase.'}
        </span>
      </div>
      <div className="am-chat-input-row">
        <textarea
          className="am-chat-input am-ts-instruction__input"
          rows={2}
          value={prompt}
          placeholder={
            outcome === 'success'
              ? 'e.g. Keep monitoring TSLA, or explore a new symbol with $300 target…'
              : 'e.g. Retry strategy with 5% target and 2% stop using the TSLA setup form…'
          }
          disabled={sending}
          onChange={event => setPrompt(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void handleSubmit()
            }
          }}
        />
        <button
          type="button"
          className="am-chat-send"
          disabled={sending || !prompt.trim()}
          onClick={() => { void handleSubmit() }}
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
      {error ? <div className="am-ts-instruction__error">{error}</div> : null}
    </div>
  )
}
