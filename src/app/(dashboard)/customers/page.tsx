import { Users } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export default function CustomersPage() {
  return (
    <ComingSoon
      title="Customers"
      description="Customer master, contacts, addresses, and pricing."
      icon={Users}
    />
  );
}
