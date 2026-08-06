# SafeSpend dashboard security boundary

## Custody classification

SafeSpend is **T2: sign and submit**. The T2 authority belongs only to the local ZeroClaw payer
plugin and its limited-funds Devnet session key. The Next.js browser surface has no signing
authority.

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
- Public keys, policy limits, balances, run IDs, and signatures: safe to render.
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
