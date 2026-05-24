import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getVendor } from '@/server/services/vendors';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { VendorHeader } from './_components/header';
import { OverviewTab } from './_tabs/overview';
import { ContactsTab } from './_tabs/contacts';
import { AddressesTab } from './_tabs/addresses';
import { ProductsTab } from './_tabs/products';
import { PaymentMethodsTab } from './_tabs/payment-methods';
import { PosTab } from './_tabs/pos';
import { ApTab } from './_tabs/ap';
import { VendorLedgerTab } from './_tabs/ledger';
import { TabSkeleton } from './_tabs/tab-shell';

// Always live (no caching) — vendor balances and contact lists drive
// operational decisions. revalidate=0 forces a re-fetch on every
// request, same as the customer detail page.
export const revalidate = 0;

export default async function VendorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // Ledger tab uses namespaced URL params (ledgerFrom/ledgerTo/ledgerType/
  // ledgerSort/ledgerSkip). Forward them so its server fetch sees the
  // current filter/page.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const vendor = await getVendor(db, id);
  if (!vendor) notFound();

  return (
    <div className="space-y-6">
      <VendorHeader vendor={vendor} />

      <Tabs defaultValue="overview">
        <TabsList variant="line" className="overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="addresses">Addresses</TabsTrigger>
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="payment-methods">Payment methods</TabsTrigger>
          <TabsTrigger value="pos">POs</TabsTrigger>
          <TabsTrigger value="ap">AP</TabsTrigger>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
        </TabsList>

        {/* Each panel is its own Suspense boundary so slow tabs stream
            in after fast ones; mirrors the customer detail layout. */}
        <TabsContent value="overview">
          <Suspense fallback={<TabSkeleton rows={2} />}>
            <OverviewTab vendor={vendor} />
          </Suspense>
        </TabsContent>
        <TabsContent value="contacts">
          <Suspense fallback={<TabSkeleton />}>
            <ContactsTab vendorId={vendor.id} />
          </Suspense>
        </TabsContent>
        <TabsContent value="addresses">
          <Suspense fallback={<TabSkeleton rows={2} />}>
            <AddressesTab vendorId={vendor.id} />
          </Suspense>
        </TabsContent>
        <TabsContent value="products">
          <Suspense fallback={<TabSkeleton rows={4} />}>
            <ProductsTab vendor={vendor} />
          </Suspense>
        </TabsContent>
        <TabsContent value="payment-methods">
          <Suspense fallback={<TabSkeleton rows={3} />}>
            <PaymentMethodsTab vendorId={vendor.id} />
          </Suspense>
        </TabsContent>
        <TabsContent value="pos">
          <Suspense fallback={<TabSkeleton rows={5} />}>
            <PosTab vendorId={vendor.id} />
          </Suspense>
        </TabsContent>
        <TabsContent value="ap">
          <Suspense fallback={<TabSkeleton rows={4} />}>
            <ApTab vendorId={vendor.id} />
          </Suspense>
        </TabsContent>
        <TabsContent value="ledger">
          <Suspense fallback={<TabSkeleton rows={5} />}>
            <VendorLedgerTab
              vendorId={vendor.id}
              vendorName={vendor.name}
              searchParams={sp}
            />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
