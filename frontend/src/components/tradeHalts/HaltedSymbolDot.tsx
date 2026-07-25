import { haltedSymbolTitle } from '../../lib/tradeHaltsUi'
import type { TradeHalt } from '../../lib/tradeHalts'
import './HaltedSymbolDot.css'

type Props = {
  halt?: TradeHalt | null
  className?: string
}

export default function HaltedSymbolDot({ halt, className = '' }: Props) {
  if (!halt || String(halt.status).toLowerCase() !== 'halted') return null
  const title = haltedSymbolTitle(halt)
  return (
    <span
      className={`halt-dot${className ? ` ${className}` : ''}`}
      title={title}
      aria-label={title}
      role="img"
    />
  )
}
