import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { SalesRepForm } from '../_components/sales-rep-form';

export const revalidate = 0;

export default async function NewSalesRepPage() {
  await requirePagePermission('admin.edit_users');

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
            New sales rep
          </h1>
          <p className="text-sm text-muted-foreground">
            Creates a standalone rep record. To give them a login, link an
            existing user from the user’s edit page.
          </p>
        </div>
      </div>

      <SalesRepForm mode={{ kind: 'create' }} />
    </div>
  );
}
