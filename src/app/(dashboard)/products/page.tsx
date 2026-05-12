import { Package } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export default function ProductsPage() {
  return (
    <ComingSoon
      title="Products"
      description="Catalog, variants, inventory, and FIFO/WAC costing."
      icon={Package}
    />
  );
}
