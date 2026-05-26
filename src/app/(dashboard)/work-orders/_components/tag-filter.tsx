'use client';

import { useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Tag as TagIcon, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Multi-select tag picker for the work-orders list filter bar. Mirrors the
// SO/PO/Bill/CM/RMA/VC list-page tag filter — kept inline here because
// the WO list doesn't have a separate _components/filters.tsx yet.

export function WorkOrderTagFilter({
  tags,
}: {
  tags: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const selectedTagIds = (params.get('tags') ?? '')
    .split(',')
    .filter(Boolean);

  function toggleTag(tagId: string, checked: boolean) {
    const next = new Set(selectedTagIds);
    if (checked) next.add(tagId);
    else next.delete(tagId);
    const value = Array.from(next).join(',');
    const params2 = new URLSearchParams(params.toString());
    if (value) params2.set('tags', value);
    else params2.delete('tags');
    startTransition(() => {
      router.push(`/work-orders?${params2.toString()}`);
    });
  }

  if (tags.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <Label>Tags</Label>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" className="w-48 justify-between">
              <span className="flex items-center gap-1.5 truncate">
                <TagIcon className="size-3.5" />
                {selectedTagIds.length > 0
                  ? `${selectedTagIds.length} selected`
                  : 'Any tags'}
              </span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="max-h-72 overflow-auto">
          {tags.map((t) => (
            <DropdownMenuCheckboxItem
              key={t.id}
              checked={selectedTagIds.includes(t.id)}
              onCheckedChange={(checked) => toggleTag(t.id, checked === true)}
              closeOnClick={false}
            >
              {t.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
