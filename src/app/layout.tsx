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
    // suppressHydrationWarning: the blocking script below adds hide-*
    // classes to <html> BEFORE React hydrates, so <html>'s className
    // legitimately differs between the server HTML and the hydrating client.
    // React owns this element's className, so without this it warns on every
    // load where a toggle is off. Scoped to <html>'s own attributes —
    // children still hydrate and report mismatches normally.
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("font-sans", geist.variable)}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: TABLE_TOGGLE_FLICKER_SCRIPT }}
        />
      </head>
      <body className="bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}