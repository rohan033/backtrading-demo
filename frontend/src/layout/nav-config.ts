import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  BarChart3,
  FlaskConical,
  History,
  LayoutDashboard,
  LineChart,
  PlayCircle,
  Settings,
  Star,
  TrendingUp,
  Wallet,
  Wrench,
  Zap,
} from 'lucide-react'

export type NavItem = {
  label: string
  to: string
  end?: boolean
  icon: LucideIcon
  iconBg: string
  iconFg: string
}

export type NavGroup = {
  title: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Monitor',
    items: [
      {
        label: 'Dashboard',
        to: '/dashboard',
        end: true,
        icon: LayoutDashboard,
        iconBg: 'bg-accent/20',
        iconFg: 'text-accent',
      },
      {
        label: 'Portfolio',
        to: '/portfolio',
        icon: Wallet,
        iconBg: 'bg-green/20',
        iconFg: 'text-green',
      },
      {
        label: 'Watchlist',
        to: '/watchlist',
        icon: Star,
        iconBg: 'bg-amber-400/20',
        iconFg: 'text-amber-400',
      },
      {
        label: 'Market',
        to: '/market',
        icon: TrendingUp,
        iconBg: 'bg-emerald-400/20',
        iconFg: 'text-emerald-400',
      },
    ],
  },
  {
    title: 'Trade',
    items: [
      {
        label: 'Strategies',
        to: '/trade/strategies',
        icon: Zap,
        iconBg: 'bg-violet-400/20',
        iconFg: 'text-violet-400',
      },
      {
        label: 'Activity',
        to: '/trade/activity',
        icon: Activity,
        iconBg: 'bg-orange-400/20',
        iconFg: 'text-orange-400',
      },
      {
        label: 'Charts',
        to: '/trade/charts',
        icon: LineChart,
        iconBg: 'bg-cyan-400/20',
        iconFg: 'text-cyan-400',
      },
    ],
  },
  {
    title: 'Learn',
    items: [
      {
        label: 'Backtest Lab',
        to: '/learn/backtest',
        icon: FlaskConical,
        iconBg: 'bg-fuchsia-400/20',
        iconFg: 'text-fuchsia-400',
      },
      {
        label: 'Simulation',
        to: '/learn/simulation',
        icon: PlayCircle,
        iconBg: 'bg-sky-400/20',
        iconFg: 'text-sky-400',
      },
      {
        label: 'Tools',
        to: '/learn/tools',
        icon: Wrench,
        iconBg: 'bg-slate-400/20',
        iconFg: 'text-slate-300',
      },
    ],
  },
  {
    title: 'Insights',
    items: [
      {
        label: 'Performance',
        to: '/insights/performance',
        icon: BarChart3,
        iconBg: 'bg-teal-400/20',
        iconFg: 'text-teal-400',
      },
      {
        label: 'History & Reports',
        to: '/insights/history',
        icon: History,
        iconBg: 'bg-rose-400/20',
        iconFg: 'text-rose-400',
      },
    ],
  },
]

export const SETTINGS_NAV: NavItem = {
  label: 'Settings',
  to: '/settings',
  icon: Settings,
  iconBg: 'bg-text-secondary/20',
  iconFg: 'text-text-secondary',
}
