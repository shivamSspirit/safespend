import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/server/api";
import { loadSafeSpendServerConfig } from "@/lib/server/config";
import { PROMPT_INJECTION_CASES, validatePaymentIntent } from "@/lib/server/payment-intent";
import { assertLocalOperatorRequest } from "@/lib/server/security";

export async function POST(request: NextRequest) {
  try {
    assertLocalOperatorRequest(request, true);
    const config = await loadSafeSpendServerConfig();
    const transcript = PROMPT_INJECTION_CASES.map((test) => {
      try {
        validatePaymentIntent(config, test.input);
        return { case: test.name, result: "unexpectedly_accepted" as const };
      } catch {
        return {
          case: test.name,
          result: "blocked" as const,
          reason: "strict intent or protected-policy validation",
        };
      }
    });
    const passed = transcript.every((item) => item.result === "blocked");
    return NextResponse.json(
      {
        passed,
        executedAt: new Date().toISOString(),
        boundary: "No test input reached the LLM, signer, or Solana RPC.",
        transcript,
      },
      { status: passed ? 200 : 500 },
    );
  } catch (error) {
    return apiError(error);
  }
}
