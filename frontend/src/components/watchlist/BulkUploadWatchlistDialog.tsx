import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Upload, X } from 'lucide-react'

import { Button } from '../ui/button'
import {
  WATCHLIST_BROKER_OPTIONS,
  parseTickerInput,
  type WatchlistBroker,
} from '../../lib/watchlistBrokers'

export type BulkUploadProgress = {
  done: number
  total: number
  current: string
}

export type BulkUploadResult = {
  watchlistName: string
  succeeded: string[]
  failed: string[]
}

export type BulkUploadHandler = (
  params: { name: string; broker: WatchlistBroker; tickers: string[] },
  onProgress: (progress: BulkUploadProgress) => void,
) => Promise<BulkUploadResult>

type Props = {
  open: boolean
  defaultName: string
  onClose: () => void
  onSubmit: BulkUploadHandler
}

export default function BulkUploadWatchlistDialog({ open, defaultName, onClose, onSubmit }: Props) {
  const [name, setName] = useState(defaultName)
  const [broker, setBroker] = useState<WatchlistBroker>('angel')
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<BulkUploadProgress | null>(null)
  const [result, setResult] = useState<BulkUploadResult | null>(null)

  const tickers = useMemo(() => parseTickerInput(raw), [raw])

  if (!open) return null

  const reset = () => {
    setRaw('')
    setProgress(null)
    setResult(null)
    setBusy(false)
  }

  const handleClose = () => {
    if (busy) return
    reset()
    onClose()
  }

  const handleSubmit = async () => {
    if (busy || tickers.length === 0 || !name.trim()) return
    setBusy(true)
    setResult(null)
    setProgress({ done: 0, total: tickers.length, current: '' })
    try {
      const res = await onSubmit({ name: name.trim(), broker, tickers }, setProgress)
      setResult(res)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-upload-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-accent/15 text-accent">
              <Upload className="h-4 w-4" />
            </span>
            <div>
              <h2 id="bulk-upload-title" className="text-base font-bold text-text-primary">
                Bulk upload watchlist
              </h2>
              <p className="mt-0.5 text-xs text-text-secondary">
                Paste comma-separated tickers — we resolve each one and add the matches.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={busy}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-secondary/70 transition-colors hover:bg-card-hi hover:text-text-primary disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-secondary">
                Watchlist name
              </span>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={busy}
                maxLength={80}
                placeholder="My watchlist"
                className="h-9 rounded-md border border-border bg-primary/40 px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent/60 disabled:opacity-50"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-secondary">
                Broker
              </span>
              <select
                value={broker}
                onChange={e => setBroker(e.target.value as WatchlistBroker)}
                disabled={busy}
                className="h-9 rounded-md border border-border bg-primary/40 px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent/60 disabled:opacity-50"
              >
                {WATCHLIST_BROKER_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between text-[11px] font-bold uppercase tracking-[0.12em] text-text-secondary">
              <span>Tickers</span>
              <span className="font-mono normal-case tracking-normal text-text-secondary/80">
                {tickers.length} detected
              </span>
            </span>
            <textarea
              value={raw}
              onChange={e => setRaw(e.target.value)}
              disabled={busy}
              rows={5}
              placeholder="RELIANCE, TCS, INFY, HDFCBANK, SBIN"
              className="resize-y rounded-md border border-border bg-primary/40 px-3 py-2 font-mono text-sm text-text-primary outline-none transition-colors focus:border-accent/60 disabled:opacity-50"
            />
            <span className="text-[11px] text-text-secondary/80">
              Separate with commas, spaces, or new lines. Duplicates are ignored.
            </span>
          </label>

          {progress && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-text-secondary">
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                  Resolving {progress.current || '…'}
                </span>
                <span className="font-mono tabular-nums">
                  {progress.done}/{progress.total}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-200"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}

          {result && (
            <div className="space-y-2.5 rounded-lg border border-border bg-primary/30 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-green/30 bg-green/10 px-2 py-0.5 font-bold text-green">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {result.succeeded.length} added
                </span>
                {result.failed.length > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-red/30 bg-red/10 px-2 py-0.5 font-bold text-red">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {result.failed.length} failed
                  </span>
                )}
                <span className="text-text-secondary">→ {result.watchlistName}</span>
              </div>
              {result.failed.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-secondary">
                    Not found
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {result.failed.map(t => (
                      <span
                        key={t}
                        className="rounded border border-red/30 bg-red/10 px-1.5 py-0.5 font-mono text-[11px] text-red"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="outline" size="sm" onClick={handleClose} disabled={busy}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSubmit}
            disabled={busy || tickers.length === 0 || !name.trim()}
            className="gap-1.5"
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Uploading…
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5" />
                Create &amp; add {tickers.length > 0 ? tickers.length : ''}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
