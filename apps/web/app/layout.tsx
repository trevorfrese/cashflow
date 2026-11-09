import type { Metadata } from 'next';
import { Archivo, Inter_Tight } from 'next/font/google';

import './globals.css';
import { Background } from '@/components/Background';

const wordmark = Archivo({
  subsets: ['latin'],
  weight: 'variable',
  axes: ['wdth'],
  variable: '--font-wordmark',
  display: 'swap',
});

const body = Inter_Tight({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
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
    <html lang="en" className={`${wordmark.variable} ${body.variable}`}>
      <body>
        <Background />
        {children}
      </body>
    </html>
  );
}
