import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/server/api";
import { assertLocalOperatorRequest } from "@/lib/server/security";
import { decidePayment } from "@/lib/server/service";

const BodySchema = z
  .object({ runId: z.string().min(8).max(160), decision: z.enum(["approve", "deny"]) })
  .strict();
export async function POST(request: NextRequest) {
  try {
    assertLocalOperatorRequest(request, true);
    const body = BodySchema.parse(await request.json());
    return NextResponse.json(await decidePayment(body.runId, body.decision));
  } catch (error) {
    return apiError(error);
  }
}
