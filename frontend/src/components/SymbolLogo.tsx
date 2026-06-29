import { useState } from 'react'

import type { SymbolVisual } from '../lib/symbolVisuals'

type SymbolLogoProps = {
  symbol: string
  visual?: SymbolVisual | null
  size?: 'small' | 'large'
  classPrefix?: 'st' | 'hm-r' | 'wt'
}

export default function SymbolLogo({
  symbol,
  visual,
  size = 'small',
  classPrefix = 'hm-r',
}: SymbolLogoProps) {
  const [failed, setFailed] = useState(false)
  const ticker = visual?.ticker || symbol
  const src = size === 'large'
    ? (visual?.logo150x150 || visual?.logo50x50 || visual?.logo35x35)
    : (visual?.logo35x35 || visual?.logo50x50 || visual?.logo150x150)

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={ticker}
        className={`${classPrefix}-symbol-logo${size === 'large' ? ` ${classPrefix}-symbol-logo--large` : ''}`}
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <span className={`${classPrefix}-symbol-letter${size === 'large' ? ` ${classPrefix}-symbol-letter--large` : ''}`}>
      {(ticker || '?').charAt(0)}
    </span>
  )
}
