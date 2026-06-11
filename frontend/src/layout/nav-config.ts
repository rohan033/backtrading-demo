import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  BarChart3,
  FlaskConical,
  History,
  LayoutDashboard,
  LineChart,
  PlayCircle,
  Radio,
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
  icon?: LucideIcon
  iconText?: string
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
        iconBg: 'bg-accent/15',
        iconFg: 'text-accent',
      },
      {
        label: 'Portfolio',
        to: '/portfolio',
        icon: Wallet,
        iconBg: 'bg-green/15',
        iconFg: 'text-green',
      },
      {
        label: 'Watchlist',
        to: '/watchlist',
        icon: Star,
        iconBg: 'bg-accent/15',
        iconFg: 'text-accent',
      },
      {
        label: 'Market',
        to: '/market',
        icon: TrendingUp,
        iconBg: 'bg-accent-2/15',
        iconFg: 'text-accent-2',
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
        iconBg: 'bg-accent/15',
        iconFg: 'text-accent',
      },
      {
        label: 'Activity',
        to: '/trade/activity',
        icon: Activity,
        iconBg: 'bg-accent-2/15',
        iconFg: 'text-accent-2',
      },
      {
        label: 'Charts',
        to: '/trade/charts',
        icon: LineChart,
        iconBg: 'bg-accent-2/15',
        iconFg: 'text-accent-2',
      },
    ],
  },
  {
    title: 'Learn',
    items: [
      {
        label: 'AI Research',
        to: '/learn/research',
        iconText: 'AI',
        iconBg: 'bg-gradient-to-br from-accent/30 to-accent-2/30',
        iconFg: 'text-text-primary',
      },
      {
        label: 'Backtest Lab',
        to: '/learn/backtest',
        icon: FlaskConical,
        iconBg: 'bg-accent-2/15',
        iconFg: 'text-accent-2',
      },
      {
        label: 'Simulation',
        to: '/learn/simulation',
        icon: PlayCircle,
        iconBg: 'bg-accent-2/15',
        iconFg: 'text-accent-2',
      },
      {
        label: 'Tools',
        to: '/learn/tools',
        icon: Wrench,
        iconBg: 'bg-text-secondary/15',
        iconFg: 'text-text-secondary',
      },
    ],
  },
  {
    title: 'Insights',
    items: [
      {
        label: 'Live servers',
        to: '/insights/live-servers',
        icon: Radio,
        iconBg: 'bg-green/15',
        iconFg: 'text-green',
      },
      {
        label: 'Performance',
        to: '/insights/performance',
        icon: BarChart3,
        iconBg: 'bg-accent-2/15',
        iconFg: 'text-accent-2',
      },
      {
        label: 'History & Reports',
        to: '/insights/history',
        icon: History,
        iconBg: 'bg-text-secondary/15',
        iconFg: 'text-text-secondary',
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
