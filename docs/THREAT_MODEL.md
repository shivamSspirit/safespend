# Threat model

## Assets

- founder treasury tokens and SOL;
- session delegate secret;
- Telegram bot token and model credentials;
- vendor allowlist, amount/period rules, reserve policy, and RPC endpoint;
- weekly burn and minimum runway policy;
- accurate monitoring cursor and approval history.

## Security goals

1. ZeroClaw never handles the founder private key.
2. A model, Telegram user, transaction memo, or hostile RPC string cannot
   select a new recipient, mint, program, allowance, or cluster.
3. A compromised session key cannot spend beyond the remaining finite onchain
   recurring delegation.
4. A stale, malformed, ambiguous, or unverifiable state denies payment.
5. A transaction is not represented as finalized until finalized observation.
6. An otherwise valid allowance cannot bypass the protected post-payment
   runway floor.

## Adversaries and controls

### Prompt injection or stolen Telegram account

An attacker asks the model to ignore policy, refund an invoice to a pasted
wallet, change the mint, or reveal secrets.

Controls: the skill treats all messages as data; payment arguments contain
only vendor id and integer amount; tool, SOP, and runtime approval scopes are
narrow; authority-bearing values are protected config plus onchain state; the
plugin independently checks every invariant. Weekly burn and minimum runway
cannot be supplied or changed through chat.

Residual risk: an attacker who can obtain both human approval interactions may
trigger an already-authorized vendor expense earlier than intended. Onchain
amount/period/expiry limits still apply.

### Malicious or compromised RPC

Controls: HTTPS, expected genesis hash, finalized reads, strict response shape
and size limits, account owner and PDA verification, exact signed transaction
simulation, locally computed signature comparison, and no raw RPC strings in
the model policy path.

Residual risk: a malicious RPC can deny service or withhold newer finalized
state. Operators should use a reputable authenticated endpoint and compare a
second provider during incident response.

### Compromised ZeroClaw host

The attacker can read process memory or encrypted-config decryption material,
steal the session key, and replace local files.

Controls: the session key owns no treasury tokens and holds fee SOL only; the
onchain delegation is finite, expiring, mint-specific, and period-specific;
treasury and session keys are different; operator reserves add a stricter
local bound.

Residual risk: the attacker can spend the remaining onchain allowance and
disable alerts. Host compromise is not solved by an LLM policy. Revoke the
delegation and rotate the session key immediately.

### Malicious plugin or supply-chain substitution

Controls: dependencies are locked, CI actions are pinned to immutable commit
hashes, RustSec runs in CI, plugin WIT is pinned, and production must enable
ZeroClaw strict publisher verification. A separately committed SHA-256 file is
signed by the same offline publisher identity, and CI requires every rebuilt
WASM byte to match it because ZeroClaw manifest signatures do not cover WASM
bytes.

Residual risk: the publisher key proves which manifest was approved, while the
signed release digest proves the exact WASM bytes. Release operators must
verify both, review any deliberate digest update, and protect the signing key
outside the repository.

### Duplicate or concurrent payment

Controls: exact per-period pulled state is checked before construction; the
onchain program updates the allowance account in the same transaction; Solana
write locking serializes competing transfers; SafeSpend never retries
automatically.

### Arithmetic, clock, and rollover errors

Controls: integer base units, checked add/subtract/multiply, finalized chain
time rather than host time, finite nonzero expiry, an expiry safety buffer, and
period rollover behavior mirrored from the onchain implementation. Runway is
computed as exact milliweeks with `u128`, and the authorization comparison uses
cross-multiplication rather than floating point.

### Incorrect or stale burn policy

The operator configures a weekly burn that no longer represents the business.

Controls: the burn and runway floor are protected configuration, included in
the deterministic policy hash, shown in successful payment evidence, and used
by both watcher and payment policy. The read-only calibrator backfills
finalized canonical-token history, counts gross outflows without netting
incoming funds, refuses incomplete bounded windows, and emits a deterministic
evidence digest. Changes require human review, an offline configuration
procedure, and daemon reload.

Residual risk: the chain cannot know a company's true offchain costs. The
onchain allowance still limits spend, but an understated burn rate weakens the
local runway lock. Historical token outflows also omit expenses paid through
other accounts or fiat rails. The founder must choose a conservative minimum
and review the policy on a fixed cadence.

## Incident response

1. Stop the ZeroClaw daemon.
2. Revoke the recurring delegation with a founder-controlled tool.
3. Move any fee SOL out of the session account.
4. Rotate Telegram, RPC, and model credentials.
5. Preserve logs without copying secrets.
6. Compare finalized treasury history through an independent RPC.
7. Replace and re-sign plugins, then restore with a new delegate and smaller
   allowance.

## Mainnet acceptance criteria

- all devnet security cases pass;
- plugin signatures and WASM digests pass `scripts/verify-release.sh`;
- the publisher private key has been moved to offline encrypted storage;
- founder and session keys are proven distinct;
- the session account owns no token accounts and has fee SOL only;
- allowances have finite expiry and the smallest useful per-period amount;
- watcher and payment policy use the same reviewed weekly burn and minimum
  runway floor;
- revocation has been rehearsed;
- two independent operators review mint, recipient ATAs, policy hash, genesis
  hash, reserves, and program id;
- a third-party review covers plugin host integration and onchain assumptions.
