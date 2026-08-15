# Vercel + Render deployment

SafeSpend uses a split deployment:

- **Vercel** serves the stateless founder dashboard and protects it with founder HTTP
  authentication.
- **Render Free** runs the dashboard API and the pinned ZeroClaw daemon in one container.
- **Supabase Free** stores signed vendor policies, short-lived vendor proposals, payment activity,
  and Telegram notification receipts. Render's local ZeroClaw SQLite store is operational scratch
  state only and may disappear when the free container sleeps.
- The Vercel server authenticates to Render with a separate 256-bit bearer token. Render rejects
  direct public API calls.

Neither host receives the founder wallet key. The browser wallet signs vendor-policy transactions
locally. Render needs only the already-bounded Devnet session key contained in the ZeroClaw secret
configuration.

## 1. Prepare Render secrets

Create a Supabase Free project and run [`deploy/render/supabase.sql`](../deploy/render/supabase.sql)
once in its SQL editor. Keep the project URL and service-role key server-only; the browser and
Vercel deployment never receive them.

From the repository root, run:

```bash
node deploy/render/prepare-secrets.mjs
```

The ignored `deploy/render/.secrets/` directory will contain:

- `zeroclaw-config.toml`
- `auth-profiles.json`
- `zeroclaw-secret-key`
- `devnet-payment-config.json`
- `gateway-token`
- `vendor-policy-seed.json`
- `frontend-proxy-token.txt`
- `dashboard-password.txt`

The preparation script never reads or copies a founder wallet key. Treat the directory as secret
material and do not commit it.

## 2. Create the Render service

In Render, create or update the service from this repository. `render.yaml` configures the free
Docker service in Oregon. Set these server-only environment variables:

| Variable                         | Value                                  |
| -------------------------------- | -------------------------------------- |
| `SUPABASE_URL`                   | Supabase project HTTPS URL             |
| `SUPABASE_SECRET_KEY`            | Supabase server secret (`sb_secret_…`) |
| `SAFESPEND_FRONTEND_PROXY_TOKEN` | Contents of `frontend-proxy-token.txt` |

Then add these Render **secret files** using the exact filenames shown:

| Secret filename              | Local source                                        |
| ---------------------------- | --------------------------------------------------- |
| `zeroclaw-config.toml`       | `deploy/render/.secrets/zeroclaw-config.toml`       |
| `auth-profiles.json`         | `deploy/render/.secrets/auth-profiles.json`         |
| `zeroclaw-secret-key`        | `deploy/render/.secrets/zeroclaw-secret-key`        |
| `devnet-payment-config.json` | `deploy/render/.secrets/devnet-payment-config.json` |
| `gateway-token`              | `deploy/render/.secrets/gateway-token`              |
| `vendor-policy-seed.json`    | `deploy/render/.secrets/vendor-policy-seed.json`    |

Deploy the service and wait for `/api/health` to return HTTP 200. Copy the final HTTPS service
origin, for example `https://safespend-runtime-xxxx.onrender.com`.

Startup fails if Supabase is missing or unreachable. It never silently falls back to Render's
ephemeral filesystem in the hosted runtime. Local development continues to use the ignored
`dashboard/.safespend/` directory without requiring Supabase.

The publishable key and JWKS URL are not used by this server-only store. SafeSpend also accepts the
legacy `SUPABASE_SERVICE_ROLE_KEY`, but new deployments should use `SUPABASE_SECRET_KEY`.

The first Docker build compiles the pinned ZeroClaw revision and can take several minutes. Startup
fails closed if a required secret is missing, if a local macOS path leaked into the uploaded
configuration, or if ZeroClaw is unhealthy.

## 3. Deploy the dashboard to Vercel

Create a Vercel project whose root directory is `dashboard`. Add these Production, Preview, and
Development environment variables:

| Variable                       | Value                                    |
| ------------------------------ | ---------------------------------------- |
| `SAFESPEND_BACKEND_ORIGIN`     | The Render HTTPS origin, with no path    |
| `SAFESPEND_BACKEND_TOKEN`      | Contents of `frontend-proxy-token.txt`   |
| `SAFESPEND_DASHBOARD_USER`     | `founder` or another non-secret username |
| `SAFESPEND_DASHBOARD_PASSWORD` | Contents of `dashboard-password.txt`     |

Deploy. Opening the Vercel URL presents browser authentication before any dashboard page or API is
served. The founder wallet still signs in the browser; the wallet key never enters a Vercel or
Render environment variable.

## 4. Production checks

Run all of these before using the hosted payment flow:

1. Open the Vercel URL in a private browser and confirm the authentication challenge appears.
2. Confirm the dashboard connects to the intended founder wallet and shows the on-chain Devnet SOL
   and token balances.
3. Add a small test vendor and verify the delegation reaches `finalized` before activation.
4. Start a small payment and verify both the SOP gate and Telegram approval are required.
   After the second approval, verify Telegram receives the submitted transaction signature even
   though the request originated in the Vercel dashboard.
5. Call the Render `/api/safespend/bootstrap` URL directly and confirm it returns HTTP 403.
6. Let Render sleep or restart it, then confirm vendor policy history and activity are restored
   from Supabase.

Rotate the frontend proxy token, dashboard password, gateway pairing material, and session key if
`deploy/render/.secrets/` is ever exposed. Never upload
`/Users/shivamsoni/.safespend-devnet-keys/founder.json`.
