# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## Project overview

`cashflow` is a tool for tracking income, expenses, and projected balances. The project is in its earliest stage, so expect the structure below to evolve. When this file and the code disagree, trust the code and update this file.

## Repository layout

Nothing has been scaffolded yet. When adding the first code, prefer a conventional layout for the chosen stack and document it here.

## Working conventions

- Keep changes small and focused. One concern per commit or pull request.
- Write commit messages in the imperative mood with a short summary line, e.g. `Add recurring transaction model`.
- Do not commit secrets, credentials, or personal financial data. Use environment variables or ignored local config files.
- Add or update tests alongside behavior changes once a test framework exists.
- Update `README.md` when setup, usage, or goals change.

## Before opening a pull request

1. Make sure the project builds and tests pass locally.
2. Run any configured formatter and linter.
3. Describe what changed and why in the PR description.

## Things to avoid

- Introducing new dependencies without a clear need.
- Large refactors mixed with feature work.
- Rewriting history on `main`.

## License

Contributions are accepted under the MIT License in `LICENSE`.
