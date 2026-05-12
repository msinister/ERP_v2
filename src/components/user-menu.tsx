'use client';

import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function UserMenu({
  user,
}: {
  user: { name: string; email: string };
}) {
  const [pending, setPending] = useState(false);

  async function onLogout() {
    setPending(true);
    try {
      await fetch('/api/auth/sign-out', { method: 'POST' });
    } finally {
      // Hard navigation so server components re-evaluate without
      // the now-cleared session cookie. router.push would keep RSC
      // caches that still think the user is signed in.
      window.location.href = '/login';
    }
  }

  const display = user.name?.trim() ? user.name : user.email;

  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right sm:block">
        <div className="text-sm font-medium leading-tight text-foreground">
          {display}
        </div>
        {user.name?.trim() ? (
          <div className="text-xs leading-tight text-muted-foreground">
            {user.email}
          </div>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onLogout}
        disabled={pending}
        aria-label="Sign out"
      >
        <LogOut />
      </Button>
    </div>
  );
}
