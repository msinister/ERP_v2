import { ShoppingCart } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export default function SalesOrdersPage() {
  return (
    <ComingSoon
      title="Sales Orders"
      description="Quote → confirm → dispatch → close lifecycle."
      icon={ShoppingCart}
    />
  );
}
