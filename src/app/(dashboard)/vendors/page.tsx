import { Truck } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export default function VendorsPage() {
  return (
    <ComingSoon
      title="Vendors & Purchase Orders"
      description="Vendor master, POs, and receipts."
      icon={Truck}
    />
  );
}
