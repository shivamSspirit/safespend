import assert from "node:assert/strict";
import test from "node:test";
import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  createRecipientTokenAccountInstruction,
  createRevokeDelegationInstruction,
  deriveRecipientTokenAccount,
  hasReviewedTransactionSemantics,
  reviewedTransactionMismatch,
  replacementDelegationStartTs,
  SYSTEM_PROGRAM,
} from "./vendor-enrollment-transaction";

const founder = new PublicKey("CXf1eb2iX2jn4DhHnDnX5dtHbebBQkwbHJLJTWUnBbh3");
const recipient = new PublicKey("4VZuyEyC9TQKcuMutK3VtF325vEtfQ8yT5MzhK2sR1xz");
const mint = new PublicKey("7PGBJ9HRchv9RZ4GRLWHCucdQpcsLUkZPPE6Z4HPu7vg");
const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const subscriptionsProgram = new PublicKey("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44");

test("derives the canonical recipient token account with the configured token program", () => {
  assert.equal(
    deriveRecipientTokenAccount(recipient, mint, tokenProgram).toBase58(),
    "Cqfzs4vgBjYP7rZP6Vrs3UqpgJ5LoXgTZvX5535foUre",
  );
});

test("accepts a wallet-refreshed blockhash but rejects reviewed instruction changes", () => {
  const instruction = createRecipientTokenAccountInstruction(
    founder,
    recipient,
    deriveRecipientTokenAccount(recipient, mint, tokenProgram),
    mint,
    tokenProgram,
  );
  const reviewed = new Transaction({
    feePayer: founder,
    recentBlockhash: PublicKey.default.toBase58(),
  }).add(instruction);
  const refreshed = Transaction.from(
    reviewed.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
  refreshed.recentBlockhash = recipient.toBase58();

  assert.equal(hasReviewedTransactionSemantics(reviewed, refreshed), true);

  refreshed.instructions[0].data = Buffer.from([0]);
  assert.equal(hasReviewedTransactionSemantics(reviewed, refreshed), false);
  assert.match(reviewedTransactionMismatch(reviewed, refreshed) ?? "", /instruction 0 data/);
});

test("accepts capped leading compute-budget instructions added by the wallet", () => {
  const recipientTokenAccount = deriveRecipientTokenAccount(recipient, mint, tokenProgram);
  const reviewedInstruction = createRecipientTokenAccountInstruction(
    founder,
    recipient,
    recipientTokenAccount,
    mint,
    tokenProgram,
  );
  const reviewed = new Transaction({
    feePayer: founder,
    recentBlockhash: PublicKey.default.toBase58(),
  }).add(reviewedInstruction);
  const signedShape = new Transaction({
    feePayer: founder,
    recentBlockhash: recipient.toBase58(),
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    reviewedInstruction,
  );

  assert.equal(reviewedTransactionMismatch(reviewed, signedShape), null);
});

test("rejects wallet priority fees above the enrollment cap", () => {
  const reviewedInstruction = createRecipientTokenAccountInstruction(
    founder,
    recipient,
    deriveRecipientTokenAccount(recipient, mint, tokenProgram),
    mint,
    tokenProgram,
  );
  const reviewed = new Transaction({
    feePayer: founder,
    recentBlockhash: PublicKey.default.toBase58(),
  }).add(reviewedInstruction);
  const unsafe = new Transaction({
    feePayer: founder,
    recentBlockhash: recipient.toBase58(),
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
    reviewedInstruction,
  );

  assert.match(reviewedTransactionMismatch(reviewed, unsafe) ?? "", /priority fee .* exceeds/);
});

test("builds the idempotent recipient token-account creation instruction", () => {
  const recipientTokenAccount = deriveRecipientTokenAccount(recipient, mint, tokenProgram);
  const instruction = createRecipientTokenAccountInstruction(
    founder,
    recipient,
    recipientTokenAccount,
    mint,
    tokenProgram,
  );

  assert.equal(instruction.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM.toBase58());
  assert.deepEqual([...instruction.data], [1]);
  assert.deepEqual(
    instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({
      pubkey: pubkey.toBase58(),
      isSigner,
      isWritable,
    })),
    [
      { pubkey: founder.toBase58(), isSigner: true, isWritable: true },
      { pubkey: recipientTokenAccount.toBase58(), isSigner: false, isWritable: true },
      { pubkey: recipient.toBase58(), isSigner: false, isWritable: false },
      { pubkey: mint.toBase58(), isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM.toBase58(), isSigner: false, isWritable: false },
      { pubkey: tokenProgram.toBase58(), isSigner: false, isWritable: false },
    ],
  );
});

test("builds the exact Subscriptions v0.4.0 revoke-delegation instruction", () => {
  const delegation = new PublicKey("8j9UbyLgWussoXMau1KEFSkBUpcH8YGybHeGTESmfY49");
  const instruction = createRevokeDelegationInstruction(founder, delegation, subscriptionsProgram);

  assert.equal(instruction.programId.toBase58(), subscriptionsProgram.toBase58());
  assert.deepEqual([...instruction.data], [3]);
  assert.deepEqual(
    instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({
      pubkey: pubkey.toBase58(),
      isSigner,
      isWritable,
    })),
    [
      { pubkey: founder.toBase58(), isSigner: true, isWritable: true },
      { pubkey: delegation.toBase58(), isSigner: false, isWritable: true },
    ],
  );
});

test("schedules a replacement after a paid current period", () => {
  assert.equal(replacementDelegationStartTs(1_050, 1_000, 100, 12_000_000n), 1_100);
});

test("starts a replacement immediately when no current-period allowance was used", () => {
  assert.equal(replacementDelegationStartTs(1_050, 1_000, 100, 0n), 1_050);
  assert.equal(replacementDelegationStartTs(1_150, 1_000, 100, 12_000_000n), 1_150);
});

test("retains an already scheduled future delegation boundary", () => {
  assert.equal(replacementDelegationStartTs(1_050, 1_100, 100, 0n), 1_100);
});
