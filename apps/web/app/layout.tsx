import type { Metadata } from 'next';
import { Archivo } from 'next/font/google';

import { Background } from '@/components/Background';

import './globals.css';

const archivo = Archivo({
  subsets: ['latin'],
  weight: 'variable',
  axes: ['wdth'],
  variable: '--font-archivo',
  display: 'swap',
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://splitmylease.com';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'CashFlow',
  description:
    'Buy now, pay later for small business rent. An open source reference implementation, released in public.',
  openGraph: {
    title: 'CashFlow',
    description: 'Buy now, pay later for small business rent. Open source.',
    url: siteUrl,
    siteName: 'CashFlow',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'CashFlow',
    description: 'Buy now, pay later for small business rent. Open source.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <body>
        <Background />
        {children}
      </body>
    </html>
  );
}
