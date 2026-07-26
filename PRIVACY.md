# SafeSpend Privacy Notice

Effective date: 26 July 2026

SafeSpend is self-hosted software. The project maintainers do not operate a
hosted SafeSpend service and do not receive a deployment's Telegram messages,
wallet configuration, model prompts, credentials, or local agent records by
default. The person or organization operating a deployment is responsible for
its data practices and is normally the controller of the personal data it
chooses to process.

This notice describes the data surfaces in the open-source project. It is not
legal advice, and an operator may need a deployment-specific notice, consent
flow, retention schedule, and data-processing agreements.

## Data a deployment may process

- Telegram user, chat, and message identifiers and the content sent to the
  founder agent.
- Solana wallet addresses, token accounts, balances, transaction signatures,
  and finalized transaction history. Public blockchain data is public.
- Protected policy settings such as approved recipients, expense amounts,
  runway floors, and alert preferences.
- Local ZeroClaw memory, SOP state, approval records, and operational logs.
- Request metadata sent to the operator's chosen Telegram, model, and Solana
  RPC providers.
- Credentials supplied by the operator. SafeSpend does not require the founder
  treasury private key. Provider tokens and the narrowly funded session key
  must remain outside the repository and must not be sent to the maintainers.

## Why the data is used

A deployment uses this data to answer the founder, monitor treasury state,
evaluate runway and allowance policy, request human approval, prepare or
execute a bounded vendor payment, and retain an operational audit trail.
SafeSpend does not include advertising, cross-site tracking, or sale of
personal information.

## Where data is stored and disclosed

ZeroClaw configuration, memory, SOP state, and logs are stored in the
operator-controlled environment according to that installation's settings.
Data is also disclosed to the providers the operator configures, including
Telegram, a model provider, and a Solana RPC provider. Those providers apply
their own terms and retention policies.

Wallet addresses and confirmed transactions submitted to Solana become part
of a public, replicated ledger. They should be treated as permanent and
publicly linkable.

## Retention, deletion, and individual rights

The deployment operator chooses local retention and is responsible for
honoring applicable access, correction, deletion, portability, and objection
requests. An operator can remove local messages, memory, logs, and
configuration under its control, subject to its backup policy. Confirmed
blockchain records cannot be removed by SafeSpend.

Contact the operator of the deployment for requests about runtime data. The
open-source maintainers cannot access or delete deployment data they never
received. Repository interactions hosted by GitHub are governed by GitHub's
privacy terms.

## Security

SafeSpend is designed to keep the founder treasury key outside the agent,
separate natural-language input from protected policy, restrict tools, require
approval, verify signed plugins, and fail closed on policy or RPC uncertainty.
No system is perfectly secure. The project is devnet-first and must not be
treated as audited mainnet custody software.

## Children

SafeSpend is business treasury software and is not directed to children.

## Changes and contact

Material changes will be recorded in this repository. For a security issue,
follow [SECURITY.md](SECURITY.md). For privacy questions about the open-source
project, open a GitHub discussion or contact the maintainer privately through
the security-reporting route. Do not place credentials, private keys, personal
messages, or sensitive transaction context in a public issue.
