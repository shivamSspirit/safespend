# SafeSpend — Runway-Locked Treasury Autopilot

SafeSpend is a self-hosted ZeroClaw agent for a founder's Solana treasury. A
Telegram conversation provides treasury status and proposes recurring business
expenses; a finite allowance created by the founder caps what the agent can
actually spend, while a separate runway lock protects company survival.

> A self-hosted founder agent that pays an approved business expense only when
> both the onchain allowance and the company's protected runway floor permit
> it.

## What is implemented

- **T0 runway watcher:** finalized SOL and SPL-token balances, exact
  milliweek runway arithmetic, protected-floor alerts, compact activity
  cursors, and meaningful-change filtering.
- **T2 bounded expense payer:** a dedicated session key pulls one exact
  recurring vendor amount through Solana Subscriptions. It checks the cluster,
  program, PDA seeds, mint, token accounts, delegate, period, expiry, reserves,
  weekly burn, post-payment runway, transaction fee, simulation, and returned
  signature.
- **ZeroClaw operation:** a Telegram skill, five-minute restricted agent cron
  that drives the monitoring SOP, human-approval checkpoint, runtime
  `always_ask` gate, narrow tool allowlist, and compact persistent memory.
- **Devnet provisioning:** a founder-authorized CLI creates and confirms the
  Subscription Authority, reads its deployed-program `init_id`, and then
  creates the recurring delegation. The founder key is used by this offline
  setup command and never enters ZeroClaw.
- **Burn calibration:** an offline, read-only CLI backfills a bounded window of
  finalized canonical-token history, counts gross outflows, and emits a hashed
  recommendation for the protected weekly-burn policy.

The payment plugin never receives the founder key and never owns treasury
tokens. A valid onchain allowance is necessary but not sufficient: SafeSpend
also rejects any payment where:

```text
post_payment_balance < weekly_burn × minimum_runway_weeks
```

If the agent host is compromised, the onchain recurring allowance remains the
outer spending boundary. The session account should contain fee SOL only.

## Architecture

```text
Telegram founder
      |
      v
ZeroClaw skill + approval SOP
      |                       protected config
      +--> treasury-watch --------------------------+
      |       finalized RPC reads                   |
      |                                             v
      +--> allowance-pay --> simulate + sign --> Solana RPC
               |                                    |
               +-- session delegate                 v
                                   recurring delegation onchain
                                   founder treasury -> vendor ATA
```

Natural-language content is not authority. Vendor addresses, mint, program,
RPC genesis hash, allowance accounts, amounts, periods, weekly burn, runway
floor, and reserves all come from protected configuration and verified
finalized state.

`weekly_burn_base_units` is an operator-owned policy value, not a model-learned
prediction. Calibrate it from finalized history with
`safespend-burn-calibrator`, review the evidence, and update both plugin
sections offline. SafeSpend intentionally does not let Telegram activity or a
single unusual transaction rewrite the payment boundary.

## Repository map

```text
crates/safespend-core/       Pure policy, arithmetic, and watcher logic
plugins/treasury-watch/      T0 ZeroClaw WASM tool
plugins/allowance-pay/       Onchain-capped payment WASM tool
tools/devnet-setup/          Founder-authorized devnet provisioning CLI
tools/devnet-exercise/       Native harness for the production payment engine
tools/burn-calibrator/       Finalized-history burn-policy calibration CLI
wit/v0/                      Pinned ZeroClaw plugin interface
zeroclaw/                    Skill, SOPs, and example runtime configuration
docs/                        Architecture, setup, tests, threat model, demo
evidence/devnet/             Public, sanitized onchain integration evidence
```

Dependency audit policy and the current Solana serialization maintenance
warning are documented in [docs/DEPENDENCY_POLICY.md](docs/DEPENDENCY_POLICY.md).
The project also publishes an original [privacy notice](PRIVACY.md). A
[future web and Supabase security baseline](docs/WEB_SECURITY_BASELINE.md)
defines mandatory controls if a browser, API, or hosted database is added; no
such surface exists in the current repository.

## Build and test

Prerequisites are Rust `1.93.1` and target `wasm32-wasip2`.

```bash
rustup show
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
./scripts/build-plugins.sh
```

The generated component artifacts are staged under `dist/plugins/` and are not
committed. Continue with [the devnet setup guide](docs/SETUP.md).

## Safety status

This repository is devnet-first, pre-mainnet software. Mainnet is disabled by
default. Both plugin manifests are signed, the example uses strict
trusted-publisher enforcement, and generated WASM files must match a committed
publisher-signed digest. See [the threat model](docs/THREAT_MODEL.md),
[security test matrix](docs/SECURITY_TESTS.md), and [security
policy](SECURITY.md).

Invoice generation is deliberately outside this submission. The workflow is
narrow: monitor founder runway, approve an already-budgeted expense, require
both the allowance and runway lock, and observe the finalized result.

See [burn policy calibration](docs/BURN_POLICY.md) before claiming that a burn
rate represents historical spending.

## Upstream

- [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw)
- [ZeroClaw plugin registry](https://github.com/zeroclaw-labs/zeroclaw-plugins)
- [Solana Subscriptions](https://github.com/solana-foundation/subscriptions)

## License

MIT
