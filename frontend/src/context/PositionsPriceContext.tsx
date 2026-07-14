import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

type PositionsPriceContextValue = {
  prices: Readonly<Record<string, number>>
  reportPrice: (rowKey: string, ltp: number | null | undefined) => void
}

const PositionsPriceContext = createContext<PositionsPriceContextValue | null>(null)

export function PositionsPriceProvider({ children }: { children: ReactNode }) {
  const [prices, setPrices] = useState<Record<string, number>>({})
  const pricesRef = useRef(prices)
  pricesRef.current = prices

  const reportPrice = useCallback((rowKey: string, ltp: number | null | undefined) => {
    if (ltp == null || !(ltp > 0)) return
    if (pricesRef.current[rowKey] === ltp) return
    setPrices(prev => (prev[rowKey] === ltp ? prev : { ...prev, [rowKey]: ltp }))
  }, [])

  const value = useMemo(
    () => ({ prices, reportPrice }),
    [prices, reportPrice],
  )

  return (
    <PositionsPriceContext.Provider value={value}>
      {children}
    </PositionsPriceContext.Provider>
  )
}

export function usePositionsPrice() {
  const ctx = useContext(PositionsPriceContext)
  if (!ctx) {
    throw new Error('usePositionsPrice must be used within PositionsPriceProvider')
  }
  return ctx
}
