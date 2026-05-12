import { Settings } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { ComingSoon } from '@/components/coming-soon';

// Server-side super-admin gate. The sidebar already hides this entry
// for non-super users, but UI gating is never the security boundary
// (CLAUDE.md non-negotiable rule). A non-super hitting /admin by URL
// gets bounced back to the dashboard.

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user?.isSuperAdmin) redirect('/dashboard');
  return (
    <ComingSoon
      title="Admin"
      description="Users, roles, permissions, audit log, and settings."
      icon={Settings}
    />
  );
}
