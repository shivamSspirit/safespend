# Technical research notes

The implementation was checked against these primary sources:

- [ZeroClaw runtime](https://github.com/zeroclaw-labs/zeroclaw), revision
  `f3023663a08f668dcec60c8d6d6db7777c86955a` during development.
- [ZeroClaw plugin examples and WIT](https://github.com/zeroclaw-labs/zeroclaw-plugins),
  pinned in this repository at revision
  `23a5dcb953f697cae08d8e2802b39894ac9ddda1`.
- [Solana Foundation Subscriptions program](https://github.com/solana-foundation/subscriptions),
  revision `d4b29e80e2b3db3fc5cd449ffb7b563055644d51`
  during implementation.
- [RustSec tooling](https://github.com/RustSec/rustsec) and
  [advisory database](https://github.com/RustSec/advisory-db).

## Decisions produced by the research

- One WASM component exposes one ZeroClaw tool, so observation and payment are
  separate components with different semantic authority.
- Protected `config_read` values are the only source for payment authority;
  injected caller fields do not override them.
- `wasi:http` is used for RPC, with application-level HTTPS and response-size
  validation.
- The Subscriptions recurring transfer gives the agent genuine T2 automation
  while retaining an onchain upper bound.
- The local policy mirrors the program's stale-period rollover instead of
  inventing a different offchain counter.
- The recurring allowance is treated as necessary infrastructure rather than
  complete business authorization. SafeSpend applies the stricter
  founder-specific rule that finalized post-payment balance must fund the
  configured minimum runway at the protected weekly burn.
- The SDK PDA helper is not trusted for nonce encoding; the implementation
  follows the onchain little-endian seed contract directly.
- Manifest signing authenticates the manifest but does not hash the WASM;
  releases therefore need both strict trusted-publisher verification and an
  artifact SHA-256.

SafeSpend implements both controls. CI verifies manifest signatures using the
same Ed25519 canonicalization contract and verifies a committed release digest
signature over the explicitly approved WASM package, manifests, and complete
tracked plugin-source inventory. The runtime loads that package rather than a
platform-dependent build directory.

These notes are a source-review record, not an audit of any upstream project.
