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
import { listContacts } from '@/server/services/customerContacts';
import { TabShell, TabEmpty } from './tab-shell';

export async function ContactsTab({ customerId }: { customerId: string }) {
  const contacts = await listContacts(db, customerId);

  if (contacts.length === 0) {
    return (
      <TabShell>
        <TabEmpty message="No contacts on file." />
      </TabShell>
    );
  }

  return (
    <TabShell>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Mobile</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {contacts.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {c.role ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {c.email ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {c.phone ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {c.mobile ?? '—'}
                </TableCell>
                <TableCell>
                  {c.isPrimary ? (
                    <Badge variant="secondary">Primary</Badge>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </TabShell>
  );
}
