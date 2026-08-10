use crate::policy::{Cluster, OperatorPolicy, VendorPolicy};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write;
use thiserror::Error;

pub const VENDOR_POLICY_SCHEMA: &str = "safespend-vendor-policy-v1";
pub const GENESIS_POLICY_HASH: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

const MAX_VENDOR_ID_LEN: usize = 32;
const MAX_DISPLAY_NAME_LEN: usize = 80;
const MAX_ADDRESS_LEN: usize = 64;
const MAX_VENDORS: usize = 64;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VendorPolicyBinding {
    pub vendor: VendorPolicy,
    pub display_name: String,
    pub recipient_token_account: String,
    pub recurring_delegation: String,
    pub delegation_nonce: u64,
    pub treasury_token_account: String,
    pub start_ts: u64,
    pub expiry_ts: u64,
    pub activated_policy_version: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VendorPolicyDocument {
    pub schema: String,
    pub version: u64,
    pub previous_policy_hash: String,
    pub issued_at_ts: u64,
    pub founder_wallet: String,
    pub treasury_owner: String,
    pub subscriptions_program: String,
    pub token_program: String,
    pub canonical_mint: String,
    pub session_delegate: String,
    pub vendors: Vec<VendorPolicyBinding>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SignedVendorPolicyDocument {
    pub document: VendorPolicyDocument,
    pub policy_hash: String,
    pub signature_base64: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VendorPolicyCode {
    InvalidDocument,
    BoundaryMismatch,
    HashMismatch,
    InvalidSignature,
}

#[derive(Clone, Debug, Eq, Error, PartialEq, Serialize)]
#[error("{code:?}: {message}")]
pub struct VendorPolicyError {
    pub code: VendorPolicyCode,
    pub message: String,
}

impl VendorPolicyError {
    fn new(code: VendorPolicyCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub fn verify_signed_vendor_policy(
    signed: &SignedVendorPolicyDocument,
    protected: &OperatorPolicy,
) -> Result<(), VendorPolicyError> {
    validate_document(&signed.document, protected)?;
    let expected_hash = vendor_policy_hash(&signed.document);
    if signed.policy_hash != expected_hash {
        return Err(VendorPolicyError::new(
            VendorPolicyCode::HashMismatch,
            "vendor policy hash does not match its canonical fields",
        ));
    }

    let founder_key = decode_address("founder wallet", &signed.document.founder_wallet)?;
    let signature = BASE64.decode(&signed.signature_base64).map_err(|_| {
        VendorPolicyError::new(
            VendorPolicyCode::InvalidSignature,
            "vendor policy signature is not valid base64",
        )
    })?;
    if signature.len() != 64 {
        return Err(VendorPolicyError::new(
            VendorPolicyCode::InvalidSignature,
            "vendor policy signature must contain 64 bytes",
        ));
    }
    let founder_key: [u8; 32] = founder_key.try_into().map_err(|_| {
        VendorPolicyError::new(
            VendorPolicyCode::InvalidSignature,
            "founder wallet key has the wrong length",
        )
    })?;
    let signature: [u8; 64] = signature.try_into().map_err(|_| {
        VendorPolicyError::new(
            VendorPolicyCode::InvalidSignature,
            "vendor policy signature has the wrong length",
        )
    })?;
    VerifyingKey::from_bytes(&founder_key)
        .and_then(|key| {
            key.verify(
                vendor_policy_signing_message(&signed.document, &signed.policy_hash).as_bytes(),
                &Signature::from_bytes(&signature),
            )
        })
        .map_err(|_| {
            VendorPolicyError::new(
                VendorPolicyCode::InvalidSignature,
                "vendor policy signature was not produced by the founder wallet",
            )
        })
}

pub fn effective_operator_policy(
    signed: &SignedVendorPolicyDocument,
    protected: &OperatorPolicy,
) -> Result<OperatorPolicy, VendorPolicyError> {
    verify_signed_vendor_policy(signed, protected)?;
    let mut policy = protected.clone();
    policy.vendors = signed
        .document
        .vendors
        .iter()
        .map(|binding| binding.vendor.clone())
        .collect();
    Ok(policy)
}

pub fn vendor_policy_signing_message(document: &VendorPolicyDocument, policy_hash: &str) -> String {
    format!(
        "SafeSpend vendor policy\nschema={}\nversion={}\nprevious_policy_hash={}\npolicy_hash={}\ntreasury_owner={}\ncluster=solana-devnet\n",
        document.schema,
        document.version,
        document.previous_policy_hash,
        policy_hash,
        document.treasury_owner,
    )
}

pub fn vendor_policy_hash(document: &VendorPolicyDocument) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, b"schema", document.schema.as_bytes());
    hash_u64(&mut hasher, b"version", document.version);
    hash_field(
        &mut hasher,
        b"previous_policy_hash",
        document.previous_policy_hash.as_bytes(),
    );
    hash_u64(&mut hasher, b"issued_at_ts", document.issued_at_ts);
    hash_field(
        &mut hasher,
        b"founder_wallet",
        document.founder_wallet.as_bytes(),
    );
    hash_field(
        &mut hasher,
        b"treasury_owner",
        document.treasury_owner.as_bytes(),
    );
    hash_field(
        &mut hasher,
        b"subscriptions_program",
        document.subscriptions_program.as_bytes(),
    );
    hash_field(
        &mut hasher,
        b"token_program",
        document.token_program.as_bytes(),
    );
    hash_field(
        &mut hasher,
        b"canonical_mint",
        document.canonical_mint.as_bytes(),
    );
    hash_field(
        &mut hasher,
        b"session_delegate",
        document.session_delegate.as_bytes(),
    );

    for binding in &document.vendors {
        hash_field(
            &mut hasher,
            b"vendor_id",
            binding.vendor.vendor_id.as_bytes(),
        );
        hash_field(
            &mut hasher,
            b"display_name",
            binding.display_name.as_bytes(),
        );
        hash_field(
            &mut hasher,
            b"recipient_wallet",
            binding.vendor.recipient_wallet.as_bytes(),
        );
        hash_field(
            &mut hasher,
            b"recipient_token_account",
            binding.recipient_token_account.as_bytes(),
        );
        hash_field(
            &mut hasher,
            b"recurring_delegation",
            binding.recurring_delegation.as_bytes(),
        );
        hash_u64(&mut hasher, b"delegation_nonce", binding.delegation_nonce);
        hash_field(
            &mut hasher,
            b"treasury_token_account",
            binding.treasury_token_account.as_bytes(),
        );
        hash_u64(
            &mut hasher,
            b"amount_per_period",
            binding.vendor.amount_per_period_base_units,
        );
        hash_u64(
            &mut hasher,
            b"period_seconds",
            binding.vendor.period_seconds,
        );
        hash_u64(&mut hasher, b"start_ts", binding.start_ts);
        hash_u64(&mut hasher, b"expiry_ts", binding.expiry_ts);
        hash_u64(
            &mut hasher,
            b"activated_policy_version",
            binding.activated_policy_version,
        );
    }

    to_hex(&hasher.finalize())
}

fn validate_document(
    document: &VendorPolicyDocument,
    protected: &OperatorPolicy,
) -> Result<(), VendorPolicyError> {
    if document.schema != VENDOR_POLICY_SCHEMA
        || document.version == 0
        || document.issued_at_ts == 0
        || document.vendors.len() > MAX_VENDORS
        || !is_hash(&document.previous_policy_hash)
    {
        return Err(VendorPolicyError::new(
            VendorPolicyCode::InvalidDocument,
            "vendor policy metadata is invalid",
        ));
    }
    if document.version == 1 && document.previous_policy_hash != GENESIS_POLICY_HASH {
        return Err(VendorPolicyError::new(
            VendorPolicyCode::InvalidDocument,
            "the first vendor policy must reference the genesis policy hash",
        ));
    }
    if protected.cluster != Cluster::Devnet
        || document.founder_wallet != protected.treasury_owner
        || document.treasury_owner != protected.treasury_owner
        || document.subscriptions_program != protected.subscriptions_program
        || document.token_program != protected.token_program
        || document.canonical_mint != protected.canonical_mint
        || document.session_delegate != protected.session_delegate
    {
        return Err(VendorPolicyError::new(
            VendorPolicyCode::BoundaryMismatch,
            "signed vendor policy does not match protected operator boundaries",
        ));
    }
    decode_address("founder wallet", &document.founder_wallet)?;
    decode_address("treasury owner", &document.treasury_owner)?;
    decode_address("subscriptions program", &document.subscriptions_program)?;
    decode_address("token program", &document.token_program)?;
    decode_address("canonical mint", &document.canonical_mint)?;
    decode_address("session delegate", &document.session_delegate)?;

    for (index, binding) in document.vendors.iter().enumerate() {
        let vendor = &binding.vendor;
        if vendor.vendor_id.is_empty()
            || vendor.vendor_id.len() > MAX_VENDOR_ID_LEN
            || !vendor
                .vendor_id
                .bytes()
                .enumerate()
                .all(|(position, byte)| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || (position > 0 && matches!(byte, b'-' | b'_'))
                })
            || binding.display_name.is_empty()
            || binding.display_name.len() > MAX_DISPLAY_NAME_LEN
            || vendor.amount_per_period_base_units == 0
            || !matches!(vendor.period_seconds, 86_400 | 604_800 | 2_592_000)
            || binding.start_ts == 0
            || binding.expiry_ts <= binding.start_ts
            || binding.activated_policy_version == 0
            || binding.activated_policy_version > document.version
        {
            return Err(VendorPolicyError::new(
                VendorPolicyCode::InvalidDocument,
                format!("vendor binding at index {index} has invalid terms"),
            ));
        }
        decode_address("recipient wallet", &vendor.recipient_wallet)?;
        decode_address("recipient token account", &binding.recipient_token_account)?;
        decode_address("recurring delegation", &binding.recurring_delegation)?;
        decode_address("treasury token account", &binding.treasury_token_account)?;
        if document.vendors[..index]
            .iter()
            .any(|prior| prior.vendor.vendor_id == vendor.vendor_id)
        {
            return Err(VendorPolicyError::new(
                VendorPolicyCode::InvalidDocument,
                format!("duplicate vendor id {}", vendor.vendor_id),
            ));
        }
    }
    Ok(())
}

fn decode_address(label: &str, value: &str) -> Result<Vec<u8>, VendorPolicyError> {
    if value.is_empty() || value.len() > MAX_ADDRESS_LEN {
        return Err(VendorPolicyError::new(
            VendorPolicyCode::InvalidDocument,
            format!("{label} is missing or too long"),
        ));
    }
    let decoded = bs58::decode(value).into_vec().map_err(|_| {
        VendorPolicyError::new(
            VendorPolicyCode::InvalidDocument,
            format!("{label} is not valid base58"),
        )
    })?;
    if decoded.len() != 32 {
        return Err(VendorPolicyError::new(
            VendorPolicyCode::InvalidDocument,
            format!("{label} does not decode to a 32-byte Solana address"),
        ));
    }
    Ok(decoded)
}

fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hash_field(hasher: &mut Sha256, label: &[u8], value: &[u8]) {
    hasher.update((label.len() as u64).to_be_bytes());
    hasher.update(label);
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn hash_u64(hasher: &mut Sha256, label: &[u8], value: u64) {
    hash_field(hasher, label, &value.to_be_bytes());
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
    use ed25519_dalek::{Signer, SigningKey};

    const SUBSCRIPTIONS: &str = "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44";
    const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const MINT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    const TREASURY: &str = "7YwNV7uN4fuzkaUxC9z1uSXLVfECygqnK9YVJ2QkD8bM";
    const DELEGATE: &str = "8Fv8uEUTQGZjkYhiBL8tE7wNb9UtvA8rvQWc2wKcYpQG";
    const VENDOR: &str = "9MTbYdTTgYbcR9tVhbkLhRMozUskdQZb7ZtawKxvGwWJ";

    fn signed_document() -> (SignedVendorPolicyDocument, OperatorPolicy) {
        let keypair = SigningKey::from_bytes(&[7; 32]);
        let founder = bs58::encode(keypair.verifying_key().as_bytes()).into_string();
        let protected = OperatorPolicy {
            cluster: Cluster::Devnet,
            allow_mainnet: false,
            subscriptions_program: SUBSCRIPTIONS.into(),
            token_program: TOKEN_PROGRAM.into(),
            canonical_mint: MINT.into(),
            treasury_owner: founder.clone(),
            session_delegate: DELEGATE.into(),
            weekly_burn_base_units: 10_000_000,
            minimum_runway_weeks: 8,
            minimum_token_reserve_base_units: 50_000_000,
            minimum_sol_reserve_lamports: 10_000_000,
            minimum_session_fee_reserve_lamports: 1_000_000,
            expiry_safety_buffer_seconds: 300,
            vendors: vec![],
        };
        let document = VendorPolicyDocument {
            schema: VENDOR_POLICY_SCHEMA.into(),
            version: 1,
            previous_policy_hash: GENESIS_POLICY_HASH.into(),
            issued_at_ts: 1_800_000_000,
            founder_wallet: founder.clone(),
            treasury_owner: founder,
            subscriptions_program: SUBSCRIPTIONS.into(),
            token_program: TOKEN_PROGRAM.into(),
            canonical_mint: MINT.into(),
            session_delegate: DELEGATE.into(),
            vendors: vec![VendorPolicyBinding {
                vendor: VendorPolicy {
                    vendor_id: "hosting".into(),
                    recipient_wallet: VENDOR.into(),
                    amount_per_period_base_units: 12_000_000,
                    period_seconds: 604_800,
                },
                display_name: "Hosting".into(),
                recipient_token_account: VENDOR.into(),
                recurring_delegation: VENDOR.into(),
                delegation_nonce: 7,
                treasury_token_account: VENDOR.into(),
                start_ts: 1_800_000_100,
                expiry_ts: 1_831_536_100,
                activated_policy_version: 1,
            }],
        };
        let policy_hash = vendor_policy_hash(&document);
        let message = vendor_policy_signing_message(&document, &policy_hash);
        let signature_base64 = BASE64.encode(keypair.sign(message.as_bytes()).to_bytes());
        (
            SignedVendorPolicyDocument {
                document,
                policy_hash,
                signature_base64,
            },
            protected,
        )
    }

    #[test]
    fn verifies_founder_signature_and_builds_effective_policy() {
        let (signed, protected) = signed_document();
        let effective = effective_operator_policy(&signed, &protected).unwrap();
        assert_eq!(effective.vendors[0].vendor_id, "hosting");
    }

    #[test]
    fn accepts_empty_signed_policy_as_deny_all() {
        let (mut signed, protected) = signed_document();
        signed.document.vendors.clear();
        signed.policy_hash = vendor_policy_hash(&signed.document);
        let keypair = SigningKey::from_bytes(&[7; 32]);
        signed.signature_base64 = BASE64.encode(
            keypair
                .sign(
                    vendor_policy_signing_message(&signed.document, &signed.policy_hash).as_bytes(),
                )
                .to_bytes(),
        );

        let effective = effective_operator_policy(&signed, &protected).unwrap();
        assert!(effective.vendors.is_empty());
    }

    #[test]
    fn rejects_mutated_recipient_after_signature() {
        let (mut signed, protected) = signed_document();
        signed.document.vendors[0].vendor.recipient_wallet = DELEGATE.into();
        assert_eq!(
            verify_signed_vendor_policy(&signed, &protected)
                .unwrap_err()
                .code,
            VendorPolicyCode::HashMismatch
        );
    }

    #[test]
    fn rejects_wrong_founder_boundary() {
        let (signed, mut protected) = signed_document();
        protected.treasury_owner = VENDOR.into();
        assert_eq!(
            verify_signed_vendor_policy(&signed, &protected)
                .unwrap_err()
                .code,
            VendorPolicyCode::BoundaryMismatch
        );
    }

    #[test]
    fn canonical_hash_matches_dashboard_fixture() {
        let document = VendorPolicyDocument {
            schema: VENDOR_POLICY_SCHEMA.into(),
            version: 7,
            previous_policy_hash: "11".repeat(32),
            issued_at_ts: 1_800_000_000,
            founder_wallet: TREASURY.into(),
            treasury_owner: TREASURY.into(),
            subscriptions_program: SUBSCRIPTIONS.into(),
            token_program: TOKEN_PROGRAM.into(),
            canonical_mint: MINT.into(),
            session_delegate: DELEGATE.into(),
            vendors: vec![VendorPolicyBinding {
                vendor: VendorPolicy {
                    vendor_id: "hosting".into(),
                    recipient_wallet: VENDOR.into(),
                    amount_per_period_base_units: 12_000_000,
                    period_seconds: 604_800,
                },
                display_name: "Hosting".into(),
                recipient_token_account: VENDOR.into(),
                recurring_delegation: VENDOR.into(),
                delegation_nonce: 42,
                treasury_token_account: VENDOR.into(),
                start_ts: 1_800_000_100,
                expiry_ts: 1_831_536_100,
                activated_policy_version: 7,
            }],
        };
        assert_eq!(
            vendor_policy_hash(&document),
            "ec1cee12e6743a19e8e147e94c8f9cd1cf3b925593b29dfc4d89d464f4bec576"
        );
    }
}
