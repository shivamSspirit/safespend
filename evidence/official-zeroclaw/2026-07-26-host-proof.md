# Official ZeroClaw host proof

Date: 2026-07-26

This record distinguishes host/plugin-boundary evidence from the still-pending
Telegram demonstration. It contains no runtime credential or private key.

## Provenance

- SafeSpend repository: `https://github.com/shivamSspirit/safespend`
- Pinned upstream ZeroClaw commit:
  `f3023663a08f668dcec60c8d6d6db7777c86955a`
- Public successful build:
  `https://github.com/shivamSspirit/safespend/actions/runs/30205115470`
- Workflow artifact: `safespend-official-zeroclaw-macos-arm64`
- Official host version: `zeroclaw 0.8.3`
- Downloaded host SHA-256:
  `4db3479275e439caca306878c72e727819d900418997d80b86504bea177774c5`

The host was compiled from the pinned official ZeroClaw source with
`agent-runtime`, `channel-telegram`, and `plugins-wasm-cranelift`.

## Strict plugin discovery

With a mode-`0600` local config, `signature_mode = "strict"`, exactly one
trusted publisher, and `plugins_dir` set to the committed reviewed package:

```text
Installed plugins:
  safespend-treasury-watch v0.1.0 — Read-only founder treasury runway, protected floor, and meaningful-change summary
  safespend-allowance-pay v0.1.0 — Runway-locked business expense through a capped Solana recurring allowance
```

Plugin inspection reported only `ConfigRead` and `HttpClient` permissions for
both components. It resolved the WASM files from `release/plugins/`, not the
unsigned build-candidate directory.

## Active security posture

The official host reported:

```text
Agent: guardian
Autonomy: supervised
Approvals: medium-risk approval required: true, high-risk commands blocked: true
Sandbox: active sandbox-exec
Workspace only: true
Environment passthrough: 0
Credential encryption: true
Gateway: loopback, pairing required, public bind false
Warnings: none
```

The official quick self-test passed all nine checks: config, workspace, SQLite,
providers, tools, channels, security, version, and web distribution.

## Real agent-to-plugin execution

The official CLI agent used an imported local Codex OAuth profile from
ZeroClaw's encrypted auth store. Its risk profile allowed only the read-only
watcher. The agent made one real tool call against finalized Solana devnet
state:

```text
tool: safespend_treasury_watch
outcome: success
duration: 1712 ms
finalized slot: 479047581
token balance: 88000000 base units
SOL balance: 1986028040 lamports
runway: 8800 milliweeks
alerts: []
```

The agent's concise response was:

```text
Current SafeSpend treasury status:
- Finalized slot: 479,047,581
- SOL balance: 1.98602804 SOL
- Token balance: 88,000,000 base units
- Calculated runway: 8.8 weeks
- Alerts: none
```

This run exposed and closed an integration defect before recording: the
upstream experimental tool world declared a logging import that the pinned
host failed to link. SafeSpend now uses a minimal, explicit compatibility world
with the same tool exports and no logging import. A regression test prevents
either component from silently reintroducing that import. The first rejected
cursor shape also led to an exact nested cursor schema, reducing malformed model
calls.

## Evidence boundary

This proves that the pinned official ZeroClaw host builds, validates its
security profile, enforces strict publisher discovery, recognizes the real
SafeSpend WASM tools, and executes the read-only watcher through the real agent
loop against Solana devnet. It does not prove a Telegram invocation. That row
remains pending until a Telegram bot token is configured and a sanitized
end-to-end transcript/video is recorded.
