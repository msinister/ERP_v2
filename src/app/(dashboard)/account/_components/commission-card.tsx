'use client';

import { TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

type CommissionData = {
  earned: number;
  reversed: number;
  net: number;
  period: { year: number; month: number };
  accrualCount: number;
  basis: string | null;
  percent: string | null;
};

export function CommissionCard({ data }: { data: CommissionData }) {
  const periodLabel = `${MONTH_NAMES[data.period.month]} ${data.period.year}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Commission Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {periodLabel} · {data.basis ?? 'Revenue'} basis
          {data.percent ? ` · ${data.percent}%` : ''}
        </p>

        <div className="grid grid-cols-3 gap-3">
          <Stat label="Earned" value={data.earned} />
          <Stat label="Reversed" value={-data.reversed} negative />
          <Stat label="Net" value={data.net} highlight />
        </div>

        {data.accrualCount === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <TrendingUp className="size-4" />
            No commissions recorded this month yet.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  negative = false,
  highlight = false,
}: {
  label: string;
  value: number;
  negative?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`mt-0.5 text-base font-semibold ${
          highlight
            ? value < 0
              ? 'text-destructive'
              : 'text-foreground'
            : negative
              ? 'text-destructive'
              : 'text-foreground'
        }`}
      >
        {negative && value !== 0 ? '-' : ''}{formatCurrency(Math.abs(value))}
      </div>
    </div>
  );
}
