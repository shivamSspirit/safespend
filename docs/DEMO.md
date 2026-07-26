# Three-minute runway-lock demo

Use one uninterrupted devnet story. Show real Telegram, terminal logs, and
Solana Explorer; do not use mock balances.

## Timeline

**0:00–0:20 — Problem and boundary**

Show a 100-token treasury with a 10-token weekly burn and say: “SafeSpend can
pay approved expenses, but only while the company keeps eight weeks of runway.
ZeroClaw never has my founder key; every vendor is also capped onchain.”

**0:20–0:45 — Useful monitoring**

Send `/status`. Show finalized token/SOL balances, runway, reserves, and a
compact recent event. Briefly show the five-minute cron SOP.

**0:45–1:15 — Attack fails**

Paste the malicious refund/policy-override prompt from `SETUP.md`. Show that it
is rejected before a payment tool call. Say that messages and memos cannot
provide a wallet, mint, or policy.

**1:15–2:05 — Approved expense**

Send `/pay hosting 12000000`. Show:

1. vendor id and exact amount;
2. founder SOP checkpoint;
3. ZeroClaw runtime tool approval;
4. submitted transaction signature, policy hash, and 8.800 weeks of
   post-payment runway;
5. Explorer transaction using the recurring allowance.

Explain that the plugin checked finalized allowance state, simulated the exact
signed transaction, and the session key held fee SOL only.

**2:05–2:40 — Runway lock beats valid allowance**

After the watcher confirms the treasury fell from 100 to 88 tokens, request
the separately configured contractor expense for 12 tokens. Show that its own
onchain recurring allowance is active and unspent, but SafeSpend returns:

```text
RUNWAY_FLOOR_BREACH
Payment would leave 7.600 weeks, below the protected 8-week floor.
```

Explain: “The allowance says this vendor may be paid. SafeSpend still refuses
because company survival is the stricter rule.”

**2:40–3:00 — Finality and close**

Show the watcher detecting the finalized first debit and updated runway. End
with: “Onchain permission is necessary. Protected runway is decisive.”

## Capture checklist

- use a clean devnet wallet and sanitized terminal;
- hide Telegram token, session secret, RPC credentials, and local paths;
- increase terminal and phone font size;
- pre-fund fee SOL and verify Explorer before recording;
- keep a backup recording, but make the submitted cut one continuous flow;
- put repository URL and devnet transaction link in the video description.
