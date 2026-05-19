import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function CreditMemoInfoCard({
  cm,
}: {
  cm: {
    reason: string | null;
    voidReason: string | null;
    category: {
      code: string;
      label: string;
      affectsInventory: boolean;
    };
    currency: string;
  };
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Credit info</CardTitle>
      </CardHeader>
      <CardContent>
        <Block
          label="Category"
          body={`${cm.category.label} (${cm.category.code})${
            cm.category.affectsInventory
              ? ' — flagged affectsInventory, but standalone CMs do not restore stock (RMA only)'
              : ''
          }`}
        />
        {cm.reason ? <Block label="Reason" body={cm.reason} /> : null}
        {cm.voidReason ? (
          <Block label="Void reason" body={cm.voidReason} muted />
        ) : null}
      </CardContent>
    </Card>
  );
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
