import { FileText } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export default function BillsPage() {
  return (
    <ComingSoon
      title="Bills & AP"
      description="Vendor bills, payments, credits, and AP aging."
      icon={FileText}
    />
  );
}
