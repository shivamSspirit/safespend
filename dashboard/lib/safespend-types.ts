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
  delegationNonce: number;
  startAt: string | null;
  expiryAt: string | null;
  policyVersion: number;
  policyHash: string | null;
  enrollmentStatus: "active" | "legacy" | "finalizing" | "exception";
  allowance: VendorAllowanceState;
};

export type VendorCadence = "daily" | "weekly" | "monthly";
export type VendorPolicyAction = "add" | "update" | "delete";

export type VendorPolicyBinding = {
  vendor: {
    vendor_id: string;
    recipient_wallet: string;
    amount_per_period_base_units: number;
    period_seconds: number;
  };
  display_name: string;
  recipient_token_account: string;
  recurring_delegation: string;
  delegation_nonce: number;
  treasury_token_account: string;
  start_ts: number;
  expiry_ts: number;
  activated_policy_version: number;
};

export type VendorPolicyDocument = {
  schema: "safespend-vendor-policy-v1";
  version: number;
  previous_policy_hash: string;
  issued_at_ts: number;
  founder_wallet: string;
  treasury_owner: string;
  subscriptions_program: string;
  token_program: string;
  canonical_mint: string;
  session_delegate: string;
  vendors: VendorPolicyBinding[];
};

export type SignedVendorPolicyDocument = {
  document: VendorPolicyDocument;
  policy_hash: string;
  signature_base64: string;
};

export type VendorEnrollmentProposal = {
  proposalId: string;
  signingMessage: string;
  unsignedTransactionBase64: string;
  expiresAt: string;
  review: {
    action: VendorPolicyAction;
    vendorId: string;
    displayName: string;
    founderWallet: string;
    recipientWallet: string;
    recipientTokenAccount: string;
    recipientTokenAccountWillBeCreated: boolean;
    canonicalMint: string;
    amountBaseUnits: string;
    amountTokens: string;
    cadence: VendorCadence;
    periodSeconds: number;
    startAt: string;
    expiryAt: string;
    recurringDelegation: string | null;
    delegationNonce: number | null;
    revokedDelegation: string | null;
    priorAmountPulledBaseUnits: string;
    replacementStartsAfterPriorPeriod: boolean;
    policyVersion: number;
    previousPolicyHash: string;
    policyHash: string;
    currentBalanceBaseUnits: string;
    projectedBalanceBaseUnits: string;
    currentRunwayMilliweeks: string;
    projectedRunwayMilliweeks: string;
    minimumRunwayWeeks: number;
  };
};

export type VendorEnrollmentResult = {
  status: "submitted" | "finalizing" | "active";
  signature: string;
  vendorId: string;
  policyVersion: number;
  policyHash: string;
  action: VendorPolicyAction;
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
  policyVersion?: number;
  policyHash?: string;
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
    vendorPolicyVersion: number;
    vendorPolicyHash: string | null;
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
