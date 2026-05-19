import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function RmaInfoCard({
  rma,
}: {
  rma: {
    reason: string | null;
    rejectedReason: string | null;
    returnless: boolean;
    restockingFeePercent: string | null;
    restockingFeeFlat: string | null;
    effective: {
      percent: { toString(): string } | null;
      flat: { toString(): string } | null;
      source: 'rma_override' | 'default' | 'none';
    };
  };
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">RMA info</CardTitle>
      </CardHeader>
      <CardContent>
        <Block
          label="Type"
          body={
            rma.returnless
              ? 'Returnless — customer keeps the goods'
              : 'Standard — goods returning'
          }
        />
        {rma.reason ? <Block label="Reason" body={rma.reason} /> : null}
        <Block
          label="Restocking fee policy"
          body={renderFeePolicy(rma)}
          muted={rma.effective.source === 'none'}
        />
        {rma.rejectedReason ? (
          <Block label="Rejected reason" body={rma.rejectedReason} muted />
        ) : null}
      </CardContent>
    </Card>
  );
}

function renderFeePolicy(rma: {
  restockingFeePercent: string | null;
  restockingFeeFlat: string | null;
  effective: {
    percent: { toString(): string } | null;
    flat: { toString(): string } | null;
    source: 'rma_override' | 'default' | 'none';
  };
}): string {
  if (rma.effective.source === 'none') {
    return 'No restocking fee';
  }
  const tag =
    rma.effective.source === 'rma_override' ? 'RMA override' : 'Admin default';
  if (rma.effective.flat != null) {
    return `${tag}: $${rma.effective.flat.toString()} flat`;
  }
  if (rma.effective.percent != null) {
    return `${tag}: ${rma.effective.percent.toString()}% of gross`;
  }
  return tag;
}

function Block({
  label,
  body,
  muted,
}: {
  label: string;
  body: string;
  muted?: boolean;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <p
        className={
          muted
            ? 'whitespace-pre-line text-sm text-muted-foreground'
            : 'whitespace-pre-line text-sm'
        }
      >
        {body}
      </p>
    </div>
  );
}
