#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
private_key="${1:-}"
generated_digests="$project_root/dist/plugins/SHA256SUMS"
trusted_digests="$project_root/release/plugin-SHA256SUMS"
trusted_signature="$project_root/release/plugin-SHA256SUMS.sig"
release_plugins="$project_root/release/plugins"

if [[ -z "$private_key" ]]; then
  echo "usage: $0 /absolute/path/to/plugin-publisher-ed25519.pk8" >&2
  exit 2
fi
if [[ ! -f "$private_key" ]]; then
  echo "publisher key does not exist: $private_key" >&2
  exit 2
fi
if [[ ! -f "$generated_digests" ]]; then
  echo "build plugins before signing release digests" >&2
  exit 2
fi

key_dir="$(cd "$(dirname "$private_key")" && pwd -P)"
key_path="$key_dir/$(basename "$private_key")"
case "$key_path" in
  "$project_root"/*)
    echo "refusing a publisher private key stored inside the repository" >&2
    exit 2
    ;;
esac

for command in git install od openssl sort tr xargs; do
  command -v "$command" >/dev/null || {
    echo "required command is unavailable: $command" >&2
    exit 2
  }
done

publisher_key="$(
  openssl pkey -inform DER -in "$key_path" -pubout -outform DER |
    tail -c 32 |
    od -An -tx1 |
    tr -d ' \n'
)"
trusted_publisher_key="$(tr -d '[:space:]' <"$project_root/release/trusted-publisher-key.txt")"
if [[ ! "$publisher_key" =~ ^[0-9a-f]{64}$ ]]; then
  echo "could not derive a 32-byte Ed25519 publisher key" >&2
  exit 1
fi
if [[ "$publisher_key" != "$trusted_publisher_key" ]]; then
  echo "publisher key does not match release/trusted-publisher-key.txt" >&2
  exit 1
fi

temporary_dir="$(mktemp -d)"
trap 'find "$temporary_dir" -type f -delete; rmdir "$temporary_dir"' EXIT

signature_file="$temporary_dir/plugin-SHA256SUMS.sig"
signature_text="$temporary_dir/plugin-SHA256SUMS.sig.txt"
digest_file="$temporary_dir/plugin-SHA256SUMS"

install -d \
  "$release_plugins/safespend-allowance-pay" \
  "$release_plugins/safespend-treasury-watch"
install -m 0644 \
  "$project_root/plugins/allowance-pay/manifest.toml" \
  "$release_plugins/safespend-allowance-pay/manifest.toml"
install -m 0644 \
  "$project_root/dist/plugins/safespend-allowance-pay/safespend_allowance_pay.wasm" \
  "$release_plugins/safespend-allowance-pay/safespend_allowance_pay.wasm"
install -m 0644 \
  "$project_root/plugins/treasury-watch/manifest.toml" \
  "$release_plugins/safespend-treasury-watch/manifest.toml"
install -m 0644 \
  "$project_root/dist/plugins/safespend-treasury-watch/safespend_treasury_watch.wasm" \
  "$release_plugins/safespend-treasury-watch/safespend_treasury_watch.wasm"

{
  git -C "$project_root" ls-files \
    Cargo.lock \
    Cargo.toml \
    rust-toolchain.toml \
    'crates/**' \
    'plugins/**' \
    'wit/**' \
    scripts/build-plugins.sh
  printf '%s\n' \
    release/plugins/safespend-allowance-pay/manifest.toml \
    release/plugins/safespend-allowance-pay/safespend_allowance_pay.wasm \
    release/plugins/safespend-treasury-watch/manifest.toml \
    release/plugins/safespend-treasury-watch/safespend_treasury_watch.wasm
} |
  LC_ALL=C sort |
  (
    cd "$project_root"
    if command -v sha256sum >/dev/null; then
      xargs sha256sum
    elif command -v shasum >/dev/null; then
      xargs shasum -a 256
    else
      echo "sha256sum or shasum is required" >&2
      exit 2
    fi
  ) >"$digest_file"

openssl pkeyutl \
  -sign \
  -rawin \
  -inkey "$key_path" \
  -keyform DER \
  -in "$digest_file" \
  -out "$signature_file"
openssl base64 -A -in "$signature_file" |
  tr '+/' '-_' |
  tr -d '=' >"$signature_text"
printf '\n' >>"$signature_text"

install -m 0644 "$digest_file" "$trusted_digests"
install -m 0644 "$signature_text" "$trusted_signature"
echo "signed release digests with the offline publisher key"
