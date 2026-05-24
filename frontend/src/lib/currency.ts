const INR_LOCALE = 'en-IN'

type InrOptions = {
  maxFractionDigits?: number
  minFractionDigits?: number
}

export function formatIndianNumber(
  value: number,
  maxFractionDigits = 2,
  minFractionDigits?: number,
) {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(INR_LOCALE, {
    minimumFractionDigits:
      minFractionDigits ?? (maxFractionDigits === 0 ? 0 : 0),
    maximumFractionDigits: maxFractionDigits,
  }).format(value)
}

export function formatInr(value: number, options: InrOptions = {}) {
  const maxFractionDigits = options.maxFractionDigits ?? 2
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(INR_LOCALE, {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits:
      options.minFractionDigits ?? (maxFractionDigits === 0 ? 0 : 2),
    maximumFractionDigits: maxFractionDigits,
  }).format(value)
}

export function formatSignedInr(value: number, options: InrOptions = {}) {
  if (!Number.isFinite(value)) return '—'
  const prefix = value >= 0 ? '+' : ''
  return `${prefix}${formatInr(value, options)}`
}

export function formatUsd(value: number, maxFractionDigits = 2) {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: maxFractionDigits,
  }).format(value)
}

export function formatSignedUsd(value: number, maxFractionDigits = 2) {
  if (!Number.isFinite(value)) return '—'
  const prefix = value >= 0 ? '+' : ''
  return `${prefix}${formatUsd(value, maxFractionDigits)}`
}

export function isIndianBroker(broker?: string | null) {
  const normalized = String(broker || 'angel').toLowerCase()
  return normalized === 'angel' || normalized === 'fake'
}

export function formatBrokerMoney(
  broker: string | undefined | null,
  value: number,
  maxFractionDigits = 2,
) {
  return isIndianBroker(broker)
    ? formatInr(value, { maxFractionDigits })
    : formatUsd(value, maxFractionDigits)
}

export function formatBrokerSignedMoney(
  broker: string | undefined | null,
  value: number,
  maxFractionDigits = 2,
) {
  return isIndianBroker(broker)
    ? formatSignedInr(value, { maxFractionDigits })
    : formatSignedUsd(value, maxFractionDigits)
}

export function formatBrokerPrice(broker: string | undefined | null, value: number) {
  return formatBrokerMoney(broker, value, 2)
}

export function formatPriceInput(value: number | string) {
  const num = Number(value)
  if (!Number.isFinite(num)) return ''
  return num.toFixed(2)
}

export function formatInrCompact(value: number) {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1e7) return `${sign}₹${formatIndianNumber(abs / 1e7, 2)} Cr`
  if (abs >= 1e5) return `${sign}₹${formatIndianNumber(abs / 1e5, 2)} L`
  return formatInr(value)
}

export function formatBrokerCompactMoney(
  broker: string | undefined | null,
  value: number,
) {
  return isIndianBroker(broker) ? formatInrCompact(value) : formatUsd(value, 0)
}

export function formatIndianDateTime(value: number | string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(INR_LOCALE, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatIndianTime(value: number | string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString(INR_LOCALE, {
    hour: 'numeric',
    minute: '2-digit',
  })
}
