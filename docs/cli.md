# Command line interface

`js-momo-sdk` ships a zero-dependency executable CLI (`js-momo-sdk` / `npx js-momo-sdk`). All commands output machine-readable JSON to stdout and exit with code `1` on errors.

## Passing secrets safely

Prefer `JS_MOMO_SDK_*` environment variables or `--*-file` flags (pass `-` to read from stdin) instead of inline CLI flags so credentials never appear in shell history:

```bash
export JS_MOMO_SDK_ENVIRONMENT="sandbox"
export JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY="your-key"
export JS_MOMO_SDK_COLLECTION_API_USER="550e8400-e29b-41d4-a716-446655440000"
export JS_MOMO_SDK_COLLECTION_API_KEY="your-api-key"
```

## Available commands

### Version & carrier detection

```bash
npx js-momo-sdk --version
npx js-momo-sdk carrier +256772123456
```

### MTN Sandbox provisioning

```bash
npx js-momo-sdk sandbox provision \
  --callback-host "example.com" \
  --output-file ./sandbox-creds.json

npx js-momo-sdk sandbox get-user "550e8400-e29b-41d4-a716-446655440000"
```

### MTN Collection, Disbursement, and Remittance

```bash
# Collection
npx js-momo-sdk collection balance
npx js-momo-sdk collection balance --currency UGX
npx js-momo-sdk collection request-to-pay 256772123456 5000 UGX order-101
npx js-momo-sdk collection status "<reference-uuid>"

# Disbursement
npx js-momo-sdk disbursement balance
npx js-momo-sdk disbursement transfer 256772123456 5000 UGX payout-101
npx js-momo-sdk disbursement status "<reference-uuid>"

# Remittance
npx js-momo-sdk remittance balance
npx js-momo-sdk remittance transfer 256772123456 5000 UGX remit-101
npx js-momo-sdk remittance status "<reference-uuid>"
```

### Airtel Money utilities

```bash
npx js-momo-sdk airtel encrypt-pin \
  --public-key-file ./airtel_public_key.pem \
  --pin-file ./pin.txt

npx js-momo-sdk airtel balance --country UG --currency UGX
```

### Webhook signature verification

```bash
# Standard HMAC-SHA256 from stdin
printf '{"status":"SUCCESSFUL"}' | npx js-momo-sdk webhook verify \
  --signature "<hex-digest>" \
  --secret-file ./webhook-secret.txt

# Base64 HMAC-SHA256 (e.g. Airtel Money x-signature)
printf '{"status":"TS"}' | npx js-momo-sdk webhook verify \
  --signature "<base64-digest>" \
  --encoding base64 \
  --secret-file ./airtel-webhook-secret.txt

# Timestamped Wave signature (empty separator)
printf '{"id":"ev1"}' | npx js-momo-sdk webhook verify \
  --signature "t=1700000000,v1=<hex>" \
  --secret-file ./wave-secret.txt \
  --timestamped \
  --timestamp-separator ""
```

### Local mock gateway server

```bash
npx js-momo-sdk mock --host 127.0.0.1 --port 8090 --status SUCCESSFUL
```
