'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutList } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';

const TABLE_PREF_KEYS = [
  'table.products',
  'table.salesOrders',
  'table.purchaseOrders',
  'table.bills',
  'table.creditMemos',
  'table.rmas',
  'table.vendorCredits',
  'table.payments',
  'table.workOrders',
  'table.customers',
  'table.vendors',
];

export function TablePreferencesCard({ prefCount }: { prefCount: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [localCount, setLocalCount] = useState(prefCount);

  async function resetAll() {
    setPending(true);
    try {
      // Reset each registered table-view preference to empty (defaults).
      await Promise.all(
        TABLE_PREF_KEYS.map((key) =>
          fetch('/api/me/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value: {} }),
          }),
        ),
      );
      setLocalCount(0);
      toast.success('Table views reset to defaults');
      router.refresh();
    } catch {
      toast.error('Failed to reset table views');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Table Preferences</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3">
          <LayoutList className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            {localCount === 0
              ? 'All table views are using default settings.'
              : `You have ${localCount} customized table view${localCount !== 1 ? 's' : ''}.`}
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={resetAll}
            disabled={pending || localCount === 0}
          >
            {pending ? 'Resetting…' : 'Reset all to defaults'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
