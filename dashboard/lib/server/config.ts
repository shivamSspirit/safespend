import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LiveVendor } from "@/lib/safespend-types";

export type ProtectedVendor = Omit<LiveVendor, "allowance">;

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const SUBSCRIPTIONS_PROGRAM = "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44";

const VendorPolicySchema = z
  .object({
    vendor_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
    recipient_wallet: z.string().min(32).max(64),
    amount_per_period_base_units: z.number().int().positive().safe(),
    period_seconds: z.number().int().positive().safe(),
  })
  .strict();

const PolicySchema = z
  .object({
    cluster: z.literal("devnet"),
    allow_mainnet: z.literal(false),
    subscriptions_program: z.literal(SUBSCRIPTIONS_PROGRAM),
    token_program: z.string().min(32).max(64),
    canonical_mint: z.string().min(32).max(64),
    treasury_owner: z.string().min(32).max(64),
    session_delegate: z.string().min(32).max(64),
    weekly_burn_base_units: z.number().int().positive().safe(),
    minimum_runway_weeks: z.number().int().nonnegative().safe(),
    minimum_token_reserve_base_units: z.number().int().nonnegative().safe(),
    minimum_sol_reserve_lamports: z.number().int().nonnegative().safe(),
    minimum_session_fee_reserve_lamports: z.number().int().nonnegative().safe(),
    expiry_safety_buffer_seconds: z.number().int().nonnegative().safe(),
    vendors: z.array(VendorPolicySchema).min(1).max(32),
  })
  .strict();

const VendorAccountsSchema = z
  .object({
    vendor_id: z.string(),
    recurring_delegation: z.string().min(32).max(64),
    delegation_nonce: z.number().int().nonnegative().safe(),
    treasury_token_account: z.string().min(32).max(64),
    recipient_token_account: z.string().min(32).max(64),
  })
  .strict();

const PaymentExportSchema = z
  .object({
    rpc_url: z.string().url(),
    expected_genesis_hash: z.literal(DEVNET_GENESIS_HASH),
    token_decimals: z.string().regex(/^\d+$/),
    policy_json: z.string().min(2),
    vendor_accounts_json: z.string().min(2),
  })
  .strict();

function workspaceCandidates(relativePath: string) {
  return [
    path.resolve(/* turbopackIgnore: true */ process.cwd(), relativePath),
    path.resolve(/* turbopackIgnore: true */ process.cwd(), "..", relativePath),
  ];
}

async function firstReadable(paths: string[]) {
  for (const candidate of paths) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next deterministic workspace location.
    }
  }
  throw new Error(`SafeSpend runtime export not found. Expected ${paths.join(" or ")}.`);
}

function displayName(vendorId: string) {
  return vendorId
    .split(/[-_]/g)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export type SafeSpendServerConfig = {
  rpcUrl: string;
  rpcProvider: string;
  expectedGenesisHash: string;
  tokenDecimals: number;
  tokenProgram: string;
  canonicalMint: string;
  treasuryOwner: string;
  treasuryTokenAccount: string;
  sessionDelegate: string;
  subscriptionsProgram: string;
  weeklyBurnBaseUnits: bigint;
  minimumRunwayWeeks: number;
  minimumTokenReserveBaseUnits: bigint;
  minimumSolReserveLamports: bigint;
  minimumSessionFeeReserveLamports: bigint;
  expirySafetyBufferSeconds: bigint;
  vendors: ProtectedVendor[];
};

let cachedConfig: SafeSpendServerConfig | undefined;

export async function loadSafeSpendServerConfig(): Promise<SafeSpendServerConfig> {
  if (cachedConfig) return cachedConfig;

  const configured = process.env.SAFESPEND_PAYMENT_CONFIG;
  const exportPath = configured
    ? path.resolve(/* turbopackIgnore: true */ configured)
    : await firstReadable(workspaceCandidates(".dev/devnet-payment-config.json"));
  const rawExport = PaymentExportSchema.parse(JSON.parse(await readFile(exportPath, "utf8")));
  const policy = PolicySchema.parse(JSON.parse(rawExport.policy_json));
  const mappings = z.array(VendorAccountsSchema).parse(JSON.parse(rawExport.vendor_accounts_json));
  const tokenDecimals = Number(rawExport.token_decimals);
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
    throw new Error("Protected token decimals are outside the supported range.");
  }

  const vendorIds = new Set(policy.vendors.map((vendor) => vendor.vendor_id));
  if (vendorIds.size !== policy.vendors.length || mappings.length !== policy.vendors.length) {
    throw new Error("Protected vendor mappings are duplicated or incomplete.");
  }

  const vendors = policy.vendors.map((vendor): ProtectedVendor => {
    const mapping = mappings.find((candidate) => candidate.vendor_id === vendor.vendor_id);
    if (!mapping || mapping.treasury_token_account !== mappings[0]?.treasury_token_account) {
      throw new Error(`Protected account mapping is invalid for vendor ${vendor.vendor_id}.`);
    }
    return {
      id: vendor.vendor_id,
      name: displayName(vendor.vendor_id),
      category: vendor.vendor_id === "hosting" ? "Infrastructure" : "Operations",
      recipientWallet: vendor.recipient_wallet,
      recipientTokenAccount: mapping.recipient_token_account,
      recurringDelegation: mapping.recurring_delegation,
      amountBaseUnits: String(vendor.amount_per_period_base_units),
      periodSeconds: vendor.period_seconds,
    };
  });

  cachedConfig = {
    rpcUrl: rawExport.rpc_url,
    rpcProvider: new URL(rawExport.rpc_url).hostname,
    expectedGenesisHash: rawExport.expected_genesis_hash,
    tokenDecimals,
    tokenProgram: policy.token_program,
    canonicalMint: policy.canonical_mint,
    treasuryOwner: policy.treasury_owner,
    treasuryTokenAccount: mappings[0].treasury_token_account,
    sessionDelegate: policy.session_delegate,
    subscriptionsProgram: policy.subscriptions_program,
    weeklyBurnBaseUnits: BigInt(policy.weekly_burn_base_units),
    minimumRunwayWeeks: policy.minimum_runway_weeks,
    minimumTokenReserveBaseUnits: BigInt(policy.minimum_token_reserve_base_units),
    minimumSolReserveLamports: BigInt(policy.minimum_sol_reserve_lamports),
    minimumSessionFeeReserveLamports: BigInt(policy.minimum_session_fee_reserve_lamports),
    expirySafetyBufferSeconds: BigInt(policy.expiry_safety_buffer_seconds),
    vendors,
  };
  return cachedConfig;
}

export function findProtectedVendor(
  config: SafeSpendServerConfig,
  vendorId: string,
  amount: bigint,
) {
  const vendor = config.vendors.find((candidate) => candidate.id === vendorId);
  if (!vendor) throw new Error("Vendor is not present in protected configuration.");
  if (BigInt(vendor.amountBaseUnits) !== amount) {
    throw new Error("Amount does not equal the protected per-period allowance.");
  }
  return vendor;
}
