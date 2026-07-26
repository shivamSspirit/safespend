# Devnet runway-lock evidence — 2026-07-26

This is public, reproducible evidence from a dedicated SafeSpend demonstration
environment. It contains no founder key, session key, Telegram token, or RPC
credential.

## Environment

- Cluster: Solana devnet
- Genesis:
  `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`
- Treasury owner:
  `DRbmdbC1evqHeJuUBwKizD1aerNUTi9KEfYEhJm1SJZH`
- Demonstration mint:
  `8wPJRcU2sztbsvK6QG2CvokVmf1444AzHn26GnwFfti1`
- Treasury token account:
  `8ri1mCQk79fJBRwhHunHAXJZjp54BzeGtaZGQGaWtyXE`
- Session delegate:
  `GqxSgz7EdquxfN8NQo1oPSsjBLer1e1WMDxb1bShBuZT`
- Solana Subscriptions program:
  `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`
- Protected policy: 10 tokens/week burn, minimum eight weeks of runway

The mint is a valueless classic SPL token created only for this test.

## Onchain allowances

The deployed subscriptions program requires authority initialization to be
confirmed before its real `init_id` is used to create a delegation. SafeSpend
read `init_id` `479034758`.

- Authority initialization:
  [transaction](https://explorer.solana.com/tx/5zNznmZrzFF7rAUuT8CSzLHRBQDc5Gb2emQULCSY7KhZzStnZhgWM4zn2g37W84aMqEw7MXynfzLvmYtP3BaCZED?cluster=devnet)
- Hosting allowance PDA: `AMoQZeaFL9XfSFuC9FHgJnG7nimm1KthSem7oNkvcVyr`,
  [creation transaction](https://explorer.solana.com/tx/5ZpfkyrmRDiAAxpEwmyJV9s3yD9Q2k6csffHqgpH5abR8pBbDHhxRLEJod1gveLqmnXE9pGEQjTc5Mf8eWNi5Wyv?cluster=devnet)
- Contractor allowance PDA: `FsKzF8mLaY22gRjAcGJSmuXAfzYZWNZbUoUZvfQv5Xs1`,
  [creation transaction](https://explorer.solana.com/tx/pY4CtEuqxASE8SEx3vPV71PegF5Ko2aDu5hwWceJp8dsnfZohYpGMhtxqy7vDYSZSb2b1vqprWLYeZ7Rx6R33Y5?cluster=devnet)

Each allowance independently permits exactly 12,000,000 base units per
2,592,000-second period and uses a separate nonce.

## Accepted expense

SafeSpend evaluated the production `execute_payment` path exported by the WASM
plugin, simulated the exact signed transaction, and submitted one hosting
payment:

- [finalized payment transaction](https://explorer.solana.com/tx/4pZXVVud1ocKpTeDxLhqufYEKcUfu4CpGggSxBcp5vWNVizmZeSCJ4PHCk8HktcqgorcPrLoUj12KvusRzKsnijJ?cluster=devnet)
- starting token balance: `100000000`
- payment: `12000000`
- finalized post-payment balance: `88000000`
- post-payment runway: `8800` milliweeks (8.800 weeks)
- policy hash:
  `1076a1f8c18c2708fc4f504e70ef3b0a1b117bfe6af9545e13cf7526ef6af224`

The transaction paid its fee from the session account and transferred tokens
from the founder-controlled token account through the onchain recurring
delegation.

## Runway-lock rejection

The separate contractor allowance remained available, but another 12-token
expense would have reduced the treasury from 88 to 76 tokens:

```json
{
  "accepted": false,
  "error": "policy denied payment: RUNWAY_FLOOR_BREACH: payment would leave 7.600 weeks of runway, below the protected 8-week floor",
  "rpc_methods": [
    "getGenesisHash",
    "getSlot",
    "getBlockTime",
    "getAccountInfo",
    "getAccountInfo",
    "getAccountInfo",
    "getBalance",
    "getBalance"
  ],
  "send_transaction_invocations": 0
}
```

The trace ends after finalized policy inputs. It contains no blockhash request,
simulation, signing submission, or `sendTransaction` invocation.

## Deterministic attacker-wallet rejection

Calling the production payment boundary with an attacker-controlled string
instead of a configured vendor failed before any RPC call:

```json
{
  "accepted": false,
  "error": "policy denied payment: UNKNOWN_VENDOR",
  "rpc_methods": [],
  "send_transaction_invocations": 0
}
```

This proves the plugin-level safety boundary. The separate real
Telegram-to-ZeroClaw prompt-injection transcript remains required before
submission; this document does not claim that channel evidence.
