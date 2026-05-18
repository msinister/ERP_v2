import type { ReactNode } from 'react';
import './globals.css';
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata = {
  title: 'ERP',
  description: 'Custom multi-instance ERP',
};

// Blocking script that reads line-item-table toggle preferences from
// localStorage and writes hide-* classes to <html> before React
// hydrates. Without this, users with a column hidden would see the
// hidden content flash visible during initial paint, then disappear
// after the toggle hook's useEffect runs. Keep the script tiny +
// side-effect-free beyond the class toggle.
const TABLE_TOGGLE_FLICKER_SCRIPT = `
try {
  if (localStorage.getItem('showProductImages') === 'false') {
    document.documentElement.classList.add('hide-product-images');
  }
  if (localStorage.getItem('showStockContext') === 'false') {
    document.documentElement.classList.add('hide-stock-context');
  }
} catch (_) {}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)}>
      <head>
        <script
          // suppressHydrationWarning here is unnecessary — this script
          // mutates <html>, not the children React owns; nothing the
          // server renders inside <body> depends on the class.
          dangerouslySetInnerHTML={{ __html: TABLE_TOGGLE_FLICKER_SCRIPT }}
        />
      </head>
      <body className="bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}