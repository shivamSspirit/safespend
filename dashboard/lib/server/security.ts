import { NextRequest } from "next/server";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostnameFromHostHeader(host: string | null) {
  if (!host) return "";
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return "";
  }
}

export function assertLocalOperatorRequest(request: NextRequest, mutation = false) {
  const requestHost = hostnameFromHostHeader(request.headers.get("host"));
  if (!LOOPBACK_HOSTS.has(requestHost)) {
    throw new LocalAccessError("SafeSpend dashboard APIs are restricted to loopback hosts.");
  }

  const origin = request.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname;
    } catch {
      throw new LocalAccessError("Invalid request origin.");
    }
    if (!LOOPBACK_HOSTS.has(originHost) || originHost !== requestHost) {
      throw new LocalAccessError("Cross-origin dashboard request rejected.");
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    throw new LocalAccessError("Cross-site dashboard request rejected.");
  }

  if (mutation && request.headers.get("x-safespend-action") !== "founder-dashboard") {
    throw new LocalAccessError("Missing SafeSpend action header.");
  }
}

export class LocalAccessError extends Error {
  readonly status = 403;
  readonly code = "LOCAL_ACCESS_REQUIRED";
}
