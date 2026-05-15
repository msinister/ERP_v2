import type { ReactNode } from 'react';
import './globals.css';
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata = {
  title: 'ERP',
  description: 'Custom multi-instance ERP',
};

// Blocking script that reads the product-image toggle preference from
// localStorage and writes the `hide-product-images` class to <html>
// before React hydrates. Without this, users with the column hidden
// would see thumbnails flash visible during initial paint, then
// disappear after the toggle hook's useEffect runs. Keep the script
// tiny + side-effect-free beyond the class toggle.
const PRODUCT_IMAGE_FLICKER_SCRIPT = `
try {
  if (localStorage.getItem('showProductImages') === 'false') {
    document.documentElement.classList.add('hide-product-images');
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
          dangerouslySetInnerHTML={{ __html: PRODUCT_IMAGE_FLICKER_SCRIPT }}
        />
      </head>
      <body className="bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}