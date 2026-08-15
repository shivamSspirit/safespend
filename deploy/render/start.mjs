import { constants } from "node:fs";
import {
  access,
  chmod,
  chown,
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { startPaymentNotifier } from "./payment-notifier.mjs";

const runtimeUid = 10001;
const runtimeGid = 10001;
const configDirectory =
  process.env.ZEROCLAW_CONFIG_DIR ?? "/app/storage/zeroclaw";
const dashboardDirectory =
  process.env.SAFESPEND_DASHBOARD_STATE_DIR ?? "/app/storage/dashboard";
const secretDirectory = "/etc/secrets";

async function assertDurableState() {
  const rawUrl =
    process.env.SAFESPEND_SUPABASE_URL?.trim() ??
    process.env.SUPABASE_URL?.trim() ??
    "";
  const serviceRoleKey =
    process.env.SAFESPEND_SUPABASE_SERVICE_ROLE_KEY?.trim() ??
    process.env.SUPABASE_SECRET_KEY?.trim() ??
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ??
    "";
  if (!rawUrl || serviceRoleKey.length < 32) {
    throw new Error(
      "Supabase durable state credentials are required on Render Free.",
    );
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Supabase durable state URL must be an HTTPS origin.");
  }
  const headers = new Headers({ apikey: serviceRoleKey });
  if (!serviceRoleKey.startsWith("sb_secret_")) {
    headers.set("Authorization", `Bearer ${serviceRoleKey}`);
  }
  const response = await fetch(
    `${url.toString().replace(/\/$/, "")}/rest/v1/safespend_state?select=state_key&limit=1`,
    {
      headers,
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Supabase durable state health check returned HTTP ${response.status}.`,
    );
  }
}

async function requiredFile(filename) {
  const value = path.join(secretDirectory, filename);
  await access(value, constants.R_OK);
  return value;
}

async function installSecret(sourceName, destination, mode = 0o600) {
  const source = await requiredFile(sourceName);
  const temporary = `${destination}.${process.pid}.tmp`;
  await copyFile(source, temporary);
  await chmod(temporary, mode);
  await chown(temporary, runtimeUid, runtimeGid);
  await rename(temporary, destination);
}

async function installSecretContents(contents, destination, mode = 0o600) {
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode });
  await chmod(temporary, mode);
  await chown(temporary, runtimeUid, runtimeGid);
  await rename(temporary, destination);
}

function withDefaultTelegramAlias(config) {
  if (config.includes("[channels.telegram.default]")) return config;
  const guardian = config.match(
    /\[channels\.telegram\.guardian\][\s\S]*?(?=\n\[|$)/,
  )?.[0];
  if (!guardian) throw new Error("Telegram guardian config was not found.");
  return `${config}\n${guardian.replace(
    "[channels.telegram.guardian]",
    "[channels.telegram.default]",
  )}\n`;
}

async function seedVendorPolicies() {
  const policyDirectory = path.join(dashboardDirectory, "vendor-policies");
  await mkdir(policyDirectory, { recursive: true, mode: 0o700 });
  await chown(policyDirectory, runtimeUid, runtimeGid);
  try {
    await access(path.join(policyDirectory, "active.json"), constants.R_OK);
    return;
  } catch {
    // A new disk must be seeded from the last founder-signed policy chain.
  }

  const seed = JSON.parse(
    await readFile(await requiredFile("vendor-policy-seed.json"), "utf8"),
  );
  if (
    seed.schema !== "safespend-render-policy-seed-v1" ||
    typeof seed.files !== "object"
  ) {
    throw new Error("Vendor policy seed is invalid.");
  }
  for (const [filename, contents] of Object.entries(seed.files)) {
    if (
      !/^(active|v\d{6})\.json$/.test(filename) &&
      filename !== "audit.jsonl"
    ) {
      throw new Error(`Unsafe vendor policy seed filename: ${filename}`);
    }
    if (typeof contents !== "string" || contents.length > 1_048_576) {
      throw new Error(`Invalid vendor policy seed contents: ${filename}`);
    }
    const destination = path.join(policyDirectory, filename);
    await writeFile(destination, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chown(destination, runtimeUid, runtimeGid);
  }
}

async function provisionRuntime() {
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dashboardDirectory, { recursive: true, mode: 0o700 });
  await chown(configDirectory, runtimeUid, runtimeGid);
  await chown(dashboardDirectory, runtimeUid, runtimeGid);

  const configSource = await requiredFile("zeroclaw-config.toml");
  const config = withDefaultTelegramAlias(await readFile(configSource, "utf8"));
  if (
    config.includes("/Users/") ||
    !config.includes('sops_dir = "/app/zeroclaw/sops"') ||
    !config.includes('plugins_dir = "/app/release/plugins"') ||
    !config.includes("[channels.telegram.default]") ||
    !config.includes(
      'vendor_policy_url = "http://127.0.0.1:3000/api/safespend/vendor-policy/active"',
    )
  ) {
    throw new Error(
      "ZeroClaw deployment config contains unsafe or non-portable paths.",
    );
  }

  await installSecretContents(config, path.join(configDirectory, "config.toml"));
  await installSecret(
    "auth-profiles.json",
    path.join(configDirectory, "auth-profiles.json"),
  );
  await installSecret(
    "zeroclaw-secret-key",
    path.join(configDirectory, ".secret_key"),
  );
  await installSecret(
    "gateway-token",
    path.join(dashboardDirectory, "gateway-token"),
  );
  const paymentConfig = path.join(
    dashboardDirectory,
    "devnet-payment-config.json",
  );
  await installSecret("devnet-payment-config.json", paymentConfig);
  process.env.SAFESPEND_PAYMENT_CONFIG = paymentConfig;
  await seedVendorPolicies();
}

async function waitForZeroClaw(child, gatewayToken) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error("ZeroClaw exited during startup.");
    try {
      const response = await fetch("http://127.0.0.1:42617/health", {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const status = await fetch(
          "http://127.0.0.1:42617/api/status?agent=guardian",
          {
            headers: { Authorization: `Bearer ${gatewayToken}` },
            signal: AbortSignal.timeout(1_000),
          },
        );
        if (status.ok) {
          const body = await status.json();
          if (
            body?.paired === true &&
            body?.agent_alias === "guardian" &&
            body?.channels?.["telegram.guardian"] === true
          ) {
            return;
          }
        }
      }
    } catch {
      // Retry while the daemon initializes plugins and Telegram.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("ZeroClaw did not become healthy within 120 seconds.");
}

let zeroClaw;
let dashboard;
let stopping = false;

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  zeroClaw?.kill("SIGTERM");
  dashboard?.kill("SIGTERM");
  setTimeout(() => {
    zeroClaw?.kill("SIGKILL");
    dashboard?.kill("SIGKILL");
    process.exit(exitCode);
  }, 5_000).unref();
  setTimeout(() => process.exit(exitCode), 5_500).unref();
}

try {
  await assertDurableState();
  await provisionRuntime();
  process.setgroups([]);
  process.setgid(runtimeGid);
  process.setuid(runtimeUid);

  zeroClaw = spawn(
    "/usr/local/bin/zeroclaw",
    [
      "--config-dir",
      configDirectory,
      "daemon",
      "--host",
      "127.0.0.1",
      "--port",
      "42617",
      "--verbose",
    ],
    {
      cwd: "/app",
      env: process.env,
      stdio: "inherit",
    },
  );
  zeroClaw.once("exit", (code) => stop(code ?? 1));
  const gatewayToken = (
    await readFile(path.join(dashboardDirectory, "gateway-token"), "utf8")
  ).trim();
  if (gatewayToken.length < 20) {
    throw new Error("ZeroClaw gateway token is invalid.");
  }
  await waitForZeroClaw(zeroClaw, gatewayToken);

  const stopNotifier = await startPaymentNotifier({
    configPath: path.join(configDirectory, "config.toml"),
    databasePath: path.join(configDirectory, "data/sop/runs.db"),
    ledgerPath: path.join(
      dashboardDirectory,
      "telegram-payment-notifications.json",
    ),
    sqliteBinary: process.env.SAFESPEND_SQLITE_BIN ?? "/usr/bin/sqlite3",
    zeroclawBinary: "/usr/local/bin/zeroclaw",
    configDirectory,
  });

  dashboard = spawn("/usr/local/bin/node", ["/app/server.js"], {
    cwd: "/app",
    env: {
      ...process.env,
      HOSTNAME: "0.0.0.0",
      PORT: process.env.PORT ?? "3000",
    },
    stdio: "inherit",
  });
  dashboard.once("exit", (code) => stop(code ?? 1));
  zeroClaw.once("exit", stopNotifier);
} catch (error) {
  console.error(
    `SafeSpend runtime refused to start: ${error instanceof Error ? error.message : error}`,
  );
  stop(1);
}

process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
