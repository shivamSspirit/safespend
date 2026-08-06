import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/server/api";
import { assertLocalOperatorRequest } from "@/lib/server/security";
import { createPayment } from "@/lib/server/service";

export async function POST(request: NextRequest) {
  try {
    assertLocalOperatorRequest(request, true);
    return NextResponse.json(await createPayment(await request.json()), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
