#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
private_key="${1:-}"
generated_digests="$project_root/dist/plugins/SHA256SUMS"
trusted_digests="$project_root/release/plugin-SHA256SUMS"
trusted_signature="$project_root/release/plugin-SHA256SUMS.sig"

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

for command in openssl install tr; do
  command -v "$command" >/dev/null || {
    echo "required command is unavailable: $command" >&2
    exit 2
  }
done

temporary_dir="$(mktemp -d)"
trap 'find "$temporary_dir" -type f -delete; rmdir "$temporary_dir"' EXIT

signature_file="$temporary_dir/plugin-SHA256SUMS.sig"
signature_text="$temporary_dir/plugin-SHA256SUMS.sig.txt"
openssl pkeyutl \
  -sign \
  -rawin \
  -inkey "$key_path" \
  -keyform DER \
  -in "$generated_digests" \
  -out "$signature_file"
openssl base64 -A -in "$signature_file" |
  tr '+/' '-_' |
  tr -d '=' >"$signature_text"
printf '\n' >>"$signature_text"

install -m 0644 "$generated_digests" "$trusted_digests"
install -m 0644 "$signature_text" "$trusted_signature"
echo "signed release digests with the offline publisher key"
