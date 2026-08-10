# SafeSpend dashboard security boundary

## Custody classification

SafeSpend is **T2: sign and submit**. Payment authority belongs only to the local ZeroClaw payer
plugin and its limited-funds Devnet session key. The ordinary payment surface has no signing
authority. The separate vendor-administration dialog may request signatures from an injected founder
wallet. Private key material remains inside that wallet; the browser and server handle only public
keys, canonical policy bytes, and signed transaction bytes.

Vendor administration uses two explicit founder signatures. The first authenticates an immutable,
hash-chained policy version containing recipient token account, amount, cadence, finite term,
delegation PDA, and protected treasury boundaries. The second signs the exact Subscriptions
transaction. Add creates a finite delegation; an onchain-terms update atomically creates the
replacement and revokes the old delegation; delete revokes the old delegation. A name-only update
retains the existing delegation and allowance period. The loopback server submits those signed bytes
to its pinned Devnet RPC, waits for finalized commitment, verifies every created or closed account,
and publishes the policy atomically only when every field matches. Immutable versions and an
append-only audit log are mode `0600`. The payer fetches and verifies the active Ed25519-signed
version before each payment; unavailable, malformed, or incorrectly signed policy data fails closed.

The browser may request a configured vendor and exact configured amount. The server validates that
closed intent, creates an `approved-expense` SOP run, and exposes its checkpoint. Clearing that
checkpoint does not authorize payment: ZeroClaw routes the payer tool's independent `always_ask`
approval to `telegram.guardian`. An absent or unreachable Telegram approver and a 120-second timeout
deny the tool call.

## Cross-channel flow

```text
Dashboard or Telegram request
        ↓
approved-expense SOP checkpoint
        ↓ founder approves in dashboard or originating channel
safespend_allowance_pay approval in Telegram
        ↓
local payer revalidates finalized allowance + policy, builds fresh tx, simulates, signs
        ↓
Devnet submitted signature
        ↓
dashboard independently verifies exact account deltas and polls finalized status
```

Vendor administration is deliberately outside this payment path and cannot satisfy either
per-payment approval. Updating allowance terms starts a fresh delegation period and is disclosed in
the founder review. If the current period has already paid, the replacement starts only at the prior
period boundary, so a policy update cannot grant a second allowance in that period. Deleting a
vendor does not transfer tokens. For delegations already replaced by an older dashboard build, the
service can conservatively reconstruct the boundary from immutable signed policy history and a
finalized local payment record; that evidence can only delay eligibility, never expand it.

Dashboard-created requests retain their exact vendor and amount in a mode-0600 local ledger. The
server reads the local ZeroClaw SOP audit store read-only to correlate Telegram-originated run
payloads and payer results. A signature is never inferred from a nearby transaction: it must be
recorded by the exact SOP run. The dashboard refuses to approve an opaque run whose exact intent it
did not record.

## Secret and trust inventory

- Session key: encrypted protected ZeroClaw plugin config; never browser or dashboard state.
- Telegram token and model credentials: ZeroClaw secret storage; never dashboard responses.
- Gateway bearer: mode-0600 `dashboard/.safespend/gateway-token`; server-only.
- RPC URL/API key: `.dev/devnet-payment-config.json`; server-only. The browser receives only the
  provider hostname.
- Public keys, signed policy versions, policy limits, balances, run IDs, and signatures: safe to
  render.
- Third parties: ZeroClaw runtime, configured Solana Devnet RPC, Telegram, model provider, and the
  pinned onchain Subscriptions program.

The model can propose/review steps but cannot bypass either human gate or the deterministic plugin
policy. The onchain Subscriptions program remains authoritative for the delegated allowance.

## Transaction firewall

The plugin pins Solana Devnet genesis and the official Subscriptions program, verifies the exact
mint, token program, treasury, recipient, delegation PDA, period, amount, reserves, and post-payment
runway from finalized state, simulates before sending, and requires the protected 64-byte keypair to
match the onchain delegate. It builds after tool approval, avoiding an expired pre-approval
blockhash.

The dashboard treats a tool result as `submitted`, not complete. It separately verifies the
transaction called the pinned program and moved the exact amount between the configured token
accounts, then waits for finalized confirmation.

Historical receipts are verified against the immutable signed policy version recorded when the
request was created. Deleting or changing a vendor therefore cannot relabel its earlier finalized
payment as failed. The Activity payment list excludes minting, treasury funding, associated-token
account setup, and delegation-administration signatures; those are real chain events but are not
vendor payments.

The dashboard never subtracts vendor allowances from the displayed treasury balance. That balance is
the finalized canonical token-account balance; an allowance is a maximum recurring permission, not
an escrow or reservation. Planning UI reports callable allowance and cadence-normalized weekly
exposure separately. Spendable headroom is calculated as the finalized balance minus the higher of
the absolute token reserve and `weekly_burn_base_units × minimum_runway_weeks`, floored at zero.

Deleting a vendor requires the founder-signed revocation and a new immutable policy version. It does
not refund prior payments or erase their receipts. Requests that have not reached submission are
refused after the policy changes; a transaction submitted before revocation may finalize first and
remains visible as a historical payment.

## Prompt-injection fail-closed transcript

With both processes running:

```bash
curl -sS -X POST \
  -H 'x-safespend-action: founder-dashboard' \
  -H 'Content-Type: application/json' \
  -d '{}' \
  http://127.0.0.1:3000/api/safespend/prompt-injection-test
```

The fixed corpus attempts recipient, instruction, mint, RPC, amount, and refund overrides. Every
case must return `blocked`. The test stops at strict intent/protected-policy validation; none of the
attack strings are sent to the LLM, signer, or Solana RPC.
