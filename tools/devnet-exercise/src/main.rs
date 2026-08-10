#![forbid(unsafe_code)]

use safespend_allowance_pay::pay::{execute_payment, PayConfig, PayError, RpcTransport};
use safespend_core::PaymentRequest;
use serde_json::Value;
use std::{collections::HashMap, env, error::Error, fs, path::Path, sync::Mutex};
use zeroize::{Zeroize, Zeroizing};

const MAX_RESPONSE_BYTES: usize = 512 * 1024;

struct HttpTransport {
    client: reqwest::blocking::Client,
    methods: Mutex<Vec<String>>,
}

impl RpcTransport for HttpTransport {
    fn post_json(&self, url: &str, body: &Value) -> Result<(u16, Vec<u8>), PayError> {
        let method = body
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| PayError::InvalidRequest("RPC method is missing".into()))?;
        self.methods
            .lock()
            .map_err(|_| PayError::Transport)?
            .push(method.to_owned());
        let response = self
            .client
            .post(url)
            .json(body)
            .send()
            .map_err(|_| PayError::Transport)?;
        let status = response.status().as_u16();
        let bytes = response.bytes().map_err(|_| PayError::Transport)?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(PayError::ResponseTooLarge);
        }
        Ok((status, bytes.to_vec()))
    }

    fn get(&self, url: &str) -> Result<(u16, Vec<u8>), PayError> {
        let response = self
            .client
            .get(url)
            .send()
            .map_err(|_| PayError::Transport)?;
        let status = response.status().as_u16();
        let bytes = response.bytes().map_err(|_| PayError::Transport)?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(PayError::ResponseTooLarge);
        }
        Ok((status, bytes.to_vec()))
    }
}

fn main() {
    match run() {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(error) => {
            eprintln!("SafeSpend devnet exercise failed: {error}");
            std::process::exit(2);
        }
    }
}

fn run() -> Result<bool, Box<dyn Error>> {
    let args = parse_args()?;
    let config_path = required(&args, "config")?;
    let session_keypair_path = required(&args, "session-keypair")?;
    if !Path::new(session_keypair_path).is_absolute() {
        return Err("--session-keypair must be an absolute path outside the repository".into());
    }
    let vendor_id = required(&args, "vendor")?.to_owned();
    let amount_base_units = required(&args, "amount")?
        .parse::<u64>()
        .map_err(|_| "--amount must be a u64")?;

    let config_bytes = fs::read(config_path)?;
    let mut section: HashMap<String, String> = serde_json::from_slice(&config_bytes)
        .map_err(|_| "--config must be a JSON object of string values")?;
    let mut keypair_bytes: Vec<u8> = serde_json::from_slice(&fs::read(session_keypair_path)?)
        .map_err(|_| "--session-keypair must be a Solana JSON keypair")?;
    if keypair_bytes.len() != 64 {
        keypair_bytes.zeroize();
        return Err("--session-keypair must contain exactly 64 bytes".into());
    }
    let encoded_keypair = Zeroizing::new(bs58::encode(&keypair_bytes).into_string());
    keypair_bytes.zeroize();
    section.insert("session_key_base58".to_owned(), encoded_keypair.to_string());

    let config = PayConfig::from_section(&section)?;
    if let Some(mut secret) = section.remove("session_key_base58") {
        secret.zeroize();
    }
    let transport = HttpTransport {
        client: reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(20))
            .https_only(true)
            .build()?,
        methods: Mutex::new(Vec::new()),
    };
    let result = execute_payment(
        &transport,
        &config,
        &PaymentRequest {
            vendor_id,
            amount_base_units,
        },
    );
    let rpc_methods = transport
        .methods
        .into_inner()
        .map_err(|_| "RPC audit trace lock was poisoned")?;
    let send_transaction_invocations = rpc_methods
        .iter()
        .filter(|method| method.as_str() == "sendTransaction")
        .count();
    match result {
        Ok(output) => {
            println!(
                "{}",
                serde_json::json!({
                    "accepted": true,
                    "payment": output,
                    "rpc_methods": rpc_methods,
                    "send_transaction_invocations": send_transaction_invocations
                })
            );
            Ok(true)
        }
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::json!({
                    "accepted": false,
                    "error": error.to_string(),
                    "rpc_methods": rpc_methods,
                    "send_transaction_invocations": send_transaction_invocations
                })
            );
            Ok(false)
        }
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
