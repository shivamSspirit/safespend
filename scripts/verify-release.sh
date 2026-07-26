#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist_dir="${1:-"$project_root/dist/plugins"}"
trusted_key_file="${2:-"$project_root/release/trusted-publisher-key.txt"}"

for command in openssl awk perl sed tr; do
  command -v "$command" >/dev/null || {
    echo "required command is unavailable: $command" >&2
    exit 2
  }
done

trusted_key="$(tr -d '[:space:]' <"$trusted_key_file")"
if [[ ! "$trusted_key" =~ ^[0-9a-f]{64}$ ]]; then
  echo "trusted publisher key must be exactly 32 lowercase hex bytes" >&2
  exit 2
fi
if ! grep -Eq '^[[:space:]]*signature_mode[[:space:]]*=[[:space:]]*"strict"[[:space:]]*$' \
  "$project_root/zeroclaw/config.example.toml"
then
  echo "ZeroClaw example config must enforce strict plugin signatures" >&2
  exit 1
fi
expected_trust_line="trusted_publisher_keys = [\"$trusted_key\"]"
actual_trust_line="$(
  sed -n 's/^[[:space:]]*trusted_publisher_keys[[:space:]]*=[[:space:]]*/trusted_publisher_keys = /p' \
    "$project_root/zeroclaw/config.example.toml"
)"
if [[ "$actual_trust_line" != "$expected_trust_line" ]]; then
  echo "ZeroClaw example config must trust exactly the release publisher key" >&2
  exit 1
fi

temporary_dir="$(mktemp -d)"
trap 'find "$temporary_dir" -type f -delete; rmdir "$temporary_dir"' EXIT

printf '302a300506032b6570032100%s' "$trusted_key" |
  perl -ne 's/\s//g; print pack("H*", $_)' >"$temporary_dir/publisher.der"

canonicalize() {
  awk '
    {
      trimmed = $0
      sub(/^[[:space:]]+/, "", trimmed)
      sub(/[[:space:]]+$/, "", trimmed)
      if ((trimmed ~ /^signature/ || trimmed ~ /^publisher_key/) && index(trimmed, "=") > 0) {
        next
      }
      lines[++count] = $0
    }
    END {
      while (count > 0 && lines[count] ~ /^[[:space:]]*$/) {
        count--
      }
      for (line_no = 1; line_no <= count; line_no++) {
        printf "%s", lines[line_no]
        if (line_no < count) {
          printf "\n"
        }
      }
    }
  ' "$1" >"$2"
}

decode_base64url() {
  local encoded="$1"
  local padding
  case $((${#encoded} % 4)) in
    0) padding="" ;;
    2) padding="==" ;;
    3) padding="=" ;;
    *)
      echo "invalid base64url length" >&2
      return 1
      ;;
  esac
  printf '%s%s' "$encoded" "$padding" |
    tr '_-' '/+' |
    openssl base64 -d -A
}

for plugin in safespend-treasury-watch safespend-allowance-pay; do
  manifest="$dist_dir/$plugin/manifest.toml"
  [[ -f "$manifest" ]] || {
    echo "missing manifest: $manifest" >&2
    exit 1
  }

  publisher="$(
    sed -n 's/^[[:space:]]*publisher_key[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest"
  )"
  signature="$(
    sed -n 's/^[[:space:]]*signature[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest"
  )"
  if [[ "$publisher" != "$trusted_key" || -z "$signature" ]]; then
    echo "$plugin is unsigned or uses an untrusted publisher" >&2
    exit 1
  fi

  canonical="$temporary_dir/$plugin.canonical"
  signature_file="$temporary_dir/$plugin.signature"
  canonicalize "$manifest" "$canonical"
  decode_base64url "$signature" >"$signature_file"
  openssl pkeyutl \
    -verify \
    -pubin \
    -inkey "$temporary_dir/publisher.der" \
    -keyform DER \
    -rawin \
    -in "$canonical" \
    -sigfile "$signature_file" \
    >/dev/null
  echo "verified manifest signature: $plugin"
done

if [[ ! -f "$dist_dir/SHA256SUMS" ]]; then
  echo "missing release digest file: $dist_dir/SHA256SUMS" >&2
  exit 1
fi
if command -v sha256sum >/dev/null; then
  (cd "$dist_dir" && sha256sum --check SHA256SUMS)
elif command -v shasum >/dev/null; then
  (cd "$dist_dir" && shasum -a 256 --check SHA256SUMS)
else
  echo "sha256sum or shasum is required" >&2
  exit 2
fi

echo "SafeSpend release verification passed"
