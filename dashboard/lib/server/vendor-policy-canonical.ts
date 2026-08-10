import { createHash } from "node:crypto";
import type { VendorPolicyDocument } from "@/lib/safespend-types";

export const VENDOR_POLICY_SCHEMA = "safespend-vendor-policy-v1" as const;
export const GENESIS_POLICY_HASH = "0".repeat(64);

function hashField(hash: ReturnType<typeof createHash>, label: string, value: Buffer) {
  const labelBytes = Buffer.from(label, "utf8");
  const labelLength = Buffer.alloc(8);
  labelLength.writeBigUInt64BE(BigInt(labelBytes.length));
  const valueLength = Buffer.alloc(8);
  valueLength.writeBigUInt64BE(BigInt(value.length));
  hash.update(labelLength).update(labelBytes).update(valueLength).update(value);
}

function hashText(hash: ReturnType<typeof createHash>, label: string, value: string) {
  hashField(hash, label, Buffer.from(value, "utf8"));
}

function hashU64(hash: ReturnType<typeof createHash>, label: string, value: number) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  hashField(hash, label, bytes);
}

export function vendorPolicyHash(document: VendorPolicyDocument) {
  const hash = createHash("sha256");
  hashText(hash, "schema", document.schema);
  hashU64(hash, "version", document.version);
  hashText(hash, "previous_policy_hash", document.previous_policy_hash);
  hashU64(hash, "issued_at_ts", document.issued_at_ts);
  hashText(hash, "founder_wallet", document.founder_wallet);
  hashText(hash, "treasury_owner", document.treasury_owner);
  hashText(hash, "subscriptions_program", document.subscriptions_program);
  hashText(hash, "token_program", document.token_program);
  hashText(hash, "canonical_mint", document.canonical_mint);
  hashText(hash, "session_delegate", document.session_delegate);
  for (const binding of document.vendors) {
    hashText(hash, "vendor_id", binding.vendor.vendor_id);
    hashText(hash, "display_name", binding.display_name);
    hashText(hash, "recipient_wallet", binding.vendor.recipient_wallet);
    hashText(hash, "recipient_token_account", binding.recipient_token_account);
    hashText(hash, "recurring_delegation", binding.recurring_delegation);
    hashU64(hash, "delegation_nonce", binding.delegation_nonce);
    hashText(hash, "treasury_token_account", binding.treasury_token_account);
    hashU64(hash, "amount_per_period", binding.vendor.amount_per_period_base_units);
    hashU64(hash, "period_seconds", binding.vendor.period_seconds);
    hashU64(hash, "start_ts", binding.start_ts);
    hashU64(hash, "expiry_ts", binding.expiry_ts);
    hashU64(hash, "activated_policy_version", binding.activated_policy_version);
  }
  return hash.digest("hex");
}

export function vendorPolicySigningMessage(document: VendorPolicyDocument, policyHash: string) {
  return `SafeSpend vendor policy\nschema=${document.schema}\nversion=${document.version}\nprevious_policy_hash=${document.previous_policy_hash}\npolicy_hash=${policyHash}\ntreasury_owner=${document.treasury_owner}\ncluster=solana-devnet\n`;
}
