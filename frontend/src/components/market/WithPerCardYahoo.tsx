import type { ReactNode } from 'react'

import { usePerCardYahooPrice } from '../../hooks/useYahooExtendedQuotes'
import { YahooPriceCardToggle } from './YahooPriceCardToggle'

type Props = {
  children: (state: {
    yahooPriceEnabled: boolean
    yahooToggle: ReactNode
  }) => ReactNode
}

export function WithPerCardYahoo({ children }: Props) {
  const {
    yahooPriceEnabled,
    yahooPriceChecked,
    setYahooPriceEnabled,
    showYahooToggle,
  } = usePerCardYahooPrice()

  const yahooToggle = showYahooToggle ? (
    <YahooPriceCardToggle
      checked={yahooPriceChecked}
      onChange={setYahooPriceEnabled}
    />
  ) : null

  return children({ yahooPriceEnabled, yahooToggle })
}
