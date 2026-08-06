export type PaymentStatus =
  | "validating"
  | "checkpoint"
  | "awaiting_telegram"
  | "submitting"
  | "submitted"
  | "finalized"
  | "denied"
  | "failed";

export type VendorAllowanceState = {
  status: "available" | "spent" | "not_started" | "expiring" | "expired" | "invalid";
  amountPulledThisPeriodBaseUnits: string;
  remainingThisPeriodBaseUnits: string;
  periodStartAt: string | null;
  periodEndAt: string | null;
  nextAvailableAt: string | null;
};

export type LiveVendor = {
  id: string;
  name: string;
  category: string;
  recipientWallet: string;
  recipientTokenAccount: string;
  recurringDelegation: string;
  amountBaseUnits: string;
  periodSeconds: number;
  allowance: VendorAllowanceState;
};

export type LivePayment = {
  id: string;
  runId: string;
  vendorId: string;
  amountBaseUnits: string;
  createdAt: string;
  updatedAt: string;
  status: PaymentStatus;
  runStatus?: string;
  signature?: string;
  confirmationStatus?: "processed" | "confirmed" | "finalized";
  error?: string;
  source: "dashboard" | "telegram";
};

export type PendingSopRun = {
  runId: string;
  sopName: string;
  step: number;
  totalSteps: number;
  waitingSince?: string;
  kind: "checkpoint" | "approval";
};

export type SafeSpendBootstrap = {
  generatedAt: string;
  custodyTier: "T2";
  connection: {
    gatewayOnline: boolean;
    paired: boolean;
    telegramOnline: boolean;
    guardianOnline: boolean;
    payerConfigured: boolean;
    auditStoreOnline: boolean;
    version?: string;
  };
  network: {
    cluster: "devnet";
    genesisHash: string;
    rpcProvider: string;
    finalizedSlot: number;
  };
  treasury: {
    owner: string;
    tokenAccount: string;
    mint: string;
    tokenDecimals: number;
    tokenBalanceBaseUnits: string;
    solBalanceLamports: string;
    sessionDelegate: string;
    sessionSolBalanceLamports: string;
    runwayMilliweeks: string;
  };
  policy: {
    subscriptionsProgram: string;
    weeklyBurnBaseUnits: string;
    minimumRunwayWeeks: number;
    minimumTokenReserveBaseUnits: string;
    minimumSolReserveLamports: string;
    minimumSessionFeeReserveLamports: string;
    allowMainnet: false;
    toolApprovalRoute: "telegram.guardian";
  };
  vendors: LiveVendor[];
  pendingRuns: PendingSopRun[];
  payments: LivePayment[];
  recentSignatures: Array<{
    signature: string;
    blockTime: number | null;
    confirmationStatus: string | null;
    err: boolean;
  }>;
};

export type ApiErrorBody = {
  error: string;
  code?: string;
  action?: string;
};
