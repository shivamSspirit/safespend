import { appendFile, cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import path from "node:path";
import bs58 from "bs58";
import type { SignedVendorPolicyDocument } from "../lib/safespend-types";
import {
  vendorPolicyHash,
  vendorPolicySigningMessage,
} from "../lib/server/vendor-policy-canonical";

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const PKCS8_ED25519_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name}.`);
  return value;
}

function revocations() {
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] !== "--revocation") continue;
    const raw = process.argv[index + 1] ?? "";
    const separator = raw.indexOf("=");
    const vendorId = raw.slice(0, separator);
    const signature = raw.slice(separator + 1);
    if (separator <= 0 || !SIGNATURE_PATTERN.test(signature)) {
      throw new Error("Each --revocation must be vendor-id=devnet-signature.");
    }
    if (values.has(vendorId)) throw new Error(`Duplicate revocation for ${vendorId}.`);
    values.set(vendorId, signature);
    index += 1;
  }
  return values;
}

async function exists(value: string) {
  try {
    await stat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function main() {
  const keypairPath = path.resolve(argument("founder-keypair"));
  const stateRoot = path.resolve(process.cwd(), ".safespend");
  const policyDirectory = path.join(stateRoot, "vendor-policies");
  const activePath = path.join(policyDirectory, "active.json");
  const requestsPath = path.join(stateRoot, "requests.json");
  const proposalsPath = path.join(stateRoot, "vendor-proposals");
  const active = JSON.parse(await readFile(activePath, "utf8")) as SignedVendorPolicyDocument;
  const secret = Uint8Array.from(JSON.parse(await readFile(keypairPath, "utf8")) as number[]);
  if (secret.length !== 64) throw new Error("Founder keypair must contain exactly 64 bytes.");
  const founder = bs58.encode(secret.subarray(32));
  if (founder !== active.document.founder_wallet) {
    throw new Error("Founder keypair does not match the active vendor policy.");
  }

  const revoked = revocations();
  const vendorIds = active.document.vendors.map((binding) => binding.vendor.vendor_id);
  if (revoked.size !== vendorIds.length || vendorIds.some((vendorId) => !revoked.has(vendorId))) {
    throw new Error("A finalized revocation signature is required for every active vendor.");
  }

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const archive = path.join(stateRoot, "archive", `reset-${timestamp}`);
  await mkdir(archive, { recursive: true, mode: 0o700 });
  await cp(activePath, path.join(archive, "active-before-reset.json"));
  if (await exists(requestsPath)) {
    await cp(requestsPath, path.join(archive, "requests-before-reset.json"));
  }
  if (await exists(proposalsPath)) {
    await rename(proposalsPath, path.join(archive, "vendor-proposals"));
  }

  const document = {
    ...active.document,
    version: active.document.version + 1,
    previous_policy_hash: active.policy_hash,
    issued_at_ts: Math.floor(Date.now() / 1000),
    vendors: [],
  };
  const policyHash = vendorPolicyHash(document);
  const signingMessage = vendorPolicySigningMessage(document, policyHash);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_SEED_PREFIX, Buffer.from(secret.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  const policySignature = sign(null, Buffer.from(signingMessage, "utf8"), privateKey);
  if (
    !verify(null, Buffer.from(signingMessage, "utf8"), createPublicKey(privateKey), policySignature)
  ) {
    throw new Error("Generated founder policy signature did not verify.");
  }
  const signed: SignedVendorPolicyDocument = {
    document,
    policy_hash: policyHash,
    signature_base64: policySignature.toString("base64"),
  };
  const body = `${JSON.stringify(signed, null, 2)}\n`;
  const immutablePath = path.join(
    policyDirectory,
    `v${String(document.version).padStart(6, "0")}.json`,
  );
  await writeFile(immutablePath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await appendFile(
    path.join(policyDirectory, "audit.jsonl"),
    `${JSON.stringify({
      schema: "safespend-vendor-policy-audit-v1",
      action: "reset",
      version: document.version,
      previousPolicyHash: document.previous_policy_hash,
      policyHash,
      policySignatureBase64: signed.signature_base64,
      founderWallet: founder,
      vendorIds,
      delegationSignatures: Object.fromEntries(revoked),
      finalizedAt: new Date().toISOString(),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const activeTemporary = `${activePath}.${process.pid}.tmp`;
  await writeFile(activeTemporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(activeTemporary, activePath);
  const requestsTemporary = `${requestsPath}.${process.pid}.tmp`;
  await writeFile(requestsTemporary, '{"version":1,"payments":[]}\n', {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(requestsTemporary, requestsPath);

  process.stdout.write(
    `${JSON.stringify({
      status: "reset",
      policyVersion: document.version,
      policyHash,
      removedVendors: vendorIds,
      paymentRecordsCleared: true,
      archive,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`SafeSpend dashboard reset failed: ${String(error)}\n`);
  process.exitCode = 1;
});
