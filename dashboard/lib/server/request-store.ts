import "server-only";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LivePayment, PaymentStatus } from "@/lib/safespend-types";

const PaymentSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().min(8),
    vendorId: z.string(),
    amountBaseUnits: z.string().regex(/^\d+$/),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    status: z.enum([
      "validating",
      "checkpoint",
      "awaiting_telegram",
      "submitting",
      "submitted",
      "finalized",
      "denied",
      "failed",
    ]),
    runStatus: z.string().optional(),
    signature: z.string().optional(),
    confirmationStatus: z.enum(["processed", "confirmed", "finalized"]).optional(),
    error: z.string().max(500).optional(),
    source: z.enum(["dashboard", "telegram"]),
  })
  .strict();

const StoreSchema = z
  .object({ version: z.literal(1), payments: z.array(PaymentSchema).max(100) })
  .strict();

function stateDirectory() {
  if (process.env.SAFESPEND_DASHBOARD_STATE_DIR)
    return path.resolve(process.env.SAFESPEND_DASHBOARD_STATE_DIR);
  return process.cwd().endsWith(`${path.sep}dashboard`)
    ? path.resolve(process.cwd(), ".safespend")
    : path.resolve(process.cwd(), "dashboard/.safespend");
}

function storePath() {
  return path.join(stateDirectory(), "requests.json");
}

let writeQueue = Promise.resolve();

export async function readPayments(): Promise<LivePayment[]> {
  try {
    const parsed = StoreSchema.parse(JSON.parse(await readFile(storePath(), "utf8")));
    return parsed.payments;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new Error("Dashboard request ledger is invalid; refusing to overwrite it.");
    }
    throw error;
  }
}

async function writePaymentsNow(payments: LivePayment[]) {
  const directory = stateDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify({ version: 1, payments: payments.slice(0, 100) }, null, 2)}\n`;
  StoreSchema.parse(JSON.parse(body));
  const temporary = `${storePath()}.${process.pid}.tmp`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, storePath());
}

export async function mutatePayments(mutator: (payments: LivePayment[]) => LivePayment[]) {
  let result: LivePayment[] = [];
  writeQueue = writeQueue.then(async () => {
    result = mutator(await readPayments());
    await writePaymentsNow(result);
  });
  await writeQueue;
  return result;
}

export async function updatePayment(
  id: string,
  patch: Partial<
    Pick<LivePayment, "status" | "runStatus" | "signature" | "confirmationStatus" | "error">
  >,
) {
  const now = new Date().toISOString();
  const payments = await mutatePayments((current) =>
    current.map((payment) =>
      payment.id === id ? { ...payment, ...patch, updatedAt: now } : payment,
    ),
  );
  return payments.find((payment) => payment.id === id) ?? null;
}

export function mapRunStatus(runStatus: string, hasApprovedCheckpoint: boolean): PaymentStatus {
  switch (runStatus) {
    case "paused_checkpoint":
      return "checkpoint";
    case "waiting_approval":
      return "checkpoint";
    case "cancelled":
      return "denied";
    case "failed":
      return "failed";
    case "completed":
      return "submitting";
    default:
      return hasApprovedCheckpoint ? "awaiting_telegram" : "validating";
  }
}
