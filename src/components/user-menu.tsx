'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, User } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

function getInitials(name: string, email: string): string {
  const trimmed = name?.trim();
  if (!trimmed) return (email?.[0] ?? '?').toUpperCase();
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

export function UserMenu({
  user,
}: {
  user: { name: string; email: string; image: string | null };
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onLogout() {
    setPending(true);
    try {
      await fetch('/api/auth/sign-out', { method: 'POST' });
    } finally {
      window.location.href = '/login';
    }
  }

  const display = user.name?.trim() ? user.name : user.email;
  const initials = getInitials(user.name ?? '', user.email);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="flex h-auto items-center gap-2.5 px-2 py-1.5"
            aria-label="User menu"
          />
        }
      >
        <UserAvatar name={display} image={user.image} initials={initials} size="sm" />
        <span className="hidden max-w-32 truncate text-sm font-medium sm:block">
          {display}
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" side="bottom" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">{display}</span>
              {user.name?.trim() ? (
                <span className="truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              ) : null}
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => router.push('/account')}>
            <User className="size-4" />
            My Account
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={onLogout}
            disabled={pending}
            className="text-destructive focus:text-destructive"
          >
            <LogOut className="size-4 text-destructive" />
            {pending ? 'Signing out…' : 'Log out'}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Exported so AppShell can reuse it for the sidebar bottom slot.
export function UserAvatar({
  name,
  image,
  initials,
  size = 'md',
}: {
  name: string;
  image: string | null;
  initials: string;
  size?: 'sm' | 'md';
}) {
  const dim = size === 'sm' ? 'size-7' : 'size-8';
  return (
    <div
      className={`${dim} shrink-0 overflow-hidden rounded-full bg-primary`}
      aria-hidden
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt={name}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[11px] font-semibold text-primary-foreground">
          {initials}
        </span>
      )}
    </div>
  );
}
