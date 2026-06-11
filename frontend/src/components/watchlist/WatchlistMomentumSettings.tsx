import { Settings2, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  DEFAULT_MOMENTUM_CONFIG,
  loadMomentumConfig,
  saveMomentumConfig,
  type MomentumConfig,
} from '../../lib/watchlistMomentum'

type Props = {
  onChange: (config: MomentumConfig) => void
}

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
      <div>
        <div className="text-[11px] font-medium text-text-primary">{label}</div>
        {hint ? <div className="mt-0.5 text-[10px] text-text-secondary/70 leading-snug">{hint}</div> : null}
      </div>
      <div>{children}</div>
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
}: {
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  disabled?: boolean
  unit?: string
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
        className="w-16 rounded border border-border bg-primary px-1.5 py-0.5 text-center text-[11px] text-text-primary outline-none focus:border-accent disabled:opacity-40"
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
      className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${
        checked ? 'bg-accent' : 'bg-border'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
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

export default function WatchlistMomentumSettings({ onChange }: Props) {
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
        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium ${
          config.enabled
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
            : 'border-border bg-card text-text-secondary hover:text-text-primary'
        }`}
        title="Momentum filter settings"
      >
        <Zap className="h-3.5 w-3.5" />
        Momentum
        {config.enabled && (
          <Settings2 className="h-3 w-3 opacity-60" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-lg border border-border bg-card shadow-xl shadow-black/40 overflow-y-auto max-h-[85vh]">
          <div className="border-b border-border px-3 py-2.5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-text-primary">Momentum filters</div>
            <div className="mt-0.5 text-[10px] text-text-secondary/80">
              Fires when price acceleration passes all active filters
            </div>
          </div>

          <div className="px-3 pb-4">
            {/* ── Toggles ─────────────────────────────────────────── */}
            <Section title="Behaviour">
              <Row label="Enable alerts" hint="Scan every symbol in all watchlists">
                <Toggle checked={config.enabled} onChange={v => patch({ enabled: v })} />
              </Row>
              <Row label="Auto-demo" hint="Auto-start strategy on demo when triggered">
                <Toggle checked={config.autoDemo} onChange={v => patch({ autoDemo: v })} disabled={off} />
              </Row>
            </Section>

            {/* ── Mode selector ───────────────────────────────────── */}
            <Section title="Detection mode">
              <Row
                label="Complex mode"
                hint={
                  config.complexMode
                    ? 'All filters active: velocity, acceleration, guards, price filter'
                    : 'Simple: fires when 1m change ≥ Min 1m % threshold — nothing else'
                }
              >
                <Toggle checked={config.complexMode} onChange={v => patch({ complexMode: v })} disabled={off} />
              </Row>
            </Section>

            {/* ── 1m threshold (always visible) ───────────────────── */}
            <Section title="Threshold">
              <Row label="Min 1m %" hint="Minimum change over last 1 minute (used in both Simple and Complex mode)">
                <NumInput value={config.min1mPct} step={0.05} min={0} disabled={off}
                  onChange={v => patch({ min1mPct: v })} unit="%" />
              </Row>
            </Section>

            {/* ── Complex-only settings ───────────────────────────── */}
            {config.complexMode && (
              <>
                <Section title="Velocity thresholds">
                  <Row label="Min 30s %" hint="Short burst check — must exceed in last 30 seconds">
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
                  <Row label="Require 10m positive" hint="Block if 10m change is negative (bounce guard)">
                    <Toggle checked={config.require10mPositive} onChange={v => patch({ require10mPositive: v })} disabled={off} />
                  </Row>
                </Section>

                <Section title="Guards">
                  <Row label="Max 1m % (spike)" hint="Reject if 1m exceeds this — likely data error or blow-off">
                    <NumInput value={config.maxSpike1mPct} step={0.5} min={1} disabled={off}
                      onChange={v => patch({ maxSpike1mPct: v })} unit="%" />
                  </Row>
                  <Row label="Max 10m % (played out)" hint="Skip if 10m already > this — move may be exhausted. 0 = off">
                    <NumInput value={config.max10mPct} step={0.5} min={0} disabled={off}
                      onChange={v => patch({ max10mPct: v })} unit="%" />
                  </Row>
                </Section>

                <Section title="Acceleration">
                  <Row label="1m acceleration factor" hint="1m per-minute rate must exceed 5m avg × this factor">
                    <NumInput value={config.accelerationFactor} step={0.05} min={1} disabled={off}
                      onChange={v => patch({ accelerationFactor: v })} />
                  </Row>
                  <Row label="Require 5m > 10m rate" hint="Per-minute rate of 5m must beat 10m rate">
                    <Toggle checked={config.require5mAbove10mRate} onChange={v => patch({ require5mAbove10mRate: v })} disabled={off} />
                  </Row>
                </Section>

                <Section title="Price filter">
                  <Row label="Min price (LTP)" hint="Ignore symbols below this price. 0 = off">
                    <NumInput value={config.minLtp} step={1} min={0} disabled={off}
                      onChange={v => patch({ minLtp: v })} />
                  </Row>
                  <Row label="Max price (LTP)" hint="Ignore symbols above this price. 0 = off">
                    <NumInput value={config.maxLtp} step={1} min={0} disabled={off}
                      onChange={v => patch({ maxLtp: v })} />
                  </Row>
                </Section>
              </>
            )}

            {/* ── Timing ──────────────────────────────────────────── */}
            <Section title="Timing">
              <Row label="Alert cooldown" hint="Minimum gap between repeat alerts for the same symbol">
                <NumInput value={config.cooldownMs / 60_000} step={1} min={1} disabled={off}
                  onChange={v => patch({ cooldownMs: Math.round(v * 60_000) })} unit="min" />
              </Row>
              <Row label="Scan every" hint="How often the algorithm checks each symbol">
                <NumInput value={config.scanEveryMs / 1000} step={0.5} min={0.5} disabled={off}
                  onChange={v => patch({ scanEveryMs: Math.max(500, Math.round(v * 1000)) })} unit="s" />
              </Row>
            </Section>

            {/* ── Strategy params ─────────────────────────────────── */}
            <Section title="Strategy params (auto-deployed)">
              <Row label="Take-profit %" hint="Long percent used when deploying a strategy">
                <NumInput value={config.longPercent} step={0.5} min={0.1} disabled={off}
                  onChange={v => patch({ longPercent: v })} unit="%" />
              </Row>
              <Row label="Stop-loss %" hint="Short percent used when deploying a strategy">
                <NumInput value={config.shortPercent} step={0.1} min={0.1} disabled={off}
                  onChange={v => patch({ shortPercent: v })} unit="%" />
              </Row>
              <Row label="Entry threshold %" hint="% above close before buy is triggered">
                <NumInput value={config.initialThreshold} step={0.05} min={0} disabled={off}
                  onChange={v => patch({ initialThreshold: v })} unit="%" />
              </Row>
              <Row label="Capital per strategy">
                <NumInput value={config.maxCapital} step={1000} min={100} disabled={off}
                  onChange={v => patch({ maxCapital: v })} />
              </Row>
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
      )}
    </div>
  )
}
