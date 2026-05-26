import { Badge } from '@/components/ui/badge';

// Compact inline tag display for list-page rows. Shows the first N tags as
// small badges with a "+M more" hint (full list in the title tooltip) for
// any overflow. Used by every operational-entity list with an OrderTag
// column (SO / PO / Bill / CM / RMA / WO / VC).
//
// Place inside a `relative z-10` table cell when the row uses a stretched-
// link overlay — the pill itself isn't clickable, but the z-index keeps
// hover styles correct over the link.

const MAX_VISIBLE = 3;

export function TagPills({
  tags,
}: {
  tags: Array<{ id: string; name: string }>;
}) {
  if (tags.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const visible = tags.slice(0, MAX_VISIBLE);
  const overflow = tags.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((t) => (
        <Badge key={t.id} variant="secondary" className="text-[10px] font-normal">
          {t.name}
        </Badge>
      ))}
      {overflow > 0 ? (
        <span
          className="text-[10px] text-muted-foreground"
          title={tags.map((t) => t.name).join(', ')}
        >
          +{overflow} more
        </span>
      ) : null}
    </div>
  );
}
