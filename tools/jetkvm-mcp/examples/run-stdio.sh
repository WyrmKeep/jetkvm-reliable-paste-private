#!/bin/sh
set -eu

: "${JETKVM_TARGET_URL:?set JETKVM_TARGET_URL to the operator-selected JetKVM HTTPS URL}"
: "${JETKVM_CREDENTIAL_FILE:?set JETKVM_CREDENTIAL_FILE to an absolute protected file}"

case "$JETKVM_TARGET_URL" in
  https://*) ;;
  *)
    printf 'JETKVM_TARGET_URL must use HTTPS in this example\n' >&2
    exit 64
    ;;
esac
case "$JETKVM_CREDENTIAL_FILE" in
  /*) ;;
  *)
    printf 'JETKVM_CREDENTIAL_FILE must be absolute\n' >&2
    exit 64
    ;;
esac
if [ ! -f "$JETKVM_CREDENTIAL_FILE" ]; then
  printf 'JETKVM_CREDENTIAL_FILE is not a regular file\n' >&2
  exit 66
fi

unset JETKVM_CREDENTIAL JETKVM_CREDENTIAL_ENV
exec "${JETKVM_MCP_COMMAND:-jetkvm-mcp}"
