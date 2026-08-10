import { NextResponse } from "next/server";
import { z } from "zod";
import { GatewayError } from "./gateway";
import { SafeSpendPolicyError } from "./payment-intent";
import { LocalAccessError } from "./security";
import { SolanaRpcError } from "./solana";

export function apiError(error: unknown) {
  if (error instanceof LocalAccessError)
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof GatewayError)
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof SafeSpendPolicyError)
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof SolanaRpcError)
    return NextResponse.json({ error: error.message, code: error.code }, { status: 502 });
  if (error instanceof z.ZodError)
    return NextResponse.json(
      {
        error: "Request or protected runtime data failed strict validation.",
        code: "VALIDATION_FAILED",
      },
      { status: 400 },
    );
  console.error("[safespend-api] unexpected server error", error);
  const message = error instanceof Error ? error.message : "Unexpected dashboard error.";
  const safeDomainFragments = [
    "amount",
    "delegation",
    "founder",
    "policy",
    "protected",
    "recipient",
    "rpc",
    "safespend",
    "solana",
    "token account",
    "treasury",
    "vendor",
    "wallet",
  ];
  const safeMessage = safeDomainFragments.some((fragment) =>
    message.toLowerCase().includes(fragment),
  )
    ? message
    : "SafeSpend refused the operation. Check the local server log.";
  return NextResponse.json({ error: safeMessage, code: "SAFESPEND_ERROR" }, { status: 500 });
}
