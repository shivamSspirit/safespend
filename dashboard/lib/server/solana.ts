import "server-only";

import { z } from "zod";
import type { VendorAllowanceState } from "@/lib/safespend-types";
import type { SafeSpendServerConfig } from "./config";

const MAX_RPC_RESPONSE_BYTES = 1_048_576;

const SignatureInfoSchema = z
  .object({
    signature: z.string().min(64).max(96),
    slot: z.number().int().nonnegative(),
    err: z.unknown().nullable(),
    blockTime: z.number().int().nullable(),
    confirmationStatus: z.string().nullable().optional(),
  })
  .passthrough();

const AccountInfoSchema = z.object({
  value: z
    .object({
      data: z.tuple([z.string(), z.literal("base64")]),
      executable: z.boolean(),
      owner: z.string(),
    })
    .nullable(),
});

const RECURRING_DELEGATION_BYTES = 211;
const RECURRING_DELEGATION_DISCRIMINATOR = 3;
const RECURRING_DELEGATION_VERSION = 1;
const CURRENT_PERIOD_START_OFFSET = 171;
const PERIOD_LENGTH_OFFSET = 179;
const EXPIRY_OFFSET = 187;
const AMOUNT_PER_PERIOD_OFFSET = 195;
const AMOUNT_PULLED_OFFSET = 203;

export class SolanaRpcError extends Error {
  readonly code = "SOLANA_RPC_ERROR";
}

async function rpc<T>(
  config: SafeSpendServerConfig,
  method: string,
  params: unknown[],
): Promise<T> {
  const response = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  const text = await response.text();
  if (text.length > MAX_RPC_RESPONSE_BYTES)
    throw new SolanaRpcError("Solana RPC response exceeded the dashboard limit.");
  if (!response.ok) throw new SolanaRpcError(`Solana RPC returned HTTP ${response.status}.`);
  let body: { result?: T; error?: unknown };
  try {
    body = JSON.parse(text) as { result?: T; error?: unknown };
  } catch {
    throw new SolanaRpcError("Solana RPC returned invalid JSON.");
  }
  if (body.error || body.result === undefined)
    throw new SolanaRpcError(`Solana RPC method ${method} failed.`);
  return body.result;
}

export async function readTreasury(config: SafeSpendServerConfig) {
  const [
    genesisHash,
    tokenBalance,
    treasuryBalance,
    sessionBalance,
    finalizedSlot,
    signatureResult,
  ] = await Promise.all([
    rpc<string>(config, "getGenesisHash", []),
    rpc<{ value: { amount: string; decimals: number } }>(config, "getTokenAccountBalance", [
      config.treasuryTokenAccount,
      { commitment: "finalized" },
    ]),
    rpc<{ value: number }>(config, "getBalance", [
      config.treasuryOwner,
      { commitment: "finalized" },
    ]),
    rpc<{ value: number }>(config, "getBalance", [
      config.sessionDelegate,
      { commitment: "finalized" },
    ]),
    rpc<number>(config, "getSlot", [{ commitment: "finalized" }]),
    rpc<unknown[]>(config, "getSignaturesForAddress", [
      config.treasuryTokenAccount,
      { commitment: "finalized", limit: 8 },
    ]),
  ]);

  if (genesisHash !== config.expectedGenesisHash)
    throw new SolanaRpcError("RPC genesis hash is not Solana Devnet. The dashboard failed closed.");
  if (tokenBalance.value.decimals !== config.tokenDecimals)
    throw new SolanaRpcError("Onchain token decimals do not match protected configuration.");
  const balance = BigInt(tokenBalance.value.amount);
  const runwayMilliweeks =
    config.weeklyBurnBaseUnits > 0n ? (balance * 1000n) / config.weeklyBurnBaseUnits : 0n;
  const signatures = z.array(SignatureInfoSchema).parse(signatureResult);

  return {
    genesisHash,
    tokenBalanceBaseUnits: balance.toString(),
    solBalanceLamports: BigInt(treasuryBalance.value).toString(),
    sessionSolBalanceLamports: BigInt(sessionBalance.value).toString(),
    finalizedSlot,
    runwayMilliweeks: runwayMilliweeks.toString(),
    recentSignatures: signatures.map((item) => ({
      signature: item.signature,
      blockTime: item.blockTime,
      confirmationStatus: item.confirmationStatus ?? null,
      err: item.err !== null,
    })),
  };
}

function timestamp(value: bigint) {
  const milliseconds = value * 1000n;
  if (milliseconds < 0n || milliseconds > BigInt(8_640_000_000_000_000)) return null;
  return new Date(Number(milliseconds)).toISOString();
}

function invalidAllowance(): VendorAllowanceState {
  return {
    status: "invalid",
    amountPulledThisPeriodBaseUnits: "0",
    remainingThisPeriodBaseUnits: "0",
    periodStartAt: null,
    periodEndAt: null,
    nextAvailableAt: null,
  };
}

function decodeAllowance(
  config: SafeSpendServerConfig,
  vendor: SafeSpendServerConfig["vendors"][number],
  account: z.infer<typeof AccountInfoSchema>["value"],
  now: bigint,
): VendorAllowanceState {
  if (!account || account.executable || account.owner !== config.subscriptionsProgram) {
    return invalidAllowance();
  }
  const data = Buffer.from(account.data[0], "base64");
  if (
    data.length !== RECURRING_DELEGATION_BYTES ||
    data[0] !== RECURRING_DELEGATION_DISCRIMINATOR ||
    data[1] !== RECURRING_DELEGATION_VERSION
  ) {
    return invalidAllowance();
  }

  let periodStart = data.readBigInt64LE(CURRENT_PERIOD_START_OFFSET);
  const periodLength = data.readBigUInt64LE(PERIOD_LENGTH_OFFSET);
  const expiry = data.readBigInt64LE(EXPIRY_OFFSET);
  const amountPerPeriod = data.readBigUInt64LE(AMOUNT_PER_PERIOD_OFFSET);
  let amountPulled = data.readBigUInt64LE(AMOUNT_PULLED_OFFSET);
  const expectedAmount = BigInt(vendor.amountBaseUnits);
  const expectedPeriod = BigInt(vendor.periodSeconds);

  if (
    periodStart < 0n ||
    periodLength === 0n ||
    expiry <= 0n ||
    amountPerPeriod !== expectedAmount ||
    periodLength !== expectedPeriod
  ) {
    return invalidAllowance();
  }

  if (now < periodStart) {
    const initialPeriodEnd =
      periodStart + periodLength < expiry ? periodStart + periodLength : expiry;
    return {
      status: "not_started",
      amountPulledThisPeriodBaseUnits: amountPulled.toString(),
      remainingThisPeriodBaseUnits: "0",
      periodStartAt: timestamp(periodStart),
      periodEndAt: timestamp(initialPeriodEnd),
      nextAvailableAt: timestamp(periodStart),
    };
  }
  if (now > expiry) {
    return {
      status: "expired",
      amountPulledThisPeriodBaseUnits: amountPulled.toString(),
      remainingThisPeriodBaseUnits: "0",
      periodStartAt: timestamp(periodStart),
      periodEndAt: timestamp(expiry),
      nextAvailableAt: null,
    };
  }
  if (now + config.expirySafetyBufferSeconds > expiry) {
    return {
      status: "expiring",
      amountPulledThisPeriodBaseUnits: amountPulled.toString(),
      remainingThisPeriodBaseUnits: "0",
      periodStartAt: timestamp(periodStart),
      periodEndAt: timestamp(expiry),
      nextAvailableAt: null,
    };
  }

  const elapsed = now - periodStart;
  if (elapsed >= periodLength) {
    const periodsPassed = elapsed / periodLength;
    const candidate = periodStart + periodsPassed * periodLength;
    if (candidate < expiry) {
      periodStart = candidate;
    } else {
      const lastBillable = expiry - 1n;
      periodStart += ((lastBillable - periodStart) / periodLength) * periodLength;
    }
    amountPulled = 0n;
  }

  const periodEnd = periodStart + periodLength < expiry ? periodStart + periodLength : expiry;
  if (amountPulled > amountPerPeriod) return invalidAllowance();
  const remaining = amountPerPeriod - amountPulled;
  const available = amountPulled === 0n && remaining >= expectedAmount;
  const nextPeriod = periodStart + periodLength;
  return {
    status: available ? "available" : "spent",
    amountPulledThisPeriodBaseUnits: amountPulled.toString(),
    remainingThisPeriodBaseUnits: remaining.toString(),
    periodStartAt: timestamp(periodStart),
    periodEndAt: timestamp(periodEnd),
    nextAvailableAt: !available && nextPeriod < expiry ? timestamp(nextPeriod) : null,
  };
}

export async function readVendorAllowances(
  config: SafeSpendServerConfig,
): Promise<Map<string, VendorAllowanceState>> {
  const finalizedSlot = await rpc<number>(config, "getSlot", [{ commitment: "finalized" }]);
  const blockTime = await rpc<number | null>(config, "getBlockTime", [finalizedSlot]);
  if (blockTime === null || !Number.isSafeInteger(blockTime) || blockTime < 0) {
    throw new SolanaRpcError("Finalized block time is unavailable for allowance evaluation.");
  }
  const accounts = await Promise.all(
    config.vendors.map((vendor) =>
      rpc<unknown>(config, "getAccountInfo", [
        vendor.recurringDelegation,
        { encoding: "base64", commitment: "finalized" },
      ]).then((value) => AccountInfoSchema.parse(value)),
    ),
  );
  return new Map(
    config.vendors.map((vendor, index) => [
      vendor.id,
      decodeAllowance(config, vendor, accounts[index].value, BigInt(blockTime)),
    ]),
  );
}

type TokenBalance = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
};

function accountKeyStrings(transaction: Record<string, unknown>) {
  const message = (transaction.transaction as { message?: { accountKeys?: unknown[] } } | undefined)
    ?.message;
  return (message?.accountKeys ?? []).map((key) => {
    if (typeof key === "string") return key;
    if (key && typeof key === "object" && "pubkey" in key)
      return String((key as { pubkey: unknown }).pubkey);
    return "";
  });
}

function tokenAmountAt(balances: TokenBalance[] | undefined, accountIndex: number, mint: string) {
  const balance = balances?.find(
    (item) => item.accountIndex === accountIndex && item.mint === mint,
  );
  return BigInt(balance?.uiTokenAmount?.amount ?? "0");
}

function callsProgram(transaction: Record<string, unknown>, programId: string) {
  const keys = accountKeyStrings(transaction);
  const message = (
    transaction.transaction as { message?: { instructions?: unknown[] } } | undefined
  )?.message;
  return (message?.instructions ?? []).some((instruction) => {
    if (!instruction || typeof instruction !== "object") return false;
    if ("programId" in instruction)
      return String((instruction as { programId: unknown }).programId) === programId;
    if ("programIdIndex" in instruction) {
      const index = Number((instruction as { programIdIndex: unknown }).programIdIndex);
      return Number.isInteger(index) && keys[index] === programId;
    }
    return false;
  });
}

export async function verifyTransferForRequest(
  config: SafeSpendServerConfig,
  vendorId: string,
  amount: bigint,
  createdAt: string,
) {
  const vendor = config.vendors.find((candidate) => candidate.id === vendorId);
  if (!vendor) return null;
  const since = Math.floor(new Date(createdAt).getTime() / 1000) - 60;
  const rawSignatures = await rpc<unknown[]>(config, "getSignaturesForAddress", [
    config.treasuryTokenAccount,
    { commitment: "confirmed", limit: 20 },
  ]);
  const signatures = z
    .array(SignatureInfoSchema)
    .parse(rawSignatures)
    .filter((item) => item.err === null && (item.blockTime === null || item.blockTime >= since));

  for (const item of signatures) {
    const transaction = await rpc<Record<string, unknown> | null>(config, "getTransaction", [
      item.signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
    if (!transaction) continue;
    const keys = accountKeyStrings(transaction);
    const treasuryIndex = keys.indexOf(config.treasuryTokenAccount);
    const recipientIndex = keys.indexOf(vendor.recipientTokenAccount);
    if (
      treasuryIndex < 0 ||
      recipientIndex < 0 ||
      !callsProgram(transaction, config.subscriptionsProgram)
    )
      continue;
    const meta = transaction.meta as
      | { preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[]; err?: unknown }
      | undefined;
    if (!meta || meta.err) continue;
    const treasuryBefore = tokenAmountAt(
      meta.preTokenBalances,
      treasuryIndex,
      config.canonicalMint,
    );
    const treasuryAfter = tokenAmountAt(
      meta.postTokenBalances,
      treasuryIndex,
      config.canonicalMint,
    );
    const recipientBefore = tokenAmountAt(
      meta.preTokenBalances,
      recipientIndex,
      config.canonicalMint,
    );
    const recipientAfter = tokenAmountAt(
      meta.postTokenBalances,
      recipientIndex,
      config.canonicalMint,
    );
    if (treasuryBefore - treasuryAfter !== amount || recipientAfter - recipientBefore !== amount)
      continue;

    const statusResult = await rpc<{
      value: Array<{ confirmationStatus?: string; err?: unknown } | null>;
    }>(config, "getSignatureStatuses", [[item.signature], { searchTransactionHistory: true }]);
    const status = statusResult.value[0];
    if (!status || status.err) continue;
    const confirmationStatus =
      status.confirmationStatus === "finalized"
        ? "finalized"
        : status.confirmationStatus === "confirmed"
          ? "confirmed"
          : "processed";
    return { signature: item.signature, confirmationStatus } as const;
  }
  return null;
}

export async function verifyPaymentSignature(
  config: SafeSpendServerConfig,
  vendorId: string,
  amount: bigint,
  signature: string,
) {
  const vendor = config.vendors.find((candidate) => candidate.id === vendorId);
  if (!vendor) return { valid: false as const, confirmationStatus: "processed" as const };
  const transaction = await rpc<Record<string, unknown> | null>(config, "getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  ]);
  const finality = await getSignatureFinality(config, signature);
  if (!transaction) {
    return {
      valid: null,
      confirmationStatus: finality?.confirmationStatus ?? ("processed" as const),
    };
  }
  const keys = accountKeyStrings(transaction);
  const treasuryIndex = keys.indexOf(config.treasuryTokenAccount);
  const recipientIndex = keys.indexOf(vendor.recipientTokenAccount);
  const meta = transaction.meta as
    | { preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[]; err?: unknown }
    | undefined;
  if (
    treasuryIndex < 0 ||
    recipientIndex < 0 ||
    !meta ||
    meta.err ||
    !callsProgram(transaction, config.subscriptionsProgram)
  ) {
    return {
      valid: false as const,
      confirmationStatus: finality?.confirmationStatus ?? ("processed" as const),
    };
  }
  const treasuryBefore = tokenAmountAt(meta.preTokenBalances, treasuryIndex, config.canonicalMint);
  const treasuryAfter = tokenAmountAt(meta.postTokenBalances, treasuryIndex, config.canonicalMint);
  const recipientBefore = tokenAmountAt(
    meta.preTokenBalances,
    recipientIndex,
    config.canonicalMint,
  );
  const recipientAfter = tokenAmountAt(
    meta.postTokenBalances,
    recipientIndex,
    config.canonicalMint,
  );
  const valid =
    treasuryBefore - treasuryAfter === amount && recipientAfter - recipientBefore === amount;
  return { valid, confirmationStatus: finality?.confirmationStatus ?? ("processed" as const) };
}

export async function getSignatureFinality(config: SafeSpendServerConfig, signature: string) {
  const result = await rpc<{ value: Array<{ confirmationStatus?: string; err?: unknown } | null> }>(
    config,
    "getSignatureStatuses",
    [[signature], { searchTransactionHistory: true }],
  );
  const status = result.value[0];
  if (!status) return null;
  if (status.err) return { confirmationStatus: "failed" as const };
  return {
    confirmationStatus:
      status.confirmationStatus === "finalized"
        ? ("finalized" as const)
        : status.confirmationStatus === "confirmed"
          ? ("confirmed" as const)
          : ("processed" as const),
  };
}
