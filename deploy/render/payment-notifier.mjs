import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const VENDOR_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_TRACKED_SIGNATURES = 500;

function querySqlite(sqliteBinary, databasePath) {
  const query =
    "SELECT json FROM sop_runs ORDER BY last_progress_at DESC LIMIT 100";
  return new Promise((resolve, reject) => {
    execFile(
      sqliteBinary,
      ["-readonly", "-json", databasePath, query],
      { encoding: "utf8", timeout: 3_000, maxBuffer: 4_000_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function submittedResult(value) {
  if (!value || typeof value !== "object" || value.status !== "submitted")
    return null;
  if (!SIGNATURE_PATTERN.test(value.signature ?? "")) return null;
  if (!VENDOR_PATTERN.test(value.vendor_id ?? "")) return null;
  const rawAmount = value.amount_base_units;
  const amount =
    typeof rawAmount === "string" && /^\d+$/.test(rawAmount)
      ? Number(rawAmount)
      : rawAmount;
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return {
    signature: value.signature,
    vendorId: value.vendor_id,
    amountBaseUnits: String(amount),
  };
}

export function projectSubmittedPayments(rows) {
  if (!Array.isArray(rows)) return [];
  const payments = [];
  for (const row of rows) {
    try {
      const stored = JSON.parse(row.json);
      const run = stored?.run;
      if (
        run?.sop_name !== "approved-expense" ||
        typeof run.run_id !== "string" ||
        run.run_id.length < 8 ||
        !Array.isArray(run.step_results)
      )
        continue;
      const outputs = [...run.step_results]
        .filter(
          (step) =>
            Number.isInteger(step?.step_number) &&
            typeof step?.output === "string",
        )
        .sort((left, right) => right.step_number - left.step_number);
      for (const step of outputs) {
        const payment = submittedResult(JSON.parse(step.output));
        if (payment) {
          payments.push({ ...payment, runId: run.run_id });
          break;
        }
      }
    } catch {
      // A malformed audit row cannot authorize a notification.
    }
  }
  return payments;
}

export function parseTelegramDelivery(config) {
  const route =
    config.match(
      /^request_route\s*=\s*"telegram\.guardian:([^"\s]+)"\s*$/m,
    )?.[1] ?? "";
  if (!/^-?\d{5,20}$/.test(route)) {
    throw new Error(
      "Telegram guardian chat ID is unavailable for payment notifications.",
    );
  }
  return { chatId: route };
}

function notificationText(payment) {
  return [
    "SafeSpend payment submitted",
    `Vendor: ${payment.vendorId}`,
    `Amount: ${payment.amountBaseUnits} base units`,
    `Transaction signature: ${payment.signature}`,
    `Explorer: https://explorer.solana.com/tx/${payment.signature}?cluster=devnet`,
  ].join("\n");
}

async function sendTelegram(
  delivery,
  payment,
  zeroclawBinary,
  configDirectory,
) {
  return new Promise((resolve, reject) => {
    execFile(
      zeroclawBinary,
      [
        "--config-dir",
        configDirectory,
        "channel",
        "send",
        notificationText(payment),
        "--channel-id",
        "telegram",
        "--recipient",
        delivery.chatId,
      ],
      { encoding: "utf8", timeout: 12_000, maxBuffer: 128_000 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

function remoteStateConfig() {
  const rawUrl =
    process.env.SAFESPEND_SUPABASE_URL?.trim() ??
    process.env.SUPABASE_URL?.trim() ??
    "";
  const serviceRoleKey =
    process.env.SAFESPEND_SUPABASE_SERVICE_ROLE_KEY?.trim() ??
    process.env.SUPABASE_SECRET_KEY?.trim() ??
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ??
    "";
  if (!rawUrl || serviceRoleKey.length < 32) return null;
  return { url: rawUrl.replace(/\/$/, ""), serviceRoleKey };
}

async function remoteStateRequest(config, pathname, init) {
  const headers = new Headers(init?.headers);
  headers.set("apikey", config.serviceRoleKey);
  if (!config.serviceRoleKey.startsWith("sb_secret_")) {
    headers.set("Authorization", `Bearer ${config.serviceRoleKey}`);
  }
  if (init?.body) headers.set("Content-Type", "application/json");
  return fetch(`${config.url}/rest/v1/safespend_state${pathname}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(8_000),
  });
}

async function readLedger(ledgerPath) {
  try {
    const remote = remoteStateConfig();
    let value;
    if (remote) {
      const response = await remoteStateRequest(
        remote,
        "?state_key=eq.notifications%2Ftelegram-payments&select=state_value",
      );
      if (!response.ok)
        throw new Error(`durable state returned HTTP ${response.status}`);
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length > 1)
        throw new Error("invalid durable state rows");
      if (!rows[0]) return null;
      value = rows[0].state_value;
    } else {
      value = JSON.parse(await readFile(ledgerPath, "utf8"));
    }
    if (value?.version !== 1 || !Array.isArray(value.signatures))
      throw new Error();
    return new Set(
      value.signatures.filter((signature) => SIGNATURE_PATTERN.test(signature)),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(
      "Payment notification ledger is invalid; refusing duplicate delivery.",
    );
  }
}

async function writeLedger(ledgerPath, signatures) {
  const values = [...signatures].slice(-MAX_TRACKED_SIGNATURES);
  const value = { version: 1, signatures: values };
  const remote = remoteStateConfig();
  if (remote) {
    const response = await remoteStateRequest(
      remote,
      "?on_conflict=state_key",
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          state_key: "notifications/telegram-payments",
          state_value: value,
        }),
      },
    );
    if (!response.ok)
      throw new Error(`durable state returned HTTP ${response.status}`);
    return;
  }
  await mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const temporary = `${ledgerPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, ledgerPath);
}

export async function startPaymentNotifier({
  configPath,
  databasePath,
  ledgerPath,
  sqliteBinary = "/usr/bin/sqlite3",
  zeroclawBinary = "/usr/local/bin/zeroclaw",
  configDirectory = path.dirname(configPath),
  intervalMs = 5_000,
}) {
  const delivery = parseTelegramDelivery(await readFile(configPath, "utf8"));
  let delivered = await readLedger(ledgerPath);
  let stopped = false;
  let polling = false;

  async function submittedPayments() {
    const stdout = await querySqlite(sqliteBinary, databasePath);
    return projectSubmittedPayments(JSON.parse(stdout || "[]"));
  }

  if (delivered === null) {
    let existing = [];
    try {
      existing = await submittedPayments();
    } catch (error) {
      const details = `${error?.message ?? ""} ${error?.stderr ?? ""}`;
      if (
        !details.includes("unable to open database") &&
        !details.includes("no such table")
      ) {
        throw error;
      }
      // A fresh free-tier instance may not have created its scratch SOP DB yet.
    }
    delivered = new Set(existing.map((payment) => payment.signature));
    await writeLedger(ledgerPath, delivered);
    console.log(
      `Payment notifier initialized with ${delivered.size} existing signature(s).`,
    );
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const payments = await submittedPayments();
      for (const payment of payments.reverse()) {
        if (delivered.has(payment.signature)) continue;
        await sendTelegram(delivery, payment, zeroclawBinary, configDirectory);
        delivered.add(payment.signature);
        await writeLedger(ledgerPath, delivered);
        console.log(`Payment notification delivered for ${payment.signature}.`);
      }
    } catch (error) {
      console.error(
        `Payment notifier will retry: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      polling = false;
    }
  }

  await poll();
  const timer = setInterval(() => void poll(), intervalMs);
  timer.unref();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
