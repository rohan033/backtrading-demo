export default function StrategyScheduleSection({
  scheduleEnabled,
  onScheduleEnabledChange,
  scheduledDate,
  onScheduledDateChange,
  tradingDayOptions,
  scheduleHint,
  loading = false,
  broker = 'angel',
  compact = false,
  variant = 'default',
}) {
  const marketOpenLabel = scheduleHint || (broker === 'etoro' ? 'CEST 3:30 PM' : 'IST 09:15')
  const isMinimal = variant === 'minimal' || compact

  if (isMinimal) {
    return (
      <section
        className={`ms-schedule-section${scheduleEnabled ? ' ms-schedule-section--on' : ''}`}
      >
        <label className="ms-schedule-section__check">
          <span
            className={`ms-schedule-section__box${scheduleEnabled ? ' ms-schedule-section__box--on' : ''}`}
            aria-hidden="true"
          >
            {scheduleEnabled ? (
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path
                  d="M2 5.5L4.5 8L9 3"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : null}
          </span>
          <input
            type="checkbox"
            className="ms-schedule-section__input"
            checked={scheduleEnabled}
            onChange={e => onScheduleEnabledChange(e.target.checked)}
          />
          <span className="ms-schedule-section__label-text">Schedule for Later</span>
        </label>

        {scheduleEnabled ? (
          <div className="ms-schedule-section__body">
            <p className="ms-schedule-section__hint">
              Auto-start at market open ({marketOpenLabel})
            </p>
            <div>
              <div className="ms-schedule-section__label-row">
                <span className="ms-schedule-section__label">Trading day</span>
                {loading ? <span className="ms-schedule-section__loading">Updating…</span> : null}
              </div>
              <div className="ms-schedule-section__pills">
                {tradingDayOptions.map(option => {
                  const selected = scheduledDate === option.trading_day
                  return (
                    <button
                      key={option.trading_day}
                      type="button"
                      onClick={() => onScheduledDateChange(option.trading_day)}
                      className={`ms-schedule-section__pill${selected ? ' ms-schedule-section__pill--active' : ''}`}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div>
              <label className="ms-schedule-section__label">Or pick a date</label>
              <input
                type="date"
                value={scheduledDate}
                onChange={e => onScheduledDateChange(e.target.value)}
                className="ms-schedule-section__date"
              />
            </div>
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <section
      className={`rounded-lg border ${
        scheduleEnabled ? 'border-accent/50 bg-accent/5' : 'border-border bg-card/60'
      } p-4`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold text-text-primary text-sm">
            Schedule
          </h3>
          <p className="mt-1 text-[10px] text-text-secondary">
            Optionally auto-start at market open ({marketOpenLabel}).
          </p>
        </div>
        <label className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-primary">
          <input
            type="checkbox"
            checked={scheduleEnabled}
            onChange={e => onScheduleEnabledChange(e.target.checked)}
          />
          Schedule for Later
        </label>
      </div>

      {scheduleEnabled ? (
        <div className="mt-4 space-y-3">
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[9px] font-semibold uppercase tracking-[1.5px] text-text-secondary">
                Trading day
              </span>
              {loading ? <span className="text-[10px] text-text-secondary">Updating…</span> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {tradingDayOptions.map(option => {
                const selected = scheduledDate === option.trading_day
                return (
                  <button
                    key={option.trading_day}
                    type="button"
                    onClick={() => onScheduledDateChange(option.trading_day)}
                    className={`rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                      selected
                        ? 'border-accent bg-accent text-white'
                        : 'border-border bg-card text-text-secondary hover:border-accent/40 hover:text-text-primary'
                    }`}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <label className="text-[9px] font-semibold uppercase tracking-[1.5px] text-text-secondary block mb-1">
              Or pick a date
            </label>
            <input
              type="date"
              value={scheduledDate}
              onChange={e => onScheduledDateChange(e.target.value)}
              className="w-full max-w-xs px-3 py-2 bg-card border border-border rounded text-xs text-text-primary outline-none focus:border-accent"
            />
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[10px] text-text-secondary">
          Save as a draft and deploy manually from the strategy detail page.
        </p>
      )}
    </section>
  )
}
