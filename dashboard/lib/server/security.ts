import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostnameFromHostHeader(host: string | null) {
  if (!host) return "";
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return "";
  }
}

function authenticatedFrontendProxy(request: NextRequest) {
  const expected = process.env.SAFESPEND_FRONTEND_PROXY_TOKEN?.trim();
  if (!expected) return false;

  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (request.headers.get("x-safespend-proxy") !== "vercel" || !authorization.startsWith(prefix)) {
    return false;
  }
  const supplied = authorization.slice(prefix.length);
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return (
    expectedBytes.length >= 32 &&
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

export function assertLocalOperatorRequest(request: NextRequest, mutation = false) {
  const requestHost = hostnameFromHostHeader(request.headers.get("host"));
  const isLoopback = LOOPBACK_HOSTS.has(requestHost);
  const isAuthenticatedProxy = authenticatedFrontendProxy(request);
  if (!isLoopback && !isAuthenticatedProxy) {
    throw new LocalAccessError("SafeSpend dashboard APIs are restricted to loopback hosts.");
  }

  const origin = request.headers.get("origin");
  if (origin && !isAuthenticatedProxy) {
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
  if (fetchSite && !isAuthenticatedProxy && !["same-origin", "none"].includes(fetchSite)) {
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
