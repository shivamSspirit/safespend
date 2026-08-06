# Repository Guidelines

## Project Structure & Module Organization

SafeSpend is a Rust workspace for fail-closed Solana treasury payments. The policy core is in `crates/safespend-core`; signed WebAssembly plugins live in `plugins/treasury-watch` and `plugins/allowance-pay`; operational CLIs are in `tools/`. Shared WIT contracts are under `wit/`. Release artifacts and signing metadata are in `release/` and `dist/`; do not hand-edit generated artifacts.

The local founder dashboard is a separate Next.js app in `dashboard/`: routes are in `dashboard/app/`, UI components in `dashboard/components/`, and server-only integrations in `dashboard/lib/server/`. Read `dashboard/AGENTS.md` before changing it. Documentation, sanitised proof, and setup material belong in `docs/` and `evidence/`.

## Build, Test, and Development Commands

From the repository root, run:

```bash
cargo fmt --all -- --check                         # verify Rust formatting
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked                    # workspace tests
./scripts/verify-release.sh                        # verify signed plugin release
```

For dashboard work, run `npm ci`, then `npm run dev` from `dashboard/` for the loopback-only development server. Use `npm run typecheck` and `npm run format:check` before submitting dashboard changes. `./scripts/run-zeroclaw-dev.sh` is for an already provisioned Devnet operator environment; never treat it as a test fixture or commit its private state.

## Coding Style & Naming Conventions

Use Rust 2021 and let `rustfmt` determine four-space formatting. Keep policy logic explicit, deterministic, and fail closed; validate untrusted or chain data before acting on it. Use `snake_case` for Rust modules/functions and `UpperCamelCase` for types. In the dashboard, use TypeScript, `PascalCase` React components (for example, `FounderDashboard`), and Prettier formatting.

## Testing Guidelines

Put Rust integration tests in `crates/safespend-core/tests/` and unit tests next to the behavior they cover. Name tests after the expected outcome, such as `rejects_payment_below_runway_floor`. Add denial-path tests for policy, recipient, mint, amount, and approval changes. Run the targeted package test while iterating, then the locked workspace suite and release verification.

## Commit & Pull Request Guidelines

Recent history uses short imperative Conventional Commit-style subjects, e.g. `feat: ship SafeSpend Devnet founder payment flow` and `Harden Telegram demo enrollment`. Keep commits focused and explain security-sensitive changes in the body. PRs should state the policy impact, commands run, linked issue (if any), and dashboard screenshots for UI changes. Never commit keys, tokens, RPC URLs, Telegram credentials, or `.zeroclaw-dev/` data.
