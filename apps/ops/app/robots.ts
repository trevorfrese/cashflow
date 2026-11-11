import type { MetadataRoute } from 'next';

/** Nothing here is for a crawler. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/' } };
}
