# AGENTS.md

Guidance for AI coding agents working in this repository lives in [CLAUDE.md](CLAUDE.md). Read that file first. It covers the repo layout, commands, conventions, and the rules around money and providers.

The short version:

- This is a mock-money reference implementation. Never add code that can move real funds by default.
- Every money or risk integration goes behind a provider interface with a mock implementation.
- All money movements post balanced double-entry ledger transactions.
- No em dashes anywhere in copy, docs, or comments. `pnpm check:copy` enforces it.
- Ask before adding a paid service or making a decision that is hard to reverse.
