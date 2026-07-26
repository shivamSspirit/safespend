# Security policy

SafeSpend is pre-mainnet software. Do not place real funds behind it until the
release checklist in `docs/SETUP.md` is complete.

Runtime data handling is described in [PRIVACY.md](PRIVACY.md). SafeSpend has
no web application or hosted database today; any future browser, API, or
Supabase surface must satisfy
[docs/WEB_SECURITY_BASELINE.md](docs/WEB_SECURITY_BASELINE.md).

## Reporting

Please use the repository's
[private vulnerability report](https://github.com/shivamSspirit/safespend/security/advisories/new)
to disclose a suspected vulnerability. Do not include private keys, seed
phrases, bot tokens, RPC credentials, or live transaction payloads in a public
issue. If GitHub's private form is unavailable, open an issue containing only a
request for a private disclosure channel.

## Supported versions

Only the latest commit on `main` is supported during the bounty build.

## Operating assumptions

- The founder key never enters ZeroClaw.
- The payment session key holds only enough SOL for transaction fees.
- The treasury's token authority grants a finite, expiring recurring
  delegation through the pinned Solana Subscriptions program.
- Mainnet remains disabled until plugin signatures and digests, RPC genesis
  pinning, and the full devnet test matrix are verified.

Compromise of the host account running ZeroClaw can steal the session key and
spend up to the remaining onchain allowance. It must not expose unlimited
treasury authority.
