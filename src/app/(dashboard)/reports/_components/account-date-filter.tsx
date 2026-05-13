import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

// GL Detail filter — account picker + date range. Native <select> so
// the page can stay a server component (no client-side state).

export function AccountDateFilter({
  accountCode,
  accounts,
  from,
  to,
  action,
}: {
  accountCode: string;
  accounts: Array<{ code: string; name: string }>;
  from: string;
  to: string;
  action: string;
}) {
  return (
    <form
      method="GET"
      action={action}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/20 p-3"
    >
      <Field className="w-80">
        <FieldLabel htmlFor="accountCode">Account</FieldLabel>
        <select
          id="accountCode"
          name="accountCode"
          defaultValue={accountCode}
          className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs"
        >
          <option value="">— pick an account —</option>
          {accounts.map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} · {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field className="w-40">
        <FieldLabel htmlFor="from">From</FieldLabel>
        <Input id="from" name="from" type="date" defaultValue={from} />
      </Field>
      <Field className="w-40">
        <FieldLabel htmlFor="to">Through</FieldLabel>
        <Input id="to" name="to" type="date" defaultValue={to} />
      </Field>
      <Button type="submit" size="sm">
        Run
      </Button>
    </form>
  );
}

export function WarehouseFilter({
  warehouseId,
  warehouses,
  action,
}: {
  warehouseId: string;
  warehouses: Array<{ id: string; code: string; name: string }>;
  action: string;
}) {
  return (
    <form
      method="GET"
      action={action}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/20 p-3"
    >
      <Field className="w-80">
        <FieldLabel htmlFor="warehouseId">Warehouse</FieldLabel>
        <select
          id="warehouseId"
          name="warehouseId"
          defaultValue={warehouseId}
          className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs"
        >
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} · {w.name}
            </option>
          ))}
        </select>
      </Field>
      <Button type="submit" size="sm">
        Run
      </Button>
    </form>
  );
}
