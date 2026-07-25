import { MAX_PINNED_HALTS, useTradeHalts } from '../../context/TradeHaltsContext'
import PinnedHaltPill from './PinnedHaltPill'
import './PinnedHaltHeaderBar.css'

export default function PinnedHaltHeaderBar() {
  const { pinnedHalts, unpinHalt } = useTradeHalts()

  if (!pinnedHalts.length) return null

  const columnCount = Math.min(pinnedHalts.length, MAX_PINNED_HALTS)

  return (
    <div className="ms-pinned-halt-strip" role="region" aria-label="Pinned trade halts">
      <div
        className="ms-pinned-halt-grid"
        style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
      >
        {pinnedHalts.slice(0, MAX_PINNED_HALTS).map(halt => (
          <PinnedHaltPill key={halt.id} halt={halt} onUnpin={() => unpinHalt(halt.id)} />
        ))}
      </div>
    </div>
  )
}
