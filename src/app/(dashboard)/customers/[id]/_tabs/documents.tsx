import { db } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listDocumentsForCustomer } from '@/server/services/customerDocuments';
import { formatStatusLabel } from '@/lib/format';
import { TabShell, TabEmpty } from './tab-shell';

const SENSITIVE_KINDS = new Set(['EIN', 'SSN', 'DRIVERS_LICENSE']);

export async function DocumentsTab({ customerId }: { customerId: string }) {
  const docs = await listDocumentsForCustomer(db, customerId);

  if (docs.length === 0) {
    return (
      <TabShell>
        <TabEmpty message="No documents uploaded." />
      </TabShell>
    );
  }

  const now = Date.now();
  const SOON_MS = 30 * 24 * 60 * 60 * 1000;

  return (
    <TabShell>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>Kind</TableHead>
              <TableHead>File / value</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {docs.map((d) => {
              const isSensitive = SENSITIVE_KINDS.has(d.kind);
              const expMs = d.expiresOn?.getTime();
              const expiresSoon =
                expMs != null && expMs > now && expMs - now < SOON_MS;
              const expired = expMs != null && expMs < now;
              return (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">
                    {formatStatusLabel(d.kind)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {isSensitive ? (
                      <span className="font-mono text-xs">
                        encrypted — view requires audit
                      </span>
                    ) : (
                      <span>{d.fileName ?? d.storageKey ?? '—'}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {d.expiresOn ? (
                      <div className="flex items-center gap-2">
                        <span className="text-sm tabular-nums">
                          {d.expiresOn.toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            timeZone: 'UTC',
                          })}
                        </span>
                        {expired ? (
                          <Badge variant="destructive">Expired</Badge>
                        ) : expiresSoon ? (
                          <Badge variant="outline">≤ 30 d</Badge>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {d.notes ?? '—'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </TabShell>
  );
}
