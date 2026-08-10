import assert from "node:assert/strict";
import test from "node:test";
import type { VendorPolicyDocument } from "@/lib/safespend-types";
import { vendorPolicyHash, vendorPolicySigningMessage } from "./vendor-policy-canonical";

const treasury = "7YwNV7uN4fuzkaUxC9z1uSXLVfECygqnK9YVJ2QkD8bM";
const vendor = "9MTbYdTTgYbcR9tVhbkLhRMozUskdQZb7ZtawKxvGwWJ";

function document(): VendorPolicyDocument {
  return {
    schema: "safespend-vendor-policy-v1",
    version: 7,
    previous_policy_hash: "11".repeat(32),
    issued_at_ts: 1_800_000_000,
    founder_wallet: treasury,
    treasury_owner: treasury,
    subscriptions_program: "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44",
    token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    canonical_mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    session_delegate: "8Fv8uEUTQGZjkYhiBL8tE7wNb9UtvA8rvQWc2wKcYpQG",
    vendors: [
      {
        vendor: {
          vendor_id: "hosting",
          recipient_wallet: vendor,
          amount_per_period_base_units: 12_000_000,
          period_seconds: 604_800,
        },
        display_name: "Hosting",
        recipient_token_account: vendor,
        recurring_delegation: vendor,
        delegation_nonce: 42,
        treasury_token_account: vendor,
        start_ts: 1_800_000_100,
        expiry_ts: 1_831_536_100,
        activated_policy_version: 7,
      },
    ],
  };
}

test("canonical vendor policy hash matches the Rust fixture", () => {
  assert.equal(
    vendorPolicyHash(document()),
    "ec1cee12e6743a19e8e147e94c8f9cd1cf3b925593b29dfc4d89d464f4bec576",
  );
});

test("recipient mutation changes the canonical policy hash", () => {
  const original = document();
  const mutated = document();
  mutated.vendors[0].vendor.recipient_wallet = mutated.session_delegate;
  assert.notEqual(vendorPolicyHash(original), vendorPolicyHash(mutated));
});

test("signing message binds version, prior hash, policy hash, and treasury", () => {
  const value = document();
  const hash = vendorPolicyHash(value);
  assert.equal(
    vendorPolicySigningMessage(value, hash),
    `SafeSpend vendor policy\nschema=safespend-vendor-policy-v1\nversion=7\nprevious_policy_hash=${"11".repeat(32)}\npolicy_hash=${hash}\ntreasury_owner=${treasury}\ncluster=solana-devnet\n`,
  );
});
