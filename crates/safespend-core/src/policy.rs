use crate::watcher::runway_milliweeks;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write;
use thiserror::Error;

const MAX_ID_LEN: usize = 96;
const MAX_ADDRESS_LEN: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Cluster {
    Devnet,
    Mainnet,
    Localnet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VendorPolicy {
    pub vendor_id: String,
    pub recipient_wallet: String,
    pub amount_per_period_base_units: u64,
    pub period_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorPolicy {
    pub cluster: Cluster,
    pub allow_mainnet: bool,
    pub subscriptions_program: String,
    pub token_program: String,
    pub canonical_mint: String,
    pub treasury_owner: String,
    pub session_delegate: String,
    pub weekly_burn_base_units: u64,
    pub minimum_runway_weeks: u64,
    pub minimum_token_reserve_base_units: u64,
    pub minimum_sol_reserve_lamports: u64,
    pub minimum_session_fee_reserve_lamports: u64,
    pub expiry_safety_buffer_seconds: u64,
    pub vendors: Vec<VendorPolicy>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentRequest {
    pub vendor_id: String,
    pub amount_base_units: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ObservedAllowance {
    pub finalized: bool,
    pub active: bool,
    pub account_owner_program: String,
    pub delegator: String,
    pub delegatee: String,
    pub mint: String,
    pub token_program: String,
    pub amount_per_period_base_units: u64,
    pub amount_pulled_this_period_base_units: u64,
    pub period_start_ts: u64,
    pub period_seconds: u64,
    pub expiry_ts: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ObservedTreasury {
    pub finalized: bool,
    pub token_balance_base_units: u64,
    pub sol_balance_lamports: u64,
    pub session_fee_balance_lamports: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ApprovedPayment {
    pub vendor_id: String,
    pub recipient_wallet: String,
    pub mint: String,
    pub token_program: String,
    pub amount_base_units: u64,
    pub period_start_ts: u64,
    pub period_end_ts: u64,
    pub post_payment_token_balance_base_units: u64,
    pub post_payment_runway_milliweeks: u128,
    pub minimum_runway_weeks: u64,
    pub allowance_remaining_after_payment_base_units: u64,
    pub policy_hash: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DenyCode {
    InvalidPolicy,
    MainnetDisabled,
    UnknownVendor,
    AmountMismatch,
    StateNotFinalized,
    AllowanceInactive,
    AllowanceProgramMismatch,
    DelegatorMismatch,
    DelegateMismatch,
    MintMismatch,
    TokenProgramMismatch,
    AllowanceTermsMismatch,
    PeriodNotStarted,
    PeriodEnded,
    AllowanceExpired,
    ExpiryTooClose,
    PeriodAlreadySpent,
    AllowanceInsufficient,
    TreasuryInsufficient,
    TokenReserveBreach,
    RunwayFloorBreach,
    SolReserveBreach,
    SessionFeeReserveBreach,
    ArithmeticOverflow,
}

#[derive(Clone, Debug, Eq, Error, PartialEq, Serialize)]
#[error("{code:?}: {message}")]
pub struct Denial {
    pub code: DenyCode,
    pub message: String,
}

impl Denial {
    fn new(code: DenyCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub fn evaluate_payment(
    policy: &OperatorPolicy,
    request: &PaymentRequest,
    allowance: &ObservedAllowance,
    treasury: &ObservedTreasury,
    now_ts: u64,
) -> Result<ApprovedPayment, Denial> {
    validate_policy(policy)?;

    if policy.cluster == Cluster::Mainnet && !policy.allow_mainnet {
        return Err(Denial::new(
            DenyCode::MainnetDisabled,
            "mainnet execution is disabled by operator policy",
        ));
    }

    let vendor = policy
        .vendors
        .iter()
        .find(|candidate| candidate.vendor_id == request.vendor_id)
        .ok_or_else(|| {
            Denial::new(
                DenyCode::UnknownVendor,
                "vendor id is not present in protected operator configuration",
            )
        })?;

    if request.amount_base_units != vendor.amount_per_period_base_units {
        return Err(Denial::new(
            DenyCode::AmountMismatch,
            "requested amount does not exactly match the configured recurring amount",
        ));
    }

    if !allowance.finalized || !treasury.finalized {
        return Err(Denial::new(
            DenyCode::StateNotFinalized,
            "allowance and treasury observations must both be finalized",
        ));
    }

    if !allowance.active {
        return Err(Denial::new(
            DenyCode::AllowanceInactive,
            "the recurring delegation is not active",
        ));
    }

    require_equal(
        &allowance.account_owner_program,
        &policy.subscriptions_program,
        DenyCode::AllowanceProgramMismatch,
        "allowance account owner does not match the pinned subscriptions program",
    )?;
    require_equal(
        &allowance.delegator,
        &policy.treasury_owner,
        DenyCode::DelegatorMismatch,
        "allowance delegator does not match the configured treasury owner",
    )?;
    require_equal(
        &allowance.delegatee,
        &policy.session_delegate,
        DenyCode::DelegateMismatch,
        "allowance delegate does not match the configured session key",
    )?;
    require_equal(
        &allowance.mint,
        &policy.canonical_mint,
        DenyCode::MintMismatch,
        "allowance mint does not match the canonical configured mint",
    )?;
    require_equal(
        &allowance.token_program,
        &policy.token_program,
        DenyCode::TokenProgramMismatch,
        "allowance token program does not match the pinned token program",
    )?;

    if allowance.amount_per_period_base_units != vendor.amount_per_period_base_units
        || allowance.period_seconds != vendor.period_seconds
    {
        return Err(Denial::new(
            DenyCode::AllowanceTermsMismatch,
            "onchain recurring terms do not exactly match vendor policy",
        ));
    }

    if now_ts < allowance.period_start_ts {
        return Err(Denial::new(
            DenyCode::PeriodNotStarted,
            "the current allowance period has not started",
        ));
    }

    if allowance.expiry_ts == 0 || now_ts > allowance.expiry_ts {
        return Err(Denial::new(
            DenyCode::AllowanceExpired,
            "the recurring delegation has no finite expiry or has expired",
        ));
    }

    let safe_until = now_ts
        .checked_add(policy.expiry_safety_buffer_seconds)
        .ok_or_else(|| {
            Denial::new(
                DenyCode::ArithmeticOverflow,
                "expiry safety window overflowed",
            )
        })?;
    if safe_until > allowance.expiry_ts {
        return Err(Denial::new(
            DenyCode::ExpiryTooClose,
            "allowance expires inside the configured safety window",
        ));
    }

    let mut effective_period_start = allowance.period_start_ts;
    let mut effective_pulled = allowance.amount_pulled_this_period_base_units;
    let elapsed = now_ts
        .checked_sub(effective_period_start)
        .ok_or_else(|| Denial::new(DenyCode::ArithmeticOverflow, "period elapsed underflowed"))?;
    if elapsed >= allowance.period_seconds {
        let periods_passed = elapsed / allowance.period_seconds;
        let increment = periods_passed
            .checked_mul(allowance.period_seconds)
            .ok_or_else(|| {
                Denial::new(
                    DenyCode::ArithmeticOverflow,
                    "period rollover multiplication overflowed",
                )
            })?;
        let candidate = effective_period_start
            .checked_add(increment)
            .ok_or_else(|| {
                Denial::new(
                    DenyCode::ArithmeticOverflow,
                    "period rollover addition overflowed",
                )
            })?;
        if candidate < allowance.expiry_ts {
            effective_period_start = candidate;
        } else {
            let last_billable = allowance.expiry_ts.checked_sub(1).ok_or_else(|| {
                Denial::new(DenyCode::ArithmeticOverflow, "allowance expiry underflowed")
            })?;
            let periods_in_bounds = last_billable
                .checked_sub(effective_period_start)
                .ok_or_else(|| {
                    Denial::new(
                        DenyCode::ArithmeticOverflow,
                        "last billable period underflowed",
                    )
                })?
                / allowance.period_seconds;
            effective_period_start = effective_period_start
                .checked_add(
                    periods_in_bounds
                        .checked_mul(allowance.period_seconds)
                        .ok_or_else(|| {
                            Denial::new(
                                DenyCode::ArithmeticOverflow,
                                "last billable period multiplication overflowed",
                            )
                        })?,
                )
                .ok_or_else(|| {
                    Denial::new(
                        DenyCode::ArithmeticOverflow,
                        "last billable period addition overflowed",
                    )
                })?;
        }
        effective_pulled = 0;
    }

    let nominal_period_end = effective_period_start
        .checked_add(allowance.period_seconds)
        .ok_or_else(|| {
            Denial::new(
                DenyCode::ArithmeticOverflow,
                "allowance period end overflowed",
            )
        })?;

    let period_end_ts = nominal_period_end.min(allowance.expiry_ts);

    if effective_pulled != 0 {
        return Err(Denial::new(
            DenyCode::PeriodAlreadySpent,
            "this fixed recurring expense has already consumed allowance this period",
        ));
    }

    let allowance_remaining = allowance
        .amount_per_period_base_units
        .checked_sub(effective_pulled)
        .ok_or_else(|| {
            Denial::new(
                DenyCode::ArithmeticOverflow,
                "observed pulled amount exceeds the period allowance",
            )
        })?;

    if allowance_remaining < request.amount_base_units {
        return Err(Denial::new(
            DenyCode::AllowanceInsufficient,
            "remaining onchain allowance is below the exact payment amount",
        ));
    }

    let post_payment_token_balance = treasury
        .token_balance_base_units
        .checked_sub(request.amount_base_units)
        .ok_or_else(|| {
            Denial::new(
                DenyCode::TreasuryInsufficient,
                "treasury token balance is below the payment amount",
            )
        })?;

    if post_payment_token_balance < policy.minimum_token_reserve_base_units {
        return Err(Denial::new(
            DenyCode::TokenReserveBreach,
            "payment would breach the protected treasury token reserve",
        ));
    }

    let post_payment_runway =
        runway_milliweeks(post_payment_token_balance, policy.weekly_burn_base_units).ok_or_else(
            || {
                Denial::new(
                    DenyCode::InvalidPolicy,
                    "weekly burn must be nonzero to enforce the runway floor",
                )
            },
        )?;
    let minimum_runway_milliweeks = u128::from(policy.minimum_runway_weeks) * 1_000;
    if post_payment_runway < minimum_runway_milliweeks {
        return Err(Denial::new(
            DenyCode::RunwayFloorBreach,
            format!(
                "payment would leave {} weeks of runway, below the protected {}-week floor",
                format_milliweeks(post_payment_runway),
                policy.minimum_runway_weeks
            ),
        ));
    }

    if treasury.sol_balance_lamports < policy.minimum_sol_reserve_lamports {
        return Err(Denial::new(
            DenyCode::SolReserveBreach,
            "treasury SOL is below the configured operational reserve",
        ));
    }

    if treasury.session_fee_balance_lamports < policy.minimum_session_fee_reserve_lamports {
        return Err(Denial::new(
            DenyCode::SessionFeeReserveBreach,
            "session-key SOL is below the configured fee reserve",
        ));
    }

    let allowance_remaining_after_payment = allowance_remaining
        .checked_sub(request.amount_base_units)
        .ok_or_else(|| {
            Denial::new(
                DenyCode::ArithmeticOverflow,
                "allowance subtraction overflowed",
            )
        })?;

    Ok(ApprovedPayment {
        vendor_id: vendor.vendor_id.clone(),
        recipient_wallet: vendor.recipient_wallet.clone(),
        mint: policy.canonical_mint.clone(),
        token_program: policy.token_program.clone(),
        amount_base_units: request.amount_base_units,
        period_start_ts: effective_period_start,
        period_end_ts,
        post_payment_token_balance_base_units: post_payment_token_balance,
        post_payment_runway_milliweeks: post_payment_runway,
        minimum_runway_weeks: policy.minimum_runway_weeks,
        allowance_remaining_after_payment_base_units: allowance_remaining_after_payment,
        policy_hash: policy_hash(policy),
    })
}

pub fn policy_hash(policy: &OperatorPolicy) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, b"schema", b"safespend-policy-v2");
    hash_field(
        &mut hasher,
        b"cluster",
        match policy.cluster {
            Cluster::Devnet => b"devnet",
            Cluster::Mainnet => b"mainnet",
            Cluster::Localnet => b"localnet",
        },
    );
    hash_field(
        &mut hasher,
        b"allow_mainnet",
        if policy.allow_mainnet {
            b"true"
        } else {
            b"false"
        },
    );
    hash_field(
        &mut hasher,
        b"subscriptions_program",
        policy.subscriptions_program.as_bytes(),
    );
    hash_field(
        &mut hasher,
        b"token_program",
        policy.token_program.as_bytes(),
    );
    hash_field(
        &mut hasher,
        b"canonical_mint",
        policy.canonical_mint.as_bytes(),
    );
    hash_field(
        &mut hasher,
        b"treasury_owner",
        policy.treasury_owner.as_bytes(),
    );
    hash_field(
        &mut hasher,
        b"session_delegate",
        policy.session_delegate.as_bytes(),
    );
    hash_field(
        &mut hasher,
        b"weekly_burn",
        &policy.weekly_burn_base_units.to_be_bytes(),
    );
    hash_field(
        &mut hasher,
        b"minimum_runway_weeks",
        &policy.minimum_runway_weeks.to_be_bytes(),
    );
    hash_field(
        &mut hasher,
        b"minimum_token_reserve",
        &policy.minimum_token_reserve_base_units.to_be_bytes(),
    );
    hash_field(
        &mut hasher,
        b"minimum_sol_reserve",
        &policy.minimum_sol_reserve_lamports.to_be_bytes(),
    );
    hash_field(
        &mut hasher,
        b"minimum_session_fee_reserve",
        &policy.minimum_session_fee_reserve_lamports.to_be_bytes(),
    );
    hash_field(
        &mut hasher,
        b"expiry_buffer",
        &policy.expiry_safety_buffer_seconds.to_be_bytes(),
    );

    for vendor in &policy.vendors {
        hash_field(&mut hasher, b"vendor_id", vendor.vendor_id.as_bytes());
        hash_field(
            &mut hasher,
            b"recipient_wallet",
            vendor.recipient_wallet.as_bytes(),
        );
        hash_field(
            &mut hasher,
            b"amount_per_period",
            &vendor.amount_per_period_base_units.to_be_bytes(),
        );
        hash_field(
            &mut hasher,
            b"period_seconds",
            &vendor.period_seconds.to_be_bytes(),
        );
    }

    to_hex(&hasher.finalize())
}

fn validate_policy(policy: &OperatorPolicy) -> Result<(), Denial> {
    validate_address("subscriptions_program", &policy.subscriptions_program)?;
    validate_address("token_program", &policy.token_program)?;
    validate_address("canonical_mint", &policy.canonical_mint)?;
    validate_address("treasury_owner", &policy.treasury_owner)?;
    validate_address("session_delegate", &policy.session_delegate)?;

    if policy.weekly_burn_base_units == 0 {
        return Err(Denial::new(
            DenyCode::InvalidPolicy,
            "weekly burn must be nonzero",
        ));
    }
    if policy.minimum_runway_weeks == 0 {
        return Err(Denial::new(
            DenyCode::InvalidPolicy,
            "minimum runway must be at least one week",
        ));
    }

    if policy.vendors.is_empty() {
        return Err(Denial::new(
            DenyCode::InvalidPolicy,
            "at least one vendor policy is required",
        ));
    }

    for (index, vendor) in policy.vendors.iter().enumerate() {
        if vendor.vendor_id.is_empty() || vendor.vendor_id.len() > MAX_ID_LEN {
            return Err(Denial::new(
                DenyCode::InvalidPolicy,
                format!("vendor at index {index} has an invalid id"),
            ));
        }
        validate_address("vendor recipient", &vendor.recipient_wallet)?;
        if vendor.amount_per_period_base_units == 0 {
            return Err(Denial::new(
                DenyCode::InvalidPolicy,
                format!("vendor {} has a zero recurring amount", vendor.vendor_id),
            ));
        }
        if vendor.period_seconds == 0 {
            return Err(Denial::new(
                DenyCode::InvalidPolicy,
                format!("vendor {} has a zero period", vendor.vendor_id),
            ));
        }
        if policy.vendors[..index]
            .iter()
            .any(|prior| prior.vendor_id == vendor.vendor_id)
        {
            return Err(Denial::new(
                DenyCode::InvalidPolicy,
                format!("duplicate vendor id {}", vendor.vendor_id),
            ));
        }
    }

    Ok(())
}

fn validate_address(label: &str, value: &str) -> Result<(), Denial> {
    if value.is_empty() || value.len() > MAX_ADDRESS_LEN {
        return Err(Denial::new(
            DenyCode::InvalidPolicy,
            format!("{label} is missing or too long"),
        ));
    }
    let decoded = bs58::decode(value).into_vec().map_err(|_| {
        Denial::new(
            DenyCode::InvalidPolicy,
            format!("{label} is not valid base58"),
        )
    })?;
    if decoded.len() != 32 {
        return Err(Denial::new(
            DenyCode::InvalidPolicy,
            format!("{label} does not decode to a 32-byte Solana address"),
        ));
    }
    Ok(())
}

fn require_equal(
    actual: &str,
    expected: &str,
    code: DenyCode,
    message: &str,
) -> Result<(), Denial> {
    if actual != expected {
        return Err(Denial::new(code, message));
    }
    Ok(())
}

fn format_milliweeks(value: u128) -> String {
    format!("{}.{:03}", value / 1_000, value % 1_000)
}

fn hash_field(hasher: &mut Sha256, label: &[u8], value: &[u8]) {
    hasher.update((label.len() as u64).to_be_bytes());
    hasher.update(label);
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn to_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUBSCRIPTIONS: &str = "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44";
    const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const MINT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    const TREASURY: &str = "7YwNV7uN4fuzkaUxC9z1uSXLVfECygqnK9YVJ2QkD8bM";
    const DELEGATE: &str = "8Fv8uEUTQGZjkYhiBL8tE7wNb9UtvA8rvQWc2wKcYpQG";
    const VENDOR: &str = "9MTbYdTTgYbcR9tVhbkLhRMozUskdQZb7ZtawKxvGwWJ";

    fn policy() -> OperatorPolicy {
        OperatorPolicy {
            cluster: Cluster::Devnet,
            allow_mainnet: false,
            subscriptions_program: SUBSCRIPTIONS.into(),
            token_program: TOKEN_PROGRAM.into(),
            canonical_mint: MINT.into(),
            treasury_owner: TREASURY.into(),
            session_delegate: DELEGATE.into(),
            weekly_burn_base_units: 10_000_000,
            minimum_runway_weeks: 8,
            minimum_token_reserve_base_units: 50_000_000,
            minimum_sol_reserve_lamports: 10_000_000,
            minimum_session_fee_reserve_lamports: 1_000_000,
            expiry_safety_buffer_seconds: 300,
            vendors: vec![VendorPolicy {
                vendor_id: "railway".into(),
                recipient_wallet: VENDOR.into(),
                amount_per_period_base_units: 12_000_000,
                period_seconds: 2_592_000,
            }],
        }
    }

    fn request() -> PaymentRequest {
        PaymentRequest {
            vendor_id: "railway".into(),
            amount_base_units: 12_000_000,
        }
    }

    fn allowance() -> ObservedAllowance {
        ObservedAllowance {
            finalized: true,
            active: true,
            account_owner_program: SUBSCRIPTIONS.into(),
            delegator: TREASURY.into(),
            delegatee: DELEGATE.into(),
            mint: MINT.into(),
            token_program: TOKEN_PROGRAM.into(),
            amount_per_period_base_units: 12_000_000,
            amount_pulled_this_period_base_units: 0,
            period_start_ts: 1_780_000_000,
            period_seconds: 2_592_000,
            expiry_ts: 1_800_000_000,
        }
    }

    fn treasury() -> ObservedTreasury {
        ObservedTreasury {
            finalized: true,
            token_balance_base_units: 100_000_000,
            sol_balance_lamports: 20_000_000,
            session_fee_balance_lamports: 2_000_000,
        }
    }

    #[test]
    fn approves_exact_finalized_payment() {
        let approved = evaluate_payment(
            &policy(),
            &request(),
            &allowance(),
            &treasury(),
            1_780_000_100,
        )
        .expect("valid payment");
        assert_eq!(approved.recipient_wallet, VENDOR);
        assert_eq!(approved.post_payment_token_balance_base_units, 88_000_000);
        assert_eq!(approved.post_payment_runway_milliweeks, 8_800);
        assert_eq!(approved.minimum_runway_weeks, 8);
        assert_eq!(approved.allowance_remaining_after_payment_base_units, 0);
        assert_eq!(approved.policy_hash.len(), 64);
    }

    #[test]
    fn policy_hash_is_deterministic_and_sensitive() {
        let first = policy_hash(&policy());
        assert_eq!(first, policy_hash(&policy()));
        let mut changed = policy();
        changed.minimum_runway_weeks += 1;
        assert_ne!(first, policy_hash(&changed));
    }

    #[test]
    fn rejects_unknown_vendor() {
        let mut bad = request();
        bad.vendor_id = "attacker".into();
        assert_denied(
            evaluate_payment(&policy(), &bad, &allowance(), &treasury(), 1_780_000_100),
            DenyCode::UnknownVendor,
        );
    }

    #[test]
    fn rejects_amount_override() {
        let mut bad = request();
        bad.amount_base_units += 1;
        assert_denied(
            evaluate_payment(&policy(), &bad, &allowance(), &treasury(), 1_780_000_100),
            DenyCode::AmountMismatch,
        );
    }

    #[test]
    fn rejects_unfinalized_rpc_state() {
        let mut bad = allowance();
        bad.finalized = false;
        assert_denied(
            evaluate_payment(&policy(), &request(), &bad, &treasury(), 1_780_000_100),
            DenyCode::StateNotFinalized,
        );
    }

    #[test]
    fn rejects_wrong_program_owner() {
        let mut bad = allowance();
        bad.account_owner_program = TREASURY.into();
        assert_denied(
            evaluate_payment(&policy(), &request(), &bad, &treasury(), 1_780_000_100),
            DenyCode::AllowanceProgramMismatch,
        );
    }

    #[test]
    fn rejects_delegate_substitution() {
        let mut bad = allowance();
        bad.delegatee = VENDOR.into();
        assert_denied(
            evaluate_payment(&policy(), &request(), &bad, &treasury(), 1_780_000_100),
            DenyCode::DelegateMismatch,
        );
    }

    #[test]
    fn rejects_lookalike_mint() {
        let mut bad = allowance();
        bad.mint = VENDOR.into();
        assert_denied(
            evaluate_payment(&policy(), &request(), &bad, &treasury(), 1_780_000_100),
            DenyCode::MintMismatch,
        );
    }

    #[test]
    fn rejects_second_payment_in_period() {
        let mut bad = allowance();
        bad.amount_pulled_this_period_base_units = 1;
        assert_denied(
            evaluate_payment(&policy(), &request(), &bad, &treasury(), 1_780_000_100),
            DenyCode::PeriodAlreadySpent,
        );
    }

    #[test]
    fn rejects_token_reserve_breach() {
        let mut low = treasury();
        low.token_balance_base_units = 60_000_000;
        assert_denied(
            evaluate_payment(&policy(), &request(), &allowance(), &low, 1_780_000_100),
            DenyCode::TokenReserveBreach,
        );
    }

    #[test]
    fn rejects_onchain_allowed_payment_below_runway_floor() {
        let mut low = treasury();
        low.token_balance_base_units = 91_000_000;
        let denial = evaluate_payment(&policy(), &request(), &allowance(), &low, 1_780_000_100)
            .expect_err("7.9 weeks must be denied");
        assert_eq!(denial.code, DenyCode::RunwayFloorBreach);
        assert!(denial.message.contains("7.900 weeks"));
        assert!(denial.message.contains("8-week floor"));
    }

    #[test]
    fn approves_exact_runway_floor_boundary() {
        let mut boundary = treasury();
        boundary.token_balance_base_units = 92_000_000;
        let approved = evaluate_payment(
            &policy(),
            &request(),
            &allowance(),
            &boundary,
            1_780_000_100,
        )
        .expect("exactly eight post-payment weeks is permitted");
        assert_eq!(approved.post_payment_runway_milliweeks, 8_000);
    }

    #[test]
    fn first_expense_succeeds_then_separate_allowed_expense_hits_runway_lock() {
        let mut two_vendors = policy();
        two_vendors.vendors.push(VendorPolicy {
            vendor_id: "contractor".into(),
            recipient_wallet: DELEGATE.into(),
            amount_per_period_base_units: 12_000_000,
            period_seconds: 2_592_000,
        });

        let first = evaluate_payment(
            &two_vendors,
            &request(),
            &allowance(),
            &treasury(),
            1_780_000_100,
        )
        .expect("hosting expense leaves 8.8 weeks");
        assert_eq!(first.post_payment_runway_milliweeks, 8_800);

        let second_request = PaymentRequest {
            vendor_id: "contractor".into(),
            amount_base_units: 12_000_000,
        };
        let after_first = ObservedTreasury {
            token_balance_base_units: first.post_payment_token_balance_base_units,
            ..treasury()
        };
        let denial = evaluate_payment(
            &two_vendors,
            &second_request,
            &allowance(),
            &after_first,
            1_780_000_100,
        )
        .expect_err("separate valid allowance must not override the runway floor");
        assert_eq!(denial.code, DenyCode::RunwayFloorBreach);
        assert!(denial.message.contains("7.600 weeks"));
    }

    #[test]
    fn zero_burn_or_zero_runway_floor_is_invalid_policy() {
        let mut zero_burn = policy();
        zero_burn.weekly_burn_base_units = 0;
        assert_denied(
            evaluate_payment(
                &zero_burn,
                &request(),
                &allowance(),
                &treasury(),
                1_780_000_100,
            ),
            DenyCode::InvalidPolicy,
        );

        let mut zero_floor = policy();
        zero_floor.minimum_runway_weeks = 0;
        assert_denied(
            evaluate_payment(
                &zero_floor,
                &request(),
                &allowance(),
                &treasury(),
                1_780_000_100,
            ),
            DenyCode::InvalidPolicy,
        );
    }

    #[test]
    fn extreme_runway_requirement_does_not_wrap() {
        let mut extreme = policy();
        extreme.weekly_burn_base_units = u64::MAX;
        extreme.minimum_runway_weeks = u64::MAX;
        let mut funded = treasury();
        funded.token_balance_base_units = u64::MAX;
        assert_denied(
            evaluate_payment(&extreme, &request(), &allowance(), &funded, 1_780_000_100),
            DenyCode::RunwayFloorBreach,
        );
    }

    #[test]
    fn rejects_sol_reserve_breach() {
        let mut low = treasury();
        low.sol_balance_lamports = 9_999_999;
        assert_denied(
            evaluate_payment(&policy(), &request(), &allowance(), &low, 1_780_000_100),
            DenyCode::SolReserveBreach,
        );
    }

    #[test]
    fn rejects_session_fee_reserve_breach() {
        let mut low = treasury();
        low.session_fee_balance_lamports = 999_999;
        assert_denied(
            evaluate_payment(&policy(), &request(), &allowance(), &low, 1_780_000_100),
            DenyCode::SessionFeeReserveBreach,
        );
    }

    #[test]
    fn advances_stale_onchain_period_like_the_program() {
        let mut stale = allowance();
        stale.amount_pulled_this_period_base_units = stale.amount_per_period_base_units;
        let now = stale.period_start_ts + stale.period_seconds + 10;
        let approved = evaluate_payment(&policy(), &request(), &stale, &treasury(), now)
            .expect("new period should reset the consumed amount");
        assert_eq!(
            approved.period_start_ts,
            stale.period_start_ts + stale.period_seconds
        );
        assert_eq!(approved.allowance_remaining_after_payment_base_units, 0);
    }

    #[test]
    fn rejects_mainnet_by_default() {
        let mut mainnet = policy();
        mainnet.cluster = Cluster::Mainnet;
        assert_denied(
            evaluate_payment(
                &mainnet,
                &request(),
                &allowance(),
                &treasury(),
                1_780_000_100,
            ),
            DenyCode::MainnetDisabled,
        );
    }

    #[test]
    fn empty_policy_fails_closed() {
        let mut empty = policy();
        empty.vendors.clear();
        assert_denied(
            evaluate_payment(&empty, &request(), &allowance(), &treasury(), 1_780_000_100),
            DenyCode::InvalidPolicy,
        );
    }

    fn assert_denied(result: Result<ApprovedPayment, Denial>, expected: DenyCode) {
        assert_eq!(result.expect_err("expected denial").code, expected);
    }
}
