import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/server/api";
import { assertLocalOperatorRequest } from "@/lib/server/security";
import { prepareVendorUpdate } from "@/lib/server/vendor-enrollment";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertLocalOperatorRequest(request, true);
    return NextResponse.json(await prepareVendorUpdate(await request.json()), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
