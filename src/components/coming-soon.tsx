import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Placeholder body for sidebar destinations whose modules are still
// under construction. Each module slice will replace its own /<slug>
// page with a real implementation.

export function ComingSoon({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="size-4 text-muted-foreground" />
            Module under construction
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Backend services for this module are in place. The UI lands in a
          later GUI slice.
        </CardContent>
      </Card>
    </div>
  );
}
