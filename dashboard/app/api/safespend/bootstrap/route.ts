import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/server/api";
import { assertLocalOperatorRequest } from "@/lib/server/security";
import { buildBootstrap } from "@/lib/server/service";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    assertLocalOperatorRequest(request);
    return NextResponse.json(await buildBootstrap());
  } catch (error) {
    return apiError(error);
  }
}
