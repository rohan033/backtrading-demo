import { ChevronDown, Settings2, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  DEFAULT_MOMENTUM_CONFIG,
  loadMomentumConfig,
  saveMomentumConfig,
  type MomentumConfig,
} from '../../lib/watchlistMomentum'

type MonitoredSymbol = {
  symbol: string
  tradeEnv: 'live' | 'demo'
  noTakeProfit: boolean
}

type Props = {
  onChange: (config: MomentumConfig) => void
  monitoredSymbols?: MonitoredSymbol[]
}

const SELECT_CLASS =
  'h-8 w-full cursor-pointer rounded-md border border-border bg-primary px-2 text-[11px] font-medium text-text-primary outline-none focus:border-accent/50 [color-scheme:dark]'

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-border/30 py-2 last:border-0">
      <div
        className="min-w-0 truncate text-[11px] leading-none"
        title={hint ? `${label} — ${hint}` : label}
      >
        <span className="font-medium text-text-primary">{label}</span>
        {hint ? (
          <>
            <span className="mx-1.5 text-text-secondary/35">·</span>
            <span className="font-normal text-text-secondary/70">{hint}</span>
          </>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function NumInput({
  value,
  onChange,
  step = 0.1,
  min,
  disabled,
  unit,
  className = 'w-16',
}: {
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  disabled?: boolean
  unit?: string
  className?: string
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        step={step}
        min={min}
        value={value}
        disabled={disabled}
        onChange={e => {
          const n = parseFloat(e.target.value)
          if (Number.isFinite(n)) onChange(n)
        }}
        className={`rounded border border-border bg-primary px-1.5 py-0.5 text-center text-[11px] text-text-primary outline-none focus:border-accent disabled:opacity-40 ${className}`}
      />
      {unit ? <span className="text-[10px] text-text-secondary">{unit}</span> : null}
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
        checked
          ? 'bg-accent ring-1 ring-inset ring-accent/60'
          : 'bg-border ring-1 ring-inset ring-white/5'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-out ${
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-[9px] font-bold uppercase tracking-[1.5px] text-text-secondary/60">{title}</div>
      <div className="rounded-md border border-border/50 bg-primary/50 px-2">{children}</div>
    </div>
  )
}

function EssentialField({
  label,
  value,
  onChange,
  step,
  min,
  disabled,
  unit,
  samples,
  sampleTone = 'accent',
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  disabled?: boolean
  unit?: string
  samples?: number[]
  sampleTone?: 'accent' | 'green' | 'red'
}) {
  const sampleActiveClass =
    sampleTone === 'green'
      ? 'bg-green/20 text-green ring-1 ring-inset ring-green/40'
      : sampleTone === 'red'
        ? 'bg-red/20 text-red ring-1 ring-inset ring-red/40'
        : 'bg-accent/20 text-accent ring-1 ring-inset ring-accent/40'
  const sampleIdleClass =
    sampleTone === 'green'
      ? 'bg-green/10 text-green/70 hover:bg-green/15 hover:text-green'
      : sampleTone === 'red'
        ? 'bg-red/10 text-red/70 hover:bg-red/15 hover:text-red'
        : 'bg-secondary/60 text-text-secondary hover:bg-secondary hover:text-text-primary'

  return (
    <label className="block space-y-1">
      <span className="text-[10px] font-medium text-text-secondary">{label}</span>
      <NumInput
        value={value}
        step={step}
        min={min}
        disabled={disabled}
        unit={unit}
        onChange={onChange}
        className="w-full"
      />
      {samples && samples.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {samples.map(sample => {
            const active = value === sample
            return (
              <button
                key={sample}
                type="button"
                disabled={disabled}
                onClick={() => onChange(sample)}
                className={`rounded px-1.5 py-0.5 text-[9px] font-semibold tabular-nums transition-colors disabled:opacity-40 ${
                  active ? sampleActiveClass : sampleIdleClass
                }`}
              >
                {sample}%
              </button>
            )
          })}
        </div>
      ) : null}
    </label>
  )
}

export default function WatchlistMomentumSettings({ onChange, monitoredSymbols = [] }: Props) {
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<MomentumConfig>(() => loadMomentumConfig())
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    onChange(config)
    saveMomentumConfig(config)
  }, [config, onChange])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const patch = (next: Partial<MomentumConfig>) => setConfig(prev => ({ ...prev, ...next }))
  const d = DEFAULT_MOMENTUM_CONFIG
  const off = !config.enabled

  return (
    <div ref={rootRef} className="relative" data-no-drag>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
          config.enabled
            ? 'border-accent/40 bg-accent/10 text-accent'
            : 'border-border bg-card text-text-secondary hover:text-text-primary'
        }`}
        title="Momentum filter settings"
      >
        <Zap className="h-3.5 w-3.5" />
        Momentum
        {config.enabled ? <Settings2 className="h-3 w-3 opacity-60" /> : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-30 mt-2 w-72 rounded-lg border border-border bg-card shadow-xl shadow-black/40 overflow-y-auto max-h-[85vh]">
          <div className="border-b border-border px-3 py-2.5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-text-primary">Momentum filters</div>
            <div className="mt-0.5 text-[10px] text-text-secondary/80">
              Fires when price acceleration passes all active filters
            </div>
          </div>

          <div className="px-3 pb-4">
            <Section title="Filter mode">
              <label className="block py-2">
                <span className="mb-1.5 block text-[10px] text-text-secondary">Detection profile</span>
                <select
                  value={config.complexMode ? 'complex' : 'simple'}
                  disabled={off}
                  onChange={event => patch({ complexMode: event.target.value === 'complex' })}
                  className={SELECT_CLASS}
                >
                  <option value="simple">Simple — 1m profit threshold only</option>
                  <option value="complex">Complex — velocity, guards &amp; acceleration</option>
                </select>
              </label>
            </Section>

            <Section title="Core params">
              <div className="grid grid-cols-2 gap-2 py-2">
                <EssentialField
                  label="1m profit %"
                  value={config.min1mPct}
                  step={0.05}
                  min={0}
                  disabled={off}
                  unit="%"
                  onChange={v => patch({ min1mPct: v })}
                />
                <EssentialField
                  label="Max cap"
                  value={config.maxCapital}
                  step={1000}
                  min={100}
                  disabled={off}
                  onChange={v => patch({ maxCapital: v })}
                />
                <EssentialField
                  label="SL %"
                  value={config.shortPercent}
                  step={0.1}
                  min={0.1}
                  disabled={off}
                  unit="%"
                  samples={[0.5, 1, 2, 3]}
                  sampleTone="red"
                  onChange={v => patch({ shortPercent: v })}
                />
                <EssentialField
                  label="TP %"
                  value={config.longPercent}
                  step={0.5}
                  min={0.1}
                  disabled={off}
                  unit="%"
                  samples={[3, 5, 10, 15]}
                  sampleTone="green"
                  onChange={v => patch({ longPercent: v })}
                />
              </div>
            </Section>

            {config.complexMode ? (
              <details className="group mt-3 rounded-md border border-border/50 bg-primary/30">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-[10px] font-bold uppercase tracking-[1.5px] text-text-secondary/80 marker:content-none">
                  <span>Complex filters</span>
                  <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-border/40 px-2 pb-2">
                  <Section title="Velocity">
                    <Row label="Min 30s %" hint="Short burst check in the last 30 seconds">
                      <NumInput value={config.min30sPct} step={0.05} min={0} disabled={off}
                        onChange={v => patch({ min30sPct: v })} unit="%" />
                    </Row>
                    <Row label="Min 5m %" hint="Minimum change over last 5 minutes">
                      <NumInput value={config.min5mPct} step={0.05} min={0} disabled={off}
                        onChange={v => patch({ min5mPct: v })} unit="%" />
                    </Row>
                    <Row label="Min 10m %" hint="Medium-term trend confirmation">
                      <NumInput value={config.min10mPct} step={0.05} min={0} disabled={off}
                        onChange={v => patch({ min10mPct: v })} unit="%" />
                    </Row>
                    <Row label="Require 10m positive" hint="Block if 10m change is negative">
                      <Toggle checked={config.require10mPositive} onChange={v => patch({ require10mPositive: v })} disabled={off} />
                    </Row>
                  </Section>

                  <Section title="Guards">
                    <Row label="Max 1m spike %" hint="Reject blow-off tops / data spikes">
                      <NumInput value={config.maxSpike1mPct} step={0.5} min={1} disabled={off}
                        onChange={v => patch({ maxSpike1mPct: v })} unit="%" />
                    </Row>
                    <Row label="Max 10m %" hint="Skip if move already extended. 0 = off">
                      <NumInput value={config.max10mPct} step={0.5} min={0} disabled={off}
                        onChange={v => patch({ max10mPct: v })} unit="%" />
                    </Row>
                  </Section>

                  <Section title="Acceleration">
                    <Row label="1m accel factor" hint="1m rate must exceed 5m avg × factor">
                      <NumInput value={config.accelerationFactor} step={0.05} min={1} disabled={off}
                        onChange={v => patch({ accelerationFactor: v })} />
                    </Row>
                    <Row label="5m rate &gt; 10m rate">
                      <Toggle checked={config.require5mAbove10mRate} onChange={v => patch({ require5mAbove10mRate: v })} disabled={off} />
                    </Row>
                  </Section>

                  <Section title="Price filter">
                    <Row label="Min LTP" hint="0 = off">
                      <NumInput value={config.minLtp} step={1} min={0} disabled={off}
                        onChange={v => patch({ minLtp: v })} />
                    </Row>
                    <Row label="Max LTP" hint="0 = off">
                      <NumInput value={config.maxLtp} step={1} min={0} disabled={off}
                        onChange={v => patch({ maxLtp: v })} />
                    </Row>
                  </Section>

                  <Section title="Timing">
                    <Row label="Alert cooldown">
                      <NumInput value={config.cooldownMs / 60_000} step={1} min={1} disabled={off}
                        onChange={v => patch({ cooldownMs: Math.round(v * 60_000) })} unit="min" />
                    </Row>
                    <Row label="Scan every">
                      <NumInput value={config.scanEveryMs / 1000} step={0.5} min={0.5} disabled={off}
                        onChange={v => patch({ scanEveryMs: Math.max(500, Math.round(v * 1000)) })} unit="s" />
                    </Row>
                  </Section>

                  <Section title="Entry">
                    <Row label="Entry threshold %" hint="% above close before buy triggers">
                      <NumInput value={config.initialThreshold} step={0.05} min={0} disabled={off}
                        onChange={v => patch({ initialThreshold: v })} unit="%" />
                    </Row>
                  </Section>
                </div>
              </details>
            ) : null}

            <Section title="Behaviour">
              <Row
                label="Enable alerts"
                hint="Momentum watchlists & ⚡ rows"
              >
                <Toggle checked={config.enabled} onChange={v => patch({ enabled: v })} />
              </Row>
              <Row
                label="Auto-demo"
                hint="Demo auto-deploy on trigger"
              >
                <Toggle checked={config.autoDemo} onChange={v => patch({ autoDemo: v })} disabled={off} />
              </Row>
              {config.enabled ? (
                <div className="border-t border-border/30 py-2 text-[10px] leading-relaxed text-text-secondary/80">
                  {monitoredSymbols.length > 0 ? (
                    <>
                      <span className="font-semibold text-text-secondary">Monitoring: </span>
                      {monitoredSymbols.map(item => (
                        <span key={item.symbol} className="mr-2 inline-flex items-center gap-1">
                          <span className="font-medium text-text-primary">{item.symbol}</span>
                          <span className={item.tradeEnv === 'live' ? 'text-red' : 'text-text-secondary/70'}>
                            {item.tradeEnv}
                          </span>
                          {item.noTakeProfit ? <span className="text-blue-300">no-tp</span> : null}
                        </span>
                      ))}
                    </>
                  ) : (
                    <span>No symbols monitored — arm rows with ⚡ or enable a momentum watchlist.</span>
                  )}
                </div>
              ) : null}
            </Section>

            <button
              type="button"
              onClick={() => setConfig({ ...d })}
              className="mt-3 w-full rounded border border-border py-1 text-[10px] text-text-secondary hover:text-text-primary"
            >
              Reset to defaults
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
