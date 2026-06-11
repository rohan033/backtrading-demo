/** @type {import('tailwindcss').Config} */

// Single source of truth: colors are CSS variables (space-separated RGB channels)
// defined in src/index.css :root, so Tailwind opacity modifiers (e.g. bg-accent/15)
// keep working via the <alpha-value> placeholder.
const channel = (name) => `rgb(var(${name}) / <alpha-value>)`

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Core surface palette (consumed app-wide)
        primary: channel('--c-bg'),
        secondary: channel('--c-bg-elev'),
        card: channel('--c-card'),
        'card-hi': channel('--c-card-hi'),
        border: channel('--c-border'),
        accent: channel('--c-accent'),
        'accent-2': channel('--c-accent-2'),
        'text-primary': channel('--c-text'),
        'text-secondary': channel('--c-text-2'),
        green: channel('--c-up'),
        red: channel('--c-down'),

        // shadcn-compatible aliases (previously only defined inside .features-shell)
        background: channel('--c-bg'),
        foreground: channel('--c-text'),
        brand: channel('--c-accent'),
        'brand-foreground': channel('--c-ink'),
        muted: channel('--c-card-hi'),
        'muted-foreground': channel('--c-text-2'),
        'ui-card': channel('--c-card'),
        input: channel('--c-border'),
        ring: channel('--c-accent'),
        destructive: channel('--c-down'),
        'destructive-foreground': channel('--c-text'),
      },
      fontFamily: {
        display: ['Bricolage Grotesque', 'Hanken Grotesk', 'system-ui', 'sans-serif'],
        sans: ['Hanken Grotesk', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      borderRadius: {
        lg: '0.75rem',
        md: '0.5rem',
        sm: '0.375rem',
      },
      boxShadow: {
        glow: '0 0 0 1px rgb(var(--c-accent) / 0.35), 0 8px 28px -8px rgb(var(--c-accent) / 0.45)',
        panel: '0 1px 0 0 rgb(255 255 255 / 0.02) inset, 0 18px 40px -24px rgb(0 0 0 / 0.7)',
      },
      letterSpacing: {
        tightest: '-0.03em',
      },
      keyframes: {
        'rise-in': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'accent-sweep': {
          '0%': { transform: 'scaleY(0)', opacity: '0' },
          '100%': { transform: 'scaleY(1)', opacity: '1' },
        },
      },
      animation: {
        'rise-in': 'rise-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) both',
        'fade-in': 'fade-in 0.6s ease both',
      },
    },
  },
  plugins: [],
}
