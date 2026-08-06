# Telegram payment evidence — 2026-08-05

This record captures the first complete operator-driven Telegram payment in the
current SafeSpend Devnet workspace. It contains only public Devnet identifiers
and a sanitized transcript. No key, bot token, gateway bearer, RPC credential,
or model credential is included.

## Payment

- command: `/pay hosting 12000000`
- SOP: `approved-expense`
- SOP run: `run-1785943007812047000-0001`
- separate approvals: founder SOP checkpoint, then Telegram payment-tool gate
- submitted amount: `12000000` base units
- [finalized Devnet transaction](https://explorer.solana.com/tx/2otdDdEreWpjQRF8pP3bNbj7esDMsCBv439WqUDbcfnJRgsSYi6vZApkapwGsr2C8rJNQRuirMLaPHig95wGMxoD?cluster=devnet)
- token balance after finality: `88000000` base units
- calculated runway after finality: `8.8` weeks

## Sanitized operator transcript

```text
founder: /pay hosting 12000000

SafeSpend: SOP approval needed for approved-expense run
run-1785943007812047000-0001 (step 1).

founder: approve run-1785943007812047000-0001

SafeSpend: Payment request staged. Waiting for the founder expense checkpoint
before any payment can be submitted.

SafeSpend: Payment submitted.
Vendor: hosting
Amount: 12000000 base units
Signature: [public signature linked above]
Treasury after payment: 88000000 base units

founder: /status

SafeSpend: Token balance 88000000 base units. Runway 8.8 weeks.
Token balance changed by -12000000 base units.
```

## What this proves

The transcript and transaction demonstrate the requested happy path: Telegram
intent, explicit SOP approval, a separate tool approval, a submitted signature,
and finalized post-payment state. They do not prove mainnet readiness or an
independent security review.

The dashboard subsequently matched the exact SOP run to the submitted signature
and checked the finalized token-account delta before showing the payment as
finalized.
