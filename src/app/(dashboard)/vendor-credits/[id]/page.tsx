import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { VendorCreditHeader } from './_components/header';
import {
  VendorCreditLinesTable,
  type VcLineRow,
} from './_components/lines-table';
import { VendorCreditTotalsCard } from './_components/totals-card';
import { VendorCreditInfoCard } from './_components/info-card';
import {
  ApplicationsCard,
  type VcApplicationRow,
} from './_components/applications-card';

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
      applications: {
        include: { bill: { select: { id: true, number: true } } },
        orderBy: { appliedAt: 'desc' },
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

  const applicationRows: VcApplicationRow[] = vc.applications.map((a) => ({
    id: a.id,
    billId: a.billId,
    billNumber: a.bill.number,
    amount: a.amount,
    appliedAt: a.appliedAt,
    reversedAt: a.reversedAt,
    notes: a.notes,
  }));

  // VC remaining = amount − appliedAmount. Only meaningful on CONFIRMED;
  // DRAFT has no GL effect yet, CANCELLED has fully unwound.
  const available = vc.amount.minus(vc.appliedAmount).toString();

  // Show the applications card on CONFIRMED + CANCELLED (when history
  // exists). DRAFT without any apps gets nothing.
  const showApplicationsCard =
    vc.status !== 'DRAFT' || applicationRows.length > 0;

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

          {showApplicationsCard ? (
            <ApplicationsCard
              vendorCreditId={vc.id}
              vendorCreditNumber={vc.number}
              vendorCreditStatus={vc.status}
              vendorId={vc.vendorId}
              available={available}
              applications={applicationRows}
            />
          ) : null}

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
