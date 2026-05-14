import { db } from '@/lib/db';
import type { VendorAddress } from '@/generated/tenant';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listVendorAddresses } from '@/server/services/vendorAddresses';
import { TabShell, TabEmpty } from './tab-shell';
import { AddAddressButton } from '../_components/add-address-button';
import { AddressRowActions } from '../_components/address-row-actions';

export async function AddressesTab({ vendorId }: { vendorId: string }) {
  const addresses = await listVendorAddresses(db, vendorId);

  if (addresses.length === 0) {
    return (
      <TabShell>
        <TabEmpty
          message="No addresses on file."
          action={<AddAddressButton vendorId={vendorId} />}
        />
      </TabShell>
    );
  }

  const remit = addresses.filter((a) => a.kind === 'REMIT_TO');
  const shipping = addresses.filter((a) => a.kind === 'SHIPPING');
  const billing = addresses.filter((a) => a.kind === 'BILLING');

  return (
    <TabShell>
      <div className="flex justify-end">
        <AddAddressButton vendorId={vendorId} />
      </div>
      {remit.length > 0 ? (
        <AddressGroup
          title="Remit-to"
          vendorId={vendorId}
          addresses={remit}
        />
      ) : null}
      {shipping.length > 0 ? (
        <AddressGroup
          title="Shipping"
          vendorId={vendorId}
          addresses={shipping}
        />
      ) : null}
      {billing.length > 0 ? (
        <AddressGroup
          title="Billing"
          vendorId={vendorId}
          addresses={billing}
        />
      ) : null}
    </TabShell>
  );
}

function AddressGroup({
  title,
  vendorId,
  addresses,
}: {
  title: string;
  vendorId: string;
  addresses: VendorAddress[];
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {addresses.map((a) => (
          <AddressCard key={a.id} address={a} vendorId={vendorId} />
        ))}
      </div>
    </section>
  );
}

function AddressCard({
  address,
  vendorId,
}: {
  address: VendorAddress;
  vendorId: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <div className="flex items-center gap-2">
            <span>{address.label ?? 'Address'}</span>
            {address.isDefault ? (
              <Badge variant="secondary">Default</Badge>
            ) : null}
          </div>
          <AddressRowActions
            vendorId={vendorId}
            address={{
              id: address.id,
              kind: address.kind,
              label: address.label,
              line1: address.line1,
              line2: address.line2,
              city: address.city,
              region: address.region,
              postalCode: address.postalCode,
              country: address.country,
              attention: address.attention,
              phone: address.phone,
              isDefault: address.isDefault,
            }}
          />
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
