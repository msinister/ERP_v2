import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// Shared chrome for every dashboard widget. Keeps the card title +
// optional subtitle line consistent and lets each widget body focus
// on its data shape.

export function WidgetCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card size="sm" className={cn('h-full', className)}>
      <CardHeader>
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </CardTitle>
        {subtitle ? (
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        ) : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function WidgetSkeleton({
  title,
  bodyClassName = 'h-12',
  className,
}: {
  title: string;
  bodyClassName?: string;
  className?: string;
}) {
  return (
    <WidgetCard title={title} className={className}>
      <Skeleton className={bodyClassName} />
    </WidgetCard>
  );
}
