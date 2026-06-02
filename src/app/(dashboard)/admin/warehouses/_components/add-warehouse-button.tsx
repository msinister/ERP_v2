'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  WarehouseFormDialog,
  type GlAccountOption,
} from './warehouse-form-dialog';

export function AddWarehouseButton({
  glAccounts,
}: {
  glAccounts: GlAccountOption[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Add warehouse
      </Button>
      <WarehouseFormDialog
        warehouse={null}
        open={open}
        onOpenChange={setOpen}
        glAccounts={glAccounts}
      />
    </>
  );
}
