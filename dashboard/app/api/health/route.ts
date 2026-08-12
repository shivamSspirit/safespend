import { NextResponse } from "next/server";
import { z } from "zod";
import { gatewayFetch, gatewayHealth } from "@/lib/server/gateway";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await gatewayHealth();
    const status = z
      .object({
        paired: z.literal(true),
        agent_alias: z.literal("guardian"),
        channels: z.record(z.string(), z.boolean()),
      })
      .parse(await gatewayFetch<unknown>("/api/status?agent=guardian"));
    if (status.channels["telegram.guardian"] !== true) {
      throw new Error("Telegram guardian is not ready.");
    }
    return NextResponse.json(
      { status: "ok", service: "safespend-runtime" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "starting", service: "safespend-runtime" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
