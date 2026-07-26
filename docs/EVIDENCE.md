# Evidence index

This file distinguishes reproducible evidence from planned demonstrations.
Never replace a pending row with a claim unless its public artifact exists.

## Automated evidence

| Evidence | Status | Reproduce |
|---|---|---|
| Exact runway boundary and two-independent-allowance scenario | Verified locally | `cargo test --locked -p safespend-core` |
| Plugin RPC parsing and substitution denials | Verified locally | `cargo test --locked -p safespend-treasury-watch -p safespend-allowance-pay` |
| Historical burn calibration parsing and conservative rounding | Verified locally | `cargo test --locked -p safespend-burn-calibrator` |
| WASI component build | Verified locally | `./scripts/build-plugins.sh` |
| Publisher signatures, approved WASM, and source-input digest | Verified locally and in CI | `./scripts/verify-release.sh` |
| Current official ZeroClaw source revision | Pinned | `f3023663a08f668dcec60c8d6d6db7777c86955a` |
| Official-host feature build and strict plugin discovery | Verified | `evidence/official-zeroclaw/2026-07-26-host-proof.md` |
| Official agent → WASM watcher → finalized devnet RPC | Verified | `evidence/official-zeroclaw/2026-07-26-host-proof.md` |

## Live evidence

| Evidence | Status | Required public reference |
|---|---|---|
| Telegram `/status` through official ZeroClaw | Pending | Sanitized transcript/video timestamp |
| Hosting allowance payment finalized on devnet | Verified | `evidence/devnet/2026-07-26-runway-lock.md` |
| Watcher observes finalized debit and 8.800 weeks | Pending | Transcript/video timestamp |
| Separate contractor allowance rejected at 7.600 weeks | Plugin boundary verified; Telegram pending | `evidence/devnet/2026-07-26-runway-lock.md` |
| Malicious wallet override rejected before tool call | Plugin boundary verified; Telegram pending | Prompt-injection transcript/video timestamp |
| Repeated authentic founder-treasury monitoring | Pending | Dated, redacted operating log |
| Independent clean setup | Pending | Tester, environment, elapsed time, corrections |
| Public repository | Live | `https://github.com/shivamSspirit/safespend` |
| Showcase video | Pending | Public or unlisted URL under three minutes |
| Discord showcase | Pending | Message URL |

## Evidence hygiene

- Never publish a founder key, session key, Telegram token, RPC credential, or
  full ZeroClaw secret configuration.
- Public Solana addresses and signatures may be published only after confirming
  they belong to the dedicated demonstration environment.
- Record submitted and finalized states separately.
- Preserve the exact policy hash, plugin manifest signatures, WASM digests,
  ZeroClaw commit, Solana genesis hash, and demo transaction signatures.
