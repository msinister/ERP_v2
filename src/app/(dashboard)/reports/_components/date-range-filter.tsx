import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

// Plain GET-form filter. The page consumes `?from=&to=` via
// searchParams; no client JS needed. The end date is interpreted as
// inclusive — the page adds one day before calling the service, which
// uses an exclusive `lt: to` upper bound.

export function DateRangeFilter({
  from,
  to,
  action,
}: {
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

export function AsOfFilter({
  asOf,
  action,
}: {
  asOf: string;
  action: string;
}) {
  return (
    <form
      method="GET"
      action={action}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/20 p-3"
    >
      <Field className="w-40">
        <FieldLabel htmlFor="asOf">As of</FieldLabel>
        <Input id="asOf" name="asOf" type="date" defaultValue={asOf} />
      </Field>
      <Button type="submit" size="sm">
        Run
      </Button>
    </form>
  );
}
