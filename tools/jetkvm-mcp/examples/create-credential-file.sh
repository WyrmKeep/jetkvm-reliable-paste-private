#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || $1 != /* ]]; then
  printf 'usage: %s /absolute/path/to/credential\n' "${0##*/}" >&2
  exit 64
fi

destination=$1
mkdir -p -- "$(dirname -- "$destination")"
temporary=$(mktemp "${destination}.tmp.XXXXXX")
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT
chmod 600 "$temporary"

if [[ ${JETKVM_EXAMPLE_CREDENTIAL_STDIN:-} == 1 ]]; then
  IFS= read -r credential
else
  read -r -s -p 'JetKVM credential: ' credential
  printf '\n' >&2
fi
if [[ -z $credential ]]; then
  printf 'credential must not be empty\n' >&2
  exit 65
fi
printf '%s' "$credential" >"$temporary"
unset credential
mv -f -- "$temporary" "$destination"
trap - EXIT
printf 'wrote protected credential file: %s\n' "$destination"
