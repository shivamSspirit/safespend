import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

export const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
export const COMPUTE_BUDGET_PROGRAM = new PublicKey("ComputeBudget111111111111111111111111111111");
export const MAX_WALLET_COMPUTE_UNITS = 1_400_000;
export const MAX_WALLET_PRIORITY_FEE_LAMPORTS = 100_000n;

export function replacementDelegationStartTs(
  finalizedNowTs: number,
  priorPeriodStartTs: number,
  priorPeriodSeconds: number,
  amountPulledInPeriod: bigint,
) {
  if (finalizedNowTs < priorPeriodStartTs) return priorPeriodStartTs;
  const priorPeriodEndTs = priorPeriodStartTs + priorPeriodSeconds;
  return amountPulledInPeriod > 0n && finalizedNowTs < priorPeriodEndTs
    ? priorPeriodEndTs
    : finalizedNowTs;
}

export function deriveRecipientTokenAccount(
  recipient: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
) {
  return PublicKey.findProgramAddressSync(
    [recipient.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

export function createRecipientTokenAccountInstruction(
  founder: PublicKey,
  recipient: PublicKey,
  recipientTokenAccount: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: founder, isSigner: true, isWritable: true },
      { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    // AssociatedTokenAccountInstruction::CreateIdempotent.
    data: Buffer.from([1]),
  });
}

export function createRevokeDelegationInstruction(
  founder: PublicKey,
  delegation: PublicKey,
  subscriptionsProgram: PublicKey,
) {
  return new TransactionInstruction({
    programId: subscriptionsProgram,
    keys: [
      { pubkey: founder, isSigner: true, isWritable: true },
      { pubkey: delegation, isSigner: false, isWritable: true },
    ],
    // Subscriptions v0.4.0 RevokeDelegation discriminator.
    data: Buffer.from([3]),
  });
}

type ReviewedInstructions = {
  instructions: TransactionInstruction[];
  error: string | null;
};

function reviewedInstructionsWithoutCappedComputeBudget(signed: Transaction): ReviewedInstructions {
  let offset = 0;
  let computeUnitLimit: number | undefined;
  let computeUnitPriceMicroLamports: bigint | undefined;

  while (signed.instructions[offset]?.programId.equals(COMPUTE_BUDGET_PROGRAM)) {
    if (offset >= 2) {
      return { instructions: [], error: "wallet added more than two compute-budget instructions" };
    }
    const data = Buffer.from(signed.instructions[offset].data);
    if (data.length === 5 && data[0] === 2) {
      if (computeUnitLimit !== undefined) {
        return {
          instructions: [],
          error: "wallet added duplicate compute-unit-limit instructions",
        };
      }
      computeUnitLimit = data.readUInt32LE(1);
      if (computeUnitLimit === 0 || computeUnitLimit > MAX_WALLET_COMPUTE_UNITS) {
        return {
          instructions: [],
          error: `wallet compute-unit limit ${computeUnitLimit} exceeds the ${MAX_WALLET_COMPUTE_UNITS} cap`,
        };
      }
    } else if (data.length === 9 && data[0] === 3) {
      if (computeUnitPriceMicroLamports !== undefined) {
        return {
          instructions: [],
          error: "wallet added duplicate compute-unit-price instructions",
        };
      }
      computeUnitPriceMicroLamports = data.readBigUInt64LE(1);
    } else {
      return {
        instructions: [],
        error: "wallet added an unsupported compute-budget instruction",
      };
    }
    offset += 1;
  }

  const maximumUnits = BigInt(computeUnitLimit ?? MAX_WALLET_COMPUTE_UNITS);
  const microLamports = computeUnitPriceMicroLamports ?? 0n;
  const maximumPriorityFeeLamports = (maximumUnits * microLamports + 999_999n) / 1_000_000n;
  if (maximumPriorityFeeLamports > MAX_WALLET_PRIORITY_FEE_LAMPORTS) {
    return {
      instructions: [],
      error: `wallet priority fee ${maximumPriorityFeeLamports} lamports exceeds the ${MAX_WALLET_PRIORITY_FEE_LAMPORTS} lamport cap`,
    };
  }

  return { instructions: signed.instructions.slice(offset), error: null };
}

export function reviewedTransactionMismatch(expected: Transaction, signed: Transaction) {
  if (!expected.feePayer?.equals(signed.feePayer ?? PublicKey.default)) {
    return "fee payer changed";
  }
  const walletInstructions = reviewedInstructionsWithoutCappedComputeBudget(signed);
  if (walletInstructions.error) return walletInstructions.error;
  if (expected.instructions.length !== walletInstructions.instructions.length) {
    const programs = walletInstructions.instructions.map((instruction) =>
      instruction.programId.toBase58(),
    );
    return `reviewed instruction count changed from ${expected.instructions.length} to ${walletInstructions.instructions.length}; wallet returned programs ${programs.join(", ")}`;
  }
  for (const [index, reviewed] of expected.instructions.entries()) {
    const candidate = walletInstructions.instructions[index];
    if (!candidate) return `instruction ${index} is missing`;
    if (!reviewed.programId.equals(candidate.programId)) {
      return `instruction ${index} program changed from ${reviewed.programId.toBase58()} to ${candidate.programId.toBase58()}`;
    }
    if (!Buffer.from(reviewed.data).equals(Buffer.from(candidate.data))) {
      return `instruction ${index} data changed for program ${reviewed.programId.toBase58()}`;
    }
    if (reviewed.keys.length !== candidate.keys.length) {
      return `instruction ${index} account count changed from ${reviewed.keys.length} to ${candidate.keys.length}`;
    }
    for (const [keyIndex, key] of reviewed.keys.entries()) {
      const signedKey = candidate.keys[keyIndex];
      if (!signedKey) return `instruction ${index} account ${keyIndex} is missing`;
      if (!key.pubkey.equals(signedKey.pubkey)) {
        return `instruction ${index} account ${keyIndex} changed from ${key.pubkey.toBase58()} to ${signedKey.pubkey.toBase58()}`;
      }
      if (key.isSigner !== signedKey.isSigner || key.isWritable !== signedKey.isWritable) {
        return `instruction ${index} account ${keyIndex} signer or writable permission changed`;
      }
    }
  }
  return null;
}

export function hasReviewedTransactionSemantics(expected: Transaction, signed: Transaction) {
  return reviewedTransactionMismatch(expected, signed) === null;
}
