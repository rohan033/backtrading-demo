import { useEffect, useRef } from 'react'

import Toaster, { type ToasterProps, type ToasterRef } from '@/components/ui/toast'

let toasterRef: ToasterRef | null = null

export function PlatformToastHost() {
  const ref = useRef<ToasterRef>(null)

  useEffect(() => {
    toasterRef = ref.current
    return () => {
      toasterRef = null
    }
  })

  return <Toaster ref={ref} defaultPosition="top-right" />
}

export function showPlatformToast(props: ToasterProps) {
  toasterRef?.show(props)
}

export type { ToasterProps }
