# SafeSpend founder dashboard

Next.js App Router dashboard connected to the real SafeSpend ZeroClaw runtime and Solana Devnet.
Founders can begin from Telegram or the dashboard while sharing one SOP and onchain state machine:

1. Enroll a vendor by signing an immutable policy message and finite delegation in the founder
   wallet. The service never receives the founder key.
2. Wait for finalized delegation verification and atomic policy publication.
3. Create an approved-expense request for an active vendor.
4. Approve the SOP checkpoint and the separate payment tool invocation in Telegram.
5. Record success only after finalized confirmation.

There is no demo-data fallback. If ZeroClaw, the audit store, or Devnet cannot be read, the UI shows
that boundary as unavailable rather than substituting sample balances or transactions.

## Run locally

Start ZeroClaw from the repository root, then start Next.js in a second terminal. The guarded
launcher refuses to create a second Telegram channel runtime when the gateway port is already
occupied:

```bash
./scripts/run-zeroclaw-dev.sh
```

```bash
cd dashboard
npm install
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). If asked, enter the six-digit HTTP pairing code
printed by the daemon. Do not use one of the Telegram `/bind` codes.

## Verification

```bash
npm run format:check
npm run typecheck
npm run build
```

## Troubleshooting

- **`Address already in use`** — do not launch another daemon. Run
  `curl -sS http://127.0.0.1:42617/health` and use the existing healthy process, or stop it before
  restarting. The guarded launcher prevents this.
- **`SOP audit unavailable`** — confirm `/usr/bin/sqlite3` exists, or set `SAFESPEND_SQLITE_BIN` to
  an absolute SQLite CLI path before starting Next.js. Balance and policy state remain available in
  degraded mode.
- **Old failed runs in Activity** — these are retained audit records from earlier tests, not current
  runtime errors. The payment panel shows only an active request or a request started during the
  current browser session.
- **Transient Devnet RPC failure** — the dashboard keeps the last verified snapshot visible and
  offers Retry. Concurrent tabs share one cached bootstrap instead of multiplying RPC traffic.

## Data boundary

This is a T2 operation: the local ZeroClaw daemon can sign and submit payments with a limited Devnet
session key. For policy administration, the browser asks an injected founder wallet to sign the
exact public policy message and delegation transaction. The key remains in the wallet; the loopback
server receives only signed bytes and submits them to its pinned Devnet RPC. The server keeps the
gateway bearer, RPC URL, session key, Telegram bot token, and model credentials out of client
responses.

The dashboard accepts only an active founder-signed `vendorId` and exact allowance. It creates
`approved-expense` directly through the gateway, can clear that SOP checkpoint, and then routes the
separate `safespend_allowance_pay` approval to `telegram.guardian`. Missing Telegram, timeout,
malformed input, wrong network, wrong mint, wrong recipient, wrong allowance, or insufficient runway
fail closed.

Submission is not success. The server independently polls Solana RPC and reports `finalized` only
after it verifies the official Subscriptions program plus exact treasury and recipient token-account
deltas.

The local ZeroClaw SOP audit store is the source of truth for run attribution. This lets one
timeline show both dashboard- and Telegram-originated requests without guessing from vendor, amount,
or transaction time. A signature is attached only to the exact run whose payer step returned it.

The dashboard queries that SQLite store read-only through the operating system SQLite client,
avoiding Node native-addon ABI failures. On systems where it is not located at `/usr/bin/sqlite3`,
set `SAFESPEND_SQLITE_BIN` to an absolute SQLite CLI path. If the audit reader is unavailable,
balances remain usable but the dashboard visibly marks audit history as unavailable instead of
failing the entire bootstrap.

Idle dashboards poll every 15 seconds and active approvals every five seconds. A server-side cache
coalesces concurrent tabs, and finalized signatures are independently reverified once per server
process rather than on every refresh.

The request form also performs a finalized-state preflight. If the exact configured payment would
reuse a spent allowance period, use missing or mismatched delegation terms, expire inside the safety
window, breach the token reserve, SOL reserve, session fee reserve, or runway floor, the dashboard
blocks the SOP before either approval is requested. The API repeats that preflight so a browser
cannot bypass the disabled button. The payer plugin still repeats every protected check immediately
before submission.

See [SECURITY.md](./SECURITY.md) for trust boundaries and the prompt-injection test transcript.
