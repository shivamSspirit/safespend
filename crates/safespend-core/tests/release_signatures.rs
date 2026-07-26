#![forbid(unsafe_code)]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::signature::{UnparsedPublicKey, ED25519};
use std::{fs, path::PathBuf};

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .expect("core crate must live two levels below the workspace")
        .to_owned()
}

fn canonical_manifest_bytes(manifest: &str) -> Vec<u8> {
    let mut lines = Vec::new();
    for line in manifest.lines() {
        let trimmed = line.trim();
        if (trimmed.starts_with("signature") || trimmed.starts_with("publisher_key"))
            && trimmed.contains('=')
        {
            continue;
        }
        lines.push(line);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    lines.join("\n").into_bytes()
}

fn quoted_field<'a>(manifest: &'a str, name: &str) -> &'a str {
    manifest
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once('=')?;
            if key.trim() != name {
                return None;
            }
            value.trim().strip_prefix('"')?.strip_suffix('"')
        })
        .unwrap_or_else(|| panic!("manifest must contain {name}"))
}

fn decode_hex(value: &str) -> Vec<u8> {
    assert!(value.len().is_multiple_of(2));
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("valid hex"))
        .collect()
}

#[test]
fn source_manifests_match_the_trusted_publisher() {
    let root = project_root();
    let trusted = fs::read_to_string(root.join("release/trusted-publisher-key.txt"))
        .expect("trusted publisher key")
        .trim()
        .to_owned();
    assert_eq!(trusted.len(), 64);

    for relative in [
        "plugins/treasury-watch/manifest.toml",
        "plugins/allowance-pay/manifest.toml",
    ] {
        let manifest = fs::read_to_string(root.join(relative)).expect("plugin manifest");
        let publisher = quoted_field(&manifest, "publisher_key");
        let signature = URL_SAFE_NO_PAD
            .decode(quoted_field(&manifest, "signature"))
            .expect("valid base64url signature");
        assert_eq!(publisher, trusted, "{relative} uses an untrusted key");

        UnparsedPublicKey::new(&ED25519, decode_hex(publisher))
            .verify(&canonical_manifest_bytes(&manifest), &signature)
            .unwrap_or_else(|_| panic!("{relative} signature must verify"));
    }
}
