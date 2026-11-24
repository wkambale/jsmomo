# Webhooks

JS MoMo SDK verifies inbound webhook deliveries using constant-time digest comparison, timestamped replay protection, IP/CIDR allowlisting, and streaming body-size limits.

## Direct verification with `WebhookHandler`

```ts
import { WebhookHandler } from "js-momo-sdk";

// Standard HMAC-SHA256 / HMAC-SHA512 (e.g. Paystack uses algorithm: "sha512")
WebhookHandler.verifyHmacSignature(rawBodyBytes, signatureHeader, secret, {
  algorithm: "sha256",
});

// Timestamped HMAC (e.g. Wave uses timestampSeparator: "")
WebhookHandler.verifyTimestampedHmacSignature(
  rawBodyBytes,
  waveSignatureHeader,
  waveWebhookSecret,
  {
    toleranceSeconds: 300,
    timestampSeparator: "",
    replayCheck: (header, _payload, _ts) => myReplayStore.markOnce(header),
  },
);

// Fail-closed IPv4 / IPv6 / IPv4-mapped IPv6 CIDR allowlisting
WebhookHandler.verifySourceIp(remoteIp, [
  "196.43.133.0/24",
  "2001:db8::/32",
]);

// Parse MTN MoMo transaction callback JSON
const tx = WebhookHandler.parseTransactionNotification(parsedBody, {
  requireIdentifier: true,
});
```

## Express middleware

Use `express.raw({ type: "application/json" })` or attach `req.rawBody` so exact unparsed bytes are verified:

```ts
import express from "express";
import { createExpressWebhookMiddleware } from "js-momo-sdk";

const app = express();

app.post(
  "/webhooks/momo",
  express.raw({ type: "application/json" }),
  createExpressWebhookMiddleware({
    secret: process.env.JS_MOMO_SDK_WEBHOOK_SECRET!,
    signatureHeaderName: "X-Signature",
    httpErrorStatus: 401,
    allowedNetworks: ["196.43.133.0/24"],
  }),
  (req, res) => {
    const payload = JSON.parse((req.body as Buffer).toString("utf8"));
    res.json({ received: true, status: payload.status });
  },
);
```

## Fastify preHandler hook

```ts
import { createFastifyWebhookPreHandler } from "js-momo-sdk";

const verifyWebhook = createFastifyWebhookPreHandler({
  secret: process.env.JS_MOMO_SDK_WEBHOOK_SECRET!,
  signatureHeaderName: "x-paystack-signature",
  algorithm: "sha512",
  httpErrorStatus: 401,
});
```

## Next.js App Router / Fetch API / Edge Runtime

```ts
import { verifyWebWebhookRequest, WebhookVerificationError } from "js-momo-sdk";

export async function POST(request: Request): Promise<Response> {
  try {
    const rawBody = await verifyWebWebhookRequest(request, {
      secret: process.env.WAVE_WEBHOOK_SECRET!,
      signatureHeaderName: "Wave-Signature",
      timestamped: true,
      timestampSeparator: "",
      maxBodyBytes: 1_048_576,
    });
    const event = JSON.parse(new TextDecoder().decode(rawBody));
    return Response.json({ ok: true, id: event.id });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }
    throw err;
  }
}
```

## Static token webhooks (Flutterwave `verif-hash`)

```ts
import { verifyStaticTokenWebhookRequest } from "js-momo-sdk";

verifyStaticTokenWebhookRequest({
  headers: req.headers,
  tokenHeaderName: "verif-hash",
  expectedToken: process.env.FLW_WEBHOOK_HASH!,
  provider: "flutterwave",
});
```
