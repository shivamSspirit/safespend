# Architecture

## Design objective

SafeSpend combines treasury observability with useful automation while keeping
the founder's unlimited authority outside the agent. The model can propose a
configured expense, but payment requires two independent proofs:

1. the Solana recurring delegation has sufficient allowance;
2. the finalized post-payment balance still funds the configured minimum
   runway at the protected weekly burn.

## Components and trust boundaries

| Component | Authority | Trusted input | Untrusted input |
|---|---|---|---|
| Telegram and model | Intent only | None | All messages and generated text |
| ZeroClaw policy | Tool routing and approvals | Local operator config | SOP payload |
| `treasury-watch` | T0, no signing | Protected addresses and thresholds | RPC responses and cursors |
| `allowance-pay` | T2, bounded delegate signing | Protected policy, mappings, session key | Request and RPC responses |
| Setup CLI | One-time founder signing | Local founder keypair and explicit CLI values | RPC responses |
| Subscriptions program | Onchain spending cap | Program state and Solana runtime | Submitted transactions |

The founder creates a finite recurring delegation to a dedicated session
delegate. Each vendor is represented twice:

1. protected local policy pins its human id, recipient wallet, exact
   base-unit amount, and period;
2. an onchain delegation pins the delegator, delegate, mint, period, amount,
   start, expiry, and already-pulled amount.

A payment is built only when these independent descriptions match exactly and
the runway inequality holds:

```text
post_payment_balance >= weekly_burn_base_units × minimum_runway_weeks
```

The comparison uses `u128` integer arithmetic. No floating-point calculation,
rounded UI amount, model estimate, or host clock participates in authorization.

## Read path

`treasury-watch` batches finalized `getBalance`, `getAccountInfo`, and
`getSignaturesForAddress` requests. It rejects oversized or malformed
responses, validates classic SPL Token account owner/mint/authority/decimals,
uses integer base units, calculates exact milliweeks, alerts below the protected
runway floor, and returns only a compact summary. Its cursor can advance
through a full page without silently skipping a backfill.

The weekly burn is deliberately not model-writable. A separate offline
calibrator can derive a recommendation from a complete bounded window of
finalized canonical-token outflows. The operator reviews that report and pins
the conservative value into both plugin configs. This separates measurement
from authorization: changing recent transaction history cannot silently
weaken an in-flight payment rule.

The monitoring SOP stores three fixed values:

- `safespend.snapshot`
- `safespend.native_cursor`
- `safespend.token_cursor`

No raw RPC response is persisted or placed into the model context.

## Payment path

1. Telegram supplies only `vendor_id` and `amount_base_units`.
2. The approved-expense SOP pauses at a human checkpoint.
3. ZeroClaw's `always_ask` policy creates a second tool-level approval.
4. The plugin verifies the protected session key matches the pinned delegate.
5. The RPC genesis hash is matched to the configured cluster.
6. A finalized slot and its block time define current chain time.
7. Allowance and token accounts are decoded and checked for exact length,
   program ownership, discriminator/version, PDA seeds, authorities, mint, and
   classic token program.
8. Pure policy logic mirrors onchain period rollover and checks exact amount,
   finite expiry, safety buffer, remaining allowance, treasury balance,
   absolute token/SOL reserves, and the post-payment runway floor with checked
   integer arithmetic.
9. The plugin builds the official `transferRecurring` instruction, obtains a
   recent blockhash, computes the fee, and enforces the session fee reserve.
10. It signs with the delegate, simulates the exact signed transaction with
    signature verification, submits with preflight, and rejects an RPC
    signature that differs from the locally expected signature.
11. The result includes post-payment balance, calculated runway, protected
    floor, and policy hash. Its status is `submitted`, never `finalized`; the
    watcher confirms later.

Concurrent duplicate submissions are ultimately serialized by Solana account
locking and enforced by the onchain pulled amount. SafeSpend still refuses
automatic retries to keep operator intent unambiguous.

## Founder-managed vendors and recurring cadence (specified extension)

The founder dashboard shall support adding, editing, disabling, and removing a
vendor, and shall offer recurring cadences of daily, weekly, and monthly. This
is a policy-administration workflow, not a payment workflow: it must never
turn a browser request, a dashboard server, Telegram, or the model into an
unbounded transfer authority.

### Vendor record

Each vendor record shall contain a stable, human-readable `vendor_id`, display
name, recipient wallet and canonical-mint recipient token account, fixed
per-period amount in base units, cadence, start time, expiry, and lifecycle
state. It shall also retain the derived recurring-delegation PDA, unique nonce,
treasury token account, canonical mint, and the policy version that activated
it. Vendor ids are unique, normalized, and immutable after activation; a
renamed vendor retains its id. Changing a recipient, mint, amount, cadence,
start, or expiry creates a replacement vendor policy and delegation rather
than mutating the active one.

Cadence uses fixed, chain-verifiable durations:

| Display cadence | `period_seconds` |
| --- | ---: |
| Daily | `86_400` |
| Weekly | `604_800` |
| Monthly | `2_592_000` (30 days) |

“Monthly” therefore means every 30 days, not a calendar-month date such as the
last business day. The dashboard shall show the precise next eligible time and
the fixed duration before the founder approves it.

### Enrollment and change flow

1. The dashboard collects vendor details and validates public keys, a positive
   base-unit amount, an allowed cadence, finite expiry, canonical mint, and a
   recipient token account owned by the specified recipient.
2. It presents an immutable review screen showing recipient, mint, amount,
   cadence/seconds, start, expiry, treasury impact, policy hash/version, and
   the runway result assuming the first payment. The founder explicitly
   approves this configuration with their founder-controlled signing authority.
3. A founder-authorized setup service creates a new, finite onchain recurring
   delegation with a fresh nonce. The session delegate may submit transfers
   only through that delegation; it cannot create, widen, or renew one.
4. After finalized chain verification, the service atomically publishes the
   matching protected local policy and vendor-account mapping as a new policy
   version. The dashboard exposes the vendor as payable only after both
   descriptions are present and identical.
5. The activation is written to an append-only audit record containing the
   founder identity, prior and new policy hashes, reviewed fields,
   delegation PDA, transaction signature, and timestamps. Sensitive keys and
   secrets are never included.

If setup, finalization, policy publication, or verification fails, the vendor
remains inactive and unavailable for payment. A finalized onchain delegation
without a matching active local policy is harmless and shall be displayed as
an enrollment exception requiring founder remediation; it is not payable.

Disabling a vendor immediately removes it from payment selection and creates a
new protected policy version. Removing or materially changing one also revokes
the old delegation with the founder authority before (or, for replacement,
after safely activating) the new delegation. Existing requests tied to a
superseded policy version are cancelled and require a new approval. No change
may silently broaden an existing allowance.

An empty founder-signed vendor policy is valid and means deny all vendor
payments. This allows the founder to remove the final vendor without falling
back to legacy static vendor configuration.

### Payment behavior after activation

The existing two approvals remain required for every individual payment. The
payment request continues to carry only `vendor_id` and the exact fixed amount;
it carries no wallet, mint, cadence, or schedule override. The payer plugin
must bind the request to the active policy version and continue to verify all
local/onchain terms, finalized allowance state, reserves, fees, expiry, and
post-payment runway immediately before signing.

Recurring cadence makes a vendor eligible once per period; it does not cause
SafeSpend to submit a payment automatically. The dashboard may show due and
next-eligible states and send reminders, but any transfer still needs the SOP
checkpoint and the Telegram payment-tool approval. Failed, denied, or expired
requests are never retried automatically.

### Acceptance and denial requirements

- A new vendor is payable only after the matching delegation and protected
  policy version both finalize and verify.
- The dashboard rejects an invalid recipient ATA, non-canonical mint, zero or
  non-integer amount, unsupported cadence, non-finite expiry, duplicate id, or
  first-payment runway breach before founder approval.
- The payer rejects stale, disabled, superseded, or version-mismatched vendors;
  a caller cannot race a policy update with a previously approved request.
- The system rejects a second payment in a daily, weekly, or monthly period,
  as well as a request before the period start or inside the expiry safety
  buffer.
- Chat, model output, and client-side requests cannot add vendors, alter
  payment terms, choose a recipient, or schedule unattended payments.

## Pinned interfaces

- Subscriptions program:
  `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`
- Classic SPL Token program:
  `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- ZeroClaw WIT source revision:
  `23a5dcb953f697cae08d8e2802b39894ac9ddda1`

The generated Subscriptions SDK version used by this repository derives a
recurring-delegation PDA incorrectly for nonces if its helper is used
directly. SafeSpend therefore derives the PDA from the onchain seed contract,
including `nonce.to_le_bytes()`, and tests nonce separation.

## Deliberate limits

- Classic SPL Token only; Token-2022 extensions are rejected.
- Exact recurring amounts only; no arbitrary transfers, refunds, swaps, or
  partial discretionary spending.
- No policy changes through chat, model output, or an ordinary payment request.
  Founder-managed vendor changes follow the separately approved enrollment flow
  above and require founder-controlled onchain authority.
- No automatic retry after a failed or denied payment.
- No invoice workflow in this first build.
- No mainnet operation until every release gate in `SETUP.md` is complete.
