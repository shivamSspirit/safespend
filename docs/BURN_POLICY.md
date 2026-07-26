# Protected weekly-burn policy

SafeSpend calculates runway from an operator-owned
`weekly_burn_base_units`. The model cannot learn, lower, or replace this value
through Telegram. That stability is intentional because the value authorizes
payments.

The repository includes a read-only calibrator so the policy can be grounded
in finalized Solana history rather than chosen arbitrarily.

## Calculation

For a reviewed window:

```text
historical weekly burn
  = ceil(gross finalized token outflows × 7 / window days)

recommended protected burn
  = max(historical weekly burn, operator minimum)
```

Incoming transfers never offset spending. Failed transactions do not count.
Signatures are deduplicated, every evidence row retains its finalized slot and
block time, and the report includes a deterministic SHA-256 evidence digest.
If the bounded backfill cannot cover the full window, calibration fails rather
than underestimating burn.

## Run

Use the same canonical token account and mint configured in both plugins:

```bash
cargo run --locked -p safespend-burn-calibrator -- \
  --rpc https://api.mainnet-beta.solana.com \
  --token-account TREASURY_TOKEN_ACCOUNT \
  --mint CANONICAL_TOKEN_MINT \
  --window-days 28 \
  --minimum-weekly-burn 10000000 \
  --max-transactions 1000
```

Save the JSON report outside the public repository if publishing its outflow
rows would reveal sensitive vendor activity. Record the report digest, window,
recommended value, review date, and reviewer in the evidence index.

## Apply

After human review, set the same recommended value in:

- the watcher plugin's `weekly_burn_base_units`;
- the payment plugin's protected `policy_json`.

Restart ZeroClaw and verify `/status` displays the reviewed policy value. A
policy change invalidates the prior payment-policy hash. Never accept a
different burn value through chat.

## Operating cadence

Recalibrate monthly and after a material change in staffing, infrastructure, or
recurring expenses. The calibrator is advisory; a founder may deliberately set
a higher conservative minimum, but should never silently use a lower value
than the reviewed historical recommendation.
