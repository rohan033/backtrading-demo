import { useAccountSummary } from '../layout/useAccountSummary'

function StatusChip({
  children,
  live = false,
}: {
  children: string | number
  live?: boolean
}) {
  return (
    <span
      className={
        live
          ? 'rounded-full border border-green/35 px-2.5 py-1 text-[11px] text-green'
          : 'rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-text-secondary'
      }
    >
      {children}
    </span>
  )
}

export default function SettingsPage() {
  const { summary } = useAccountSummary()

  return (
    <div className="h-full overflow-auto p-6">
      <p className="mb-6 max-w-2xl text-sm text-text-secondary">
        Manage broker connections, runtime status, and platform preferences.
      </p>

      <section className="max-w-2xl rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3.5">
          <h2 className="text-sm font-semibold">Account & brokers</h2>
          <p className="mt-1 text-[11px] text-text-secondary">
            Connection health and live runtime summary.
          </p>
        </div>
        <div className="space-y-4 px-4 py-4">
          <div className="flex flex-wrap gap-2">
            <StatusChip>{summary.positions} positions</StatusChip>
            <StatusChip live>{summary.runningStrategies} running</StatusChip>
            <StatusChip live>Connected</StatusChip>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded border border-border bg-secondary px-3 py-3">
              <div className="text-[10px] uppercase tracking-widest text-text-secondary">Angel One</div>
              <div className="mt-1 flex items-center gap-2 text-xs">
                <span className="h-1.5 w-1.5 rounded-full bg-green" />
                Live · Connected
              </div>
            </div>
            <div className="rounded border border-border bg-secondary px-3 py-3">
              <div className="text-[10px] uppercase tracking-widest text-text-secondary">eToro</div>
              <div className="mt-1 flex items-center gap-2 text-xs">
                <span className="h-1.5 w-1.5 rounded-full bg-green" />
                Demo · Connected
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
