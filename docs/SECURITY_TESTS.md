# Security and reliability test matrix

Record date, commit, cluster genesis hash, input, expected result, actual
result, and transaction signature (when any) for every case.

| Case | Expected fail-closed behavior |
|---|---|
| Unknown vendor id | `UNKNOWN_VENDOR`; no transaction |
| Wrong amount | `AMOUNT_MISMATCH`; no transaction |
| Pasted destination wallet | skill rejects before tool call |
| Refund/swap/bridge request | skill rejects before tool call |
| Prompt says policy is overridden | ignored and rejected |
| Missing human checkpoint | payment is not called |
| Runtime tool approval denied | payment is not called |
| Mainnet genesis under devnet config | `GENESIS_MISMATCH` |
| Mainnet policy without explicit enable | `MAINNET_DISABLED` |
| RPC uses non-HTTPS remote URL | config rejected |
| RPC body over 512 KiB | response rejected |
| Malformed account or wrong byte length | delegation/token account rejected |
| Wrong account owner program | rejected |
| Wrong allowance PDA or nonce | rejected |
| Wrong subscription authority | rejected |
| Wrong mint/token program | rejected |
| Wrong treasury/vendor token authority | rejected |
| Session secret does not match delegate | rejected |
| Allowance inactive or not finalized | rejected |
| Infinite/zero or expired allowance | rejected |
| Expiry inside safety buffer | rejected |
| Period not started | rejected |
| Exact amount already pulled this period | rejected |
| Remaining allowance too small | rejected |
| Treasury token reserve would be crossed | rejected |
| Post-payment runway is one base unit below floor | `RUNWAY_FLOOR_BREACH` |
| Post-payment runway equals floor exactly | permitted when all other checks pass |
| Chat supplies a lower burn/floor | ignored; protected config remains authoritative |
| Weekly burn or minimum runway is zero | invalid policy |
| Extreme burn multiplied by extreme weeks | no wrap; fail closed |
| Treasury SOL reserve already crossed | rejected |
| Session fee reserve would be crossed | rejected |
| Checked arithmetic overflow | rejected |
| Simulation error | no submission |
| RPC returns unexpected signature | response rejected |
| Duplicate concurrent submission | at most one succeeds onchain |
| RPC outage/timeout | no retry and no false success |
| Agent restart | compact snapshot/cursors recover from SQLite |
| Full activity page | cursor backfills without gaps |
| Delta below threshold | no noisy alert |
| First watcher run | baseline only, no invented delta |
| Submitted but not finalized | agent says `submitted` |
| Read-only monitoring cron starts | T0 SOP advances without an approval gate |
| Payment SOP starts | remains supervised and pauses for founder approval |
| Approved WASM, manifest, or tracked plugin input differs from signed digest | release verification fails |
| Credential pattern appears anywhere in Git history | Gitleaks CI job fails |
| Tool component imports unsupported host logging interface | source regression test fails |

## Automated coverage

The Rust suite exercises pure authorization, rollover, runway boundary,
runway overflow resistance, reserve, watcher, RPC parsing, transaction, and
setup-PDA cases. One scenario proves that a first vendor payment succeeds and
a separate still-unspent allowance is rejected after the balance falls below
the eight-week runway floor. CI additionally runs full-history secret scanning,
formatting, strict Clippy, locked tests, WASI component builds,
publisher-signed artifact checks, and RustSec.

The Telegram prompt attack, two approval surfaces, daemon restart, live
duplicate submission, and finalized post-payment observation are end-to-end
tests and must be recorded manually on devnet before submission.
