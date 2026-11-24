# Error handling

All SDK errors extend `JsMomoSDKError` and preserve structured diagnostic metadata so failed payment attempts can always be reconciled without losing the generated transaction reference.

## Exception hierarchy

| Exception | Trigger |
| --- | --- |
| `JsMomoSDKError` | Base class for all SDK HTTP, network, timeout, and response schema errors |
| `AuthenticationError` | HTTP `401` or invalid OAuth2 token payload |
| `MissingCredentialsError` | Accessing an unconfigured MTN product (Collection, Disbursement, Remittance) |
| `BadRequestError` | HTTP `400` or `422` validation rejection from the gateway |
| `ResourceNotFoundError` | HTTP `404` unknown transaction reference |
| `ConflictError` | HTTP `409` duplicate `X-Reference-Id` |
| `JsMomoSDKServerError` | HTTP `5xx` upstream gateway outage |
| `TransactionFailedError` | Settled `FAILED` transaction during polling or Airtel HTTP `200` terminal rejection |
| `WebhookVerificationError` | Invalid HMAC, expired timestamp, replay detected, or disallowed source IP |

## Structured diagnostic attributes

Every `JsMomoSDKError` carries:

- `referenceId: string | null` — The caller-supplied or SDK-generated transaction reference ID, preserved even when authentication, network, timeout, HTTP `4xx`/`5xx`, or schema validation fails.
- `statusCode: number | null` — HTTP status code when available.
- `errorCode: string | null` — Gateway error code extracted from JSON error envelopes across all 7 rails.
- `reason: string | null` — Human-readable error message or transport subtype (`TimeoutError`, `TypeError`).
- `provider: string | null` — Originating rail name (`"MTN MoMo"`, `"Airtel Money"`, `"Wave"`, `"M-Pesa"`, `"Paystack"`, `"Flutterwave"`, `"Orange Money"`).
- `responseBody: Record<string, unknown>` — Recursively redacted response payload (tokens, PINs, API keys, and secrets are automatically replaced with `"<redacted>"`).
- `attemptedReferences: AttemptedReference[]` — Populated by `PaymentRouter` when multi-rail fallback attempts fail.

## Example

```ts
import {
  BadRequestError,
  ConflictError,
  JsMomoSDKError,
  TransactionFailedError,
} from "js-momo-sdk";

try {
  const ref = await client.collection.requestToPay({
    amount: "5000",
    currency: "UGX",
    payerMsisdn: "256772123456",
    externalId: "order-99",
  });
  console.log("Accepted:", ref);
} catch (err) {
  if (err instanceof ConflictError) {
    console.warn("Duplicate reference, querying status:", err.referenceId);
  } else if (err instanceof BadRequestError) {
    console.error("Rejected:", err.errorCode, err.reason, err.referenceId);
  } else if (err instanceof TransactionFailedError) {
    console.error("Failed transaction:", err.referenceId, err.reason);
  } else if (err instanceof JsMomoSDKError) {
    console.error(
      `[${err.provider}] status=${err.statusCode} ref=${err.referenceId}: ${err.reason ?? err.message}`,
    );
  } else {
    throw err;
  }
}
```
