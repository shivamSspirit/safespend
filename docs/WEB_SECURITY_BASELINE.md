# Future Web and Supabase Security Baseline

SafeSpend currently has no browser frontend, HTTP application server, API
routes, Supabase client, Postgres schema, or hosted user database. Therefore
there are no live browser headers or row-level-security policies to configure
in this repository today. This document is a release gate for any future web
surface; it must not be cited as proof that controls exist before that surface
is implemented and tested.

## Supabase and database gate

Before exposing any table, view, function, storage bucket, or realtime channel:

1. Enable row-level security on every object reachable by `anon` or
   `authenticated`. Begin with no policies, then add the minimum explicit
   operations required.
2. Scope every policy to authenticated ownership or a server-verified tenant.
   Test cross-user reads, writes, updates, deletes, RPC functions, joins,
   storage objects, and realtime subscriptions with two separate users.
3. Keep the service-role key on a trusted server only. It must never appear in
   browser bundles, mobile bundles, public configuration, logs, error
   responses, screenshots, or model context.
4. Treat a Supabase anonymous key as public and rely on correct RLS—not key
   secrecy—for authorization.
5. Validate authorization in database policy and server code. A hidden button
   or client-side wallet check is not an authorization boundary.
6. Add migration tests that fail if an exposed table lacks RLS or a policy
   accidentally grants unrestricted access.
7. Apply equivalent ownership policies to storage and restrict privileged SQL
   functions with explicit execution grants and a safe `search_path`.

No production release may proceed with an exposed table that has RLS disabled
or an untested permissive policy.

## Browser and HTTP gate

Set headers at the final public edge and verify them against the deployed URL:

- `Content-Security-Policy` using nonces or hashes, a minimal `connect-src`,
  `object-src 'none'`, `base-uri 'none'`, and `frame-ancestors 'none'`.
- `Strict-Transport-Security` in HTTPS production only, after confirming all
  subdomains are ready for the selected scope.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: no-referrer` or a documented, equally restrictive policy.
- A minimal `Permissions-Policy` that disables unused browser capabilities.
- `Cache-Control: no-store` on authenticated or sensitive responses.
- `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` where wallet
  and embedded-provider compatibility has been tested.

Do not use `unsafe-inline` or a wildcard source merely to silence a CSP error.
Do not advertise HSTS on a development HTTP origin.

## API and session gate

- Use an exact CORS origin allowlist; never combine credentialed requests with
  wildcard origins.
- Protect cookie-authenticated state changes against CSRF. Cookies must be
  `Secure`, `HttpOnly`, and use the narrowest workable `SameSite` setting.
- Validate types, lengths, enums, public keys, token mints, and numeric bounds
  at the server boundary. Ignore client-provided roles, owners, and policy
  limits.
- Rate-limit authentication, approval, payment, export, and expensive query
  paths. Return generic authentication errors.
- Redact tokens, cookies, authorization headers, prompts, Telegram content,
  personal data, and transaction signing material from logs and traces.
- Keep secrets in server-side runtime configuration. Variables with public
  frontend prefixes must contain public values only.
- Require reauthentication or an approval ceremony for security-sensitive
  changes. Record an immutable, privacy-aware audit event.

## Verification required before launch

- Automated anonymous, user, cross-user, and privileged database tests.
- A production bundle scan for credentials and private configuration.
- Secret scanning across complete Git history in CI.
- Deployed-header and TLS checks against the real hostname.
- Dependency and container scans for the deployed stack.
- Abuse tests for prompt injection, authorization bypass, replay, CSRF, CORS,
  caching, and log leakage.
- A deployment-specific privacy notice with operator identity, lawful basis,
  processors, retention periods, and a rights-request contact.
