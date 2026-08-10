# Vercel + Render deployment

SafeSpend uses a split deployment:

- **Vercel** serves the stateless founder dashboard and protects it with founder HTTP
  authentication.
- **Render** runs the dashboard API and the pinned ZeroClaw daemon in one container. A paid
  persistent disk stores signed vendor policies, payment requests, and ZeroClaw SQLite state.
- The Vercel server authenticates to Render with a separate 256-bit bearer token. Render rejects
  direct public API calls.

Neither host receives the founder wallet key. The browser wallet signs vendor-policy transactions
locally. Render needs only the already-bounded Devnet session key contained in the ZeroClaw secret
configuration.

## 1. Prepare Render secrets

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

## 2. Create the Render Blueprint

In Render, create a Blueprint from this repository. Render discovers `render.yaml` and creates the
`safespend-runtime` Docker web service with a 1 GB persistent disk in Singapore.

Set `SAFESPEND_FRONTEND_PROXY_TOKEN` to the exact contents of
`frontend-proxy-token.txt`. Then add these Render **secret files** using the exact filenames shown:

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
5. Call the Render `/api/safespend/bootstrap` URL directly and confirm it returns HTTP 403.
6. Restart the Render service and confirm vendor policy history and activity survive on the disk.

Rotate the frontend proxy token, dashboard password, gateway pairing material, and session key if
`deploy/render/.secrets/` is ever exposed. Never upload
`/Users/shivamsoni/.safespend-devnet-keys/founder.json`.
