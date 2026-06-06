import { db } from '@/lib/db';
import { listContacts } from '@/server/services/customerContacts';
import { ContactsClient } from '../_components/contacts-client';

export async function ContactsTab({ customerId }: { customerId: string }) {
  const contacts = await listContacts(db, customerId);

  return (
    <ContactsClient
      customerId={customerId}
      contacts={contacts.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        email: c.email,
        phone: c.phone,
        mobile: c.mobile,
        isPrimary: c.isPrimary,
      }))}
    />
  );
}
