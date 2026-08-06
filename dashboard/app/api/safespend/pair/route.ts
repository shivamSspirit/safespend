import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/server/api";
import { pairGateway } from "@/lib/server/gateway";
import { assertLocalOperatorRequest } from "@/lib/server/security";

const BodySchema = z.object({ pairingCode: z.string().regex(/^\d{6}$/) }).strict();
export async function POST(request: NextRequest) {
  try {
    assertLocalOperatorRequest(request, true);
    return NextResponse.json(await pairGateway(BodySchema.parse(await request.json()).pairingCode));
  } catch (error) {
    return apiError(error);
  }
}
