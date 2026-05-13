import Link from 'next/link';
import {
  Boxes,
  FileText,
  LineChart,
  ListChecks,
  Receipt,
  ScrollText,
  Scale,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type ReportCard = {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
};

const FINANCIAL: ReportCard[] = [
  {
    href: '/reports/trial-balance',
    title: 'Trial Balance',
    description: 'Beginning, period activity, and ending balances per account.',
    icon: Scale,
  },
  {
    href: '/reports/balance-sheet',
    title: 'Balance Sheet',
    description: 'Assets, liabilities, and equity as of a point in time.',
    icon: FileText,
  },
  {
    href: '/reports/income-statement',
    title: 'Income Statement',
    description: 'Revenue, expenses, and net income for a period.',
    icon: LineChart,
  },
  {
    href: '/reports/gl-detail',
    title: 'GL Detail',
    description: 'Journal-entry detail for a single account with running balance.',
    icon: ListChecks,
  },
  {
    href: '/reports/journal',
    title: 'Journal',
    description: 'Every posted journal entry for a period with all lines.',
    icon: ScrollText,
  },
];

const OPERATIONAL: ReportCard[] = [
  {
    href: '/reports/sales/by-customer',
    title: 'Sales by Customer',
    description: 'Revenue and order count grouped by customer.',
    icon: Users,
  },
  {
    href: '/reports/sales/by-item',
    title: 'Sales by Item',
    description: 'Quantity sold and revenue grouped by variant.',
    icon: Receipt,
  },
  {
    href: '/reports/inventory/valuation',
    title: 'Inventory Valuation',
    description: 'On-hand quantity and WAC-based value by SKU and warehouse.',
    icon: Boxes,
  },
];

export default function ReportsHubPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Financial and operational reporting. All read-only — pick a report
          to open it.
        </p>
      </div>

      <Section title="Financial" cards={FINANCIAL} />
      <Section title="Operational" cards={OPERATIONAL} />
    </div>
  );
}

function Section({ title, cards }: { title: string; cards: ReportCard[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <ReportTile key={c.href} card={c} />
        ))}
      </div>
    </section>
  );
}

function ReportTile({ card }: { card: ReportCard }) {
  const Icon = card.icon;
  return (
    <Link href={card.href} className="block focus:outline-none">
      <Card className="h-full transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring">
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="rounded-md border border-border bg-background p-2 text-muted-foreground">
              <Icon className="size-4" />
            </span>
            <CardTitle className="text-base">{card.title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{card.description}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
