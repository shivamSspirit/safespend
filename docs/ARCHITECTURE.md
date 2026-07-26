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
- No policy changes through chat.
- No automatic retry after a failed or denied payment.
- No invoice workflow in this first build.
- No mainnet operation until every release gate in `SETUP.md` is complete.
