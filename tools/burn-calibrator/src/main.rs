#![forbid(unsafe_code)]

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use solana_rpc_client::rpc_client::{GetConfirmedSignaturesForAddress2Config, RpcClient};
use solana_rpc_client_types::config::RpcTransactionConfig;
use solana_signature::Signature;
use solana_transaction_status_client_types::UiTransactionEncoding;
use std::{
    collections::{BTreeSet, HashMap},
    env,
    error::Error,
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};

const DAY_SECONDS: u64 = 86_400;
const DEFAULT_WINDOW_DAYS: u64 = 28;
const DEFAULT_MAX_TRANSACTIONS: usize = 1_000;
const MAX_MAX_TRANSACTIONS: usize = 10_000;
const RPC_PAGE_LIMIT: usize = 1_000;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct OutflowEvidence {
    signature: String,
    slot: u64,
    block_time: i64,
    amount_base_units: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct CalibrationReport {
    method: &'static str,
    commitment: &'static str,
    token_account: String,
    canonical_mint: String,
    as_of_ts: u64,
    window_start_ts: u64,
    window_days: u64,
    history_complete: bool,
    finalized_signatures_scanned: usize,
    successful_transactions_parsed: usize,
    outgoing_transactions: usize,
    total_outflow_base_units: u128,
    historical_weekly_burn_base_units: u64,
    protected_minimum_weekly_burn_base_units: u64,
    recommended_weekly_burn_base_units: u64,
    evidence_sha256: String,
    outflows: Vec<OutflowEvidence>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("SafeSpend burn calibration failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let rpc_url = required(&args, "rpc")?;
    validate_rpc_url(rpc_url)?;
    let token_account = Pubkey::from_str(required(&args, "token-account")?)
        .map_err(|_| "--token-account is not a valid Solana address")?;
    let canonical_mint = Pubkey::from_str(required(&args, "mint")?)
        .map_err(|_| "--mint is not a valid Solana address")?;
    let window_days = optional_u64(&args, "window-days", DEFAULT_WINDOW_DAYS)?;
    if window_days == 0 || window_days > 365 {
        return Err("--window-days must be between 1 and 365".into());
    }
    let protected_minimum = optional_u64(&args, "minimum-weekly-burn", 0)?;
    let max_transactions = optional_usize(&args, "max-transactions", DEFAULT_MAX_TRANSACTIONS)?;
    if max_transactions == 0 || max_transactions > MAX_MAX_TRANSACTIONS {
        return Err(
            format!("--max-transactions must be between 1 and {MAX_MAX_TRANSACTIONS}").into(),
        );
    }
    let as_of_ts = match args.get("as-of-ts") {
        Some(value) => value
            .parse::<u64>()
            .map_err(|_| "--as-of-ts must be a u64")?,
        None => SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
    };
    let window_seconds = window_days
        .checked_mul(DAY_SECONDS)
        .ok_or("window seconds overflow")?;
    let window_start_ts = as_of_ts
        .checked_sub(window_seconds)
        .ok_or("--as-of-ts is earlier than the requested window")?;

    let client = RpcClient::new_with_commitment(rpc_url.to_owned(), CommitmentConfig::finalized());
    let mut before = None;
    let mut seen = BTreeSet::new();
    let mut evidence = Vec::new();
    let mut scanned = 0usize;
    let mut successful_transactions = 0usize;
    let history_complete = loop {
        let remaining_plus_sentinel = max_transactions.saturating_sub(scanned).saturating_add(1);
        let page_limit = remaining_plus_sentinel.min(RPC_PAGE_LIMIT);
        let rows = client.get_signatures_for_address_with_config(
            &token_account,
            GetConfirmedSignaturesForAddress2Config {
                before,
                until: None,
                limit: Some(page_limit),
                commitment: Some(CommitmentConfig::finalized()),
            },
        )?;
        if rows.is_empty() {
            break true;
        }

        let row_count = rows.len();
        let mut reached_cutoff = false;
        for row in &rows {
            let block_time = row
                .block_time
                .ok_or("finalized signature is missing blockTime; refusing incomplete history")?;
            if block_time < 0 {
                return Err("finalized signature has a negative blockTime".into());
            }
            let block_time_u64 =
                u64::try_from(block_time).map_err(|_| "blockTime conversion failed")?;
            if block_time_u64 < window_start_ts {
                reached_cutoff = true;
                break;
            }
            if block_time_u64 > as_of_ts {
                return Err("finalized signature is newer than --as-of-ts".into());
            }
            scanned = scanned.checked_add(1).ok_or("scan count overflow")?;
            if scanned > max_transactions {
                return Err(format!(
                    "history exceeds --max-transactions {max_transactions}; increase the bound \
                     and rerun so burn cannot be underestimated"
                )
                .into());
            }
            if !seen.insert(row.signature.clone()) {
                continue;
            }
            if row.err.is_some() {
                continue;
            }

            let signature = Signature::from_str(&row.signature)
                .map_err(|_| "RPC returned an invalid transaction signature")?;
            let transaction = client.get_transaction_with_config(
                &signature,
                RpcTransactionConfig {
                    encoding: Some(UiTransactionEncoding::JsonParsed),
                    commitment: Some(CommitmentConfig::finalized()),
                    max_supported_transaction_version: Some(0),
                },
            )?;
            let transaction_json = serde_json::to_value(transaction)?;
            let amount = transaction_outflow(
                &transaction_json,
                &token_account.to_string(),
                &canonical_mint.to_string(),
            )?;
            successful_transactions = successful_transactions
                .checked_add(1)
                .ok_or("transaction count overflow")?;
            if amount != 0 {
                evidence.push(OutflowEvidence {
                    signature: row.signature.clone(),
                    slot: row.slot,
                    block_time,
                    amount_base_units: amount,
                });
            }
        }

        if reached_cutoff || row_count < page_limit {
            break true;
        }
        before = Some(
            Signature::from_str(&rows[row_count - 1].signature)
                .map_err(|_| "RPC returned an invalid pagination signature")?,
        );
    };

    let report = build_report(
        token_account.to_string(),
        canonical_mint.to_string(),
        as_of_ts,
        window_start_ts,
        window_days,
        history_complete,
        scanned,
        successful_transactions,
        protected_minimum,
        evidence,
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn build_report(
    token_account: String,
    canonical_mint: String,
    as_of_ts: u64,
    window_start_ts: u64,
    window_days: u64,
    history_complete: bool,
    scanned: usize,
    successful_transactions: usize,
    protected_minimum: u64,
    mut outflows: Vec<OutflowEvidence>,
) -> Result<CalibrationReport, Box<dyn Error>> {
    if !history_complete {
        return Err("history window is incomplete".into());
    }
    outflows.sort_by(|left, right| {
        left.slot
            .cmp(&right.slot)
            .then_with(|| left.signature.cmp(&right.signature))
    });
    let total_outflow = outflows.iter().try_fold(0u128, |total, row| {
        total
            .checked_add(u128::from(row.amount_base_units))
            .ok_or("outflow total overflow")
    })?;
    let weekly_numerator = total_outflow
        .checked_mul(7)
        .ok_or("weekly burn numerator overflow")?;
    let historical_weekly = ceil_div(weekly_numerator, u128::from(window_days));
    let historical_weekly = u64::try_from(historical_weekly)
        .map_err(|_| "historical weekly burn does not fit policy u64")?;
    let recommended = historical_weekly.max(protected_minimum);

    let mut hasher = Sha256::new();
    hasher.update(b"safespend-burn-evidence-v1");
    hasher.update(token_account.as_bytes());
    hasher.update(canonical_mint.as_bytes());
    hasher.update(as_of_ts.to_be_bytes());
    hasher.update(window_start_ts.to_be_bytes());
    hasher.update(window_days.to_be_bytes());
    for row in &outflows {
        hasher.update(row.signature.as_bytes());
        hasher.update(row.slot.to_be_bytes());
        hasher.update(row.block_time.to_be_bytes());
        hasher.update(row.amount_base_units.to_be_bytes());
    }
    let evidence_sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    Ok(CalibrationReport {
        method: "gross finalized token-account outflows; ceil(total × 7 / window_days)",
        commitment: "finalized",
        token_account,
        canonical_mint,
        as_of_ts,
        window_start_ts,
        window_days,
        history_complete,
        finalized_signatures_scanned: scanned,
        successful_transactions_parsed: successful_transactions,
        outgoing_transactions: outflows.len(),
        total_outflow_base_units: total_outflow,
        historical_weekly_burn_base_units: historical_weekly,
        protected_minimum_weekly_burn_base_units: protected_minimum,
        recommended_weekly_burn_base_units: recommended,
        evidence_sha256,
        outflows,
    })
}

fn transaction_outflow(
    transaction: &Value,
    token_account: &str,
    canonical_mint: &str,
) -> Result<u64, Box<dyn Error>> {
    let account_keys = transaction
        .pointer("/transaction/transaction/message/accountKeys")
        .and_then(Value::as_array)
        .ok_or("transaction is missing parsed account keys")?;
    let account_index = account_keys
        .iter()
        .position(|entry| match entry {
            Value::String(value) => value == token_account,
            Value::Object(map) => map
                .get("pubkey")
                .and_then(Value::as_str)
                .is_some_and(|value| value == token_account),
            _ => false,
        })
        .ok_or("transaction does not contain the configured token account")?;
    let account_index =
        u64::try_from(account_index).map_err(|_| "token account index does not fit u64")?;
    let meta = transaction
        .pointer("/transaction/meta")
        .ok_or("transaction is missing metadata")?;
    if meta.get("err").is_some_and(|error| !error.is_null()) {
        return Err("successful signature returned failed transaction metadata".into());
    }
    let pre = token_balance(meta, "preTokenBalances", account_index, canonical_mint)?;
    let post = token_balance(meta, "postTokenBalances", account_index, canonical_mint)?;
    Ok(pre.saturating_sub(post))
}

fn token_balance(
    meta: &Value,
    field: &str,
    account_index: u64,
    canonical_mint: &str,
) -> Result<u64, Box<dyn Error>> {
    let rows = meta
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("transaction metadata is missing {field}"))?;
    let row = rows
        .iter()
        .find(|row| row.get("accountIndex").and_then(Value::as_u64) == Some(account_index))
        .ok_or_else(|| format!("{field} has no configured token-account balance"))?;
    if row.get("mint").and_then(Value::as_str) != Some(canonical_mint) {
        return Err(format!("{field} mint does not match canonical mint").into());
    }
    row.pointer("/uiTokenAmount/amount")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field} amount is missing"))?
        .parse::<u64>()
        .map_err(|_| format!("{field} amount is not u64").into())
}

fn ceil_div(numerator: u128, denominator: u128) -> u128 {
    if numerator == 0 {
        0
    } else {
        1 + (numerator - 1) / denominator
    }
}

fn parse_args() -> Result<HashMap<String, String>, Box<dyn Error>> {
    let mut parsed = HashMap::new();
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        if !flag.starts_with("--") {
            return Err(format!("unexpected argument: {flag}").into());
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        if parsed
            .insert(flag.trim_start_matches("--").to_owned(), value)
            .is_some()
        {
            return Err(format!("duplicate argument: {flag}").into());
        }
    }
    Ok(parsed)
}

fn required<'a>(args: &'a HashMap<String, String>, name: &str) -> Result<&'a str, Box<dyn Error>> {
    args.get(name)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing --{name}").into())
}

fn optional_u64(
    args: &HashMap<String, String>,
    name: &str,
    default: u64,
) -> Result<u64, Box<dyn Error>> {
    args.get(name)
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| format!("--{name} must be a u64").into())
        })
        .unwrap_or(Ok(default))
}

fn optional_usize(
    args: &HashMap<String, String>,
    name: &str,
    default: usize,
) -> Result<usize, Box<dyn Error>> {
    args.get(name)
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| format!("--{name} must be a usize").into())
        })
        .unwrap_or(Ok(default))
}

fn validate_rpc_url(value: &str) -> Result<(), Box<dyn Error>> {
    let secure = value.starts_with("https://");
    let local = value.starts_with("http://127.0.0.1:") || value.starts_with("http://localhost:");
    if value.len() > 2_048 || (!secure && !local) {
        return Err("--rpc must use HTTPS (or loopback for local testing)".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOKEN_ACCOUNT: &str = "H2Ugzo7c9p2f8CqAGQ6kF5mPS5FKFUEtLGfq6bGJfPVn";
    const MINT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

    fn fixture(pre: &str, post: &str) -> Value {
        json!({
            "transaction": {
                "transaction": {
                    "message": {
                        "accountKeys": [
                            {"pubkey": "11111111111111111111111111111111"},
                            {"pubkey": TOKEN_ACCOUNT}
                        ]
                    }
                },
                "meta": {
                    "err": null,
                    "preTokenBalances": [{
                        "accountIndex": 1,
                        "mint": MINT,
                        "uiTokenAmount": {"amount": pre}
                    }],
                    "postTokenBalances": [{
                        "accountIndex": 1,
                        "mint": MINT,
                        "uiTokenAmount": {"amount": post}
                    }]
                }
            }
        })
    }

    #[test]
    fn counts_gross_outflow_but_not_inflow() {
        assert_eq!(
            transaction_outflow(&fixture("100000000", "88000000"), TOKEN_ACCOUNT, MINT)
                .expect("valid outgoing transaction"),
            12_000_000
        );
        assert_eq!(
            transaction_outflow(&fixture("88000000", "100000000"), TOKEN_ACCOUNT, MINT)
                .expect("valid incoming transaction"),
            0
        );
    }

    #[test]
    fn wrong_mint_fails_closed() {
        let error = transaction_outflow(
            &fixture("100000000", "88000000"),
            TOKEN_ACCOUNT,
            "11111111111111111111111111111111",
        )
        .expect_err("mint substitution");
        assert!(error.to_string().contains("canonical mint"));
    }

    #[test]
    fn report_uses_conservative_ceil_and_protected_minimum() {
        let report = build_report(
            TOKEN_ACCOUNT.to_string(),
            MINT.to_string(),
            2_419_200,
            0,
            28,
            true,
            2,
            2,
            10,
            vec![OutflowEvidence {
                signature: "a".repeat(88),
                slot: 42,
                block_time: 1,
                amount_base_units: 11,
            }],
        )
        .expect("valid report");
        assert_eq!(report.historical_weekly_burn_base_units, 3);
        assert_eq!(report.recommended_weekly_burn_base_units, 10);
        assert_eq!(report.evidence_sha256.len(), 64);
    }

    #[test]
    fn incomplete_window_is_never_reported() {
        let error = build_report(
            TOKEN_ACCOUNT.to_string(),
            MINT.to_string(),
            2_419_200,
            0,
            28,
            false,
            1,
            1,
            0,
            Vec::new(),
        )
        .expect_err("incomplete history");
        assert_eq!(error.to_string(), "history window is incomplete");
    }
}
