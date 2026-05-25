export type LogLineCategory =
  | 'error'
  | 'warn'
  | 'buy'
  | 'sell'
  | 'trigger'
  | 'ws'
  | 'tick'
  | 'engine'
  | 'control'
  | 'info'
  | 'default'

export type ParsedLogLine = {
  id: string
  raw: string
  timestamp: string | null
  message: string
  category: LogLineCategory
  indent: number
  className: string
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:,\d+)?|\d{2}:\d{2}:\d{2})\s+/

const CATEGORY_CLASS: Record<LogLineCategory, string> = {
  error: 'text-red',
  warn: 'text-amber-400',
  buy: 'text-green',
  sell: 'text-orange-400',
  trigger: 'text-violet-400',
  ws: 'text-cyan-400',
  tick: 'text-sky-400/90',
  engine: 'text-indigo-300',
  control: 'text-fuchsia-300',
  info: 'text-text-primary',
  default: 'text-text-secondary',
}

export function parseLogLine(raw: string, index: number): ParsedLogLine {
  const cleaned = raw.replace(ANSI_ESCAPE_RE, '')
  const leadingSpaces = cleaned.match(/^(\s+)/)?.[1].length ?? 0
  const trimmed = cleaned.trimStart()
  const timestampMatch = trimmed.match(TIMESTAMP_RE)
  const timestamp = timestampMatch?.[1] ?? null
  const message = timestamp ? trimmed.slice(timestampMatch[0].length) : trimmed
  const category = classifyLogLine(message)

  return {
    id: `${index}-${message.slice(0, 48)}`,
    raw: cleaned,
    timestamp,
    message,
    category,
    indent: Math.min(4, Math.floor(leadingSpaces / 2)),
    className: CATEGORY_CLASS[category],
  }
}

function classifyLogLine(message: string): LogLineCategory {
  const upper = message.toUpperCase()

  if (
    /\b(ERROR|CRITICAL|EXCEPTION|TRACEBACK|REJECTED|FAILED|FAILURE)\b/.test(upper)
    || message.includes('❌')
  ) {
    return 'error'
  }

  if (/\b(WARNING|WARN|STALE|DROPPING)\b/.test(upper)) {
    return 'warn'
  }

  if (
    /\b(BUY|ORDER\s+PLACED|ORDER_FILLED|FILLED|LONG|TAKE_PROFIT)\b/.test(upper)
    || upper.includes('▲')
    || upper.includes('[TM] PLACING BUY')
  ) {
    return 'buy'
  }

  if (
    /\b(SELL|STOP_LOSS|POSITION_CLOSED|CLOSE|SHORT|ORDER_CANCELLED)\b/.test(upper)
    || upper.includes('▼')
    || upper.includes('[TM] PROCESSING SELL')
  ) {
    return 'sell'
  }

  if (
    /\b(TRIGGER|THRESHOLD|BREAKOUT|ENTRY|EXECUTOR_STATUS|SIGNAL)\b/.test(upper)
    || upper.includes('BUY TRIGGER')
  ) {
    return 'trigger'
  }

  if (/\[(WS|WEBSOCKET|PRICESTREAM)\]|\bWEBSOCKET\b/i.test(message)) {
    return 'ws'
  }

  if (/\[TICK\]|FIRST_TICK|FLOW STATS/.test(upper)) {
    return 'tick'
  }

  if (/\[(ENGINE|LIVE_SEARCH|LIVE_ENGINE)\]/.test(upper)) {
    return 'engine'
  }

  if (/\[(CONTROL|CURSOR_AGENT)\]/.test(upper)) {
    return 'control'
  }

  if (/\[(TM|BROKER|SUMMARY)\]|INFO:|HTTP \//.test(upper)) {
    return 'info'
  }

  return 'default'
}

export function categoryBadge(category: LogLineCategory): string {
  switch (category) {
    case 'buy':
      return 'BUY'
    case 'sell':
      return 'SEL'
    case 'trigger':
      return 'TRG'
    case 'ws':
      return 'WS'
    case 'tick':
      return 'TCK'
    case 'error':
      return 'ERR'
    case 'warn':
      return 'WRN'
    case 'engine':
      return 'ENG'
    case 'control':
      return 'CTL'
    default:
      return 'LOG'
  }
}

export function categoryBadgeClass(category: LogLineCategory): string {
  switch (category) {
    case 'error':
      return 'bg-red/15 text-red'
    case 'warn':
      return 'bg-amber-400/15 text-amber-400'
    case 'buy':
      return 'bg-green/15 text-green'
    case 'sell':
      return 'bg-orange-400/15 text-orange-400'
    case 'trigger':
      return 'bg-violet-400/15 text-violet-400'
    case 'ws':
      return 'bg-cyan-400/15 text-cyan-400'
    case 'tick':
      return 'bg-sky-400/15 text-sky-400'
    case 'engine':
      return 'bg-indigo-400/15 text-indigo-300'
    case 'control':
      return 'bg-fuchsia-400/15 text-fuchsia-300'
    default:
      return 'bg-text-secondary/10 text-text-secondary'
  }
}
