import { db } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listAddresses } from '@/server/services/customerAddresses';
import { TabShell, TabEmpty } from './tab-shell';

export async function AddressesTab({ customerId }: { customerId: string }) {
  const addresses = await listAddresses(db, customerId);

  if (addresses.length === 0) {
    return (
      <TabShell>
        <TabEmpty message="No addresses on file." />
      </TabShell>
    );
  }

  const billing = addresses.filter((a) => a.kind === 'BILLING');
  const shipping = addresses.filter((a) => a.kind === 'SHIPPING');

  return (
    <TabShell>
      {billing.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">
            Billing
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {billing.map((a) => (
              <AddressCard key={a.id} address={a} />
            ))}
          </div>
        </section>
      ) : null}
      {shipping.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">
            Shipping
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {shipping.map((a) => (
              <AddressCard key={a.id} address={a} />
            ))}
          </div>
        </section>
      ) : null}
    </TabShell>
  );
}

function AddressCard({
  address,
}: {
  address: {
    id: string;
    label: string | null;
    line1: string;
    line2: string | null;
    city: string;
    region: string;
    postalCode: string;
    country: string;
    attention: string | null;
    phone: string | null;
    isDefault: boolean;
  };
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span>{address.label ?? 'Address'}</span>
          {address.isDefault ? <Badge variant="secondary">Default</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {address.attention ? (
          <div className="text-muted-foreground">Attn: {address.attention}</div>
        ) : null}
        <div>{address.line1}</div>
        {address.line2 ? <div>{address.line2}</div> : null}
        <div>
          {address.city}, {address.region} {address.postalCode}
        </div>
        <div className="text-muted-foreground">{address.country}</div>
        {address.phone ? (
          <div className="pt-1 text-muted-foreground">{address.phone}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}
