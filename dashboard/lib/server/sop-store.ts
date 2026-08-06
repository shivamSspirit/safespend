import "server-only";

import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";

const TriggerSchema = z
  .object({
    payload: z.string().max(4096),
    timestamp: z.string().datetime(),
  })
  .passthrough();

const StepResultSchema = z
  .object({
    step_number: z.number().int().positive(),
    status: z.string(),
    output: z.string().max(32_768).optional().default(""),
    completed_at: z.string().datetime().optional(),
  })
  .passthrough();

const StoredRunSchema = z
  .object({
    run: z
      .object({
        run_id: z.string().min(8).max(160),
        sop_name: z.string(),
        trigger_event: TriggerSchema,
        status: z.string(),
        current_step: z.number().int().nonnegative(),
        total_steps: z.number().int().nonnegative(),
        started_at: z.string().datetime(),
        completed_at: z.string().datetime().nullable().optional(),
        step_results: z.array(StepResultSchema).default([]),
      })
      .passthrough(),
  })
  .passthrough();

const IntentSchema = z
  .object({
    vendor_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
    amount_base_units: z.union([
      z.number().int().positive().safe().transform(String),
      z.string().regex(/^\d+$/),
    ]),
  })
  .passthrough();

const SubmittedSchema = z
  .object({
    status: z.literal("submitted"),
    signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,96}$/),
    vendor_id: z.string(),
    amount_base_units: z.union([
      z.number().int().positive().safe().transform(String),
      z.string().regex(/^\d+$/),
    ]),
  })
  .passthrough();

export type ApprovedExpenseRun = {
  runId: string;
  status: string;
  currentStep: number;
  totalSteps: number;
  startedAt: string;
  completedAt?: string;
  vendorId: string;
  amountBaseUnits: string;
  signature?: string;
  outcome: "submitted" | "denied" | "failed" | "pending";
  error?: string;
};

function runStoreCandidates() {
  const configured = process.env.ZEROCLAW_CONFIG_DIR?.trim();
  return [
    configured ? path.resolve(configured, "data/sop/runs.db") : null,
    path.resolve(process.cwd(), ".zeroclaw-dev/data/sop/runs.db"),
    path.resolve(process.cwd(), "../.zeroclaw-dev/data/sop/runs.db"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function safeFailure(output: string, status: string) {
  if (/denied by user|step 1 was denied/i.test(output) || status === "cancelled") {
    return { outcome: "denied" as const, error: "Denied by user. No payment was sent." };
  }
  if (status === "waiting_approval" || status === "paused_checkpoint" || status === "running") {
    return { outcome: "pending" as const };
  }
  if (/amount_mismatch/i.test(output)) {
    return {
      outcome: "failed" as const,
      error:
        "Protected policy rejected the amount because it did not match the configured allowance.",
    };
  }
  if (/rpc transport failed/i.test(output)) {
    return {
      outcome: "failed" as const,
      error: "The Devnet RPC request failed before a transaction was submitted.",
    };
  }
  if (/session key/i.test(output)) {
    return {
      outcome: "failed" as const,
      error: "The protected session signer configuration was rejected. No payment was sent.",
    };
  }
  return {
    outcome: "failed" as const,
    error:
      status === "failed"
        ? "The approved-expense SOP failed before a transaction was submitted."
        : "The SOP completed without a verified submitted transaction.",
  };
}

function projectRun(raw: unknown): ApprovedExpenseRun | null {
  const stored = StoredRunSchema.safeParse(raw);
  if (!stored.success || stored.data.run.sop_name !== "approved-expense") return null;
  const run = stored.data.run;
  let intentValue: unknown;
  try {
    intentValue = JSON.parse(run.trigger_event.payload);
  } catch {
    return null;
  }
  const intent = IntentSchema.safeParse(intentValue);
  if (!intent.success) return null;

  const lastOutput =
    [...run.step_results]
      .sort((a, b) => b.step_number - a.step_number)
      .find((step) => step.output.trim())
      ?.output.trim() ?? "";
  let submittedValue: unknown;
  try {
    submittedValue = JSON.parse(lastOutput);
  } catch {
    submittedValue = null;
  }
  const submitted = SubmittedSchema.safeParse(submittedValue);
  const exactSubmission =
    submitted.success &&
    submitted.data.vendor_id === intent.data.vendor_id &&
    submitted.data.amount_base_units === intent.data.amount_base_units;
  const fallback = safeFailure(lastOutput, run.status);

  return {
    runId: run.run_id,
    status: run.status,
    currentStep: run.current_step,
    totalSteps: run.total_steps,
    startedAt: run.started_at,
    completedAt: run.completed_at ?? undefined,
    vendorId: intent.data.vendor_id,
    amountBaseUnits: intent.data.amount_base_units,
    signature: exactSubmission ? submitted.data.signature : undefined,
    outcome: exactSubmission ? "submitted" : fallback.outcome,
    error: exactSubmission ? undefined : fallback.error,
  };
}

const SqliteRowsSchema = z.array(z.object({ json: z.string() }).strict());

function sqliteBinary() {
  const configured = process.env.SAFESPEND_SQLITE_BIN?.trim();
  return configured ? path.resolve(configured) : "/usr/bin/sqlite3";
}

function queryRunStore(databasePath: string, limit: number) {
  const query = `SELECT json FROM sop_runs ORDER BY last_progress_at DESC LIMIT ${limit}`;
  return new Promise<string>((resolve, reject) => {
    execFile(
      sqliteBinary(),
      ["-readonly", "-json", databasePath, query],
      { encoding: "utf8", timeout: 3_000, maxBuffer: 4_000_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

export async function readApprovedExpenseRuns(limit = 40): Promise<ApprovedExpenseRun[]> {
  let lastError: unknown;
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  for (const candidate of runStoreCandidates()) {
    try {
      const rows = SqliteRowsSchema.parse(
        JSON.parse((await queryRunStore(candidate, boundedLimit)) || "[]"),
      );
      return rows.flatMap((row) => {
        try {
          const projected = projectRun(JSON.parse(row.json));
          return projected ? [projected] : [];
        } catch {
          return [];
        }
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    lastError
      ? "SafeSpend could not read the local SOP audit store."
      : "SafeSpend SOP audit store was not found.",
  );
}
