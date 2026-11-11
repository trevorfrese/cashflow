import type { NextConfig } from 'next';

/**
 * The operations console runs as a Node server on a staff machine: it needs route handlers
 * for the session cookie and the API proxy, so unlike the marketing site it is not a static
 * export. It is not deployed anywhere.
 */
const nextConfig: NextConfig = {
  transpilePackages: ['@cashflow/shared'],
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Staff tool: never indexed, never framed, never leaks a URL to another site.
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
