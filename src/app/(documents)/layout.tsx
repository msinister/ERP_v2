import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import './print.css';

// Auth-gated layout for printable documents. No AppShell — these
// pages render the document on a clean white background so a browser
// Print → Save as PDF produces a usable file without the app chrome
// bleeding in.
//
// Middleware short-circuits unauthenticated requests at the edge via
// cookie presence. This layout is the real session check (signature,
// expiry, user.enabled). The customer portal slice — when it lands —
// will reuse most of the per-doc page rendering but ship its own
// auth-by-portal-token layer.
export default async function DocumentsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return (
    <div className="min-h-screen bg-muted/30 text-foreground document-root">
      {children}
    </div>
  );
}
