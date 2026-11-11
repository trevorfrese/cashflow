import type { Metadata } from 'next';
import { Archivo } from 'next/font/google';

import { themeCss } from '@/lib/theme';

import './globals.css';

// The same variable Archivo the marketing site loads, with the width axis for display type.
const archivo = Archivo({
  subsets: ['latin'],
  weight: 'variable',
  axes: ['wdth'],
  variable: '--font-archivo',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'CashFlow Ops', template: '%s | CashFlow Ops' },
  description: 'CashFlow operations console for staff. Local only. Sandbox data, no real money.',
  // A staff tool. Never indexed, on any host it might end up on.
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <head>
        {/* Brand tokens from @cashflow/shared as CSS custom properties. Static text. */}
        <style dangerouslySetInnerHTML={{ __html: themeCss() }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
