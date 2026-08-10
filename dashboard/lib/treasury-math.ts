import type { LivePayment, LiveVendor, SafeSpendBootstrap } from "./safespend-types";

const SECONDS_PER_WEEK = 604_800n;

function nonnegative(value: bigint) {
  return value < 0n ? 0n : value;
}

function divideCeil(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) throw new Error("Cadence must be a positive number of seconds.");
  return (numerator + denominator - 1n) / denominator;
}

export function weeklyEquivalentBaseUnits(amountBaseUnits: string, periodSeconds: number) {
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds <= 0) {
    throw new Error("Cadence must be a positive safe integer.");
  }
  return divideCeil(BigInt(amountBaseUnits) * SECONDS_PER_WEEK, BigInt(periodSeconds));
}

export function isFinalizedPayment(payment: LivePayment) {
  return payment.status === "finalized" && Boolean(payment.signature);
}

export function isOpenPaymentRequest(payment: LivePayment) {
  return ["validating", "checkpoint", "awaiting_telegram", "submitting"].includes(payment.status);
}

export function calculateTreasuryMetrics(data: SafeSpendBootstrap) {
  const balance = BigInt(data.treasury.tokenBalanceBaseUnits);
  const weeklyBurn = BigInt(data.policy.weeklyBurnBaseUnits);
  const runwayFloor = weeklyBurn * BigInt(data.policy.minimumRunwayWeeks);
  const absoluteReserve = BigInt(data.policy.minimumTokenReserveBaseUnits);
  const protectedFloor = runwayFloor > absoluteReserve ? runwayFloor : absoluteReserve;
  const activeVendors = data.vendors.filter((vendor) => vendor.enrollmentStatus === "active");
  const exposureVendors = activeVendors.filter(
    (vendor) => !["expired", "invalid"].includes(vendor.allowance.status),
  );
  const normalizedWeeklyAllowance = exposureVendors.reduce(
    (total, vendor) =>
      total + weeklyEquivalentBaseUnits(vendor.amountBaseUnits, vendor.periodSeconds),
    0n,
  );
  const callableNow = activeVendors.reduce(
    (total, vendor) =>
      vendor.allowance.status === "available"
        ? total + BigInt(vendor.allowance.remainingThisPeriodBaseUnits)
        : total,
    0n,
  );
  const finalizedPayments = data.payments.filter(isFinalizedPayment);
  const submittedPayments = data.payments.filter(
    (payment) => payment.status === "submitted" && Boolean(payment.signature),
  );
  const openRequests = data.payments.filter(isOpenPaymentRequest);

  return {
    balance,
    protectedFloor,
    spendableAboveFloor: nonnegative(balance - protectedFloor),
    runwayFloor,
    absoluteReserve,
    normalizedWeeklyAllowance,
    callableNow,
    finalizedPaymentCount: finalizedPayments.length,
    finalizedOutflow: finalizedPayments.reduce(
      (total, payment) => total + BigInt(payment.amountBaseUnits),
      0n,
    ),
    submittedPaymentCount: submittedPayments.length,
    submittedOutflow: submittedPayments.reduce(
      (total, payment) => total + BigInt(payment.amountBaseUnits),
      0n,
    ),
    openRequestCount: openRequests.length,
  };
}

export function calculateVendorHistory(payments: LivePayment[], vendor: Pick<LiveVendor, "id">) {
  const matching = payments.filter((payment) => payment.vendorId === vendor.id);
  const finalized = matching.filter(isFinalizedPayment);
  const open = matching.filter(isOpenPaymentRequest);
  return {
    finalizedCount: finalized.length,
    finalizedOutflow: finalized.reduce(
      (total, payment) => total + BigInt(payment.amountBaseUnits),
      0n,
    ),
    openRequestCount: open.length,
  };
}
