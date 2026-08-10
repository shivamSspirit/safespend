# Dependency security policy

CI runs `cargo audit` against the committed lockfile and fails on RustSec
vulnerability advisories.

## Known maintenance warning

RustSec advisory `RUSTSEC-2025-0141` marks `bincode` 1.3.3 as unmaintained. It
does not describe a vulnerability. SafeSpend currently uses bincode 1.x for
the exact legacy Solana `Message` and `Transaction` wire representation, and
the pinned Solana 3.1 dependency graph also brings in the same crate.

Changing only SafeSpend's direct dependency would neither remove the
transitive warning nor establish byte-for-byte compatibility with the Solana
RPC wire format. The project therefore:

- keeps the version locked;
- serializes only locally constructed typed Solana messages and transactions,
  never attacker-controlled Rust values;
- bounds every RPC response before deserialization;
- runs simulation before submission;
- treats any future vulnerability advisory as a CI failure;
- will migrate when the pinned Solana transaction stack exposes a maintained,
  wire-compatible serializer.

This warning must not be described as resolved or silently excluded from audit
output.

## Dashboard audit status

The founder dashboard uses `@solana/web3.js` 1.98.4 to parse and verify the
wallet-signed legacy transaction bytes used by the deployed Subscriptions
program. `npm audit --omit=dev` currently reports three moderate findings from
`uuid <11.1.1` through Web3's `jayson` RPC dependency. The advisory concerns
UUID calls supplied with a caller-owned output buffer; SafeSpend does not call
that API or use Web3's RPC client. Its own RPC adapter uses bounded `fetch`
responses, and proposal IDs use Node's `crypto.randomUUID`.

The audit's proposed forced change downgrades Web3 to `0.0.3`, which is not a
compatible or safe remediation. The high-severity `bigint-buffer` path formerly
introduced by the SPL-token helper was removed: SafeSpend now derives the ATA
from the pinned associated-token PDA seeds directly. Do not describe the
remaining moderate transitive warning as fixed; migrate when the Solana client
stack publishes a compatible patched release.
