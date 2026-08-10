import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LivePayment, PendingSopRun, SafeSpendBootstrap } from "@/lib/safespend-types";
import { loadSafeSpendServerConfig, loadSafeSpendServerConfigForPolicyVersion } from "./config";
import { gatewayFetch, gatewayHealth, getGatewayToken } from "./gateway";
import {
  validateAllowancePreflight,
  validatePaymentIntent,
  validatePaymentPreflight,
} from "./payment-intent";
import { mutatePayments, readPayments } from "./request-store";
import { readTreasury, readVendorAllowances, verifyPaymentSignature } from "./solana";
import { readApprovedExpenseRuns, type ApprovedExpenseRun } from "./sop-store";

const PendingSchema = z
  .object({
    pending: z.array(
      z
        .object({
          run_id: z.string(),
          sop_name: z.string(),
          step: z.number().int().nonnegative(),
          total_steps: z.number().int().nonnegative(),
          waiting_since: z.string().optional().nullable(),
          kind: z.enum(["checkpoint", "approval"]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const RunsSchema = z
  .object({
    runs: z.array(
      z
        .object({
          run_id: z.string(),
          sop_name: z.string(),
          status: z.string(),
          current_step: z.number().int().nonnegative(),
          total_steps: z.number().int().nonnegative(),
          started_at: z.string(),
          completed_at: z.string().nullable().optional(),
          trigger_source: z.string(),
          active: z.boolean(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const StatusSchema = z
  .object({
    version: z.string().optional(),
    paired: z.boolean(),
    channels: z.record(z.string(), z.boolean()),
    agent_alias: z.string().nullable().optional(),
    health: z.unknown(),
  })
  .passthrough();

const RunResponseSchema = z.object({ run_id: z.string().min(8) }).passthrough();

const BOOTSTRAP_CACHE_MS = 5_000;
let cachedBootstrap: { expiresAt: number; value: SafeSpendBootstrap } | undefined;
let bootstrapInFlight: Promise<SafeSpendBootstrap> | undefined;
let bootstrapEpoch = 0;
const verifiedSignatures = new Set<string>();

function pendingProjection(value: z.infer<typeof PendingSchema>): PendingSopRun[] {
  return value.pending
    .filter((run) => run.sop_name === "approved-expense")
    .map((run) => ({
      runId: run.run_id,
      sopName: run.sop_name,
      step: run.step,
      totalSteps: run.total_steps,
      waitingSince: run.waiting_since ?? undefined,
      kind: run.kind,
    }));
}

export async function connectionState() {
  try {
    const health = await gatewayHealth();
    const token = await getGatewayToken();
    if (!token) return { gatewayOnline: true, paired: false, gatewayPaired: health.paired };
    try {
      await gatewayFetch<unknown>("/api/status?agent=guardian");
      return { gatewayOnline: true, paired: true, gatewayPaired: health.paired };
    } catch {
      return { gatewayOnline: true, paired: false, gatewayPaired: health.paired };
    }
  } catch {
    return { gatewayOnline: false, paired: false, gatewayPaired: false };
  }
}

function discoveredPayments(current: LivePayment[], storedRuns: ApprovedExpenseRun[]) {
  const knownRunIds = new Set(current.map((payment) => payment.runId));
  const discovered = storedRuns
    .filter((run) => !knownRunIds.has(run.runId))
    .map((run): LivePayment => ({
      id: randomUUID(),
      runId: run.runId,
      vendorId: run.vendorId,
      amountBaseUnits: run.amountBaseUnits,
      createdAt: run.startedAt,
      updatedAt: run.completedAt ?? run.startedAt,
      status:
        run.outcome === "submitted"
          ? "submitted"
          : run.outcome === "pending"
            ? "validating"
            : run.outcome,
      runStatus: run.status,
      signature: run.signature,
      error: run.error,
      source: "telegram",
    }));
  return [...current, ...discovered];
}

async function reconcilePayments(
  current: LivePayment[],
  storedRuns: ApprovedExpenseRun[],
  pendingRunIds: Set<string>,
) {
  const storedByRunId = new Map(storedRuns.map((run) => [run.runId, run]));
  const historicalConfigs = new Map<
    number | undefined,
    Awaited<ReturnType<typeof loadSafeSpendServerConfig>>
  >();
  const next: LivePayment[] = [];
  for (const payment of discoveredPayments(current, storedRuns)) {
    const patch: Partial<LivePayment> = {};
    const stored = storedByRunId.get(payment.runId);
    const runStatus = stored?.status ?? payment.runStatus;
    if (runStatus) patch.runStatus = runStatus;
    // The ZeroClaw run record is authoritative. In particular, never retain a
    // signature guessed by an older dashboard build when this exact run has no
    // submitted result of its own.
    const signature = stored ? stored.signature : payment.signature;
    if (stored) {
      patch.signature = stored.signature;
      if (!stored.signature) patch.confirmationStatus = undefined;
    }
    if (signature) {
      let verificationConfig = historicalConfigs.get(payment.policyVersion);
      if (!verificationConfig) {
        verificationConfig = await loadSafeSpendServerConfigForPolicyVersion(payment.policyVersion);
        historicalConfigs.set(payment.policyVersion, verificationConfig);
      }
      const alreadyVerified =
        verifiedSignatures.has(signature) &&
        payment.signature === signature &&
        payment.status === "finalized" &&
        payment.confirmationStatus === "finalized";
      const verification = alreadyVerified
        ? { valid: true as const, confirmationStatus: "finalized" as const }
        : await verifyPaymentSignature(
            verificationConfig,
            payment.vendorId,
            BigInt(payment.amountBaseUnits),
            signature,
          );
      if (verification.confirmationStatus === "failed") {
        patch.status = "failed";
        patch.error = "The submitted transaction failed onchain.";
      } else if (verification.valid === false) {
        patch.status = "failed";
        patch.error = "The submitted signature does not match the protected Devnet transfer.";
      } else {
        patch.error = undefined;
        patch.confirmationStatus = verification.confirmationStatus;
        patch.status =
          verification.valid === true && verification.confirmationStatus === "finalized"
            ? "finalized"
            : "submitted";
        if (patch.status === "finalized") verifiedSignatures.add(signature);
      }
    } else if (stored?.outcome === "denied" || runStatus === "cancelled") {
      patch.status = "denied";
      patch.error = stored?.error;
    } else if (
      stored?.outcome === "failed" ||
      runStatus === "failed" ||
      runStatus === "completed"
    ) {
      patch.status = "failed";
      patch.error =
        stored?.error ?? "The approved-expense SOP failed before a verified transfer was found.";
    } else if (pendingRunIds.has(payment.runId)) patch.status = "checkpoint";
    else if (runStatus === "running" || payment.status === "checkpoint")
      patch.status = "awaiting_telegram";
    const changed = Object.entries(patch).some(
      ([key, value]) => (payment as unknown as Record<string, unknown>)[key] !== value,
    );
    next.push({
      ...payment,
      ...patch,
      updatedAt: changed ? new Date().toISOString() : payment.updatedAt,
    });
  }
  return next;
}

async function buildBootstrapFresh(): Promise<SafeSpendBootstrap> {
  const config = await loadSafeSpendServerConfig();
  const [treasury, rawStatus, rawPending, rawRuns] = await Promise.all([
    readTreasury(config),
    gatewayFetch<unknown>("/api/status?agent=guardian"),
    gatewayFetch<unknown>("/admin/sop/pending"),
    gatewayFetch<unknown>("/api/sops/runs?sop=approved-expense"),
  ]);
  const status = StatusSchema.parse(rawStatus);
  const pending = PendingSchema.parse(rawPending);
  const runs = RunsSchema.parse(rawRuns);
  const pendingRuns = pendingProjection(pending);
  const allowanceStates = await readVendorAllowances(config);
  let auditStoreOnline = true;
  let storedRuns: ApprovedExpenseRun[] = [];
  try {
    storedRuns = await readApprovedExpenseRuns();
  } catch {
    auditStoreOnline = false;
  }
  const knownGatewayRunIds = new Set(runs.runs.map((run) => run.run_id));
  const reconciled = await reconcilePayments(
    await readPayments(),
    storedRuns.filter((run) => knownGatewayRunIds.has(run.runId)),
    new Set(pendingRuns.map((run) => run.runId)),
  );
  await mutatePayments((current) => {
    const reconciledIds = new Set(reconciled.map((payment) => payment.id));
    return [...current.filter((payment) => !reconciledIds.has(payment.id)), ...reconciled];
  });
  return {
    generatedAt: new Date().toISOString(),
    custodyTier: "T2",
    connection: {
      gatewayOnline: true,
      paired: status.paired,
      telegramOnline: status.channels["telegram.guardian"] === true,
      guardianOnline: status.agent_alias === "guardian",
      payerConfigured: true,
      auditStoreOnline,
      version: status.version,
    },
    network: {
      cluster: "devnet",
      genesisHash: treasury.genesisHash,
      rpcProvider: config.rpcProvider,
      finalizedSlot: treasury.finalizedSlot,
    },
    treasury: {
      owner: config.treasuryOwner,
      tokenAccount: config.treasuryTokenAccount,
      mint: config.canonicalMint,
      tokenDecimals: config.tokenDecimals,
      tokenBalanceBaseUnits: treasury.tokenBalanceBaseUnits,
      solBalanceLamports: treasury.solBalanceLamports,
      sessionDelegate: config.sessionDelegate,
      sessionSolBalanceLamports: treasury.sessionSolBalanceLamports,
      runwayMilliweeks: treasury.runwayMilliweeks,
    },
    policy: {
      subscriptionsProgram: config.subscriptionsProgram,
      weeklyBurnBaseUnits: config.weeklyBurnBaseUnits.toString(),
      minimumRunwayWeeks: config.minimumRunwayWeeks,
      minimumTokenReserveBaseUnits: config.minimumTokenReserveBaseUnits.toString(),
      minimumSolReserveLamports: config.minimumSolReserveLamports.toString(),
      minimumSessionFeeReserveLamports: config.minimumSessionFeeReserveLamports.toString(),
      allowMainnet: false,
      toolApprovalRoute: "telegram.guardian",
      vendorPolicyVersion: config.vendorPolicyVersion,
      vendorPolicyHash: config.vendorPolicyHash,
    },
    vendors: config.vendors.map((vendor) => ({
      ...vendor,
      allowance: allowanceStates.get(vendor.id) ?? {
        status: "invalid",
        amountPulledThisPeriodBaseUnits: "0",
        remainingThisPeriodBaseUnits: "0",
        periodStartAt: null,
        periodEndAt: null,
        nextAvailableAt: null,
      },
    })),
    pendingRuns,
    payments: reconciled.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    recentSignatures: treasury.recentSignatures,
  };
}

export async function buildBootstrap(): Promise<SafeSpendBootstrap> {
  const now = Date.now();
  if (cachedBootstrap && cachedBootstrap.expiresAt > now) return cachedBootstrap.value;
  if (bootstrapInFlight) return bootstrapInFlight;
  const startedAtEpoch = bootstrapEpoch;
  const inFlight = buildBootstrapFresh()
    .then((value) => {
      if (startedAtEpoch === bootstrapEpoch) {
        cachedBootstrap = { value, expiresAt: Date.now() + BOOTSTRAP_CACHE_MS };
      }
      return value;
    })
    .finally(() => {
      if (bootstrapInFlight === inFlight) bootstrapInFlight = undefined;
    });
  bootstrapInFlight = inFlight;
  return inFlight;
}

export function invalidateBootstrap() {
  bootstrapEpoch += 1;
  cachedBootstrap = undefined;
  bootstrapInFlight = undefined;
}

export async function createPayment(value: unknown) {
  invalidateBootstrap();
  const config = await loadSafeSpendServerConfig();
  const { intent } = validatePaymentIntent(config, value);
  const [treasury, allowanceStates] = await Promise.all([
    readTreasury(config),
    readVendorAllowances(config),
  ]);
  validateAllowancePreflight(allowanceStates.get(intent.vendorId));
  validatePaymentPreflight(config, treasury, BigInt(intent.amountBaseUnits));
  const payload = JSON.stringify({
    vendor_id: intent.vendorId,
    amount_base_units: Number(intent.amountBaseUnits),
  });
  const response = RunResponseSchema.parse(
    await gatewayFetch<unknown>("/api/sops/approved-expense/run", {
      method: "POST",
      body: JSON.stringify({ payload }),
    }),
  );
  const now = new Date().toISOString();
  const payment: LivePayment = {
    id: randomUUID(),
    runId: response.run_id,
    vendorId: intent.vendorId,
    amountBaseUnits: intent.amountBaseUnits,
    createdAt: now,
    updatedAt: now,
    status: "validating",
    source: "dashboard",
    policyVersion: config.vendorPolicyVersion,
    policyHash: config.vendorPolicyHash ?? undefined,
  };
  await mutatePayments((current) => [
    payment,
    ...current.filter((item) => item.runId !== payment.runId),
  ]);
  invalidateBootstrap();
  return payment;
}

export async function decidePayment(runId: string, decision: "approve" | "deny") {
  invalidateBootstrap();
  const payment = (await readPayments()).find((candidate) => candidate.runId === runId);
  if (!payment) throw new Error("SafeSpend refused to decide an unknown dashboard request.");
  if (decision === "approve" && payment.policyVersion !== undefined) {
    const config = await loadSafeSpendServerConfig();
    if (
      payment.policyVersion !== config.vendorPolicyVersion ||
      payment.policyHash !== (config.vendorPolicyHash ?? undefined)
    ) {
      throw new Error(
        "SafeSpend refused because the vendor policy changed after this request was created.",
      );
    }
  }
  const pending = PendingSchema.parse(await gatewayFetch<unknown>("/admin/sop/pending"));
  const exactPending = pending.pending.find(
    (run) => run.run_id === runId && run.sop_name === "approved-expense",
  );
  if (!exactPending)
    throw new Error("SafeSpend refused because this run is not at an approved-expense gate.");
  const pathname = decision === "approve" ? "/admin/sop/approve" : "/admin/sop/deny";
  await gatewayFetch<unknown>(pathname, {
    method: "POST",
    body: JSON.stringify(
      decision === "approve"
        ? { run_id: runId }
        : { run_id: runId, reason: "Denied from founder dashboard" },
    ),
  });
  const updated: LivePayment = {
    ...payment,
    updatedAt: new Date().toISOString(),
    status: decision === "approve" ? "awaiting_telegram" : "denied",
    runStatus: decision === "approve" ? "running" : "cancelled",
  };
  await mutatePayments((current) =>
    current.map((candidate) => (candidate.id === payment.id ? updated : candidate)),
  );
  invalidateBootstrap();
  return updated;
}
