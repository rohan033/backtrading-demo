import { forwardRef, useImperativeHandle, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  Toaster as SonnerToaster,
  toast as sonnerToast,
} from 'sonner'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Info,
  X,
} from 'lucide-react'

import { cn } from '@/lib/utils'

type Variant = 'default' | 'success' | 'error' | 'warning'
type Position =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

interface ActionButton {
  label: string
  onClick: () => void
  variant?: 'default' | 'outline' | 'ghost' | 'destructive'
  icon?: React.ComponentType<{ className?: string }>
}

export interface ToasterProps {
  title?: string
  message: string
  variant?: Variant
  duration?: number
  position?: Position
  actions?: ActionButton
  onDismiss?: () => void
  highlightTitle?: boolean
}

export interface ToasterRef {
  show: (props: ToasterProps) => void
}

const variantStyles: Record<Variant, string> = {
  default: 'bg-white border-[#D0D0D0] text-[#1A1A1A]',
  success: 'bg-white border-[#8FD4A8] text-[#1A1A1A]',
  error: 'bg-white border-[#E8A0A0] text-[#1A1A1A]',
  warning: 'bg-white border-[#E6C76B] text-[#1A1A1A]',
}

const titleColor: Record<Variant, string> = {
  default: 'text-[#1A1A1A]',
  success: 'text-[#126B3A]',
  error: 'text-[#A61F1F]',
  warning: 'text-[#7A5A00]',
}

const iconColor: Record<Variant, string> = {
  default: 'text-[#404040]',
  success: 'text-[#126B3A]',
  error: 'text-[#A61F1F]',
  warning: 'text-[#8A6A00]',
}

const variantIcons: Record<Variant, React.ComponentType<{ className?: string }>> = {
  default: Info,
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
}

const toastAnimation = {
  initial: { opacity: 0, y: -12, scale: 0.95 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -8, scale: 0.95 },
}

const Toaster = forwardRef<ToasterRef, { defaultPosition?: Position }>(
  ({ defaultPosition = 'top-right' }, ref) => {
    const toastReference = useRef<ReturnType<typeof sonnerToast.custom> | null>(null)

    useImperativeHandle(ref, () => ({
      show({
        title,
        message,
        variant = 'default',
        duration = 4000,
        position = defaultPosition,
        actions,
        onDismiss,
        highlightTitle,
      }) {
        const Icon = variantIcons[variant]

        toastReference.current = sonnerToast.custom(
          (toastId) => (
            <motion.div
              variants={toastAnimation}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className={cn(
                'flex w-full max-w-sm items-start justify-between gap-2 rounded-lg border-[1.5px] p-3 shadow-md',
                variantStyles[variant],
              )}
            >
              <div className="flex min-w-0 items-start gap-2">
                <Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', iconColor[variant])} />
                <div className="min-w-0 space-y-1">
                  {title ? (
                    <h3
                      className={cn(
                        'text-xs font-bold leading-tight',
                        titleColor[variant],
                        highlightTitle && titleColor.success,
                      )}
                    >
                      {title}
                    </h3>
                  ) : null}
                  <p className="whitespace-pre-wrap break-all text-xs leading-snug text-[#404040]">{message}</p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {actions ? (
                  <button
                    type="button"
                    onClick={() => {
                      actions.onClick()
                      sonnerToast.dismiss(toastId)
                    }}
                    className="h-7 cursor-pointer rounded-md border-[1.5px] border-[#D0D0D0] bg-white px-2 text-xs font-bold text-[#1A1A1A] hover:bg-[#F5F5F5]"
                  >
                    {actions.label}
                  </button>
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    sonnerToast.dismiss(toastId)
                    onDismiss?.()
                  }}
                  className="rounded-full p-1 text-[#606060] transition-colors hover:bg-[#F0F0F0] focus:outline-none"
                  aria-label="Dismiss notification"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </motion.div>
          ),
          { duration, position },
        )
      },
    }))

    return (
      <SonnerToaster
        position={defaultPosition}
        toastOptions={{ unstyled: true, className: 'flex justify-end' }}
        expand
        visibleToasts={5}
        gap={10}
      />
    )
  },
)

Toaster.displayName = 'Toaster'

export default Toaster
