import { NextRequest, NextResponse } from "next/server";
import { assertLocalOperatorRequest } from "@/lib/server/security";
import { readActiveVendorPolicy } from "@/lib/server/vendor-policy-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  assertLocalOperatorRequest(request);
  const active = await readActiveVendorPolicy();
  if (!active) {
    return NextResponse.json(
      { error: "No founder-signed vendor policy is active.", code: "POLICY_NOT_ACTIVE" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(active, { headers: { "Cache-Control": "no-store" } });
}
