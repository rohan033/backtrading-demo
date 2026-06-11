import { Link } from 'react-router-dom'
import { ArrowRight, BarChart3, LineChart, Wallet, Zap } from 'lucide-react'

import { Gallery4, type Gallery4Item } from '@/components/ui/gallery4'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import '@/features-theme.css'

const featureItems: Gallery4Item[] = [
  {
    id: 'backtest-lab',
    title: 'Backtest Lab',
    description:
      'Replay historical sessions with configurable entry triggers, take-profit, and stop-loss rules.',
    href: '/learn/backtest',
    image:
      'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=1080&q=80',
  },
  {
    id: 'live-strategies',
    title: 'Live Strategies',
    description:
      'Deploy automated broker-stock-strategy bots with demo or live environments and multi-runtime chart streaming.',
    href: '/trade/strategies',
    image:
      'https://images.unsplash.com/photo-1642790106117-e829e14a795f?auto=format&fit=crop&w=1080&q=80',
  },
  {
    id: 'portfolio-monitor',
    title: 'Portfolio Monitor',
    description:
      'Track holdings, unrealized P&L, and buying power in one view.',
    href: '/portfolio',
    image:
      'https://images.unsplash.com/photo-1559526324-593bc073d938?auto=format&fit=crop&w=1080&q=80',
  },
  {
    id: 'market-watchlist',
    title: 'Market & Watchlist',
    description:
      'Build watchlists, scan session status, and compare symbol momentum.',
    href: '/watchlist',
    image:
      'https://images.unsplash.com/photo-1526628953301-3e589a6a8b74?auto=format&fit=crop&w=1080&q=80',
  },
  {
    id: 'activity-analytics',
    title: 'Activity & Analytics',
    description:
      'Unified orders, fills, and trading events with scoped filters per strategy.',
    href: '/trade/activity',
    image:
      'https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=1080&q=80',
  },
  {
    id: 'etoro-integration',
    title: 'eToro & Multi-Broker',
    description:
      'Hybrid websocket and REST order tracking with environment-aware demo/live routing.',
    href: '/settings',
    image:
      'https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=1080&q=80',
  },
]

const highlights = [
  {
    icon: LineChart,
    title: 'Research to execution',
    description: 'One platform from historical backtests to live multi-runtime strategies.',
  },
  {
    icon: Zap,
    title: 'Operator-first UX',
    description: 'Clear hierarchy between monitor, trade, learn, and insights workflows.',
  },
  {
    icon: Wallet,
    title: 'Broker-aware portfolio',
    description: 'Holdings, cash, and strategy P&L surfaced in a single account summary.',
  },
  {
    icon: BarChart3,
    title: 'Event-driven activity',
    description: 'Order lifecycle events, session history, and performance in one timeline.',
  },
]

export default function FeaturesPage() {
  return (
    <div className="features-shell">
      <header className="border-b border-border/60">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-brand-foreground font-bold">
              SD
            </span>
            <div>
              <div className="text-sm font-semibold">Strategy Desk</div>
              <div className="text-xs text-muted-foreground">Professional trading platform</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost">
              <Link to="/watchlist">Open app</Link>
            </Button>
            <Button asChild>
              <Link to="/watchlist">
                Launch workspace
                <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <section className="container mx-auto px-4 py-16 md:py-24">
        <div className="max-w-3xl">
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-brand">
            Platform capabilities
          </p>
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl lg:text-6xl">
            Built for serious strategy operators
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
            Monitor portfolios, deploy live strategies, run backtests, and review activity —
            with a SaaS-grade information architecture designed to reduce noise and cognitive load.
          </p>
        </div>
      </section>

      <Gallery4
        title="Platform features"
        description="Explore the core modules in the redesigned Strategy Desk experience."
        items={featureItems}
      />

      <section className="container mx-auto px-4 pb-20">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {highlights.map(({ icon: Icon, title, description }) => (
            <Card key={title} className="border-border/80 bg-ui-card">
              <CardHeader>
                <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-brand/10 text-brand">
                  <Icon className="size-5" />
                </div>
                <CardTitle className="text-lg">{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
              <CardContent />
            </Card>
          ))}
        </div>
      </section>

      <footer className="border-t border-border/60 py-8">
        <div className="container mx-auto flex flex-col items-start justify-between gap-4 px-4 md:flex-row md:items-center">
          <p className="text-sm text-muted-foreground">
            Strategy Desk · shadcn Gallery4 marketing page
          </p>
          <Button asChild variant="outline">
            <Link to="/watchlist">Return to trading app</Link>
          </Button>
        </div>
      </footer>
    </div>
  )
}
