import { NextRequest, NextResponse } from "next/server";

function unavailable(message: string) {
  return NextResponse.json(
    { error: message, code: "DEPLOYMENT_CONFIGURATION_ERROR" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function equalSecret(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash[index] ^ rightHash[index];
  }
  return difference === 0;
}

async function founderAuthenticated(request: NextRequest, user: string, password: string) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Basic ")) return false;
  try {
    const decoded = atob(authorization.slice("Basic ".length));
    return equalSecret(decoded, `${user}:${password}`);
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const backendOrigin = process.env.SAFESPEND_BACKEND_ORIGIN?.trim();
  if (!backendOrigin) return NextResponse.next();

  const backendToken = process.env.SAFESPEND_BACKEND_TOKEN?.trim() ?? "";
  const dashboardUser = process.env.SAFESPEND_DASHBOARD_USER?.trim() ?? "";
  const dashboardPassword = process.env.SAFESPEND_DASHBOARD_PASSWORD ?? "";
  if (backendToken.length < 32 || !dashboardUser || dashboardPassword.length < 16) {
    return unavailable("SafeSpend hosting secrets are incomplete.");
  }

  if (!(await founderAuthenticated(request, dashboardUser, dashboardPassword))) {
    return new NextResponse("Founder authentication required.", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="SafeSpend founder", charset="UTF-8"',
      },
    });
  }

  if (!request.nextUrl.pathname.startsWith("/api/safespend/")) {
    return NextResponse.next();
  }

  let target: URL;
  try {
    const origin = new URL(backendOrigin);
    if (origin.protocol !== "https:" || origin.username || origin.password) {
      return unavailable("SafeSpend backend origin must be an HTTPS origin.");
    }
    target = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, origin);
  } catch {
    return unavailable("SafeSpend backend origin is invalid.");
  }

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const action = request.headers.get("x-safespend-action");
  if (contentType) headers.set("content-type", contentType);
  if (action) headers.set("x-safespend-action", action);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${backendToken}`);
  headers.set("x-safespend-proxy", "vercel");

  return NextResponse.rewrite(target, { request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
