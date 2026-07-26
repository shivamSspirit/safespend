# Devnet demo reset and session rotation — 2026-07-26

This record documents the isolated state prepared for the final Telegram
recording. It contains only public devnet identifiers.

## Why the state was rotated

A local attempt to automate ZeroClaw's interactive secret enrollment sent the
devnet session credential before pseudo-terminal echo was disabled. SafeSpend
treated the credential as compromised immediately. No founder key, Telegram
token, mainnet credential, or real asset was involved.

Containment was fail-closed:

1. all 100 valueless demonstration tokens in the affected treasury token
   account were burned;
2. the affected session's remaining devnet SOL was returned to the founder;
3. the affected token account and session were verified at zero;
4. the exact affected local key file was deleted; and
5. a new token account, fee-only session, and two new allowances were created.

The retired allowances still exist as immutable devnet history, but point to a
token account with a zero balance.

## Public containment transactions

- Burn retired account balance:
  [transaction](https://explorer.solana.com/tx/2B5CGdUXdJ3giBo4zEUn7KHqimagfX5dcc8KUugeJGgaVAXoRFce1Z5vY4KXvBzmXtMjtBhaEyuZv2WLH3LYxPEF?cluster=devnet)
- Create replacement token account:
  [transaction](https://explorer.solana.com/tx/4wMnoosd5DR8Rny3TUZhBRCqR7N1mspU3hP1d178XxfkJCU8dxzewAXNeatCYh77jsPZFxC8TZgYmLT4AifmjUws?cluster=devnet)
- Mint 100 replacement demonstration tokens:
  [transaction](https://explorer.solana.com/tx/4asuq2Qt47zbBMaT2aL26rACbYbYvV4bbvnUV6DChZLuWxAs5VCWkzxQwXA8Posa1n4247wqib2CR25gpsgLa3v3?cluster=devnet)
- Fund replacement session with fee SOL only:
  [transaction](https://explorer.solana.com/tx/4RWxbJNs7QVmoMyKwxDFNRW89vYtncSA658eCJtDVKf5abcyo2bw1RMYtD3UjWvwpdbx3eyvpUKg3TvEDM4sWagD?cluster=devnet)
- Evacuate retired session SOL:
  [transaction](https://explorer.solana.com/tx/nvKTHFJpxy3MHJp3iLLYopYdNALRQf2kyDurqEVF9xmkPGtHq6AXWUhS4HUmyNGpaaGgvVBNCTN8PPfnMa3JsvF?cluster=devnet)

## Replacement state

- Treasury owner:
  `DRbmdbC1evqHeJuUBwKizD1aerNUTi9KEfYEhJm1SJZH`
- Demonstration mint:
  `8wPJRcU2sztbsvK6QG2CvokVmf1444AzHn26GnwFfti1`
- Replacement treasury token account:
  `8DwFQ3rJNNP9Md14U1Dkwf1EyZnGpJTBuwMG4bAuciAx`
- Replacement session delegate:
  `A6ryZKh5TdixkZXCGKmyseYNjCJKtZkXVSeRefuRTzf5`
- Starting token balance: `100000000` base units
- Protected weekly burn: `10000000` base units
- Protected minimum runway: eight weeks
- Starting calculated runway: 10 weeks

The replacement session key file is outside the repository with mode `0600`.
Its secret value is not recorded here.

## Fresh independent allowances

- Hosting, nonce 5, PDA:
  `FSPggixBusjWMQWEij2AM3btrvzzjDx4dXVuhJg3K9kk`,
  [creation transaction](https://explorer.solana.com/tx/5yjdaqViGS9GzyaBSM1GXs9TZxyjHRfohCtjrd8rcfqxDDK7PHEY6T8LPWUapa6ZnR8QmbyN4kHXzxCo7Ub5myXy?cluster=devnet)
- Contractor, nonce 6, PDA:
  `4YH67JVFM6r2KmZM4sjpf3BdkZBvXPfEh6JFUGsomKiG`,
  [creation transaction](https://explorer.solana.com/tx/RHBy4QwWQi1cad3VeJMtosq6URgWRAx41ZRUWFPR7GRqPJzbqie9bivDfygmqbQyfhsr3i9XxSgtccSkigwYV4D?cluster=devnet)

Each independently permits exactly 12,000,000 base units per 2,592,000-second
period. Neither had been spent when this record was created.

## Validation after rotation

The downloaded helper hashes matched the public macOS workflow artifact. The
production payment boundary parsed the replacement key and rejected an unknown
vendor before any RPC call:

```json
{
  "accepted": false,
  "error": "policy denied payment: UNKNOWN_VENDOR",
  "rpc_methods": [],
  "send_transaction_invocations": 0
}
```

The pinned official ZeroClaw agent then called the real watcher against
finalized devnet state and reported:

```text
Finalized token balance: 100000000 base units
SOL balance: 1974501000 lamports
Runway: 10 weeks
Alerts: none
```

Telegram remains disabled until its user-owned BotFather token is enrolled
manually through the masked prompt and founder-only pairing is completed.
