#![forbid(unsafe_code)]

use solana_address::{address, Address};
use solana_commitment_config::CommitmentConfig;
use solana_keypair::read_keypair_file;
use solana_rpc_client::rpc_client::RpcClient;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::{collections::HashMap, env, error::Error, str::FromStr};
use subscriptions::{
    accounts::SubscriptionAuthority,
    instructions::{
        CreateRecurringDelegation, CreateRecurringDelegationInstructionArgs,
        InitSubscriptionAuthority,
    },
    types::CreateRecurringDelegationData,
    SUBSCRIPTIONS_ID,
};

const DEVNET_GENESIS: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const TOKEN_PROGRAM: Address = address!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM_PROGRAM: Address = address!("11111111111111111111111111111111");

fn main() {
    if let Err(error) = run() {
        eprintln!("SafeSpend setup failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let rpc_url = required(&args, "rpc")?;
    if !rpc_url.starts_with("https://") && !rpc_url.starts_with("http://127.0.0.1:") {
        return Err("--rpc must use HTTPS (or loopback for local testing)".into());
    }
    let client = RpcClient::new_with_commitment(rpc_url.to_owned(), CommitmentConfig::confirmed());
    let genesis = client.get_genesis_hash()?.to_string();
    if genesis != DEVNET_GENESIS {
        return Err(format!(
            "refusing non-devnet cluster (genesis {genesis}); this command has no mainnet override"
        )
        .into());
    }

    let treasury = read_keypair_file(required(&args, "treasury-keypair")?)
        .map_err(|_| "could not read treasury keypair")?;
    let treasury_owner = treasury.pubkey();
    let mint = parse_address(required(&args, "mint")?)?;
    let treasury_token_account = parse_address(required(&args, "treasury-token-account")?)?;
    let delegate = parse_address(required(&args, "session-delegate")?)?;
    let nonce = parse_u64(&args, "nonce")?;
    let amount = parse_u64(&args, "amount")?;
    let period_seconds = parse_u64(&args, "period-seconds")?;
    let expiry_ts = parse_i64(&args, "expiry-ts")?;
    if amount == 0 || period_seconds == 0 || expiry_ts <= 0 {
        return Err("amount, period-seconds, and expiry-ts must be positive".into());
    }

    let subscription_authority = SubscriptionAuthority::find_pda(&treasury_owner, &mint).0;
    let recurring_delegation =
        find_recurring_delegation_pda(&subscription_authority, &treasury_owner, &delegate, nonce);

    let existing_authority = client
        .get_account_with_commitment(&subscription_authority, CommitmentConfig::confirmed())?
        .value;
    if let Some(account) = &existing_authority {
        if account.owner != SUBSCRIPTIONS_ID {
            return Err("existing Subscription Authority has the wrong program owner".into());
        }
        let decoded = SubscriptionAuthority::from_bytes(&account.data)
            .map_err(|_| "existing Subscription Authority is malformed")?;
        if decoded.user != treasury_owner || decoded.token_mint != mint {
            return Err("existing Subscription Authority does not match treasury and mint".into());
        }
    }

    let mut instructions = Vec::with_capacity(2);
    if existing_authority.is_none() {
        instructions.push(
            InitSubscriptionAuthority {
                owner: treasury_owner,
                subscription_authority,
                token_mint: mint,
                user_ata: treasury_token_account,
                system_program: SYSTEM_PROGRAM,
                token_program: TOKEN_PROGRAM,
                payer: None,
            }
            .instruction(),
        );
    }
    let create = CreateRecurringDelegation {
        delegator: treasury_owner,
        subscription_authority,
        delegation_account: recurring_delegation,
        delegatee: delegate,
        system_program: SYSTEM_PROGRAM,
        payer: None,
    }
    .instruction(CreateRecurringDelegationInstructionArgs {
        recurring_delegation: CreateRecurringDelegationData {
            nonce,
            amount_per_period: amount,
            period_length_s: period_seconds,
            start_ts: 0,
            expiry_ts,
            // Safe only because initialization and creation are atomic in this
            // fresh-blockhash transaction. No durable nonce is used.
            expected_subscription_authority_init_id: i64::MIN,
        },
    });
    instructions.push(create);

    let blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &instructions,
        Some(&treasury_owner),
        &[&treasury],
        blockhash,
    );
    let signature = client.send_and_confirm_transaction(&transaction)?;

    println!(
        "{}",
        serde_json::json!({
            "cluster": "devnet",
            "subscriptions_program": SUBSCRIPTIONS_ID.to_string(),
            "treasury_owner": treasury_owner.to_string(),
            "mint": mint.to_string(),
            "session_delegate": delegate.to_string(),
            "subscription_authority": subscription_authority.to_string(),
            "recurring_delegation": recurring_delegation.to_string(),
            "delegation_nonce": nonce,
            "subscription_authority_created": existing_authority.is_none(),
            "amount_per_period_base_units": amount,
            "period_seconds": period_seconds,
            "expiry_ts": expiry_ts,
            "setup_signature": signature.to_string()
        })
    );
    Ok(())
}

fn find_recurring_delegation_pda(
    subscription_authority: &Address,
    delegator: &Address,
    delegatee: &Address,
    nonce: u64,
) -> Address {
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
        parsed.insert(flag.trim_start_matches("--").to_owned(), value);
    }
    Ok(parsed)
}

fn required<'a>(args: &'a HashMap<String, String>, name: &str) -> Result<&'a str, Box<dyn Error>> {
    args.get(name)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing --{name}").into())
}

fn parse_address(value: &str) -> Result<Address, Box<dyn Error>> {
    Address::from_str(value).map_err(|_| "invalid Solana address".into())
}

fn parse_u64(args: &HashMap<String, String>, name: &str) -> Result<u64, Box<dyn Error>> {
    required(args, name)?
        .parse()
        .map_err(|_| format!("--{name} must be a u64").into())
}

fn parse_i64(args: &HashMap<String, String>, name: &str) -> Result<i64, Box<dyn Error>> {
    required(args, name)?
        .parse()
        .map_err(|_| format!("--{name} must be an i64").into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonce_changes_the_pda() {
        let owner = address!("7YwNV7uN4fuzkaUxC9z1uSXLVfECygqnK9YVJ2QkD8bM");
        let delegate = address!("8Fv8uEUTQGZjkYhiBL8tE7wNb9UtvA8rvQWc2wKcYpQG");
        let mint = address!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
        let authority = SubscriptionAuthority::find_pda(&owner, &mint).0;
        assert_ne!(
            find_recurring_delegation_pda(&authority, &owner, &delegate, 1),
            find_recurring_delegation_pda(&authority, &owner, &delegate, 2)
        );
    }
}
