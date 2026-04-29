import type { ReactNode } from 'react';

export const metadata = {
  title: 'ERP',
  description: 'Custom multi-instance ERP',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}