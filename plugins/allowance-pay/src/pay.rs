use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use safespend_core::{
    evaluate_payment, ApprovedPayment, ObservedAllowance, ObservedTreasury, OperatorPolicy,
    PaymentRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::{collections::HashMap, str::FromStr};
use subscriptions::{
    accounts::{EventAuthority, RecurringDelegation, SubscriptionAuthority},
    instructions::{TransferRecurring, TransferRecurringInstructionArgs},
    types::TransferData,
    SUBSCRIPTIONS_ID,
};
use thiserror::Error;
use zeroize::Zeroizing;

const CLASSIC_TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MAX_RPC_RESPONSE_BYTES: usize = 512 * 1024;
const RECURRING_DELEGATION_V1_LEN: usize = 211;

pub trait RpcTransport {
    fn post_json(&self, url: &str, body: &Value) -> Result<(u16, Vec<u8>), PayError>;
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VendorAccounts {
    pub vendor_id: String,
    pub recurring_delegation: String,
    pub delegation_nonce: u64,
    pub treasury_token_account: String,
    pub recipient_token_account: String,
}

pub struct PayConfig {
    pub rpc_url: String,
    pub expected_genesis_hash: String,
    pub token_decimals: u8,
    pub policy: OperatorPolicy,
    pub vendor_accounts: Vec<VendorAccounts>,
    session_key_base58: Zeroizing<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PaymentOutput {
    pub status: &'static str,
    pub signature: String,
    pub explorer_url: String,
    pub vendor_id: String,
    pub amount_base_units: u64,
    pub post_payment_token_balance_base_units: u64,
    pub post_payment_runway_milliweeks: u128,
    pub weekly_burn_base_units: u64,
    pub minimum_runway_weeks: u64,
    pub policy_hash: String,
    pub period_start_ts: u64,
    pub period_end_ts: u64,
}

#[derive(Debug, Error)]
pub enum PayError {
    #[error("invalid protected config: {0}")]
    InvalidConfig(String),
    #[error("invalid payment request: {0}")]
    InvalidRequest(String),
    #[error("RPC transport failed")]
    Transport,
    #[error("RPC returned HTTP {0}")]
    HttpStatus(u16),
    #[error("RPC response exceeded size limit")]
    ResponseTooLarge,
    #[error("RPC response was invalid: {0}")]
    InvalidResponse(String),
    #[error("RPC method failed")]
    RpcMethod,
    #[error("RPC cluster genesis hash does not match protected config")]
    GenesisMismatch,
    #[error("session key does not match the protected delegate address")]
    SessionDelegateMismatch,
    #[error("vendor account mapping is missing or duplicated")]
    VendorMappingInvalid,
    #[error("recurring delegation PDA does not match protected seeds")]
    DelegationPdaMismatch,
    #[error("recurring delegation account is invalid")]
    InvalidDelegation,
    #[error("subscription authority PDA does not match the delegation")]
    SubscriptionAuthorityMismatch,
    #[error("configured token account failed ownership or mint validation")]
    TokenAccountMismatch,
    #[error("policy denied payment: {0}")]
    PolicyDenied(String),
    #[error("session-key fee reserve would be breached")]
    FeeReserveBreach,
    #[error("transaction construction or signing failed")]
    TransactionBuild,
    #[error("transaction simulation failed")]
    SimulationFailed,
    #[error("RPC returned a different transaction signature")]
    SignatureMismatch,
}

impl PayConfig {
    pub fn from_section(section: &HashMap<String, String>) -> Result<Self, PayError> {
        let rpc_url = required(section, "rpc_url")?;
        validate_rpc_url(&rpc_url)?;
        let expected_genesis_hash = required(section, "expected_genesis_hash")?;
        parse_address_like("expected_genesis_hash", &expected_genesis_hash)?;
        let token_decimals = parse_required(section, "token_decimals")?;
        let policy: OperatorPolicy = parse_json(section, "policy_json")?;
        let vendor_accounts: Vec<VendorAccounts> = parse_json(section, "vendor_accounts_json")?;
        let session_key_base58 = Zeroizing::new(required(section, "session_key_base58")?);

        if policy.subscriptions_program != SUBSCRIPTIONS_ID.to_string() {
            return Err(PayError::InvalidConfig(
                "subscriptions_program must be the pinned official program".into(),
            ));
        }
        if policy.token_program != CLASSIC_TOKEN_PROGRAM {
            return Err(PayError::InvalidConfig(
                "MVP supports only the classic SPL Token program".into(),
            ));
        }
        if vendor_accounts.is_empty() || vendor_accounts.len() != policy.vendors.len() {
            return Err(PayError::InvalidConfig(
                "every policy vendor needs exactly one account mapping".into(),
            ));
        }
        for mapping in &vendor_accounts {
            parse_address_like("recurring_delegation", &mapping.recurring_delegation)?;
            parse_address_like("treasury_token_account", &mapping.treasury_token_account)?;
            parse_address_like("recipient_token_account", &mapping.recipient_token_account)?;
            if !policy
                .vendors
                .iter()
                .any(|vendor| vendor.vendor_id == mapping.vendor_id)
                || vendor_accounts
                    .iter()
                    .filter(|candidate| candidate.vendor_id == mapping.vendor_id)
                    .count()
                    != 1
            {
                return Err(PayError::VendorMappingInvalid);
            }
        }

        Ok(Self {
            rpc_url,
            expected_genesis_hash,
            token_decimals,
            policy,
            vendor_accounts,
            session_key_base58,
        })
    }
}

pub fn execute_payment(
    transport: &impl RpcTransport,
    config: &PayConfig,
    request: &PaymentRequest,
) -> Result<PaymentOutput, PayError> {
    let keypair = decode_session_key(&config.session_key_base58)?;
    let delegate = keypair.pubkey();
    if delegate.to_string() != config.policy.session_delegate {
        return Err(PayError::SessionDelegateMismatch);
    }

    let vendor = config
        .policy
        .vendors
        .iter()
        .find(|vendor| vendor.vendor_id == request.vendor_id)
        .ok_or_else(|| PayError::PolicyDenied("UNKNOWN_VENDOR".into()))?;
    let accounts = exact_vendor_mapping(config, &request.vendor_id)?;

    let genesis: String = rpc_result(transport, config, 1, "getGenesisHash", json!([]))?
        .as_str()
        .ok_or_else(|| PayError::InvalidResponse("genesis hash was not a string".into()))?
        .to_owned();
    if genesis != config.expected_genesis_hash {
        return Err(PayError::GenesisMismatch);
    }

    let finalized_slot = rpc_result(
        transport,
        config,
        2,
        "getSlot",
        json!([{"commitment": "finalized"}]),
    )?
    .as_u64()
    .ok_or_else(|| PayError::InvalidResponse("finalized slot was not an integer".into()))?;
    let now_ts = rpc_result(
        transport,
        config,
        3,
        "getBlockTime",
        json!([finalized_slot]),
    )?
    .as_i64()
    .and_then(|value| u64::try_from(value).ok())
    .ok_or_else(|| PayError::InvalidResponse("finalized block time was unavailable".into()))?;

    let allowance_value = rpc_result(
        transport,
        config,
        4,
        "getAccountInfo",
        json!([
            accounts.recurring_delegation,
            {"encoding": "base64", "commitment": "finalized"}
        ]),
    )?;
    let (allowance_owner, allowance_data) = parse_binary_account(allowance_value)?;
    if allowance_owner != config.policy.subscriptions_program
        || allowance_data.len() != RECURRING_DELEGATION_V1_LEN
    {
        return Err(PayError::InvalidDelegation);
    }
    let delegation = RecurringDelegation::from_bytes(&allowance_data)
        .map_err(|_| PayError::InvalidDelegation)?;
    if delegation.header.discriminator != 3 || delegation.header.version == 0 {
        return Err(PayError::InvalidDelegation);
    }

    let treasury_owner = parse_address("treasury_owner", &config.policy.treasury_owner)?;
    let mint = parse_address("canonical_mint", &config.policy.canonical_mint)?;
    let configured_delegate = parse_address("session_delegate", &config.policy.session_delegate)?;
    let expected_allowance = find_recurring_delegation_pda(
        &delegation.subscription_authority,
        &treasury_owner,
        &configured_delegate,
        accounts.delegation_nonce,
    );
    if expected_allowance.to_string() != accounts.recurring_delegation {
        return Err(PayError::DelegationPdaMismatch);
    }
    let expected_subscription_authority = SubscriptionAuthority::find_pda(&treasury_owner, &mint).0;
    if expected_subscription_authority != delegation.subscription_authority {
        return Err(PayError::SubscriptionAuthorityMismatch);
    }

    let treasury_token_value = rpc_result(
        transport,
        config,
        5,
        "getAccountInfo",
        json!([
            accounts.treasury_token_account,
            {"encoding": "jsonParsed", "commitment": "finalized"}
        ]),
    )?;
    let treasury_token = parse_token_account(
        treasury_token_value,
        &config.policy.token_program,
        &config.policy.canonical_mint,
        &config.policy.treasury_owner,
        config.token_decimals,
    )?;
    let recipient_token_value = rpc_result(
        transport,
        config,
        6,
        "getAccountInfo",
        json!([
            accounts.recipient_token_account,
            {"encoding": "jsonParsed", "commitment": "finalized"}
        ]),
    )?;
    parse_token_account(
        recipient_token_value,
        &config.policy.token_program,
        &config.policy.canonical_mint,
        &vendor.recipient_wallet,
        config.token_decimals,
    )?;

    let treasury_sol = rpc_context_value_u64(
        rpc_result(
            transport,
            config,
            7,
            "getBalance",
            json!([config.policy.treasury_owner, {"commitment": "finalized"}]),
        )?,
        "treasury balance",
    )?;
    let session_sol = rpc_context_value_u64(
        rpc_result(
            transport,
            config,
            8,
            "getBalance",
            json!([config.policy.session_delegate, {"commitment": "finalized"}]),
        )?,
        "session balance",
    )?;

    let observed = observed_allowance(&config.policy, &delegation, allowance_owner, now_ts)?;
    let approved = evaluate_payment(
        &config.policy,
        request,
        &observed,
        &ObservedTreasury {
            finalized: true,
            token_balance_base_units: treasury_token,
            sol_balance_lamports: treasury_sol,
            session_fee_balance_lamports: session_sol,
        },
        now_ts,
    )
    .map_err(|denial| {
        let code = serde_json::to_value(denial.code)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "POLICY_DENIED".to_string());
        PayError::PolicyDenied(format!("{code}: {}", denial.message))
    })?;

    let blockhash_text = rpc_result(
        transport,
        config,
        9,
        "getLatestBlockhash",
        json!([{"commitment": "finalized"}]),
    )?
    .pointer("/value/blockhash")
    .and_then(Value::as_str)
    .ok_or_else(|| PayError::InvalidResponse("latest blockhash was missing".into()))?
    .to_owned();
    let blockhash = Hash::from_str(&blockhash_text).map_err(|_| PayError::TransactionBuild)?;

    let instruction = TransferRecurring {
        delegation_pda: expected_allowance,
        subscription_authority: expected_subscription_authority,
        delegator_ata: parse_address("treasury_token_account", &accounts.treasury_token_account)?,
        receiver_ata: parse_address("recipient_token_account", &accounts.recipient_token_account)?,
        token_mint: mint,
        token_program: parse_address("token_program", &config.policy.token_program)?,
        delegatee: delegate,
        event_authority: EventAuthority::find_pda().0,
        self_program: SUBSCRIPTIONS_ID,
    }
    .instruction(TransferRecurringInstructionArgs {
        transfer_data: TransferData {
            amount: approved.amount_base_units,
            delegator: treasury_owner,
            mint,
        },
    });
    let mut message = Message::new(&[instruction], Some(&delegate));
    message.recent_blockhash.clone_from(&blockhash);
    let message_bytes = bincode::serialize(&message).map_err(|_| PayError::TransactionBuild)?;
    let fee = rpc_result(
        transport,
        config,
        10,
        "getFeeForMessage",
        json!([
            BASE64.encode(message_bytes),
            {"commitment": "finalized"}
        ]),
    )?
    .pointer("/value")
    .and_then(Value::as_u64)
    .ok_or_else(|| PayError::InvalidResponse("fee estimate was unavailable".into()))?;
    let post_fee = session_sol
        .checked_sub(fee)
        .ok_or(PayError::FeeReserveBreach)?;
    if post_fee < config.policy.minimum_session_fee_reserve_lamports {
        return Err(PayError::FeeReserveBreach);
    }

    let mut transaction = Transaction::new_unsigned(message);
    transaction
        .try_sign(&[&keypair], blockhash)
        .map_err(|_| PayError::TransactionBuild)?;
    let expected_signature = transaction
        .signatures
        .first()
        .ok_or(PayError::TransactionBuild)?
        .to_string();
    let transaction_bytes =
        bincode::serialize(&transaction).map_err(|_| PayError::TransactionBuild)?;
    let encoded_transaction = BASE64.encode(transaction_bytes);

    let simulation = rpc_result(
        transport,
        config,
        11,
        "simulateTransaction",
        json!([
            encoded_transaction,
            {
                "encoding": "base64",
                "sigVerify": true,
                "replaceRecentBlockhash": false,
                "commitment": "finalized"
            }
        ]),
    )?;
    if !simulation.pointer("/value/err").is_some_and(Value::is_null) {
        return Err(PayError::SimulationFailed);
    }

    let submitted_signature = rpc_result(
        transport,
        config,
        12,
        "sendTransaction",
        json!([
            encoded_transaction,
            {
                "encoding": "base64",
                "skipPreflight": false,
                "preflightCommitment": "finalized",
                "maxRetries": 3
            }
        ]),
    )?
    .as_str()
    .ok_or_else(|| PayError::InvalidResponse("submitted signature was missing".into()))?
    .to_owned();
    if submitted_signature != expected_signature {
        return Err(PayError::SignatureMismatch);
    }

    Ok(output_for(config, approved, submitted_signature))
}

fn output_for(config: &PayConfig, approved: ApprovedPayment, signature: String) -> PaymentOutput {
    let cluster = match config.policy.cluster {
        safespend_core::Cluster::Devnet => "?cluster=devnet",
        safespend_core::Cluster::Localnet => "?cluster=custom",
        safespend_core::Cluster::Mainnet => "",
    };
    PaymentOutput {
        status: "submitted",
        explorer_url: format!("https://explorer.solana.com/tx/{signature}{cluster}"),
        signature,
        vendor_id: approved.vendor_id,
        amount_base_units: approved.amount_base_units,
        post_payment_token_balance_base_units: approved.post_payment_token_balance_base_units,
        post_payment_runway_milliweeks: approved.post_payment_runway_milliweeks,
        weekly_burn_base_units: config.policy.weekly_burn_base_units,
        minimum_runway_weeks: approved.minimum_runway_weeks,
        policy_hash: approved.policy_hash,
        period_start_ts: approved.period_start_ts,
        period_end_ts: approved.period_end_ts,
    }
}

fn observed_allowance(
    policy: &OperatorPolicy,
    delegation: &RecurringDelegation,
    account_owner_program: String,
    now_ts: u64,
) -> Result<ObservedAllowance, PayError> {
    let period_start_ts = u64::try_from(delegation.current_period_start_ts)
        .map_err(|_| PayError::InvalidDelegation)?;
    let expiry_ts = u64::try_from(delegation.expiry_ts).map_err(|_| PayError::InvalidDelegation)?;
    Ok(ObservedAllowance {
        finalized: true,
        active: delegation.expiry_ts > 0 && now_ts <= expiry_ts,
        account_owner_program,
        delegator: delegation.header.delegator.to_string(),
        delegatee: delegation.header.delegatee.to_string(),
        mint: delegation.mint.to_string(),
        token_program: policy.token_program.clone(),
        amount_per_period_base_units: delegation.amount_per_period,
        amount_pulled_this_period_base_units: delegation.amount_pulled_in_period,
        period_start_ts,
        period_seconds: delegation.period_length_s,
        expiry_ts,
    })
}

fn find_recurring_delegation_pda(
    subscription_authority: &Address,
    delegator: &Address,
    delegatee: &Address,
    nonce: u64,
) -> Address {
    // The onchain program uses little-endian nonce bytes. This is intentionally
    // not the generated v0.4.0 helper, whose nonce seed encoding differs.
    Address::find_program_address(
        &[
            b"delegation",
            subscription_authority.as_ref(),
            delegator.as_ref(),
            delegatee.as_ref(),
            &nonce.to_le_bytes(),
        ],
        &SUBSCRIPTIONS_ID,
    )
    .0
}

fn exact_vendor_mapping<'a>(
    config: &'a PayConfig,
    vendor_id: &str,
) -> Result<&'a VendorAccounts, PayError> {
    let mut matches = config
        .vendor_accounts
        .iter()
        .filter(|mapping| mapping.vendor_id == vendor_id);
    let first = matches.next().ok_or(PayError::VendorMappingInvalid)?;
    if matches.next().is_some() {
        return Err(PayError::VendorMappingInvalid);
    }
    Ok(first)
}

fn decode_session_key(encoded: &str) -> Result<Keypair, PayError> {
    let bytes = Zeroizing::new(
        bs58::decode(encoded)
            .into_vec()
            .map_err(|_| PayError::InvalidConfig("session key is not valid base58".into()))?,
    );
    if bytes.len() != 64 {
        return Err(PayError::InvalidConfig(
            "session key must decode to an exact 64-byte Solana keypair".into(),
        ));
    }
    Keypair::try_from(bytes.as_slice())
        .map_err(|_| PayError::InvalidConfig("session keypair bytes are inconsistent".into()))
}

fn rpc_result(
    transport: &impl RpcTransport,
    config: &PayConfig,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, PayError> {
    let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    let (status, bytes) = transport.post_json(&config.rpc_url, &body)?;
    if status != 200 {
        return Err(PayError::HttpStatus(status));
    }
    if bytes.len() > MAX_RPC_RESPONSE_BYTES {
        return Err(PayError::ResponseTooLarge);
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| PayError::InvalidResponse("response was not valid JSON".into()))?;
    if value.get("error").is_some() {
        return Err(PayError::RpcMethod);
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| PayError::InvalidResponse("RPC result was missing".into()))
}

fn parse_binary_account(value: Value) -> Result<(String, Vec<u8>), PayError> {
    let account = value
        .get("value")
        .filter(|candidate| !candidate.is_null())
        .ok_or(PayError::InvalidDelegation)?;
    let owner = account
        .get("owner")
        .and_then(Value::as_str)
        .ok_or(PayError::InvalidDelegation)?
        .to_owned();
    let encoded = account
        .pointer("/data/0")
        .and_then(Value::as_str)
        .ok_or(PayError::InvalidDelegation)?;
    let encoding = account
        .pointer("/data/1")
        .and_then(Value::as_str)
        .ok_or(PayError::InvalidDelegation)?;
    if encoding != "base64" {
        return Err(PayError::InvalidDelegation);
    }
    let data = BASE64
        .decode(encoded)
        .map_err(|_| PayError::InvalidDelegation)?;
    Ok((owner, data))
}

fn parse_token_account(
    value: Value,
    expected_program: &str,
    expected_mint: &str,
    expected_wallet: &str,
    expected_decimals: u8,
) -> Result<u64, PayError> {
    let account = value
        .get("value")
        .filter(|candidate| !candidate.is_null())
        .ok_or(PayError::TokenAccountMismatch)?;
    if account.get("owner").and_then(Value::as_str) != Some(expected_program) {
        return Err(PayError::TokenAccountMismatch);
    }
    let info = account
        .pointer("/data/parsed/info")
        .ok_or(PayError::TokenAccountMismatch)?;
    if info.get("mint").and_then(Value::as_str) != Some(expected_mint)
        || info.get("owner").and_then(Value::as_str) != Some(expected_wallet)
        || info.get("state").and_then(Value::as_str) != Some("initialized")
        || info
            .pointer("/tokenAmount/decimals")
            .and_then(Value::as_u64)
            != Some(u64::from(expected_decimals))
    {
        return Err(PayError::TokenAccountMismatch);
    }
    info.pointer("/tokenAmount/amount")
        .and_then(Value::as_str)
        .and_then(|amount| amount.parse().ok())
        .ok_or(PayError::TokenAccountMismatch)
}

fn rpc_context_value_u64(value: Value, label: &str) -> Result<u64, PayError> {
    value
        .get("value")
        .and_then(Value::as_u64)
        .ok_or_else(|| PayError::InvalidResponse(format!("{label} was missing")))
}

fn parse_address(label: &str, value: &str) -> Result<Address, PayError> {
    Address::from_str(value)
        .map_err(|_| PayError::InvalidConfig(format!("{label} is not a Solana address")))
}

fn parse_address_like(label: &str, value: &str) -> Result<(), PayError> {
    parse_address(label, value).map(|_| ())
}

fn required(section: &HashMap<String, String>, key: &str) -> Result<String, PayError> {
    section
        .get(key)
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| PayError::InvalidConfig(format!("missing {key}")))
}

fn parse_required<T>(section: &HashMap<String, String>, key: &str) -> Result<T, PayError>
where
    T: FromStr,
{
    required(section, key)?
        .parse()
        .map_err(|_| PayError::InvalidConfig(format!("{key} has an invalid value")))
}

fn parse_json<T>(section: &HashMap<String, String>, key: &str) -> Result<T, PayError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_str(&required(section, key)?)
        .map_err(|_| PayError::InvalidConfig(format!("{key} is invalid JSON")))
}

fn validate_rpc_url(url: &str) -> Result<(), PayError> {
    let loopback = url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://localhost:")
        || url == "http://127.0.0.1"
        || url == "http://localhost";
    if !url.starts_with("https://") && !loopback {
        return Err(PayError::InvalidConfig(
            "rpc_url must use HTTPS except for loopback development".into(),
        ));
    }
    Ok(())
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

    #[test]
    fn public_plaintext_rpc_is_rejected() {
        assert!(matches!(
            validate_rpc_url("http://rpc.example.com"),
            Err(PayError::InvalidConfig(_))
        ));
    }

    #[test]
    fn invalid_secret_does_not_panic() {
        assert!(matches!(
            decode_session_key("attacker-controlled"),
            Err(PayError::InvalidConfig(_))
        ));
    }

    #[test]
    fn token_account_substitution_fails_closed() {
        let value = json!({
            "value": {
                "owner": TOKEN_PROGRAM,
                "data": {"parsed": {"info": {
                    "mint": MINT,
                    "owner": VENDOR,
                    "state": "initialized",
                    "tokenAmount": {"amount": "12000000", "decimals": 6}
                }}}
            }
        });
        assert!(matches!(
            parse_token_account(value, TOKEN_PROGRAM, MINT, TREASURY, 6),
            Err(PayError::TokenAccountMismatch)
        ));
    }

    #[test]
    fn pda_uses_the_programs_little_endian_nonce_seed() {
        let authority = Address::from_str(TREASURY).unwrap();
        let delegator = Address::from_str(TREASURY).unwrap();
        let delegate = Address::from_str(DELEGATE).unwrap();
        let first = find_recurring_delegation_pda(&authority, &delegator, &delegate, 1);
        let second = find_recurring_delegation_pda(&authority, &delegator, &delegate, 256);
        assert_ne!(first, second);
        assert_eq!(first.as_ref().len(), 32);
        assert_eq!(SUBSCRIPTIONS_ID.to_string(), SUBSCRIPTIONS);
    }
}
