import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatStatusLabel } from '@/lib/format';

export type ReceiptBillRef = {
  id: string;
  number: string;
  status: string;
};

export function ReceiptInfoCard({
  warehouseCode,
  warehouseName,
  notes,
  linkedBills,
}: {
  warehouseCode: string;
  warehouseName: string;
  notes: string | null;
  linkedBills: ReceiptBillRef[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Receipt info</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
          <Row label="Warehouse" value={`${warehouseName} (${warehouseCode})`} />
          <div className="space-y-0.5">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              Linked bills
            </dt>
            <dd className="text-sm">
              {linkedBills.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <ul className="space-y-1">
                  {linkedBills.map((b) => (
                    <li key={b.id} className="flex items-center gap-2">
                      {/* Bills UI is upcoming — show the number + status
                          as plain text for now. Once the bills GUI lands
                          this can flip to a Link to /bills/[id]. */}
                      <span className="font-mono">{b.number}</span>
                      <BillStatusBadge status={b.status} />
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>

        {notes ? (
          <div className="mt-4 border-t pt-3">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Notes
            </div>
            <p className="whitespace-pre-line text-sm">{notes}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BillStatusBadge({ status }: { status: string }) {
  const label = formatStatusLabel(status);
  if (status === 'CONFIRMED') {
    return <Badge variant="secondary">{label}</Badge>;
  }
  if (status === 'CANCELLED') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {label}
      </Badge>
    );
  }
  return <Badge variant="outline">{label}</Badge>;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}
