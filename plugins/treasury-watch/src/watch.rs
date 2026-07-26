use safespend_core::{summarize_treasury, BalanceSnapshot, TreasurySummary, TreasuryThresholds};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use thiserror::Error;

const DEFAULT_RECENT_LIMIT: usize = 3;
const MAX_RECENT_LIMIT: usize = 5;
const MAX_RPC_RESPONSE_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WatchArgs {
    #[serde(default)]
    pub previous_snapshot: Option<BalanceSnapshot>,
    #[serde(default)]
    pub native_cursor: ActivityCursor,
    #[serde(default)]
    pub token_cursor: ActivityCursor,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityCursor {
    #[serde(default)]
    pub last_finalized_signature: Option<String>,
    #[serde(default)]
    pub backfill_before: Option<String>,
    #[serde(default)]
    pub pending_newest_signature: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ActivityEvent {
    pub signature: String,
    pub slot: u64,
    pub block_time: Option<i64>,
    pub failed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ActivityPage {
    pub baseline: bool,
    pub complete: bool,
    pub events: Vec<ActivityEvent>,
    pub next_cursor: ActivityCursor,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WatchOutput {
    pub snapshot: BalanceSnapshot,
    pub summary: TreasurySummary,
    pub native_activity: ActivityPage,
    pub token_activity: ActivityPage,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchConfig {
    pub rpc_url: String,
    pub treasury_owner: String,
    pub treasury_token_account: String,
    pub canonical_mint: String,
    pub token_program: String,
    pub token_decimals: u8,
    pub weekly_burn_base_units: u64,
    pub minimum_runway_weeks: u64,
    pub minimum_token_reserve_base_units: u64,
    pub minimum_sol_reserve_lamports: u64,
    pub meaningful_token_delta_base_units: u64,
    pub meaningful_sol_delta_lamports: u64,
    pub recent_limit: usize,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum WatchError {
    #[error("invalid config: {0}")]
    InvalidConfig(String),
    #[error("invalid arguments: {0}")]
    InvalidArguments(String),
    #[error("RPC transport failed")]
    Transport,
    #[error("RPC returned HTTP {0}")]
    HttpStatus(u16),
    #[error("RPC response exceeded size limit")]
    ResponseTooLarge,
    #[error("RPC response was invalid: {0}")]
    InvalidResponse(String),
    #[error("RPC method {0} failed")]
    RpcMethod(u64),
    #[error("token account owner mismatch")]
    TokenAccountOwnerMismatch,
    #[error("token account mint mismatch")]
    TokenMintMismatch,
    #[error("token account wallet owner mismatch")]
    TokenWalletOwnerMismatch,
    #[error("token account decimals mismatch")]
    TokenDecimalsMismatch,
}

pub trait RpcTransport {
    fn post_json(&self, url: &str, body: &Value) -> Result<(u16, Vec<u8>), WatchError>;
}

impl WatchConfig {
    pub fn from_section(section: &HashMap<String, String>) -> Result<Self, WatchError> {
        let rpc_url = required(section, "rpc_url")?;
        validate_rpc_url(&rpc_url)?;

        let treasury_owner = required_pubkey(section, "treasury_owner")?;
        let treasury_token_account = required_pubkey(section, "treasury_token_account")?;
        let canonical_mint = required_pubkey(section, "canonical_mint")?;
        let token_program = required_pubkey(section, "token_program")?;

        let token_decimals = parse_u64(section, "token_decimals")?;
        let token_decimals = u8::try_from(token_decimals)
            .map_err(|_| WatchError::InvalidConfig("token_decimals must fit in u8".to_string()))?;
        if token_decimals > 18 {
            return Err(WatchError::InvalidConfig(
                "token_decimals must be at most 18".to_string(),
            ));
        }

        let recent_limit = section
            .get("recent_limit")
            .map(|value| {
                value.parse::<usize>().map_err(|_| {
                    WatchError::InvalidConfig("recent_limit must be a positive integer".to_string())
                })
            })
            .transpose()?
            .unwrap_or(DEFAULT_RECENT_LIMIT);
        if !(1..=MAX_RECENT_LIMIT).contains(&recent_limit) {
            return Err(WatchError::InvalidConfig(format!(
                "recent_limit must be between 1 and {MAX_RECENT_LIMIT}"
            )));
        }

        let weekly_burn_base_units = parse_u64(section, "weekly_burn_base_units")?;
        if weekly_burn_base_units == 0 {
            return Err(WatchError::InvalidConfig(
                "weekly_burn_base_units must be nonzero".to_string(),
            ));
        }
        let minimum_runway_weeks = parse_u64(section, "minimum_runway_weeks")?;
        if minimum_runway_weeks == 0 {
            return Err(WatchError::InvalidConfig(
                "minimum_runway_weeks must be at least one".to_string(),
            ));
        }

        Ok(Self {
            rpc_url,
            treasury_owner,
            treasury_token_account,
            canonical_mint,
            token_program,
            token_decimals,
            weekly_burn_base_units,
            minimum_runway_weeks,
            minimum_token_reserve_base_units: parse_u64(
                section,
                "minimum_token_reserve_base_units",
            )?,
            minimum_sol_reserve_lamports: parse_u64(section, "minimum_sol_reserve_lamports")?,
            meaningful_token_delta_base_units: parse_u64(
                section,
                "meaningful_token_delta_base_units",
            )?,
            meaningful_sol_delta_lamports: parse_u64(section, "meaningful_sol_delta_lamports")?,
            recent_limit,
        })
    }
}

pub fn execute_watch(
    transport: &impl RpcTransport,
    config: &WatchConfig,
    args: &WatchArgs,
    observed_at_ts: u64,
) -> Result<WatchOutput, WatchError> {
    validate_cursor(&args.native_cursor)?;
    validate_cursor(&args.token_cursor)?;

    let batch = json!([
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getBalance",
            "params": [config.treasury_owner, {"commitment": "finalized"}]
        },
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "getAccountInfo",
            "params": [
                config.treasury_token_account,
                {"commitment": "finalized", "encoding": "jsonParsed"}
            ]
        },
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "getSignaturesForAddress",
            "params": [
                config.treasury_owner,
                signature_options(&args.native_cursor, config.recent_limit)
            ]
        },
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "getSignaturesForAddress",
            "params": [
                config.treasury_token_account,
                signature_options(&args.token_cursor, config.recent_limit)
            ]
        }
    ]);

    let (status, bytes) = transport.post_json(&config.rpc_url, &batch)?;
    if !(200..300).contains(&status) {
        return Err(WatchError::HttpStatus(status));
    }
    if bytes.len() > MAX_RPC_RESPONSE_BYTES {
        return Err(WatchError::ResponseTooLarge);
    }
    let response: Value = serde_json::from_slice(&bytes)
        .map_err(|_| WatchError::InvalidResponse("response is not JSON".to_string()))?;
    let rows = response
        .as_array()
        .ok_or_else(|| WatchError::InvalidResponse("batch response is not an array".to_string()))?;

    let balance = result_for(rows, 1)?;
    let native_slot = required_u64(balance, &["context", "slot"], "balance context slot")?;
    let sol_balance = required_u64(balance, &["value"], "lamport balance")?;

    let account = result_for(rows, 2)?;
    let token_slot = required_u64(account, &["context", "slot"], "token context slot")?;
    let account_value = account
        .get("value")
        .filter(|value| !value.is_null())
        .ok_or_else(|| WatchError::InvalidResponse("token account does not exist".to_string()))?;

    let account_owner = required_str(account_value, &["owner"], "token account program owner")?;
    if account_owner != config.token_program {
        return Err(WatchError::TokenAccountOwnerMismatch);
    }

    let info_path = ["data", "parsed", "info"];
    let token_info = value_at(account_value, &info_path).ok_or_else(|| {
        WatchError::InvalidResponse("token account is not jsonParsed".to_string())
    })?;
    if required_str(token_info, &["mint"], "token mint")? != config.canonical_mint {
        return Err(WatchError::TokenMintMismatch);
    }
    if required_str(token_info, &["owner"], "token wallet owner")? != config.treasury_owner {
        return Err(WatchError::TokenWalletOwnerMismatch);
    }
    let token_amount = value_at(token_info, &["tokenAmount"])
        .ok_or_else(|| WatchError::InvalidResponse("missing token amount".to_string()))?;
    let decimals = required_u64(token_amount, &["decimals"], "token decimals")?;
    if decimals != u64::from(config.token_decimals) {
        return Err(WatchError::TokenDecimalsMismatch);
    }
    let token_balance = required_str(token_amount, &["amount"], "token amount")?
        .parse::<u64>()
        .map_err(|_| WatchError::InvalidResponse("token amount is not u64".to_string()))?;

    let snapshot = BalanceSnapshot {
        finalized_slot: native_slot.min(token_slot),
        observed_at_ts,
        token_balance_base_units: token_balance,
        sol_balance_lamports: sol_balance,
    };
    let summary = summarize_treasury(
        args.previous_snapshot.as_ref(),
        &snapshot,
        &TreasuryThresholds {
            weekly_burn_base_units: config.weekly_burn_base_units,
            minimum_runway_weeks: config.minimum_runway_weeks,
            minimum_token_reserve_base_units: config.minimum_token_reserve_base_units,
            minimum_sol_reserve_lamports: config.minimum_sol_reserve_lamports,
            meaningful_token_delta_base_units: config.meaningful_token_delta_base_units,
            meaningful_sol_delta_lamports: config.meaningful_sol_delta_lamports,
        },
    );

    let native_rows = signature_rows(result_for(rows, 3)?)?;
    let token_rows = signature_rows(result_for(rows, 4)?)?;

    Ok(WatchOutput {
        snapshot,
        summary,
        native_activity: page_from_rows(&args.native_cursor, native_rows, config.recent_limit),
        token_activity: page_from_rows(&args.token_cursor, token_rows, config.recent_limit),
    })
}

fn signature_options(cursor: &ActivityCursor, limit: usize) -> Value {
    let baseline = cursor.last_finalized_signature.is_none();
    let mut options = serde_json::Map::new();
    options.insert(
        "commitment".to_string(),
        Value::String("finalized".to_string()),
    );
    options.insert(
        "limit".to_string(),
        Value::from(if baseline { 1 } else { limit }),
    );
    if let Some(until) = &cursor.last_finalized_signature {
        options.insert("until".to_string(), Value::String(until.clone()));
    }
    if let Some(before) = &cursor.backfill_before {
        options.insert("before".to_string(), Value::String(before.clone()));
    }
    Value::Object(options)
}

fn page_from_rows(cursor: &ActivityCursor, rows: Vec<ActivityEvent>, limit: usize) -> ActivityPage {
    if cursor.last_finalized_signature.is_none() {
        return ActivityPage {
            baseline: true,
            complete: true,
            events: Vec::new(),
            next_cursor: ActivityCursor {
                last_finalized_signature: rows.first().map(|row| row.signature.clone()),
                backfill_before: None,
                pending_newest_signature: None,
            },
        };
    }

    let complete = rows.len() < limit;
    let pending_newest = cursor
        .pending_newest_signature
        .clone()
        .or_else(|| rows.first().map(|row| row.signature.clone()));

    let next_cursor = if complete {
        ActivityCursor {
            last_finalized_signature: pending_newest
                .or_else(|| cursor.last_finalized_signature.clone()),
            backfill_before: None,
            pending_newest_signature: None,
        }
    } else {
        ActivityCursor {
            last_finalized_signature: cursor.last_finalized_signature.clone(),
            backfill_before: rows.last().map(|row| row.signature.clone()),
            pending_newest_signature: pending_newest,
        }
    };

    ActivityPage {
        baseline: false,
        complete,
        events: rows,
        next_cursor,
    }
}

fn signature_rows(value: &Value) -> Result<Vec<ActivityEvent>, WatchError> {
    let rows = value.as_array().ok_or_else(|| {
        WatchError::InvalidResponse("signature result is not an array".to_string())
    })?;
    rows.iter()
        .map(|row| {
            let signature = required_str(row, &["signature"], "signature")?.to_string();
            validate_signature(&signature)?;
            Ok(ActivityEvent {
                signature,
                slot: required_u64(row, &["slot"], "signature slot")?,
                block_time: row.get("blockTime").and_then(Value::as_i64),
                failed: row.get("err").is_some_and(|error| !error.is_null()),
            })
        })
        .collect()
}

fn result_for(rows: &[Value], id: u64) -> Result<&Value, WatchError> {
    let row = rows
        .iter()
        .find(|row| row.get("id").and_then(Value::as_u64) == Some(id))
        .ok_or_else(|| WatchError::InvalidResponse(format!("missing response id {id}")))?;
    if row.get("error").is_some_and(|error| !error.is_null()) {
        return Err(WatchError::RpcMethod(id));
    }
    row.get("result")
        .ok_or_else(|| WatchError::InvalidResponse(format!("missing result for id {id}")))
}

fn value_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |current, key| current.get(key))
}

fn required_str<'a>(value: &'a Value, path: &[&str], label: &str) -> Result<&'a str, WatchError> {
    value_at(value, path)
        .and_then(Value::as_str)
        .ok_or_else(|| WatchError::InvalidResponse(format!("missing or invalid {label}")))
}

fn required_u64(value: &Value, path: &[&str], label: &str) -> Result<u64, WatchError> {
    value_at(value, path)
        .and_then(Value::as_u64)
        .ok_or_else(|| WatchError::InvalidResponse(format!("missing or invalid {label}")))
}

fn validate_cursor(cursor: &ActivityCursor) -> Result<(), WatchError> {
    if cursor.last_finalized_signature.is_none()
        && (cursor.backfill_before.is_some() || cursor.pending_newest_signature.is_some())
    {
        return Err(WatchError::InvalidArguments(
            "backfill state requires a finalized cursor".to_string(),
        ));
    }
    for signature in [
        cursor.last_finalized_signature.as_deref(),
        cursor.backfill_before.as_deref(),
        cursor.pending_newest_signature.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        validate_signature(signature)?;
    }
    Ok(())
}

fn validate_signature(value: &str) -> Result<(), WatchError> {
    let bytes = bs58::decode(value)
        .into_vec()
        .map_err(|_| WatchError::InvalidArguments("signature is not base58".to_string()))?;
    if bytes.len() != 64 {
        return Err(WatchError::InvalidArguments(
            "signature must decode to 64 bytes".to_string(),
        ));
    }
    Ok(())
}

fn validate_pubkey(label: &str, value: &str) -> Result<(), WatchError> {
    let bytes = bs58::decode(value)
        .into_vec()
        .map_err(|_| WatchError::InvalidConfig(format!("{label} is not base58")))?;
    if bytes.len() != 32 {
        return Err(WatchError::InvalidConfig(format!(
            "{label} must decode to 32 bytes"
        )));
    }
    Ok(())
}

fn required(section: &HashMap<String, String>, key: &str) -> Result<String, WatchError> {
    section
        .get(key)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| WatchError::InvalidConfig(format!("missing {key}")))
}

fn required_pubkey(section: &HashMap<String, String>, key: &str) -> Result<String, WatchError> {
    let value = required(section, key)?;
    validate_pubkey(key, &value)?;
    Ok(value)
}

fn parse_u64(section: &HashMap<String, String>, key: &str) -> Result<u64, WatchError> {
    required(section, key)?
        .parse::<u64>()
        .map_err(|_| WatchError::InvalidConfig(format!("{key} must be u64")))
}

fn validate_rpc_url(value: &str) -> Result<(), WatchError> {
    if value.len() > 2_048 {
        return Err(WatchError::InvalidConfig(
            "rpc_url exceeds 2048 bytes".to_string(),
        ));
    }
    let secure = value.starts_with("https://");
    let local = value.starts_with("http://127.0.0.1:") || value.starts_with("http://localhost:");
    if !secure && !local {
        return Err(WatchError::InvalidConfig(
            "rpc_url must use https, except loopback localnet".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TREASURY: &str = "7YwNV7uN4fuzkaUxC9z1uSXLVfECygqnK9YVJ2QkD8bM";
    const TOKEN_ACCOUNT: &str = "H2Ugzo7c9p2f8CqAGQ6kF5mPS5FKFUEtLGfq6bGJfPVn";
    const MINT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const SIG_A: &str =
        "5G9wpVYJi7CjRF6fDCqSJRgcxF9iE6JtjZiAXKYPmktRynjN1yZsPHo5tGXJ44pGjB7NfRQVVTKy8dKMcB6P2wAb";
    const SIG_B: &str =
        "4fVQ7YrWNJFdVBYJH9bDBhBHRg5mBDbqNj4GgTtBGqtVcQkTQ7jH6dBTVWc8gjMZZ1M1qYfh3u8SPZB1jzYv2bQL";
    const SIG_C: &str =
        "3FZ4DAXmDBnHDvDzi27X6X7D4YqzJPzkqKLtqBmg2HTQ69enHzWkCE9icTBCnnd5K4aJxusgA88kHzL1bEBpqPQs";

    struct MockTransport {
        status: u16,
        response: Value,
    }

    impl RpcTransport for MockTransport {
        fn post_json(&self, _url: &str, _body: &Value) -> Result<(u16, Vec<u8>), WatchError> {
            Ok((
                self.status,
                serde_json::to_vec(&self.response).expect("fixture serializes"),
            ))
        }
    }

    fn config() -> WatchConfig {
        WatchConfig {
            rpc_url: "https://api.devnet.solana.com".to_string(),
            treasury_owner: TREASURY.to_string(),
            treasury_token_account: TOKEN_ACCOUNT.to_string(),
            canonical_mint: MINT.to_string(),
            token_program: TOKEN_PROGRAM.to_string(),
            token_decimals: 6,
            weekly_burn_base_units: 10_000_000,
            minimum_runway_weeks: 8,
            minimum_token_reserve_base_units: 50_000_000,
            minimum_sol_reserve_lamports: 10_000_000,
            meaningful_token_delta_base_units: 1_000_000,
            meaningful_sol_delta_lamports: 1_000_000,
            recent_limit: 2,
        }
    }

    fn response(native: Value, token: Value) -> Value {
        json!([
            {
                "jsonrpc": "2.0",
                "id": 1,
                "result": {"context": {"slot": 100}, "value": 20_000_000}
            },
            {
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "context": {"slot": 101},
                    "value": {
                        "owner": TOKEN_PROGRAM,
                        "data": {
                            "parsed": {
                                "info": {
                                    "mint": MINT,
                                    "owner": TREASURY,
                                    "tokenAmount": {
                                        "amount": "100000000",
                                        "decimals": 6,
                                        "uiAmount": 100.0
                                    }
                                },
                                "type": "account"
                            },
                            "program": "spl-token",
                            "space": 165
                        }
                    }
                }
            },
            {"jsonrpc": "2.0", "id": 3, "result": native},
            {"jsonrpc": "2.0", "id": 4, "result": token}
        ])
    }

    fn event(signature: &str, slot: u64) -> Value {
        json!({
            "signature": signature,
            "slot": slot,
            "blockTime": 1_780_000_000,
            "err": null,
            "memo": null,
            "confirmationStatus": "finalized"
        })
    }

    #[test]
    fn first_run_establishes_baseline_without_replaying_activity() {
        let transport = MockTransport {
            status: 200,
            response: response(json!([event(SIG_A, 99)]), json!([event(SIG_B, 98)])),
        };
        let output = execute_watch(
            &transport,
            &config(),
            &WatchArgs {
                previous_snapshot: None,
                native_cursor: ActivityCursor::default(),
                token_cursor: ActivityCursor::default(),
            },
            1_780_000_100,
        )
        .expect("valid watch");
        assert_eq!(output.snapshot.finalized_slot, 100);
        assert!(output.native_activity.events.is_empty());
        assert_eq!(
            output
                .native_activity
                .next_cursor
                .last_finalized_signature
                .as_deref(),
            Some(SIG_A)
        );
        assert_eq!(output.summary.runway_milliweeks, Some(10_000));
    }

    #[test]
    fn full_page_keeps_old_cursor_until_backfill_finishes() {
        let cursor = ActivityCursor {
            last_finalized_signature: Some(SIG_C.to_string()),
            ..ActivityCursor::default()
        };
        let page = page_from_rows(
            &cursor,
            vec![
                ActivityEvent {
                    signature: SIG_A.to_string(),
                    slot: 102,
                    block_time: None,
                    failed: false,
                },
                ActivityEvent {
                    signature: SIG_B.to_string(),
                    slot: 101,
                    block_time: None,
                    failed: false,
                },
            ],
            2,
        );
        assert!(!page.complete);
        assert_eq!(
            page.next_cursor.last_finalized_signature.as_deref(),
            Some(SIG_C)
        );
        assert_eq!(page.next_cursor.backfill_before.as_deref(), Some(SIG_B));
        assert_eq!(
            page.next_cursor.pending_newest_signature.as_deref(),
            Some(SIG_A)
        );
    }

    #[test]
    fn backfill_completion_advances_to_pending_newest() {
        let cursor = ActivityCursor {
            last_finalized_signature: Some(SIG_C.to_string()),
            backfill_before: Some(SIG_B.to_string()),
            pending_newest_signature: Some(SIG_A.to_string()),
        };
        let page = page_from_rows(&cursor, Vec::new(), 2);
        assert!(page.complete);
        assert_eq!(
            page.next_cursor.last_finalized_signature.as_deref(),
            Some(SIG_A)
        );
        assert!(page.next_cursor.backfill_before.is_none());
    }

    #[test]
    fn token_account_substitution_fails_closed() {
        let mut fixture = response(json!([]), json!([]));
        fixture[1]["result"]["value"]["data"]["parsed"]["info"]["owner"] =
            Value::String(TOKEN_ACCOUNT.to_string());
        let transport = MockTransport {
            status: 200,
            response: fixture,
        };
        let error = execute_watch(
            &transport,
            &config(),
            &WatchArgs {
                previous_snapshot: None,
                native_cursor: ActivityCursor::default(),
                token_cursor: ActivityCursor::default(),
            },
            1_780_000_100,
        )
        .expect_err("owner mismatch");
        assert_eq!(error, WatchError::TokenWalletOwnerMismatch);
    }

    #[test]
    fn empty_config_fails_before_network() {
        let error = WatchConfig::from_section(&HashMap::new()).expect_err("missing config");
        assert_eq!(
            error,
            WatchError::InvalidConfig("missing rpc_url".to_string())
        );
    }

    #[test]
    fn public_plaintext_rpc_is_rejected() {
        let mut section = HashMap::new();
        section.insert("rpc_url".to_string(), "http://rpc.example.com".to_string());
        let error = WatchConfig::from_section(&section).expect_err("insecure RPC");
        assert!(matches!(error, WatchError::InvalidConfig(_)));
    }
}
