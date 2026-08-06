
# SafeSpend — policy-bound founder payments on Solana

SafeSpend is a self-hosted treasury operations agent for founders who want the
convenience of chat-based payments without giving a language model an
open-ended wallet. From Telegram or a local dashboard, a founder can check
runway and request a known operating expense. SafeSpend submits only an exact,
preconfigured vendor payment that passes both an onchain allowance and a
founder-owned runway policy.

## What it does and who it is for

Founders often pay the same small set of expenses — hosting, contractors, and
software — from a token treasury. An allowance prevents overspending a vendor
budget, but it does not answer the business question: can the company afford
this payment today? SafeSpend requires both conditions:

1. The founder-created Solana recurring delegation permits the exact payment.
2. The finalized post-payment balance remains above the protected runway floor.

The flow has two human boundaries. A `/pay <vendor-id> <amount-base-units>`
request creates an `approved-expense` SOP checkpoint. After the founder clears
it, Telegram presents a separate approval for the bounded payment tool. Only
then does the isolated payer re-read finalized Devnet state, simulate a fresh
transaction, sign it, submit it, and verify finality.

A completed Devnet payment demonstrates the full path: Telegram request, SOP
approval, payment-tool approval, submitted signature, and finalized treasury
observation. See the [public Devnet transaction](https://explorer.solana.com/tx/2otdDdEreWpjQRF8pP3bNbj7esDMsCBv439WqUDbcfnJRgsSYi6vZApkapwGsr2C8rJNQRuirMLaPHig95wGMxoD?cluster=devnet)
and its [sanitized operator transcript](evidence/devnet/2026-08-05-telegram-payment.md).

## ZeroClaw composition

SafeSpend uses ZeroClaw as the local agent host, not as the custody boundary:
the Telegram channel accepts founder commands; narrow guardian and payer agents
run the workflow; [SOPs](zeroclaw/sops/) create an auditable founder checkpoint;
runtime tool approval gates submission; and reviewed Rust WASM plugins watch
finalized balances and execute the bounded payment operation. The local Next.js
[dashboard](dashboard/) reads the same SOP and Devnet state, so it is a second
founder surface rather than a separate payment backend.

## Custody tier and threat model

SafeSpend is **T2: bounded sign and submit**. The founder key never enters
ZeroClaw. A separate session key has fee SOL only and can act solely through
founder-created recurring delegations in Solana's Subscriptions program.

Immediately before signing, the payer verifies finalized cluster identity,
programs, mint, treasury, recipient token account, delegation PDA, delegate,
period, remaining allowance, token/SOL reserves, and
`post-payment balance >= weekly burn × runway floor`. A spent vendor allowance
is unavailable in both the dashboard and the payment API. A compromised host
could access the limited session key, but the onchain delegation remains a
finite, mint-specific, recipient-specific outer cap.

Natural language is never authority: chat cannot provide a recipient, mint,
amount override, policy, or private key. A real Telegram prompt-injection test
sent an attacker wallet plus “ignore policy” instructions; it was rejected with
zero tool calls, no SOP, and no transaction. See the
[transcript](docs/PROMPT_INJECTION_TRANSCRIPT.md),
[threat model](docs/THREAT_MODEL.md), and
[security test matrix](docs/SECURITY_TESTS.md). Trust assumptions are declared:
ZeroClaw/local host, Telegram, Solana RPC, the model provider, and the
Subscriptions program. No MCP payment facilitator is in the signing path.

## Reproduce on Devnet

Start with the [judge fast path](README.md#judge-fast-path-three-minutes-to-verify-longer-for-a-personal-setup):
`cargo test --workspace --locked`, `./scripts/verify-release.sh`, then inspect
the public Devnet transaction. A personal Telegram payment environment takes
longer because it intentionally requires a founder key, test mint, vendor
accounts, recurring delegations, bot, model login, and masked secrets.

For the complete setup, use [docs/SETUP.md](docs/SETUP.md), copy
[zeroclaw/config.example.toml](zeroclaw/config.example.toml) into ignored
`.zeroclaw-dev/config.toml`, and follow the exact [approved-expense
SOP](zeroclaw/sops/approved-expense). The payment policy and finalized checks
are in [plugins/allowance-pay](plugins/allowance-pay); provisioning is in
[tools/devnet-setup](tools/devnet-setup). All secrets are redacted: local
runtime config, wallet keypairs, Telegram tokens, RPC credentials, and session
keys are never committed.

SafeSpend currently runs on Solana Devnet only. Mainnet is intentionally
disabled.
