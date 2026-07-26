#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_dir="$project_root/target/wasm32-wasip2/release"
dist_dir="$project_root/dist/plugins"

cargo build \
  --manifest-path "$project_root/Cargo.toml" \
  --release \
  --target wasm32-wasip2 \
  -p safespend-treasury-watch \
  -p safespend-allowance-pay

install -d \
  "$dist_dir/safespend-treasury-watch" \
  "$dist_dir/safespend-allowance-pay"

install -m 0644 \
  "$project_root/plugins/treasury-watch/manifest.toml" \
  "$dist_dir/safespend-treasury-watch/manifest.toml"
install -m 0644 \
  "$target_dir/safespend_treasury_watch.wasm" \
  "$dist_dir/safespend-treasury-watch/safespend_treasury_watch.wasm"

install -m 0644 \
  "$project_root/plugins/allowance-pay/manifest.toml" \
  "$dist_dir/safespend-allowance-pay/manifest.toml"
install -m 0644 \
  "$target_dir/safespend_allowance_pay.wasm" \
  "$dist_dir/safespend-allowance-pay/safespend_allowance_pay.wasm"

if command -v sha256sum >/dev/null; then
  (
    cd "$dist_dir"
    sha256sum \
      safespend-allowance-pay/safespend_allowance_pay.wasm \
      safespend-treasury-watch/safespend_treasury_watch.wasm \
      >SHA256SUMS
  )
elif command -v shasum >/dev/null; then
  (
    cd "$dist_dir"
    shasum -a 256 \
      safespend-allowance-pay/safespend_allowance_pay.wasm \
      safespend-treasury-watch/safespend_treasury_watch.wasm \
      >SHA256SUMS
  )
else
  echo "sha256sum or shasum is required to create release digests" >&2
  exit 2
fi

echo "SafeSpend plugins staged under $dist_dir"
