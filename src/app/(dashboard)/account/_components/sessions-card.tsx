'use client';

import { useState } from 'react';
import { Monitor, Smartphone, Globe, LogOut, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/lib/toast';

type Session = {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
};

type LoginEntry = {
  id: string;
  createdAt: string;
  ipAddress: string | null;
};

function parseDevice(ua: string | null): { label: string; Icon: typeof Monitor } {
  if (!ua) return { label: 'Unknown device', Icon: Globe };
  const lower = ua.toLowerCase();
  if (lower.includes('iphone') || lower.includes('android') || lower.includes('mobile')) {
    return { label: 'Mobile browser', Icon: Smartphone };
  }
  if (lower.includes('chrome')) return { label: 'Chrome', Icon: Monitor };
  if (lower.includes('firefox')) return { label: 'Firefox', Icon: Monitor };
  if (lower.includes('safari')) return { label: 'Safari', Icon: Monitor };
  if (lower.includes('edge')) return { label: 'Edge', Icon: Monitor };
  return { label: 'Browser', Icon: Monitor };
}

export function SessionsCard({
  sessions: initialSessions,
  loginHistory,
}: {
  sessions: Session[];
  loginHistory: LoginEntry[];
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const [revokeAllPending, setRevokeAllPending] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function revokeAll() {
    setRevokeAllPending(true);
    try {
      const res = await fetch('/api/me/sessions', { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Failed to sign out other devices');
        return;
      }
      setSessions((prev) => prev.filter((s) => s.isCurrent));
      toast.success('Signed out of all other devices');
    } finally {
      setRevokeAllPending(false);
    }
  }

  async function revokeSession(id: string) {
    setRevokingId(id);
    try {
      const res = await fetch(`/api/me/sessions/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Failed to revoke session');
        return;
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
      toast.success('Session revoked');
    } finally {
      setRevokingId(null);
    }
  }

  const otherSessions = sessions.filter((s) => !s.isCurrent);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>Security &amp; Sessions</CardTitle>
          {otherSessions.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={revokeAll}
              disabled={revokeAllPending}
            >
              <LogOut className="size-3.5" />
              {revokeAllPending ? 'Signing out…' : 'Log out all other devices'}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Active sessions */}
        <div>
          <p className="mb-2 text-sm font-medium">Active sessions</p>
          <div className="space-y-2">
            {sessions.length === 0 && (
              <p className="text-sm text-muted-foreground">No active sessions found.</p>
            )}
            {sessions.map((s) => {
              const { label, Icon } = parseDevice(s.userAgent);
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-3 rounded-md border px-3 py-2.5 text-sm"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{label}</span>
                      {s.isCurrent && (
                        <Badge variant="secondary" className="text-[10px] py-0">
                          This device
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {s.ipAddress ?? 'Unknown IP'} · Started{' '}
                      {new Date(s.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  {!s.isCurrent && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => revokeSession(s.id)}
                      disabled={revokingId === s.id}
                      aria-label="Revoke session"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {loginHistory.length > 0 && (
          <>
            <Separator />
            <div>
              <p className="mb-2 text-sm font-medium">Recent logins</p>
              <div className="space-y-1">
                {loginHistory.map((e) => (
                  <div
                    key={e.id}
                    className="flex items-center justify-between gap-3 py-1 text-xs text-muted-foreground"
                  >
                    <span>{new Date(e.createdAt).toLocaleString()}</span>
                    <span>{e.ipAddress ?? 'Unknown IP'}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
