'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TermFormDialog } from './term-form-dialog';

export function AddTermButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus />
        Add term
      </Button>
      <TermFormDialog term={null} open={open} onOpenChange={setOpen} />
    </>
  );
}
