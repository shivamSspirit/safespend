#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
private_key="${1:-}"

if [[ -z "$private_key" ]]; then
  echo "usage: $0 /absolute/path/to/plugin-publisher-ed25519.pk8" >&2
  exit 2
fi
if [[ ! -f "$private_key" ]]; then
  echo "publisher key does not exist: $private_key" >&2
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

for command in openssl awk od tr; do
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
if [[ ! "$publisher_key" =~ ^[0-9a-f]{64}$ ]]; then
  echo "could not derive a 32-byte Ed25519 publisher key" >&2
  exit 1
fi

temporary_dir="$(mktemp -d)"
trap 'find "$temporary_dir" -type f -delete; rmdir "$temporary_dir"' EXIT

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

for manifest in \
  "$project_root/plugins/treasury-watch/manifest.toml" \
  "$project_root/plugins/allowance-pay/manifest.toml"
do
  plugin="$(basename "$(dirname "$manifest")")"
  canonical="$temporary_dir/$plugin.canonical"
  signature_file="$temporary_dir/$plugin.signature"
  replacement="$temporary_dir/$plugin.manifest"

  canonicalize "$manifest" "$canonical"
  openssl pkeyutl \
    -sign \
    -rawin \
    -inkey "$key_path" \
    -keyform DER \
    -in "$canonical" \
    -out "$signature_file"
  signature="$(
    openssl base64 -A -in "$signature_file" |
      tr '+/' '-_' |
      tr -d '='
  )"

  {
    printf '%s\n' "$(cat "$canonical")"
    printf 'publisher_key = "%s"\n' "$publisher_key"
    printf 'signature = "%s"\n' "$signature"
  } >"$replacement"
  install -m 0644 "$replacement" "$manifest"
  echo "signed $manifest"
done

printf '%s\n' "$publisher_key" >"$project_root/release/trusted-publisher-key.txt"
echo "publisher key: $publisher_key"
