import "server-only";

import { randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import type {
  SignedVendorPolicyDocument,
  VendorCadence,
  VendorEnrollmentProposal,
  VendorEnrollmentResult,
  VendorPolicyBinding,
  VendorPolicyDocument,
} from "@/lib/safespend-types";
import { loadSafeSpendServerConfig, type SafeSpendServerConfig } from "./config";
import {
  GENESIS_POLICY_HASH,
  parseVendorPolicyDocument,
  publishVendorPolicy,
  readActiveVendorPolicy,
  readVendorPolicyVersion,
  validateSignedVendorPolicy,
  vendorPolicyHash,
  vendorPolicySigningMessage,
  VENDOR_POLICY_SCHEMA,
} from "./vendor-policy-store";
import { readPayments } from "./request-store";
import {
  createRecipientTokenAccountInstruction,
  createRevokeDelegationInstruction,
  deriveRecipientTokenAccount,
  replacementDelegationStartTs,
  reviewedTransactionMismatch,
  SYSTEM_PROGRAM,
} from "./vendor-enrollment-transaction";
import {
  createRemoteState,
  readRemoteState,
  usesRemoteState,
  writeRemoteState,
} from "./state-store";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const MAX_RPC_RESPONSE_BYTES = 1_048_576;
const PROPOSAL_TTL_SECONDS = 8 * 60;
const DELEGATION_LIFETIME_SECONDS = 365 * 86_400;

const CADENCE_SECONDS: Record<VendorCadence, number> = {
  daily: 86_400,
  weekly: 604_800,
  monthly: 2_592_000,
};

const PreviewSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    recipientWallet: z.string().trim().min(32).max(64),
    amountTokens: z.string().trim().min(1).max(32),
    cadence: z.enum(["daily", "weekly", "monthly"]),
    founderWallet: z.string().trim().min(32).max(64),
  })
  .strict();

const UpdatePreviewSchema = PreviewSchema.extend({
  vendorId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
}).strict();

const DeletePreviewSchema = z
  .object({
    vendorId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
    founderWallet: z.string().trim().min(32).max(64),
  })
  .strict();

const ActivationSchema = z
  .object({
    proposalId: z.string().uuid(),
    policySignatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    signedTransactionBase64: z.string().min(100).max(4_000),
  })
  .strict();

type StoredProposal = {
  proposalId: string;
  createdAtTs: number;
  expiresAtTs: number;
  document: VendorPolicyDocument;
  policyHash: string;
  signingMessage: string;
  unsignedTransactionBase64: string;
  transactionMessageBase64: string;
  review: VendorEnrollmentProposal["review"];
  submissionSignature?: string;
};

function proposalDirectory() {
  if (process.env.SAFESPEND_DASHBOARD_STATE_DIR)
    return path.resolve(process.env.SAFESPEND_DASHBOARD_STATE_DIR, "vendor-proposals");
  return process.cwd().endsWith(`${path.sep}dashboard`)
    ? path.resolve(process.cwd(), ".safespend/vendor-proposals")
    : path.resolve(process.cwd(), "dashboard/.safespend/vendor-proposals");
}

function proposalPath(id: string) {
  return path.join(proposalDirectory(), `${id}.json`);
}

async function writeProposal(proposal: StoredProposal, exclusive = false) {
  if (usesRemoteState()) {
    const key = `vendor-proposals/${proposal.proposalId}`;
    if (exclusive) {
      if (!(await createRemoteState(key, proposal))) {
        const error = new Error("Vendor proposal already exists.") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
    } else {
      await writeRemoteState(key, proposal);
    }
    return;
  }
  const directory = proposalDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(proposal, null, 2)}\n`;
  if (exclusive) {
    await writeFile(proposalPath(proposal.proposalId), body, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return;
  }
  const temporary = `${proposalPath(proposal.proposalId)}.${process.pid}.tmp`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, proposalPath(proposal.proposalId));
}

async function readProposal(id: string): Promise<StoredProposal> {
  let parsed: unknown;
  try {
    parsed = usesRemoteState()
      ? await readRemoteState(`vendor-proposals/${id}`)
      : JSON.parse(await readFile(proposalPath(id), "utf8"));
    if (parsed === null) {
      const error = new Error("Vendor proposal not found.") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Vendor enrollment proposal was not found or has expired.");
    }
    throw new Error("Vendor enrollment proposal store is invalid; SafeSpend failed closed.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Vendor proposal is invalid.");
  const proposal = parsed as StoredProposal;
  if (
    proposal.proposalId !== id ||
    !Number.isSafeInteger(proposal.createdAtTs) ||
    !Number.isSafeInteger(proposal.expiresAtTs) ||
    typeof proposal.policyHash !== "string" ||
    typeof proposal.signingMessage !== "string" ||
    typeof proposal.unsignedTransactionBase64 !== "string" ||
    typeof proposal.transactionMessageBase64 !== "string" ||
    !["add", "update", "delete"].includes(proposal.review?.action)
  ) {
    throw new Error("Vendor enrollment proposal is malformed; SafeSpend failed closed.");
  }
  proposal.document = parseVendorPolicyDocument(proposal.document);
  let reviewedTransaction: Transaction;
  try {
    reviewedTransaction = Transaction.from(
      Buffer.from(proposal.unsignedTransactionBase64, "base64"),
    );
  } catch {
    throw new Error("Vendor enrollment proposal transaction is malformed.");
  }
  if (
    vendorPolicyHash(proposal.document) !== proposal.policyHash ||
    vendorPolicySigningMessage(proposal.document, proposal.policyHash) !==
      proposal.signingMessage ||
    reviewedTransaction.serializeMessage().toString("base64") !== proposal.transactionMessageBase64
  ) {
    throw new Error("Vendor enrollment proposal integrity check failed.");
  }
  return proposal;
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
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (text.length > MAX_RPC_RESPONSE_BYTES) throw new Error("Solana RPC response was too large.");
  if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}.`);
  const body = JSON.parse(text) as { result?: T; error?: { message?: string } };
  if (body.error || body.result === undefined) {
    throw new Error(body.error?.message ?? `Solana RPC method ${method} failed.`);
  }
  return body.result;
}

function publicKey(value: string, label: string) {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid Solana public key.`);
  }
}

function slug(displayName: string) {
  const value = displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)) {
    throw new Error("Vendor name must contain letters or numbers so SafeSpend can create an ID.");
  }
  return value;
}

function amountBaseUnits(value: string, decimals: number) {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error("Amount must be a positive decimal token amount.");
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`Amount supports at most ${decimals} decimal places for this mint.`);
  }
  const units = BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
  if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount is outside SafeSpend's supported positive range.");
  }
  return units;
}

function displayTokenAmount(units: bigint, decimals: number) {
  const padded = units.toString().padStart(decimals + 1, "0");
  const whole = decimals ? padded.slice(0, -decimals) : padded;
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, "") : "";
  return fraction ? `${whole}.${fraction}` : whole;
}

function u64Le(value: number) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function writeI64(buffer: Buffer, offset: number, value: number) {
  buffer.writeBigInt64LE(BigInt(value), offset);
}

function decodeSubscriptionAuthority(data: Buffer, treasuryOwner: PublicKey, mint: PublicKey) {
  if (
    data.length < 106 ||
    !new PublicKey(data.subarray(1, 33)).equals(treasuryOwner) ||
    !new PublicKey(data.subarray(33, 65)).equals(mint)
  ) {
    throw new Error("Subscription authority does not match the protected treasury and mint.");
  }
  const initId = data.readBigInt64LE(98);
  if (initId <= 0n || initId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Subscription authority init ID is invalid.");
  }
  return Number(initId);
}

type BinaryAccount = { value: { owner: string; data: [string, "base64"] } | null };

async function binaryAccount(config: SafeSpendServerConfig, address: string) {
  const result = await rpc<BinaryAccount>(config, "getAccountInfo", [
    address,
    { encoding: "base64", commitment: "finalized" },
  ]);
  return result.value
    ? { owner: result.value.owner, data: Buffer.from(result.value.data[0], "base64") }
    : null;
}

async function validateRecipientTokenAccount(
  config: SafeSpendServerConfig,
  recipientWallet: PublicKey,
) {
  const mint = publicKey(config.canonicalMint, "Canonical mint");
  const tokenProgram = publicKey(config.tokenProgram, "Token program");
  const ata = deriveRecipientTokenAccount(recipientWallet, mint, tokenProgram);
  const result = await rpc<{
    value: {
      owner: string;
      data:
        | { parsed?: { info?: { mint?: string; owner?: string; state?: string } } }
        | [string, string];
    } | null;
  }>(config, "getAccountInfo", [
    ata.toBase58(),
    { encoding: "jsonParsed", commitment: "finalized" },
  ]);
  if (!result.value) return { address: ata, exists: false };
  const info = Array.isArray(result.value.data) ? undefined : result.value.data.parsed?.info;
  if (
    result.value.owner !== config.tokenProgram ||
    info?.mint !== config.canonicalMint ||
    info?.owner !== recipientWallet.toBase58() ||
    info?.state !== "initialized"
  ) {
    throw new Error(
      "Recipient canonical-mint token account is missing or not owned by the recipient wallet.",
    );
  }
  return { address: ata, exists: true };
}

async function assertTransactionSimulation(
  config: SafeSpendServerConfig,
  transactionBase64: string,
) {
  const simulation = await rpc<{
    value: { err: unknown; logs?: string[] | null };
  }>(config, "simulateTransaction", [
    transactionBase64,
    {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    },
  ]);
  if (simulation.value.err) {
    console.error("[safespend-enrollment] transaction simulation failed", {
      error: simulation.value.err,
      logs: simulation.value.logs?.slice(-12),
    });
    throw new Error(
      "Vendor policy transaction simulation failed; no wallet signature was requested.",
    );
  }
}

function decodeDelegationBinding(
  config: SafeSpendServerConfig,
  vendor: SafeSpendServerConfig["vendors"][number],
  account: { owner: string; data: Buffer },
  activatedPolicyVersion: number,
): VendorPolicyBinding {
  const data = account.data;
  if (
    account.owner !== config.subscriptionsProgram ||
    data.length !== 211 ||
    data[0] !== 3 ||
    data[1] === 0 ||
    bs58.encode(data.subarray(3, 35)) !== config.treasuryOwner ||
    bs58.encode(data.subarray(35, 67)) !== config.sessionDelegate ||
    bs58.encode(data.subarray(139, 171)) !== config.canonicalMint
  ) {
    throw new Error(`Existing delegation for ${vendor.id} is invalid; policy import refused.`);
  }
  const start = data.readBigInt64LE(171);
  const period = data.readBigUInt64LE(179);
  const expiry = data.readBigInt64LE(187);
  const amount = data.readBigUInt64LE(195);
  if (
    start <= 0n ||
    expiry <= start ||
    period !== BigInt(vendor.periodSeconds) ||
    amount !== BigInt(vendor.amountBaseUnits) ||
    expiry > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(`Existing delegation terms for ${vendor.id} do not match protected config.`);
  }
  return {
    vendor: {
      vendor_id: vendor.id,
      recipient_wallet: vendor.recipientWallet,
      amount_per_period_base_units: Number(amount),
      period_seconds: Number(period),
    },
    display_name: vendor.name,
    recipient_token_account: vendor.recipientTokenAccount,
    recurring_delegation: vendor.recurringDelegation,
    delegation_nonce: vendor.delegationNonce,
    treasury_token_account: config.treasuryTokenAccount,
    start_ts: Number(start),
    expiry_ts: Number(expiry),
    activated_policy_version: activatedPolicyVersion,
  };
}

async function currentBindings(config: SafeSpendServerConfig, nextVersion: number) {
  const active = await readActiveVendorPolicy();
  if (active) return active.document.vendors;
  const bindings: VendorPolicyBinding[] = [];
  for (const vendor of config.vendors) {
    const account = await binaryAccount(config, vendor.recurringDelegation);
    if (!account) throw new Error(`Existing delegation for ${vendor.id} is missing.`);
    bindings.push(decodeDelegationBinding(config, vendor, account, nextVersion));
  }
  return bindings;
}

async function assertCurrentVersion(document: VendorPolicyDocument) {
  const active = await readActiveVendorPolicy();
  const expectedVersion = active ? active.document.version + 1 : 1;
  const expectedPrevious = active?.policy_hash ?? GENESIS_POLICY_HASH;
  if (document.version !== expectedVersion || document.previous_policy_hash !== expectedPrevious) {
    throw new Error("Vendor policy changed while this enrollment was open. Review it again.");
  }
}

async function historicalCarryover(
  config: SafeSpendServerConfig,
  active: SignedVendorPolicyDocument | null,
  binding: VendorPolicyBinding,
  finalizedNowTs: number,
) {
  const predecessorVersion = binding.activated_policy_version - 1;
  if (!active || predecessorVersion < 1) return { boundaryTs: 0, amountBaseUnits: 0n };
  const previous = await readVendorPolicyVersion(predecessorVersion);
  if (!previous) return { boundaryTs: 0, amountBaseUnits: 0n };
  validateSignedVendorPolicy(previous, {
    treasuryOwner: config.treasuryOwner,
    subscriptionsProgram: config.subscriptionsProgram,
    tokenProgram: config.tokenProgram,
    canonicalMint: config.canonicalMint,
    sessionDelegate: config.sessionDelegate,
  });
  const predecessor = previous.document.vendors.find(
    (candidate) => candidate.vendor.vendor_id === binding.vendor.vendor_id,
  );
  if (!predecessor || predecessor.recurring_delegation === binding.recurring_delegation) {
    return { boundaryTs: 0, amountBaseUnits: 0n };
  }

  let boundaryTs = 0;
  let amountBaseUnits = 0n;
  for (const payment of await readPayments()) {
    if (
      payment.vendorId !== binding.vendor.vendor_id ||
      payment.status !== "finalized" ||
      !payment.signature
    ) {
      continue;
    }
    const paidAtTs = Math.floor(new Date(payment.createdAt).getTime() / 1000);
    if (
      !Number.isSafeInteger(paidAtTs) ||
      paidAtTs < predecessor.start_ts ||
      paidAtTs >= predecessor.expiry_ts
    ) {
      continue;
    }
    const elapsed = paidAtTs - predecessor.start_ts;
    const periodStartTs =
      predecessor.start_ts +
      Math.floor(elapsed / predecessor.vendor.period_seconds) * predecessor.vendor.period_seconds;
    const periodEndTs = Math.min(
      periodStartTs + predecessor.vendor.period_seconds,
      predecessor.expiry_ts,
    );
    if (binding.start_ts < periodEndTs && finalizedNowTs < periodEndTs) {
      boundaryTs = Math.max(boundaryTs, periodEndTs);
      amountBaseUnits += BigInt(payment.amountBaseUnits);
    }
  }
  return { boundaryTs, amountBaseUnits };
}

async function prepareVendorMutation(
  action: "add" | "update" | "delete",
  value: unknown,
): Promise<VendorEnrollmentProposal> {
  const input: {
    founderWallet: string;
    vendorId: string;
    displayName: string;
    recipientWallet: string;
    amountTokens: string;
    cadence: VendorCadence;
  } = (() => {
    if (action === "add") {
      const parsed = PreviewSchema.parse(value);
      return { ...parsed, vendorId: "" };
    }
    if (action === "update") return UpdatePreviewSchema.parse(value);
    const parsed = DeletePreviewSchema.parse(value);
    return {
      ...parsed,
      displayName: "",
      recipientWallet: "",
      amountTokens: "",
      cadence: "monthly",
    };
  })();
  const config = await loadSafeSpendServerConfig();
  if (input.founderWallet !== config.treasuryOwner) {
    throw new Error("Connected wallet is not the protected founder treasury authority.");
  }
  const founder = publicKey(input.founderWallet, "Founder wallet");
  const active = await readActiveVendorPolicy();
  const existing = await currentBindings(config, active ? active.document.version + 1 : 1);
  const vendorId = action === "add" ? slug(input.displayName) : input.vendorId;
  const priorBinding = existing.find((binding) => binding.vendor.vendor_id === vendorId);
  if (action === "add" && priorBinding) {
    throw new Error(`Vendor ID ${vendorId} already exists. Choose a distinct display name.`);
  }
  if (action !== "add" && (!active || !priorBinding)) {
    throw new Error(`Vendor ${vendorId} is not active in the founder-signed policy.`);
  }
  const priorDelegationState = priorBinding
    ? await verifyFinalizedDelegation(config, priorBinding)
    : null;

  const genesis = await rpc<string>(config, "getGenesisHash", []);
  if (genesis !== config.expectedGenesisHash) {
    throw new Error("RPC is not Solana Devnet. Vendor policy change failed closed.");
  }
  const finalizedSlot = await rpc<number>(config, "getSlot", [{ commitment: "finalized" }]);
  const blockTime = await rpc<number | null>(config, "getBlockTime", [finalizedSlot]);
  if (blockTime === null || !Number.isSafeInteger(blockTime) || blockTime <= 0) {
    throw new Error("Finalized Solana time is unavailable.");
  }
  const amount =
    action === "delete"
      ? BigInt(priorBinding!.vendor.amount_per_period_base_units)
      : amountBaseUnits(input.amountTokens, config.tokenDecimals);
  const periodSeconds =
    action === "delete" ? priorBinding!.vendor.period_seconds : CADENCE_SECONDS[input.cadence];
  const cadenceValue =
    action === "delete"
      ? ((Object.entries(CADENCE_SECONDS).find(([, seconds]) => seconds === periodSeconds)?.[0] ??
          "monthly") as VendorCadence)
      : input.cadence;
  const recipient = publicKey(
    action === "delete" ? priorBinding!.vendor.recipient_wallet : input.recipientWallet,
    "Recipient wallet",
  );
  const recipientTokenAccountState =
    action === "delete"
      ? {
          address: publicKey(priorBinding!.recipient_token_account, "Recipient token account"),
          exists: true,
        }
      : await validateRecipientTokenAccount(config, recipient);
  const recipientTokenAccount = recipientTokenAccountState.address;
  const updateTermsChanged =
    action === "update" &&
    (priorBinding!.vendor.recipient_wallet !== recipient.toBase58() ||
      priorBinding!.vendor.amount_per_period_base_units !== Number(amount) ||
      priorBinding!.vendor.period_seconds !== periodSeconds);
  const historical =
    action === "update"
      ? await historicalCarryover(config, active, priorBinding!, blockTime)
      : { boundaryTs: 0, amountBaseUnits: 0n };
  const currentDelegationBoundary =
    action === "update"
      ? replacementDelegationStartTs(
          blockTime,
          priorDelegationState!.currentPeriodStartTs,
          priorBinding!.vendor.period_seconds,
          priorDelegationState!.amountPulledInPeriod,
        )
      : blockTime;
  const requiresCarryoverRepair =
    action === "update" &&
    priorDelegationState!.amountPulledInPeriod === 0n &&
    historical.amountBaseUnits > 0n &&
    historical.boundaryTs > blockTime;
  const requiresNewDelegation = action === "add" || updateTermsChanged || requiresCarryoverRepair;
  const startTs =
    action === "update" && requiresNewDelegation
      ? Math.max(currentDelegationBoundary, historical.boundaryTs)
      : action === "update"
        ? blockTime
        : blockTime + 180;
  const expiryTs = startTs + DELEGATION_LIFETIME_SECONDS;

  if (
    action === "update" &&
    priorBinding!.display_name === input.displayName &&
    !updateTermsChanged &&
    !requiresCarryoverRepair
  ) {
    throw new Error("No vendor terms changed. Update at least one reviewed field.");
  }

  const tokenBalance = await rpc<{ value: { amount: string; decimals: number } }>(
    config,
    "getTokenAccountBalance",
    [config.treasuryTokenAccount, { commitment: "finalized" }],
  );
  if (tokenBalance.value.decimals !== config.tokenDecimals) {
    throw new Error("Treasury token decimals do not match protected config.");
  }
  const balance = BigInt(tokenBalance.value.amount);
  const projected = action === "delete" ? balance : balance - amount;
  const projectedRunway = projected > 0n ? (projected * 1000n) / config.weeklyBurnBaseUnits : 0n;
  if (
    projected < config.minimumTokenReserveBaseUnits ||
    projectedRunway < BigInt(config.minimumRunwayWeeks * 1000)
  ) {
    throw new Error(
      "The first payment under these vendor terms would breach reserve or runway policy.",
    );
  }

  const mint = publicKey(config.canonicalMint, "Canonical mint");
  const tokenProgram = publicKey(config.tokenProgram, "Token program");
  const subscriptionsProgram = publicKey(config.subscriptionsProgram, "Subscriptions program");
  const sessionDelegate = publicKey(config.sessionDelegate, "Session delegate");
  let subscriptionAuthority: PublicKey | undefined;
  let authorityInitId: number | undefined;
  let nonce = 0;
  let recurringDelegation: PublicKey | undefined;
  if (requiresNewDelegation) {
    [subscriptionAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("SubscriptionAuthority"), founder.toBuffer(), mint.toBuffer()],
      subscriptionsProgram,
    );
    const authorityAccount = await binaryAccount(config, subscriptionAuthority.toBase58());
    if (!authorityAccount || authorityAccount.owner !== config.subscriptionsProgram) {
      throw new Error(
        "Protected subscription authority is not initialized. Complete initial Devnet provisioning first.",
      );
    }
    authorityInitId = decodeSubscriptionAuthority(authorityAccount.data, founder, mint);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      nonce = randomInt(1, 2 ** 48);
      [recurringDelegation] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("delegation"),
          subscriptionAuthority.toBuffer(),
          founder.toBuffer(),
          sessionDelegate.toBuffer(),
          u64Le(nonce),
        ],
        subscriptionsProgram,
      );
      if (!(await binaryAccount(config, recurringDelegation.toBase58()))) break;
      recurringDelegation = undefined;
    }
    if (!recurringDelegation) throw new Error("Could not allocate a unique delegation nonce.");
  }

  const version = active ? active.document.version + 1 : 1;
  const binding: VendorPolicyBinding | undefined = (() => {
    if (action === "delete") return undefined;
    if (action === "update" && !requiresNewDelegation) {
      return { ...priorBinding!, display_name: input.displayName };
    }
    return {
      vendor: {
        vendor_id: vendorId,
        recipient_wallet: recipient.toBase58(),
        amount_per_period_base_units: Number(amount),
        period_seconds: periodSeconds,
      },
      display_name: input.displayName,
      recipient_token_account: recipientTokenAccount.toBase58(),
      recurring_delegation: recurringDelegation!.toBase58(),
      delegation_nonce: nonce,
      treasury_token_account: config.treasuryTokenAccount,
      start_ts: startTs,
      expiry_ts: expiryTs,
      activated_policy_version: version,
    };
  })();
  const nextBindings =
    action === "add"
      ? [...existing, binding!]
      : action === "update"
        ? existing.map((candidate) =>
            candidate.vendor.vendor_id === vendorId ? binding! : candidate,
          )
        : existing.filter((candidate) => candidate.vendor.vendor_id !== vendorId);
  const issuedAtTs = blockTime;
  const document: VendorPolicyDocument = {
    schema: VENDOR_POLICY_SCHEMA,
    version,
    previous_policy_hash: active?.policy_hash ?? GENESIS_POLICY_HASH,
    issued_at_ts: issuedAtTs,
    founder_wallet: founder.toBase58(),
    treasury_owner: config.treasuryOwner,
    subscriptions_program: config.subscriptionsProgram,
    token_program: config.tokenProgram,
    canonical_mint: config.canonicalMint,
    session_delegate: config.sessionDelegate,
    vendors: nextBindings,
  };
  const policyHash = vendorPolicyHash(document);
  const signingMessage = vendorPolicySigningMessage(document, policyHash);

  let createDelegation: TransactionInstruction | undefined;
  if (requiresNewDelegation) {
    const instructionData = Buffer.alloc(49);
    instructionData[0] = 2;
    instructionData.writeBigUInt64LE(BigInt(nonce), 1);
    instructionData.writeBigUInt64LE(amount, 9);
    instructionData.writeBigUInt64LE(BigInt(periodSeconds), 17);
    writeI64(instructionData, 25, startTs);
    writeI64(instructionData, 33, expiryTs);
    writeI64(instructionData, 41, authorityInitId!);
    createDelegation = new TransactionInstruction({
      programId: subscriptionsProgram,
      keys: [
        { pubkey: founder, isSigner: true, isWritable: true },
        { pubkey: subscriptionAuthority!, isSigner: false, isWritable: false },
        { pubkey: recurringDelegation!, isSigner: false, isWritable: true },
        { pubkey: sessionDelegate, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: instructionData,
    });
  }
  const memo = new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [],
    data: Buffer.from(`SafeSpend ${action} policy ${policyHash}`, "utf8"),
  });
  const latest = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
    config,
    "getLatestBlockhash",
    [{ commitment: "finalized" }],
  );
  const transaction = new Transaction({
    feePayer: founder,
    recentBlockhash: latest.value.blockhash,
  });
  if (requiresNewDelegation && !recipientTokenAccountState.exists) {
    transaction.add(
      createRecipientTokenAccountInstruction(
        founder,
        recipient,
        recipientTokenAccount,
        mint,
        tokenProgram,
      ),
    );
  }
  if (createDelegation) transaction.add(createDelegation);
  if (priorBinding && (action === "delete" || requiresNewDelegation)) {
    transaction.add(
      createRevokeDelegationInstruction(
        founder,
        publicKey(priorBinding.recurring_delegation, "Existing recurring delegation"),
        subscriptionsProgram,
      ),
    );
  }
  transaction.add(memo);
  const unsignedTransactionBase64 = transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  await assertTransactionSimulation(config, unsignedTransactionBase64);
  const transactionMessageBase64 = transaction.serializeMessage().toString("base64");
  const proposalId = randomUUID();
  const expiresAtTs =
    action === "add"
      ? Math.min(startTs - 30, issuedAtTs + PROPOSAL_TTL_SECONDS)
      : issuedAtTs + PROPOSAL_TTL_SECONDS;
  const review: VendorEnrollmentProposal["review"] = {
    action,
    vendorId,
    displayName: action === "delete" ? priorBinding!.display_name : input.displayName,
    founderWallet: founder.toBase58(),
    recipientWallet: recipient.toBase58(),
    recipientTokenAccount: recipientTokenAccount.toBase58(),
    recipientTokenAccountWillBeCreated: action !== "delete" && !recipientTokenAccountState.exists,
    canonicalMint: config.canonicalMint,
    amountBaseUnits: amount.toString(),
    amountTokens: displayTokenAmount(amount, config.tokenDecimals),
    cadence: cadenceValue,
    periodSeconds,
    startAt: new Date((binding?.start_ts ?? priorBinding!.start_ts) * 1000).toISOString(),
    expiryAt: new Date((binding?.expiry_ts ?? priorBinding!.expiry_ts) * 1000).toISOString(),
    recurringDelegation: binding?.recurring_delegation ?? null,
    delegationNonce: binding?.delegation_nonce ?? null,
    revokedDelegation:
      priorBinding && (action === "delete" || requiresNewDelegation)
        ? priorBinding.recurring_delegation
        : null,
    priorAmountPulledBaseUnits: (
      priorDelegationState?.amountPulledInPeriod || historical.amountBaseUnits
    ).toString(),
    replacementStartsAfterPriorPeriod: requiresNewDelegation && startTs > blockTime,
    policyVersion: version,
    previousPolicyHash: document.previous_policy_hash,
    policyHash,
    currentBalanceBaseUnits: balance.toString(),
    projectedBalanceBaseUnits: projected.toString(),
    currentRunwayMilliweeks: ((balance * 1000n) / config.weeklyBurnBaseUnits).toString(),
    projectedRunwayMilliweeks: projectedRunway.toString(),
    minimumRunwayWeeks: config.minimumRunwayWeeks,
  };
  await writeProposal(
    {
      proposalId,
      createdAtTs: issuedAtTs,
      expiresAtTs,
      document,
      policyHash,
      signingMessage,
      unsignedTransactionBase64,
      transactionMessageBase64,
      review,
    },
    true,
  );
  return {
    proposalId,
    signingMessage,
    unsignedTransactionBase64,
    expiresAt: new Date(expiresAtTs * 1000).toISOString(),
    review,
  };
}

export async function prepareVendorEnrollment(value: unknown): Promise<VendorEnrollmentProposal> {
  return prepareVendorMutation("add", value);
}

export async function prepareVendorUpdate(value: unknown): Promise<VendorEnrollmentProposal> {
  return prepareVendorMutation("update", value);
}

export async function prepareVendorDeletion(value: unknown): Promise<VendorEnrollmentProposal> {
  return prepareVendorMutation("delete", value);
}

async function verifyFinalizedDelegation(
  config: SafeSpendServerConfig,
  binding: VendorPolicyBinding,
) {
  const account = await binaryAccount(config, binding.recurring_delegation);
  if (!account) throw new Error("Finalized delegation account is missing.");
  const imported = decodeDelegationBinding(
    config,
    {
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
      policyHash: null,
      enrollmentStatus: "finalizing",
    },
    account,
    binding.activated_policy_version,
  );
  if (
    imported.start_ts !== binding.start_ts ||
    imported.expiry_ts !== binding.expiry_ts ||
    imported.recurring_delegation !== binding.recurring_delegation
  ) {
    throw new Error("Finalized delegation does not exactly match the reviewed vendor policy.");
  }
  const amountPulledInPeriod = account.data.readBigUInt64LE(203);
  if (amountPulledInPeriod > BigInt(binding.vendor.amount_per_period_base_units)) {
    throw new Error("Finalized delegation has invalid current-period spend state.");
  }
  return {
    currentPeriodStartTs: imported.start_ts,
    amountPulledInPeriod,
  };
}

export async function activateVendorEnrollment(value: unknown): Promise<VendorEnrollmentResult> {
  const input = ActivationSchema.parse(value);
  const config = await loadSafeSpendServerConfig();
  const proposal = await readProposal(input.proposalId);
  const active = await readActiveVendorPolicy();
  if (active?.policy_hash === proposal.policyHash) {
    return {
      status: "active",
      signature: proposal.submissionSignature ?? "",
      vendorId: proposal.review.vendorId,
      policyVersion: proposal.document.version,
      policyHash: proposal.policyHash,
      action: proposal.review.action,
    };
  }
  await assertCurrentVersion(proposal.document);
  if (!proposal.submissionSignature && Math.floor(Date.now() / 1000) > proposal.expiresAtTs) {
    throw new Error("Vendor policy proposal expired before submission. Review it again.");
  }
  const signedPolicy: SignedVendorPolicyDocument = {
    document: proposal.document,
    policy_hash: proposal.policyHash,
    signature_base64: input.policySignatureBase64,
  };
  validateSignedVendorPolicy(signedPolicy, {
    treasuryOwner: config.treasuryOwner,
    subscriptionsProgram: config.subscriptionsProgram,
    tokenProgram: config.tokenProgram,
    canonicalMint: config.canonicalMint,
    sessionDelegate: config.sessionDelegate,
  });

  let signature = proposal.submissionSignature;
  if (!signature) {
    let transaction: Transaction;
    try {
      transaction = Transaction.from(Buffer.from(input.signedTransactionBase64, "base64"));
    } catch {
      throw new Error("Wallet returned an invalid signed vendor-policy transaction.");
    }
    const reviewedTransaction = Transaction.from(
      Buffer.from(proposal.unsignedTransactionBase64, "base64"),
    );
    const transactionMismatch = reviewedTransactionMismatch(reviewedTransaction, transaction);
    if (transactionMismatch) {
      console.error("[safespend-enrollment] wallet transaction mismatch", transactionMismatch);
      throw new Error(
        `Wallet changed the reviewed vendor-policy transaction. ${transactionMismatch}. Change refused.`,
      );
    }
    if (!transaction.verifySignatures(true)) {
      throw new Error(
        "Founder wallet signature for the reviewed vendor-policy transaction is invalid.",
      );
    }
    if (transaction.serializeMessage().toString("base64") !== proposal.transactionMessageBase64) {
      console.info(
        "[safespend-enrollment] accepted wallet-reencoded transaction with unchanged reviewed semantics",
      );
    }
    const founderSignature = transaction.signatures.find((item) =>
      item.publicKey.equals(publicKey(config.treasuryOwner, "Treasury owner")),
    )?.signature;
    if (!founderSignature)
      throw new Error("Vendor-policy transaction lacks the founder signature.");
    signature = bs58.encode(founderSignature);
    const returned = await rpc<string>(config, "sendTransaction", [
      input.signedTransactionBase64,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      },
    ]);
    if (returned !== signature) throw new Error("RPC returned a different transaction signature.");
    proposal.submissionSignature = signature;
    await writeProposal(proposal);
  }

  const statuses = await rpc<{
    value: Array<{
      err: unknown;
      confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
    } | null>;
  }>(config, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
  const status = statuses.value[0];
  if (status?.err) throw new Error("Vendor-policy transaction failed onchain.");
  if (status?.confirmationStatus !== "finalized") {
    return {
      status: status ? "finalizing" : "submitted",
      signature,
      vendorId: proposal.review.vendorId,
      policyVersion: proposal.document.version,
      policyHash: proposal.policyHash,
      action: proposal.review.action,
    };
  }

  if (proposal.review.revokedDelegation) {
    const revoked = await binaryAccount(config, proposal.review.revokedDelegation);
    if (revoked) {
      throw new Error("Finalized policy change did not close the superseded delegation.");
    }
  }
  if (proposal.review.action !== "delete") {
    const binding = proposal.document.vendors.find(
      (candidate) => candidate.vendor.vendor_id === proposal.review.vendorId,
    );
    if (!binding) throw new Error("Reviewed vendor binding is missing from the signed policy.");
    await verifyFinalizedDelegation(config, binding);
    const recipientTokenAccount = await validateRecipientTokenAccount(
      config,
      publicKey(binding.vendor.recipient_wallet, "Recipient wallet"),
    );
    if (!recipientTokenAccount.exists) {
      throw new Error("Finalized policy change did not create the recipient token account.");
    }
  } else if (
    proposal.document.vendors.some(
      (candidate) => candidate.vendor.vendor_id === proposal.review.vendorId,
    )
  ) {
    throw new Error("Deleted vendor is still present in the reviewed policy.");
  }
  await publishVendorPolicy(signedPolicy, {
    action: proposal.review.action,
    delegationSignature: signature,
    founderWallet: proposal.document.founder_wallet,
    vendorId: proposal.review.vendorId,
    finalizedAt: new Date().toISOString(),
  });
  return {
    status: "active",
    signature,
    vendorId: proposal.review.vendorId,
    policyVersion: proposal.document.version,
    policyHash: proposal.policyHash,
    action: proposal.review.action,
  };
}
