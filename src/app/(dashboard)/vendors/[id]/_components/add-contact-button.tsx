'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContactFormDialog } from './contact-form-dialog';

export function AddContactButton({ vendorId }: { vendorId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus />
        Add contact
      </Button>
      <ContactFormDialog
        vendorId={vendorId}
        contact={null}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
