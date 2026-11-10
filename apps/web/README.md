# @cashflow/web

The CashFlow marketing site at splitmylease.com. One page in the neo-brutalist design system (shared brand tokens, Archivo set wide, 3px ink borders, hard shadows) that explains the rent split and points to the open source project.

## Develop

```sh
pnpm --filter @cashflow/web dev     # http://localhost:3000
pnpm --filter @cashflow/web build   # static export to ./out
```

## Deploy on Vercel

1. Import the `trevorfrese/cashflow` repo in Vercel.
2. Set **Root Directory** to `apps/web`. Vercel detects Next.js and pnpm workspaces from the repo root lockfile.
3. Leave build settings as detected (`next build`). The site is a static export, so no serverless functions are created.
4. Add `splitmylease.com` and `www.splitmylease.com` under Domains and follow the DNS instructions Vercel shows.

No environment variables are required. `NEXT_PUBLIC_SITE_URL` is optional and defaults to `https://splitmylease.com`.
