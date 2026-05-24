import {
  formatInr,
  formatSignedInr,
  formatUsd,
  pnlClass,
  useAccountSummary,
} from './useAccountSummary'

export default function AccountSummary() {
  const { summary } = useAccountSummary()

  return (
    <div className="grid gap-2.5 border-b border-border px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-widest text-text-secondary">Equity</span>
        <span className="text-right font-mono text-[13px] font-semibold">
          {formatInr(summary.angelEquity, { maxFractionDigits: 0 })}
          {summary.etoroEquity > 0 ? (
            <span className="mt-0.5 block text-[10px] font-normal text-text-secondary">
              {formatUsd(summary.etoroEquity, 0)} eToro
            </span>
          ) : null}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-widest text-text-secondary">Day P&L</span>
        <span className={`font-mono text-[13px] font-semibold ${pnlClass(summary.dayPnl)}`}>
          {formatSignedInr(summary.dayPnl, { maxFractionDigits: 0 })}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-widest text-text-secondary">Buying power</span>
        <span className="font-mono text-[13px] font-semibold">
          {formatInr(summary.buyingPower, { maxFractionDigits: 0 })}
        </span>
      </div>
    </div>
  )
}
