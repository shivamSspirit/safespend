# SafeSpend — Runway-Locked Treasury Autopilot

> A self-hosted founder agent that pays an approved business expense only when
> both the onchain allowance and the company's protected runway floor permit
> it.

## The job

Solo founders regularly pay infrastructure providers and contractors from a
small stablecoin treasury. An allowance can prevent an agent from exceeding a
vendor budget, but it cannot answer the business question that matters most:
can this expense be paid now without endangering the company's survival?

SafeSpend runs inside ZeroClaw and talks to the founder through Telegram. It
monitors a pinned Solana treasury, calculates runway from a protected weekly
burn policy, and submits only exact recurring vendor payments that satisfy two
independent conditions:

1. the founder-created Solana recurring delegation permits the expense;
2. the finalized post-payment balance still funds the protected minimum runway.

The winning demonstration starts with 100 tokens and a 10-token weekly burn.
A 12-token hosting payment succeeds, leaving 8.800 weeks. A second contractor
has its own active, unspent 12-token allowance, but SafeSpend rejects that
payment because the resulting 7.600 weeks would violate the eight-week floor.
A malicious Telegram message that supplies an attacker wallet and asks to
override policy is rejected before the payment tool is called.

## Why Solana

The allowance is not a database flag. Solana's Subscriptions and Allowances
program enforces the delegate, mint, amount, cadence, and expiry onchain. The
agent cannot exceed that outer boundary even if its host is compromised.
SafeSpend adds a stricter founder-owned survival policy before constructing,
simulating, signing, and submitting the permitted pull.

## ZeroClaw features

- real Telegram channel;
- signed Rust `wasm32-wasip2` tools;
- cron-triggered treasury monitoring SOP;
- persistent compact memory and restart-safe activity cursors;
- human SOP checkpoint and runtime `always_ask` approval;
- strict plugin publisher trust and bounded WASM execution.

## Custody and threat model

SafeSpend is T2. ZeroClaw never receives the founder key. A separate session
key contains fee SOL only and can act solely through founder-created recurring
delegations. The payment core validates finalized state, cluster genesis,
program owners, PDA seeds, canonical mint, token authorities, vendor mapping,
exact amount, period, expiry, reserves, fee budget, and post-payment runway. It
simulates the exact signed transaction before submission and never retries
automatically.

The weekly burn is protected configuration. A read-only calibrator can derive
a conservative recommendation from a complete bounded window of finalized
gross outflows, but Telegram and the model cannot modify payment policy.

## Reproduce

See:

- `README.md`
- `docs/SETUP.md`
- `docs/BURN_POLICY.md`
- `docs/THREAT_MODEL.md`
- `docs/SECURITY_TESTS.md`
- `docs/EVIDENCE.md`
- `docs/DEMO.md`

## Public evidence

- Repository: https://github.com/shivamSspirit/safespend
- Finalized devnet payment:
  https://explorer.solana.com/tx/4pZXVVud1ocKpTeDxLhqufYEKcUfu4CpGggSxBcp5vWNVizmZeSCJ4PHCk8HktcqgorcPrLoUj12KvusRzKsnijJ?cluster=devnet
- Devnet evidence: `evidence/devnet/2026-07-26-runway-lock.md`
- Video: pending real Telegram-to-ZeroClaw recording
- Discord showcase: pending video publication
