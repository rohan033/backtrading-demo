import type { TradeHalt } from '../../lib/tradeHalts'
import { formatProbableOpenTime } from '../../lib/tradeHaltsUi'
import { useSecondTicker } from '../../hooks/useSecondTicker'
import HaltLudpTimer from './HaltLudpTimer'
import './PinnedHaltPill.css'

type Props = {
  halt: TradeHalt
  onUnpin: () => void
}

export default function PinnedHaltPill({ halt, onUnpin }: Props) {
  const now = useSecondTicker()
  const probableOpen = formatProbableOpenTime(halt, now)
  const reason = halt.reason_code || 'LUDP'

  return (
    <span
      className="ms-pinned-halt-pill"
      title={`${halt.symbol} ${reason} · probable open ${probableOpen}`}
    >
      <strong className="ms-pinned-halt-pill__sym">{halt.symbol}</strong>
      <HaltLudpTimer halt={halt} pill />
      <button
        type="button"
        className="ms-pinned-halt-pill__unpin"
        aria-label={`Unpin ${halt.symbol} from header`}
        onClick={onUnpin}
      >
        ×
      </button>
    </span>
  )
}
