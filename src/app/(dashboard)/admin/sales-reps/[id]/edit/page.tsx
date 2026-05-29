import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { getSalesRep, listLinkableUsers } from '@/server/services/salesReps';
import { SalesRepForm } from '../../_components/sales-rep-form';

export const revalidate = 0;

export default async function EditSalesRepPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePagePermission('admin.edit_users');

  const { id } = await params;
  const rep = await getSalesRep(db, id);
  if (!rep) notFound();

  const [users, linkedUser] = await Promise.all([
    listLinkableUsers(db, { includeRepId: rep.id }),
    db.user.findFirst({
      where: { salesRepId: rep.id },
      select: { id: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/admin/sales-reps"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Sales reps
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Edit sales rep
          </h1>
          <p className="text-sm text-muted-foreground">
            {rep.name} · <span className="font-mono">{rep.code}</span>
          </p>
        </div>
      </div>

      <SalesRepForm
        mode={{ kind: 'edit', repId: rep.id }}
        users={users}
        defaults={{
          code: rep.code,
          name: rep.name,
          email: rep.email ?? '',
          active: rep.active,
          commissionEnabled: rep.commissionEnabled,
          commissionBasis: rep.commissionBasis ?? 'REVENUE',
          commissionPercent: rep.commissionPercent?.toString() ?? '',
          linkUserId: linkedUser?.id ?? '',
        }}
      />
    </div>
  );
}
