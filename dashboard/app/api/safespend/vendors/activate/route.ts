import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/server/api";
import { assertLocalOperatorRequest } from "@/lib/server/security";
import { invalidateBootstrap } from "@/lib/server/service";
import { activateVendorEnrollment } from "@/lib/server/vendor-enrollment";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertLocalOperatorRequest(request, true);
    const result = await activateVendorEnrollment(await request.json());
    if (result.status === "active") invalidateBootstrap();
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}
