import "server-only";

import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const PaymentOutputSchema = z
  .object({
    status: z.literal("submitted"),
    signature: z.string().min(64).max(96),
    vendor_id: z.string(),
    amount_base_units: z.number().int().positive().safe(),
    post_payment_token_balance_base_units: z.number().int().nonnegative().safe(),
    post_payment_runway_milliweeks: z.number().int().nonnegative().safe(),
    policy_hash: z.string(),
  })
  .passthrough();

function traceCandidates() {
  return [
    path.resolve(process.cwd(), ".zeroclaw-dev/data/state/runtime-trace.jsonl"),
    path.resolve(process.cwd(), "../.zeroclaw-dev/data/state/runtime-trace.jsonl"),
  ];
}

async function tailFile(filePath: string, maxBytes = 2_000_000) {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stats.size - length));
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function findSubmittedPayment(vendorId: string, amount: bigint, createdAt: string) {
  let text = "";
  for (const candidate of traceCandidates()) {
    try {
      text = await tailFile(candidate);
      break;
    } catch {
      // Continue to the next workspace-relative trace location.
    }
  }
  if (!text) return null;
  const created = new Date(createdAt).getTime() - 60_000;
  const lines = text.split("\n").reverse();
  for (const line of lines) {
    if (!line.includes('"tool":"safespend_allowance_pay"') || !line.includes('"outcome":"success"'))
      continue;
    try {
      const event = JSON.parse(line) as {
        "@timestamp"?: string;
        attributes?: { output?: string; tool?: string };
      };
      if (!event["@timestamp"] || new Date(event["@timestamp"]).getTime() < created) continue;
      const output = PaymentOutputSchema.safeParse(JSON.parse(event.attributes?.output ?? ""));
      if (!output.success) continue;
      if (output.data.vendor_id === vendorId && BigInt(output.data.amount_base_units) === amount) {
        return {
          signature: output.data.signature,
          policyHash: output.data.policy_hash,
          postPaymentBalanceBaseUnits: String(output.data.post_payment_token_balance_base_units),
          postPaymentRunwayMilliweeks: String(output.data.post_payment_runway_milliweeks),
        };
      }
    } catch {
      // Malformed and unrelated trace lines are ignored.
    }
  }
  return null;
}
