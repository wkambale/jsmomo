# Resilience and observability

JS MoMo SDK includes bounded transport protections, idempotent retries, settlement polling, structured telemetry hooks, and a local multi-rail simulator.

## Retries, backoff, and response size ceilings

```ts
import { JsMomoSDK, JsMomoSDKConfig, ProductConfig } from "js-momo-sdk";

const config = new JsMomoSDKConfig({
  environment: "sandbox",
  timeout: 20,
  maxRetries: 2,
  retryBackoff: 0.5,
  collection: new ProductConfig({
    subscriptionKey: "sub-key",
    apiUser: "550e8400-e29b-41d4-a716-446655440000",
    apiKey: "api-key",
  }),
});

const client = new JsMomoSDK(config, {
  maxResponseBytes: 512 * 1024, // 512 KiB streaming ceiling
});
```

- Retries only execute on idempotent requests (`GET`/`HEAD`/`PUT`/`DELETE`, or `POST` requests carrying `X-Reference-Id` or `Idempotency-Key`).
- Retry delays honor `Retry-After` headers (clamped safely) and use `crypto.randomInt` jitter.
- HTTP `3xx` redirects are never followed automatically (`redirect: "manual"`).

## Settlement polling (`waitForSettlement`)

```ts
import { waitForSettlement } from "js-momo-sdk";

const settled = await waitForSettlement(
  () => client.collection.getPaymentStatus(referenceId),
  {
    timeout: 60,
    interval: 2,
    backoffMultiplier: 1.5,
    maxInterval: 10,
    referenceId,
  },
);
```

If the transaction resolves to `FAILED`, `waitForSettlement()` throws `TransactionFailedError` with `referenceId` and the provider's failure `reason`.

## Observability (`TelemetryHook`)

Attach a `TelemetryHook` to any client config or webhook verifier to capture redacted request latency, HTTP status, retry attempt counts, correlation IDs, and webhook verification outcomes:

```ts
import type { TelemetryHook } from "js-momo-sdk";

const telemetry: TelemetryHook = {
  onRequest(event) {
    console.log(
      event.method,
      event.path, // MSISDNs, emails, and API user IDs are redacted
      event.statusCode,
      `${event.latencyMs.toFixed(1)}ms`,
      `attempt=${event.attempt}`,
      `ref=${event.correlationId}`,
    );
  },
  onWebhook(event) {
    console.log(event.provider, event.verified, event.reason);
  },
};
```

## Local mock gateway server

Run the zero-dependency simulator in integration tests or CI:

```ts
import { startMockServer } from "js-momo-sdk";

const mock = await startMockServer({
  host: "127.0.0.1",
  port: 0,
  defaultStatus: "SUCCESSFUL",
});

console.log("Mock URL:", mock.url);
await mock.close();
```
