import "server-only";

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import path from "node:path";
import bs58 from "bs58";
import { z } from "zod";
import type {
  SignedVendorPolicyDocument,
  VendorPolicyBinding,
  VendorPolicyDocument,
} from "@/lib/safespend-types";
import {
  GENESIS_POLICY_HASH,
  vendorPolicyHash,
  vendorPolicySigningMessage,
  VENDOR_POLICY_SCHEMA,
} from "./vendor-policy-canonical";
import {
  createRemoteState,
  readRemoteState,
  usesRemoteState,
  writeRemoteState,
} from "./state-store";

export {
  GENESIS_POLICY_HASH,
  vendorPolicyHash,
  vendorPolicySigningMessage,
  VENDOR_POLICY_SCHEMA,
} from "./vendor-policy-canonical";

const AddressSchema = z.string().min(32).max(64);
const VendorPolicyBindingSchema = z
  .object({
    vendor: z
      .object({
        vendor_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
        recipient_wallet: AddressSchema,
        amount_per_period_base_units: z.number().int().positive().safe(),
        period_seconds: z.union([z.literal(86_400), z.literal(604_800), z.literal(2_592_000)]),
      })
      .strict(),
    display_name: z.string().trim().min(1).max(80),
    recipient_token_account: AddressSchema,
    recurring_delegation: AddressSchema,
    delegation_nonce: z.number().int().positive().safe(),
    treasury_token_account: AddressSchema,
    start_ts: z.number().int().positive().safe(),
    expiry_ts: z.number().int().positive().safe(),
    activated_policy_version: z.number().int().positive().safe(),
  })
  .strict();

const VendorPolicyDocumentSchema = z
  .object({
    schema: z.literal(VENDOR_POLICY_SCHEMA),
    version: z.number().int().positive().safe(),
    previous_policy_hash: z.string().regex(/^[0-9a-f]{64}$/),
    issued_at_ts: z.number().int().positive().safe(),
    founder_wallet: AddressSchema,
    treasury_owner: AddressSchema,
    subscriptions_program: AddressSchema,
    token_program: AddressSchema,
    canonical_mint: AddressSchema,
    session_delegate: AddressSchema,
    // An empty founder-signed policy is an intentional deny-all state.
    vendors: z.array(VendorPolicyBindingSchema).max(64),
  })
  .strict();

export function parseVendorPolicyDocument(value: unknown): VendorPolicyDocument {
  return VendorPolicyDocumentSchema.parse(value) as VendorPolicyDocument;
}

const SignedVendorPolicySchema = z
  .object({
    document: VendorPolicyDocumentSchema,
    policy_hash: z.string().regex(/^[0-9a-f]{64}$/),
    signature_base64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();

export type VendorPolicyBoundaries = {
  treasuryOwner: string;
  subscriptionsProgram: string;
  tokenProgram: string;
  canonicalMint: string;
  sessionDelegate: string;
};

function stateDirectory() {
  if (process.env.SAFESPEND_DASHBOARD_STATE_DIR)
    return path.resolve(process.env.SAFESPEND_DASHBOARD_STATE_DIR, "vendor-policies");
  return process.cwd().endsWith(`${path.sep}dashboard`)
    ? path.resolve(process.cwd(), ".safespend/vendor-policies")
    : path.resolve(process.cwd(), "dashboard/.safespend/vendor-policies");
}

function activePath() {
  return path.join(stateDirectory(), "active.json");
}

function assertAddress(value: string, label: string) {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new Error(`${label} is not a valid Solana public key.`);
  }
  if (decoded.length !== 32) throw new Error(`${label} is not a 32-byte Solana public key.`);
  return decoded;
}

export function validateSignedVendorPolicy(
  value: unknown,
  boundaries: VendorPolicyBoundaries,
): SignedVendorPolicyDocument {
  const signed = SignedVendorPolicySchema.parse(value) as SignedVendorPolicyDocument;
  const document = signed.document;
  if (
    document.founder_wallet !== boundaries.treasuryOwner ||
    document.treasury_owner !== boundaries.treasuryOwner ||
    document.subscriptions_program !== boundaries.subscriptionsProgram ||
    document.token_program !== boundaries.tokenProgram ||
    document.canonical_mint !== boundaries.canonicalMint ||
    document.session_delegate !== boundaries.sessionDelegate
  ) {
    throw new Error("Signed vendor policy does not match protected treasury boundaries.");
  }
  if (document.version === 1 && document.previous_policy_hash !== GENESIS_POLICY_HASH) {
    throw new Error("The first signed vendor policy does not reference the genesis hash.");
  }
  const ids = new Set<string>();
  for (const binding of document.vendors) {
    if (ids.has(binding.vendor.vendor_id))
      throw new Error("Signed vendor policy has duplicate IDs.");
    ids.add(binding.vendor.vendor_id);
    if (
      binding.expiry_ts <= binding.start_ts ||
      binding.activated_policy_version > document.version
    ) {
      throw new Error(`Signed vendor policy has invalid terms for ${binding.vendor.vendor_id}.`);
    }
    assertAddress(binding.vendor.recipient_wallet, "Recipient wallet");
    assertAddress(binding.recipient_token_account, "Recipient token account");
    assertAddress(binding.recurring_delegation, "Recurring delegation");
    assertAddress(binding.treasury_token_account, "Treasury token account");
  }
  const expectedHash = vendorPolicyHash(document);
  if (signed.policy_hash !== expectedHash)
    throw new Error("Signed vendor policy hash does not match its fields.");
  const rawFounder = assertAddress(document.founder_wallet, "Founder wallet");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(rawFounder)]),
    format: "der",
    type: "spki",
  });
  const signature = Buffer.from(signed.signature_base64, "base64");
  if (
    signature.length !== 64 ||
    !verify(
      null,
      Buffer.from(vendorPolicySigningMessage(document, signed.policy_hash), "utf8"),
      publicKey,
      signature,
    )
  ) {
    throw new Error("Signed vendor policy signature is invalid.");
  }
  return signed;
}

export async function readActiveVendorPolicy(): Promise<SignedVendorPolicyDocument | null> {
  if (usesRemoteState()) {
    const remote = await readRemoteState<unknown>("vendor-policies/active");
    if (remote !== null) {
      return SignedVendorPolicySchema.parse(remote) as SignedVendorPolicyDocument;
    }
  }
  try {
    return SignedVendorPolicySchema.parse(
      JSON.parse(await readFile(activePath(), "utf8")),
    ) as SignedVendorPolicyDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new Error("Active vendor policy store is invalid; SafeSpend failed closed.");
    }
    throw error;
  }
}

export async function readVendorPolicyVersion(
  version: number,
): Promise<SignedVendorPolicyDocument | null> {
  if (!Number.isSafeInteger(version) || version < 1) return null;
  if (usesRemoteState()) {
    const remote = await readRemoteState<unknown>(
      `vendor-policies/v${String(version).padStart(6, "0")}`,
    );
    if (remote !== null) {
      return SignedVendorPolicySchema.parse(remote) as SignedVendorPolicyDocument;
    }
  }
  const immutablePath = path.join(stateDirectory(), `v${String(version).padStart(6, "0")}.json`);
  try {
    return SignedVendorPolicySchema.parse(
      JSON.parse(await readFile(immutablePath, "utf8")),
    ) as SignedVendorPolicyDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Immutable vendor policy v${version} is invalid; SafeSpend failed closed.`);
  }
}

let vendorPolicyWriteQueue = Promise.resolve();

async function publishVendorPolicyNow(
  signed: SignedVendorPolicyDocument,
  audit: {
    action: "add" | "update" | "delete";
    delegationSignature: string;
    founderWallet: string;
    vendorId: string;
    finalizedAt: string;
  },
) {
  const directory = stateDirectory();
  const body = `${JSON.stringify(signed, null, 2)}\n`;
  const current = await readActiveVendorPolicy();
  const expectedVersion = current ? current.document.version + 1 : 1;
  const expectedPrevious = current?.policy_hash ?? GENESIS_POLICY_HASH;
  if (
    signed.document.version !== expectedVersion ||
    signed.document.previous_policy_hash !== expectedPrevious
  ) {
    throw new Error("Active vendor policy changed before atomic publication.");
  }
  const immutablePath = path.join(
    directory,
    `v${String(signed.document.version).padStart(6, "0")}.json`,
  );
  const remoteKey = `vendor-policies/v${String(signed.document.version).padStart(6, "0")}`;
  const remoteCreated = await createRemoteState(remoteKey, signed);
  if (remoteCreated !== null) {
    if (!remoteCreated) {
      const existing = await readRemoteState<unknown>(remoteKey);
      if (JSON.stringify(existing) !== JSON.stringify(signed)) {
        throw new Error("A different immutable policy already occupies this version.");
      }
    }
    const auditKey = "vendor-policies/audit";
    const auditRows = (await readRemoteState<unknown[]>(auditKey)) ?? [];
    const auditRow = {
      schema: "safespend-vendor-policy-audit-v1",
      version: signed.document.version,
      previousPolicyHash: signed.document.previous_policy_hash,
      policyHash: signed.policy_hash,
      policySignatureBase64: signed.signature_base64,
      ...audit,
    };
    await writeRemoteState(auditKey, [
      ...auditRows
        .filter(
          (row) =>
            !row ||
            typeof row !== "object" ||
            (row as { policyHash?: string }).policyHash !== signed.policy_hash,
        )
        .slice(-999),
      auditRow,
    ]);
    await writeRemoteState("vendor-policies/active", signed);
    return;
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(immutablePath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(immutablePath, "utf8");
    if (existing !== body) {
      throw new Error("A different immutable policy already occupies this version.");
    }
  }
  await appendFile(
    path.join(directory, "audit.jsonl"),
    `${JSON.stringify({
      schema: "safespend-vendor-policy-audit-v1",
      version: signed.document.version,
      previousPolicyHash: signed.document.previous_policy_hash,
      policyHash: signed.policy_hash,
      policySignatureBase64: signed.signature_base64,
      ...audit,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const temporary = `${activePath()}.${process.pid}.tmp`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, activePath());
}

export async function publishVendorPolicy(
  signed: SignedVendorPolicyDocument,
  audit: {
    action: "add" | "update" | "delete";
    delegationSignature: string;
    founderWallet: string;
    vendorId: string;
    finalizedAt: string;
  },
) {
  vendorPolicyWriteQueue = vendorPolicyWriteQueue
    .catch(() => undefined)
    .then(() => publishVendorPolicyNow(signed, audit));
  await vendorPolicyWriteQueue;
}

export function liveVendorFromBinding(
  binding: VendorPolicyBinding,
  policyHash: string,
): Omit<import("@/lib/safespend-types").LiveVendor, "allowance"> {
  return {
    id: binding.vendor.vendor_id,
    name: binding.display_name,
    category: "Operations",
    recipientWallet: binding.vendor.recipient_wallet,
    recipientTokenAccount: binding.recipient_token_account,
    recurringDelegation: binding.recurring_delegation,
    amountBaseUnits: String(binding.vendor.amount_per_period_base_units),
    periodSeconds: binding.vendor.period_seconds,
    delegationNonce: binding.delegation_nonce,
    startAt: new Date(binding.start_ts * 1000).toISOString(),
    expiryAt: new Date(binding.expiry_ts * 1000).toISOString(),
    policyVersion: binding.activated_policy_version,
    policyHash,
    enrollmentStatus: "active",
  };
}
