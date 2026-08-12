import "server-only";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { retryOnce } from "./retry";

const PairResponseSchema = z.object({
  paired: z.literal(true),
  persisted: z.literal(true),
  token: z.string().min(20),
});

function localStateDirectory() {
  if (process.env.SAFESPEND_DASHBOARD_STATE_DIR) {
    return path.resolve(process.env.SAFESPEND_DASHBOARD_STATE_DIR);
  }
  return process.cwd().endsWith(`${path.sep}dashboard`)
    ? path.resolve(process.cwd(), ".safespend")
    : path.resolve(process.cwd(), "dashboard/.safespend");
}

function tokenPath() {
  return path.join(localStateDirectory(), "gateway-token");
}

export function gatewayBaseUrl() {
  const value = process.env.ZEROCLAW_GATEWAY_URL ?? "http://127.0.0.1:42617";
  const url = new URL(value);
  const isLoopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "http:" || !isLoopback || url.username || url.password) {
    throw new Error("ZEROCLAW_GATEWAY_URL must be an unauthenticated loopback HTTP URL.");
  }
  return url.toString().replace(/\/$/, "");
}

export async function getGatewayToken() {
  const envToken = process.env.ZEROCLAW_GATEWAY_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    const stored = (await readFile(tokenPath(), "utf8")).trim();
    return stored || null;
  } catch {
    return null;
  }
}

async function responseJson(response: Response) {
  const text = await response.text();
  if (text.length > 1_048_576) throw new Error("Gateway response exceeded the dashboard limit.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Gateway returned invalid JSON with HTTP ${response.status}.`);
  }
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = "GATEWAY_ERROR",
  ) {
    super(message);
  }
}

export async function gatewayHealth() {
  try {
    return await retryOnce(async () => {
      const response = await fetch(`${gatewayBaseUrl()}/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) throw new GatewayError("ZeroClaw health check failed.", response.status);
      return z
        .object({
          status: z.literal("ok"),
          paired: z.boolean(),
          require_pairing: z.boolean(),
        })
        .passthrough()
        .parse(await responseJson(response));
    });
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(
      "ZeroClaw gateway is offline. Start the daemon and retry.",
      503,
      "GATEWAY_OFFLINE",
    );
  }
}

export async function pairGateway(pairingCode: string) {
  const response = await fetch(`${gatewayBaseUrl()}/pair`, {
    method: "POST",
    headers: { "X-Pairing-Code": pairingCode },
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  const body = await responseJson(response);
  if (!response.ok) {
    const message = z.object({ error: z.string().optional() }).passthrough().safeParse(body);
    throw new GatewayError(
      message.success
        ? (message.data.error ?? "Gateway pairing failed.")
        : "Gateway pairing failed.",
      response.status,
      "PAIRING_FAILED",
    );
  }
  const paired = PairResponseSchema.parse(body);
  const directory = localStateDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${tokenPath()}.${process.pid}.tmp`;
  await writeFile(temporary, `${paired.token}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, tokenPath());
  return { paired: true as const };
}

export async function gatewayFetch<T>(pathname: string, init?: RequestInit): Promise<T> {
  if (!pathname.startsWith("/") || pathname.includes("..")) {
    throw new GatewayError("Unsafe gateway path rejected.", 500, "UNSAFE_GATEWAY_PATH");
  }
  const token = await getGatewayToken();
  if (!token)
    throw new GatewayError("Pair the dashboard with ZeroClaw first.", 401, "PAIRING_REQUIRED");
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${gatewayBaseUrl()}${pathname}`, {
    ...init,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  const body = await responseJson(response);
  if (!response.ok) {
    const parsed = z.object({ error: z.string().optional() }).passthrough().safeParse(body);
    throw new GatewayError(
      parsed.success
        ? (parsed.data.error ?? "ZeroClaw request failed.")
        : "ZeroClaw request failed.",
      response.status,
    );
  }
  return body as T;
}
