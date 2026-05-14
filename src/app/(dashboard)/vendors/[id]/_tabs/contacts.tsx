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
import { listVendorContacts } from '@/server/services/vendorContacts';
import { TabShell, TabEmpty } from './tab-shell';
import { AddContactButton } from '../_components/add-contact-button';
import { ContactRowActions } from '../_components/contact-row-actions';

export async function ContactsTab({ vendorId }: { vendorId: string }) {
  const contacts = await listVendorContacts(db, vendorId);

  if (contacts.length === 0) {
    return (
      <TabShell>
        <TabEmpty
          message="No contacts on file."
          action={<AddContactButton vendorId={vendorId} />}
        />
      </TabShell>
    );
  }

  return (
    <TabShell>
      <div className="flex justify-end">
        <AddContactButton vendorId={vendorId} />
      </div>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Mobile</TableHead>
              <TableHead className="w-24">Primary</TableHead>
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
                <TableCell>
                  <ContactRowActions
                    vendorId={vendorId}
                    contact={{
                      id: c.id,
                      name: c.name,
                      role: c.role,
                      email: c.email,
                      phone: c.phone,
                      mobile: c.mobile,
                      isPrimary: c.isPrimary,
                    }}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </TabShell>
  );
}
