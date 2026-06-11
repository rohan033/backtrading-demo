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

import { Button } from '@/components/ui/button'
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
  default: 'bg-card border-border text-text-primary',
  success: 'bg-card border-green/50',
  error: 'bg-card border-red/50',
  warning: 'bg-card border-amber-500/50',
}

const titleColor: Record<Variant, string> = {
  default: 'text-text-primary',
  success: 'text-green',
  error: 'text-red',
  warning: 'text-amber-400',
}

const iconColor: Record<Variant, string> = {
  default: 'text-text-secondary',
  success: 'text-green',
  error: 'text-red',
  warning: 'text-amber-400',
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
                'flex w-full max-w-xs items-start justify-between gap-2 rounded-xl border p-3 shadow-md',
                variantStyles[variant],
              )}
            >
              <div className="flex min-w-0 items-start gap-2">
                <Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', iconColor[variant])} />
                <div className="min-w-0 space-y-0.5">
                  {title ? (
                    <h3
                      className={cn(
                        'text-xs font-medium leading-none',
                        titleColor[variant],
                        highlightTitle && titleColor.success,
                      )}
                    >
                      {title}
                    </h3>
                  ) : null}
                  <p className="text-xs text-text-secondary">{message}</p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {actions ? (
                  <Button
                    variant={actions.variant || 'outline'}
                    size="sm"
                    onClick={() => {
                      actions.onClick()
                      sonnerToast.dismiss(toastId)
                    }}
                    className="h-7 cursor-pointer gap-1 px-2 text-xs"
                  >
                    {actions.icon ? <actions.icon className="h-3.5 w-3.5" /> : null}
                    {actions.label}
                  </Button>
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    sonnerToast.dismiss(toastId)
                    onDismiss?.()
                  }}
                  className="rounded-full p-1 transition-colors hover:bg-secondary focus:outline-none"
                  aria-label="Dismiss notification"
                >
                  <X className="h-3 w-3 text-text-secondary" />
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
