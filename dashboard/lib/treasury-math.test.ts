import assert from "node:assert/strict";
import test from "node:test";
import type { SafeSpendBootstrap } from "./safespend-types";
import {
  calculateTreasuryMetrics,
  calculateVendorHistory,
  weeklyEquivalentBaseUnits,
} from "./treasury-math";

test("normalizes daily, weekly, and fixed 30-day allowances conservatively", () => {
  assert.equal(weeklyEquivalentBaseUnits("100", 86_400), 700n);
  assert.equal(weeklyEquivalentBaseUnits("100", 604_800), 100n);
  assert.equal(weeklyEquivalentBaseUnits("100", 2_592_000), 24n);
});

test("separates finalized balance headroom from allowances and payment history", () => {
  const data = {
    treasury: { tokenBalanceBaseUnits: "967", tokenDecimals: 0 },
    policy: {
      weeklyBurnBaseUnits: "10",
      minimumRunwayWeeks: 8,
      minimumTokenReserveBaseUnits: "50",
    },
    vendors: [
      {
        id: "hosting",
        enrollmentStatus: "active",
        amountBaseUnits: "30",
        periodSeconds: 604_800,
        allowance: { status: "available", remainingThisPeriodBaseUnits: "20" },
      },
      {
        id: "deleted",
        enrollmentStatus: "exception",
        amountBaseUnits: "999",
        periodSeconds: 86_400,
        allowance: { status: "available", remainingThisPeriodBaseUnits: "999" },
      },
    ],
    payments: [
      { vendorId: "hosting", amountBaseUnits: "10", status: "finalized", signature: "sig" },
      { vendorId: "hosting", amountBaseUnits: "10", status: "denied" },
      { vendorId: "hosting", amountBaseUnits: "10", status: "checkpoint" },
    ],
  } as unknown as SafeSpendBootstrap;

  const metrics = calculateTreasuryMetrics(data);
  assert.equal(metrics.balance, 967n);
  assert.equal(metrics.protectedFloor, 80n);
  assert.equal(metrics.spendableAboveFloor, 887n);
  assert.equal(metrics.normalizedWeeklyAllowance, 30n);
  assert.equal(metrics.callableNow, 20n);
  assert.equal(metrics.finalizedOutflow, 10n);
  assert.equal(metrics.openRequestCount, 1);

  assert.deepEqual(calculateVendorHistory(data.payments, { id: "hosting" }), {
    finalizedCount: 1,
    finalizedOutflow: 10n,
    openRequestCount: 1,
  });
});
