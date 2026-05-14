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
import { TabSkeleton } from './_tabs/tab-shell';

// Always live (no caching) — vendor balances and contact lists drive
// operational decisions. revalidate=0 forces a re-fetch on every
// request, same as the customer detail page.
export const revalidate = 0;

export default async function VendorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
        </TabsList>

        {/* Each panel is its own Suspense boundary so slow tabs stream
            in after fast ones; mirrors the customer detail layout.
            6C will add Products + Payment Methods; 6D adds POs + AP. */}
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
      </Tabs>
    </div>
  );
}
