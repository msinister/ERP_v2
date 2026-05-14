import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { VendorCreditHeader } from './_components/header';
import {
  VendorCreditLinesTable,
  type VcLineRow,
} from './_components/lines-table';
import { VendorCreditTotalsCard } from './_components/totals-card';
import { VendorCreditInfoCard } from './_components/info-card';

// Always live — appliedAmount + status flip as applications happen.
export const revalidate = 0;

export default async function VendorCreditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const vc = await db.vendorCredit.findFirst({
    where: { id, deletedAt: null },
    include: {
      vendor: { select: { id: true, code: true, name: true } },
      lines: {
        where: { deletedAt: null },
        orderBy: { lineNumber: 'asc' },
      },
    },
  });
  if (!vc) notFound();

  const isOverpayment =
    !!vc.sourceTag && vc.sourceTag.startsWith('OVERPAYMENT:');
  const hasApplications = vc.appliedAmount.greaterThan(0);

  const lineRows: VcLineRow[] = vc.lines.map((l) => ({
    id: l.id,
    description: l.description,
    amount: l.amount,
    notes: l.notes,
  }));

  return (
    <div className="space-y-6">
      <VendorCreditHeader
        vc={{
          id: vc.id,
          number: vc.number,
          status: vc.status,
          vendor: vc.vendor,
          creditDate: vc.creditDate,
          confirmedAt: vc.confirmedAt,
          cancelledAt: vc.cancelledAt,
          isOverpayment,
          hasApplications,
        }}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <VendorCreditLinesTable lines={lineRows} />

          <VendorCreditInfoCard
            vc={{
              reason: vc.reason,
              notes: vc.notes,
              cancelReason: vc.cancelReason,
              sourceTag: vc.sourceTag,
            }}
          />
        </div>

        <div className="space-y-6">
          <VendorCreditTotalsCard
            status={vc.status}
            amount={vc.amount}
            appliedAmount={vc.appliedAmount}
            currency={vc.currency ?? 'USD'}
          />
        </div>
      </div>
    </div>
  );
}
