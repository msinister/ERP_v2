import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getCustomer } from '@/server/services/customers';
import { getActor } from '@/lib/permissions/getActor';
import { customerScopeWhere } from '@/lib/permissions/scope';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { CustomerHeader } from './_components/header';
import { OverviewTab } from './_tabs/overview';
import { ContactsTab } from './_tabs/contacts';
import { AddressesTab } from './_tabs/addresses';
import { PricingTab } from './_tabs/pricing';
import { DocumentsTab } from './_tabs/documents';
import { ActivityTab } from './_tabs/activity';
import { ArTab } from './_tabs/ar';
import { TabSkeleton } from './_tabs/tab-shell';

// Always live (no caching) — customer balances and activity drive
// operational decisions. revalidate=0 forces a re-fetch on every
// request, same as the dashboard.
export const revalidate = 0;

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // AR tab uses URL-driven pagination for its two paginated
  // sections (payHistorySkip, paidInvSkip). Forward through so the
  // server-rendered AR fetches see the current page.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getActor();
  if (!actor) redirect('/login');
  // Out-of-scope customers resolve to null → not-found, so a "view own"
  // user can't open another rep's customer by guessing the URL.
  const customer = await getCustomer(db, id, customerScopeWhere(actor));
  if (!customer) notFound();

  return (
    <div className="space-y-6">
      <CustomerHeader customer={customer} />

      <Tabs defaultValue="overview">
        <TabsList variant="line" className="overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="addresses">Addresses</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="ar">AR</TabsTrigger>
        </TabsList>

        {/* Each panel is its own Suspense boundary so slow tabs (AR,
            documents) stream in after fast ones; the client switcher
            uses already-rendered panels once they arrive. */}
        <TabsContent value="overview">
          <Suspense fallback={<TabSkeleton rows={2} />}>
            <OverviewTab customer={customer} />
          </Suspense>
        </TabsContent>
        <TabsContent value="contacts">
          <Suspense fallback={<TabSkeleton />}>
            <ContactsTab customerId={customer.id} />
          </Suspense>
        </TabsContent>
        <TabsContent value="addresses">
          <Suspense fallback={<TabSkeleton rows={2} />}>
            <AddressesTab customerId={customer.id} />
          </Suspense>
        </TabsContent>
        <TabsContent value="pricing">
          <Suspense fallback={<TabSkeleton />}>
            <PricingTab customerId={customer.id} />
          </Suspense>
        </TabsContent>
        <TabsContent value="documents">
          <Suspense fallback={<TabSkeleton />}>
            <DocumentsTab customerId={customer.id} />
          </Suspense>
        </TabsContent>
        <TabsContent value="activity">
          <Suspense fallback={<TabSkeleton rows={5} />}>
            <ActivityTab customerId={customer.id} />
          </Suspense>
        </TabsContent>
        <TabsContent value="ar">
          <Suspense fallback={<TabSkeleton rows={4} />}>
            <ArTab
              customerId={customer.id}
              customerName={customer.name}
              searchParams={sp}
            />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
