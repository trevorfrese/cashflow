import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pure static site. Works on Vercel and on any static host.
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@cashflow/shared'],
  reactStrictMode: true,
};

export default nextConfig;
