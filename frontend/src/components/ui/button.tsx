import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-semibold ring-offset-background transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-brand text-brand-foreground shadow-[0_4px_14px_rgb(var(--c-accent)/0.28)] hover:-translate-y-px hover:shadow-[0_6px_20px_rgb(var(--c-accent)/0.42)] active:translate-y-0',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90',
        outline:
          'border border-input bg-card/40 hover:border-accent/40 hover:bg-card-hi hover:text-foreground',
        secondary:
          'bg-muted text-foreground hover:bg-card-hi',
        tertiary:
          'border border-transparent bg-transparent text-text-secondary hover:border-border hover:bg-card/70 hover:text-text-primary',
        ghost: 'hover:bg-muted hover:text-foreground',
        link: 'text-brand underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        xs: 'h-7 rounded px-3 text-[11px] font-semibold',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
