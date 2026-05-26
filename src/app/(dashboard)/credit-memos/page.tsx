import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus } from 'lucide-react';
import { CreditMemoStatus } from '@/generated/tenant';
import { db } from '@/lib/db';
import { listCreditMemosPaged } from '@/server/services/creditMemos';
import { listCustomers } from '@/server/services/customers';
import { listCategories } from '@/server/services/creditMemoCategories';
import { listAllOrderTags } from '@/server/services/orderTags';
import { getActor } from '@/lib/permissions/getActor';
import { creditMemoScopeWhere } from '@/lib/permissions/scope';
import { Button } from '@/components/ui/button';
import {
  CreditMemosFilters,
  type CustomerOption,
  type CategoryOption,
} from './_components/filters';
import {
  CreditMemosTable,
  type CreditMemoRowData,
} from './_components/table';
import { CreditMemosPagination } from './_components/pagination';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isCreditMemoStatus(v: string | undefined): v is CreditMemoStatus {
  if (!v) return false;
  return Object.values(CreditMemoStatus).includes(v as CreditMemoStatus);
}

export default async function CreditMemosPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const q = pickString(sp.q);
  const statusRaw = pickString(sp.status);
  const status = isCreditMemoStatus(statusRaw) ? statusRaw : undefined;
  const customerId = pickString(sp.customerId);
  const categoryId = pickString(sp.categoryId);
  const fromParam = pickString(sp.from);
  const toParam = pickString(sp.to);
  const tagsParam = pickString(sp.tags);
  const tagIds = tagsParam ? tagsParam.split(',').filter(Boolean) : undefined;
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const actor = await getActor();
  if (!actor) redirect('/login');
  const scope = creditMemoScopeWhere(actor);

  const [customers, categories, allOrderTags, page] = await Promise.all([
    listCustomers(db, { active: true, take: 1000 }),
    listCategories(db, { active: true, take: 200 }),
    listAllOrderTags(db),
    listCreditMemosPaged(db, {
      q,
      status,
      customerId,
      categoryId,
      createdAtFrom: fromParam ? new Date(fromParam) : undefined,
      // "to" is a calendar date — extend to end-of-day so a same-day
      // filter doesn't exclude the day's own rows.
      createdAtTo: toParam ? new Date(`${toParam}T23:59:59.999Z`) : undefined,
      tagIds,
      scope,
      skip,
      take,
    }),
  ]);

  const customerOptions: CustomerOption[] = customers.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
  }));
  const categoryOptions: CategoryOption[] = categories.map((c) => ({
    id: c.id,
    code: c.code,
    label: c.label,
  }));
  const tagOptions = allOrderTags.map((t) => ({ id: t.id, name: t.name }));

  const tableRows: CreditMemoRowData[] = page.rows.map((cm) => ({
    id: cm.id,
    number: cm.number,
    customerId: cm.customer.id,
    customerCode: cm.customer.code,
    customerName: cm.customer.name,
    categoryId: cm.category.id,
    categoryCode: cm.category.code,
    categoryLabel: cm.category.label,
    creditDate: cm.issuedAt ?? cm.createdAt,
    amount: cm.amount,
    netCredit: cm.netCredit,
    appliedAmount: cm.appliedAmount,
    status: cm.status,
    tags: cm.tags.map((a) => ({ id: a.tag.id, name: a.tag.name })),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Credit Memos
          </h1>
          <p className="text-sm text-muted-foreground">
            Draft → Confirmed → Voided. Confirmed memos post DR Sales
            Returns / CR AR; auto-apply to the linked invoice when one is
            set.
          </p>
        </div>
        <Button render={<Link href="/credit-memos/new" />}>
          <Plus />
          New credit memo
        </Button>
      </div>

      <CreditMemosFilters
        customers={customerOptions}
        categories={categoryOptions}
        tags={tagOptions}
      />

      <CreditMemosTable rows={tableRows} />

      <CreditMemosPagination total={page.total} skip={skip} take={take} />
    </div>
  );
}
