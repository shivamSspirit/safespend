import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type HostedRouteContext = {
  params: Promise<{ path: string[] }>;
};

function unavailable(message: string, status = 503) {
  return NextResponse.json(
    { error: message, code: "BACKEND_UNAVAILABLE" },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function forward(request: NextRequest, context: HostedRouteContext) {
  const backendOrigin = process.env.SAFESPEND_BACKEND_ORIGIN?.trim() ?? "";
  const backendToken = process.env.SAFESPEND_BACKEND_TOKEN?.trim() ?? "";
  if (
    backendToken.length < 32 ||
    request.headers.get("x-safespend-internal-token") !== backendToken
  ) {
    return unavailable("SafeSpend hosted route is not available.", 404);
  }

  let origin: URL;
  try {
    origin = new URL(backendOrigin);
    if (origin.protocol !== "https:" || origin.username || origin.password) {
      return unavailable("SafeSpend backend origin is invalid.");
    }
  } catch {
    return unavailable("SafeSpend backend origin is invalid.");
  }

  const { path } = await context.params;
  const backendPath = path.map(encodeURIComponent).join("/");
  const target = new URL(`/api/safespend/${backendPath}${request.nextUrl.search}`, origin);
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${backendToken}`,
    "x-safespend-proxy": "vercel",
  });
  const contentType = request.headers.get("content-type");
  const action = request.headers.get("x-safespend-action");
  if (contentType) headers.set("content-type", contentType);
  if (action) headers.set("x-safespend-action", action);

  try {
    const body = request.method === "GET" ? undefined : await request.arrayBuffer();
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(115_000),
    });
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    const responseType = response.headers.get("content-type");
    if (responseType) responseHeaders.set("content-type", responseType);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return unavailable(
      timedOut
        ? "SafeSpend is still waking up. Wait a moment, then retry."
        : "SafeSpend runtime is temporarily unavailable. Retry shortly.",
    );
  }
}

export const GET = forward;
export const POST = forward;
