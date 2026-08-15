const TABLE = "safespend_state";
const MAX_RESPONSE_BYTES = 2_000_000;

type RemoteStateConfig = { url: string; serviceRoleKey: string };

function remoteStateConfig(): RemoteStateConfig | null {
  const rawUrl =
    process.env.SAFESPEND_SUPABASE_URL?.trim() ?? process.env.SUPABASE_URL?.trim() ?? "";
  const serviceRoleKey =
    process.env.SAFESPEND_SUPABASE_SERVICE_ROLE_KEY?.trim() ??
    process.env.SUPABASE_SECRET_KEY?.trim() ??
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ??
    "";
  if (!rawUrl && !serviceRoleKey) return null;
  if (!rawUrl || serviceRoleKey.length < 32) {
    throw new Error("SafeSpend durable state credentials are incomplete.");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("SafeSpend durable state URL must be an HTTPS origin.");
  }
  return { url: url.toString().replace(/\/$/, ""), serviceRoleKey };
}

function assertKey(key: string) {
  if (!/^[a-z0-9][a-z0-9/_-]{0,159}$/.test(key)) {
    throw new Error("SafeSpend durable state key is invalid.");
  }
}

async function responseBody(response: Response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error("SafeSpend durable state response exceeded its limit.");
  }
  if (!response.ok) {
    throw new Error(`SafeSpend durable state returned HTTP ${response.status}.`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

async function stateFetch(config: RemoteStateConfig, pathname: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("apikey", config.serviceRoleKey);
  if (!config.serviceRoleKey.startsWith("sb_secret_")) {
    headers.set("Authorization", `Bearer ${config.serviceRoleKey}`);
  }
  if (init?.body) headers.set("Content-Type", "application/json");
  return fetch(`${config.url}/rest/v1/${TABLE}${pathname}`, {
    ...init,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
}

export function usesRemoteState() {
  return remoteStateConfig() !== null;
}

export async function readRemoteState<T>(key: string): Promise<T | null> {
  assertKey(key);
  const config = remoteStateConfig();
  if (!config) return null;
  const response = await stateFetch(
    config,
    `?state_key=eq.${encodeURIComponent(key)}&select=state_value`,
  );
  const body = await responseBody(response);
  if (!Array.isArray(body) || body.length > 1) {
    throw new Error("SafeSpend durable state returned an invalid row set.");
  }
  const row = body[0] as { state_value?: T } | undefined;
  return row?.state_value ?? null;
}

export async function writeRemoteState(key: string, value: unknown) {
  assertKey(key);
  const config = remoteStateConfig();
  if (!config) return false;
  const response = await stateFetch(config, "?on_conflict=state_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ state_key: key, state_value: value }),
  });
  await responseBody(response);
  return true;
}

export async function createRemoteState(key: string, value: unknown) {
  assertKey(key);
  const config = remoteStateConfig();
  if (!config) return null;
  const response = await stateFetch(config, "", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ state_key: key, state_value: value }),
  });
  if (response.status === 409) return false;
  await responseBody(response);
  return true;
}
