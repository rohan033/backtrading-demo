import {
  DEFAULT_MOMENTUM_CONFIG,
  type MomentumConfig,
} from '../../lib/watchlistMomentum'

type MonitoredSymbol = {
  symbol: string
  tradeEnv: 'live' | 'demo'
  noTakeProfit: boolean
}

type Props = {
  config: MomentumConfig
  onChange: (config: MomentumConfig) => void
  monitoredSymbols?: MonitoredSymbol[]
}

function NumField({
  label,
  value,
  step = 0.1,
  min,
  unit,
  disabled,
  samples,
  sampleTone,
  onChange,
}: {
  label: string
  value: number
  step?: number
  min?: number
  unit?: string
  disabled?: boolean
  samples?: number[]
  sampleTone?: 'green' | 'red'
  onChange: (v: number) => void
}) {
  return (
    <label className="wt-mf">
      <span className="wt-mf-label">
        {label}
        {unit ? <span className="wt-mf-unit"> {unit}</span> : null}
      </span>
      <input
        type="number"
        className="wt-mf-input"
        value={value}
        step={step}
        min={min}
        disabled={disabled}
        onChange={e => onChange(Number(e.target.value))}
      />
      {samples && !disabled ? (
        <span className="wt-mf-samples">
          {samples.map(sample => (
            <button
              key={sample}
              type="button"
              className={`wt-mf-chip${value === sample ? ' wt-mf-chip--on' : ''}${sampleTone ? ` wt-mf-chip--${sampleTone}` : ''}`}
              onClick={() => onChange(sample)}
            >
              {sample}
            </button>
          ))}
        </span>
      ) : null}
    </label>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="wt-mt-row">
      <span className="wt-mt-label">
        {label}
        {hint ? <span className="wt-mom-hint"> · {hint}</span> : null}
      </span>
      <button
        type="button"
        disabled={disabled}
        className={`wt-mt-switch${checked ? ' wt-mt-switch--on' : ''}`}
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
      >
        <span className="wt-mt-knob" />
      </button>
    </label>
  )
}

export function WatchAndTradeMomentumTrigger({
  config,
  open,
  onOpenChange,
}: {
  config: MomentumConfig
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <button
      type="button"
      className={`wt-toolbar-btn wt-toolbar-btn--momentum${config.enabled ? ' wt-toolbar-btn--active' : ''}${open ? ' wt-toolbar-btn--open' : ''}`}
      onClick={() => onOpenChange(!open)}
      aria-expanded={open}
      title="Auto momentum settings"
    >
      <span className="wt-toolbar-btn__icon" aria-hidden="true">⚡</span>
      Momentum
      {config.enabled ? <span className="wt-toolbar-dot" title="Alerts on" /> : null}
    </button>
  )
}

export default function WatchAndTradeMomentumSettings({
  config,
  onChange,
  monitoredSymbols = [],
}: Props) {
  const off = !config.enabled
  const patch = (next: Partial<MomentumConfig>) => onChange({ ...config, ...next })

  return (
    <div className="wt-mom-config-panel wt-mom-config-panel--drawer">
      <div className="wt-mom-config-panel__head">
        <div className="wt-mom-config-panel__title">
          <strong>Auto momentum</strong>
          <span>Scans armed symbols and deploys when filters pass</span>
        </div>
        <div className="wt-mom-config-panel__toggles">
          <ToggleRow
            label="Enable"
            checked={config.enabled}
            onChange={v => patch({ enabled: v })}
          />
          <ToggleRow
            label="Auto-demo"
            hint="deploy on trigger"
            checked={config.autoDemo}
            disabled={off}
            onChange={v => patch({ autoDemo: v })}
          />
        </div>
      </div>

      <div className="wt-mom-profile-cards">
        <button
          type="button"
          className={`wt-mom-profile-card${!config.complexMode ? ' wt-mom-profile-card--active' : ''}`}
          disabled={off}
          onClick={() => patch({ complexMode: false })}
        >
          <span className="wt-mom-profile-card__title">Simple</span>
          <span className="wt-mom-profile-card__desc">1m profit threshold only — fastest entries</span>
        </button>
        <button
          type="button"
          className={`wt-mom-profile-card${config.complexMode ? ' wt-mom-profile-card--active' : ''}`}
          disabled={off}
          onClick={() => patch({ complexMode: true })}
        >
          <span className="wt-mom-profile-card__title">Complex</span>
          <span className="wt-mom-profile-card__desc">Velocity, guards, acceleration &amp; timing</span>
        </button>
      </div>

      <div className="wt-mom-config-panel__body wt-mom-config-panel__body--horizontal">
        <div className={`wt-mom-config-panel__col wt-mom-core-band${!config.complexMode ? ' wt-mom-config-panel__col--highlight' : ''}`}>
          <div className="wt-mom-col-head">Core params</div>
          <div className="wt-mom-grid wt-mom-grid--4">
            <NumField
              label="1m profit"
              unit="%"
              value={config.min1mPct}
              step={0.05}
              min={0}
              disabled={off}
              onChange={v => patch({ min1mPct: v })}
            />
            <NumField
              label="Max cap"
              value={config.maxCapital}
              step={1000}
              min={100}
              disabled={off}
              onChange={v => patch({ maxCapital: v })}
            />
            <NumField
              label="TP"
              unit="%"
              value={config.longPercent}
              step={0.5}
              min={0.1}
              disabled={off}
              samples={[3, 5, 10, 15]}
              sampleTone="green"
              onChange={v => patch({ longPercent: v })}
            />
            <NumField
              label="SL"
              unit="%"
              value={config.shortPercent}
              step={0.1}
              min={0.1}
              disabled={off}
              samples={[0.5, 1, 2, 3]}
              sampleTone="red"
              onChange={v => patch({ shortPercent: v })}
            />
          </div>
        </div>

        {config.complexMode ? (
          <div className="wt-mom-config-panel__col wt-mom-complex-band wt-mom-config-panel__col--highlight">
            <div className="wt-mom-col-head wt-mom-col-head--complex">Complex filters</div>
            <div className="wt-mom-filter-row">
              <div className="wt-mom-filter-card">
                <div className="wt-mom-popover__label">Velocity</div>
                <div className="wt-mom-grid wt-mom-grid--2">
                  <NumField label="Min 30s" unit="%" value={config.min30sPct} step={0.05} min={0} disabled={off}
                    onChange={v => patch({ min30sPct: v })} />
                  <NumField label="Min 5m" unit="%" value={config.min5mPct} step={0.05} min={0} disabled={off}
                    onChange={v => patch({ min5mPct: v })} />
                  <NumField label="Min 10m" unit="%" value={config.min10mPct} step={0.05} min={0} disabled={off}
                    onChange={v => patch({ min10mPct: v })} />
                  <NumField label="Entry thr." unit="%" value={config.initialThreshold} step={0.05} min={0} disabled={off}
                    onChange={v => patch({ initialThreshold: v })} />
                </div>
                <ToggleRow label="Require 10m positive" checked={config.require10mPositive} disabled={off}
                  onChange={v => patch({ require10mPositive: v })} />
              </div>

              <div className="wt-mom-filter-card">
                <div className="wt-mom-popover__label">Guards</div>
                <div className="wt-mom-grid wt-mom-grid--2">
                  <NumField label="Max 1m spike" unit="%" value={config.maxSpike1mPct} step={0.5} min={1} disabled={off}
                    onChange={v => patch({ maxSpike1mPct: v })} />
                  <NumField label="Max 10m" unit="%" value={config.max10mPct} step={0.5} min={0} disabled={off}
                    onChange={v => patch({ max10mPct: v })} />
                </div>
              </div>

              <div className="wt-mom-filter-card">
                <div className="wt-mom-popover__label">Acceleration &amp; timing</div>
                <div className="wt-mom-grid wt-mom-grid--2">
                  <NumField label="1m accel ×" value={config.accelerationFactor} step={0.05} min={1} disabled={off}
                    onChange={v => patch({ accelerationFactor: v })} />
                  <NumField
                    label="Cooldown"
                    unit="min"
                    value={config.cooldownMs / 60_000}
                    step={1}
                    min={1}
                    disabled={off}
                    onChange={v => patch({ cooldownMs: Math.round(v * 60_000) })}
                  />
                  <NumField
                    label="Scan every"
                    unit="s"
                    value={config.scanEveryMs / 1000}
                    step={0.5}
                    min={0.5}
                    disabled={off}
                    onChange={v => patch({ scanEveryMs: Math.max(500, Math.round(v * 1000)) })}
                  />
                  <NumField label="Min LTP" value={config.minLtp} step={1} min={0} disabled={off}
                    onChange={v => patch({ minLtp: v })} />
                </div>
                <ToggleRow label="5m rate > 10m rate" checked={config.require5mAbove10mRate} disabled={off}
                  onChange={v => patch({ require5mAbove10mRate: v })} />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="wt-mom-config-panel__foot">
        {config.enabled ? (
          <div className="wt-mom-monitored">
            {monitoredSymbols.length > 0 ? (
              <>
                <span className="wt-mom-monitored__title">Monitoring</span>
                <div className="wt-mom-monitored__chips">
                  {monitoredSymbols.map(item => (
                    <span key={item.symbol} className="wt-mom-monitored__chip">
                      {item.symbol}
                      <em className={item.tradeEnv === 'live' ? 'wt-env-live' : ''}>{item.tradeEnv}</em>
                      {item.noTakeProfit ? <em className="wt-env-notp">no-tp</em> : null}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <span className="wt-mom-monitored__empty">
                Arm rows with ⚡ or enable a momentum watchlist.
              </span>
            )}
          </div>
        ) : (
          <span className="wt-mom-monitored__empty">Alerts are off — enable to start scanning.</span>
        )}
        <button
          type="button"
          className="wt-reset-btn"
          onClick={() => onChange({ ...DEFAULT_MOMENTUM_CONFIG })}
        >
          Reset defaults
        </button>
      </div>
    </div>
  )
}
