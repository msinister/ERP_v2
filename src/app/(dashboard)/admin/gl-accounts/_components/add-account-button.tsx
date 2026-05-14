'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AccountFormDialog } from './account-form-dialog';

export function AddAccountButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus />
        Add account
      </Button>
      <AccountFormDialog
        account={null}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
