import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/server/api";
import { assertLocalOperatorRequest } from "@/lib/server/security";
import { connectionState } from "@/lib/server/service";

export async function GET(request: NextRequest) {
  try {
    assertLocalOperatorRequest(request);
    return NextResponse.json(await connectionState());
  } catch (error) {
    return apiError(error);
  }
}
