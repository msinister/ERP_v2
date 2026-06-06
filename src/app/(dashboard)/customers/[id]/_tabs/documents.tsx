import { db } from '@/lib/db';
import { listDocumentsForCustomer } from '@/server/services/customerDocuments';
import { DocumentsClient } from '../_components/documents-client';

export async function DocumentsTab({ customerId }: { customerId: string }) {
  const docs = await listDocumentsForCustomer(db, customerId);

  return (
    <DocumentsClient
      customerId={customerId}
      documents={docs.map((d) => ({
        id: d.id,
        kind: d.kind as
          | 'RESALE_PERMIT'
          | 'BUSINESS_LICENSE'
          | 'RESALE_CERT'
          | 'OTHER'
          | 'EIN'
          | 'SSN'
          | 'DRIVERS_LICENSE',
        fileName: d.fileName,
        storageKey: d.storageKey,
        expiresOn: d.expiresOn,
        notes: d.notes,
      }))}
    />
  );
}
