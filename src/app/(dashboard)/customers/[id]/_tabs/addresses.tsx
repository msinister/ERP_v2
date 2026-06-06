import { db } from '@/lib/db';
import { listAddresses } from '@/server/services/customerAddresses';
import { AddressesClient } from '../_components/addresses-client';

export async function AddressesTab({ customerId }: { customerId: string }) {
  const addresses = await listAddresses(db, customerId);

  return (
    <AddressesClient
      customerId={customerId}
      addresses={addresses.map((a) => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        line1: a.line1,
        line2: a.line2,
        city: a.city,
        region: a.region,
        postalCode: a.postalCode,
        country: a.country,
        attention: a.attention,
        phone: a.phone,
        isDefault: a.isDefault,
      }))}
    />
  );
}
