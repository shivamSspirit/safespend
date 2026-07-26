# Security policy

SafeSpend is pre-mainnet software. Do not place real funds behind it until the
release checklist in `docs/SETUP.md` is complete.

## Reporting

Please disclose a suspected vulnerability privately to the repository
maintainer. Do not include private keys, seed phrases, bot tokens, RPC
credentials, or live transaction payloads in a report. Until a dedicated
security contact is published, open a GitHub issue containing only a request
for a private disclosure channel.

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
