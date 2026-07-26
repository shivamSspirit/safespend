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
