# Multi-provider orchestration

JS MoMo SDK normalizes **7 African mobile money and payment gateways** behind a single `PaymentProvider` interface and `PaymentRouter`.

## Supported payment rails

| Provider | Adapter | Native Client | Collection | Disbursement | Balance | Webhook Verification |
| --- | --- | --- | --- | --- | --- | --- |
| MTN MoMo | `MtnMomoProvider` | `JsMomoSDK` | Yes | Yes | Yes | Static / HMAC / IP allowlist |
| Airtel Money | `AirtelMoneyProvider` | `AirtelClient` | Yes | Yes | Yes | Static / HMAC / IP allowlist |
| Wave | `WaveProvider` | `WaveClient` | Yes | Yes | Yes | Timestamped HMAC (`Wave-Signature`) |
| Safaricom M-Pesa | `MpesaProvider` | `MpesaClient` | Yes (STK Push) | Yes (B2C) | Callback-only | IP allowlist |
| Paystack | `PaystackProvider` | `PaystackClient` | Yes | Yes (`RCP_`) | Yes | HMAC-SHA512 (`x-paystack-signature`) |
| Flutterwave | `FlutterwaveProvider` | `FlutterwaveClient` | Yes | Yes | Yes | Constant-time `verif-hash` |
| Orange Money | `OrangeMoneyProvider` | `OrangeMoneyClient` | Yes | No | No | Pluggable `OrangePaymentContextStore` |

## Routing with `PaymentRouter`

```ts
import {
  AirtelClient,
  AirtelMoneyProvider,
  DisbursementRequest,
  JsMomoSDK,
  MpesaClient,
  MpesaProvider,
  MtnMomoProvider,
  PaymentRequest,
  PaymentRouter,
  ProductConfig,
  WaveClient,
  WaveProvider,
} from "js-momo-sdk";

const router = new PaymentRouter({
  providers: [
    new MtnMomoProvider(
      new JsMomoSDK({
        collection: new ProductConfig({
          subscriptionKey: process.env.JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY!,
          apiUser: process.env.JS_MOMO_SDK_COLLECTION_API_USER!,
          apiKey: process.env.JS_MOMO_SDK_COLLECTION_API_KEY!,
        }),
      }),
    ),
    new AirtelMoneyProvider(
      new AirtelClient({
        clientId: process.env.JS_MOMO_SDK_AIRTEL_CLIENT_ID!,
        clientSecret: process.env.JS_MOMO_SDK_AIRTEL_CLIENT_SECRET!,
        country: "UG",
        currency: "UGX",
      }),
    ),
    new WaveProvider(
      new WaveClient({
        apiKey: process.env.WAVE_API_KEY!,
        successUrl: "https://shop.example.com/ok",
        errorUrl: "https://shop.example.com/err",
      }),
    ),
    new MpesaProvider(
      new MpesaClient({
        consumerKey: process.env.MPESA_CONSUMER_KEY!,
        consumerSecret: process.env.MPESA_CONSUMER_SECRET!,
        shortCode: "174379",
        passkey: process.env.MPESA_PASSKEY!,
        callbackUrl: "https://shop.example.com/webhooks/mpesa",
      }),
    ),
  ],
  defaultProvider: "mtn_momo",
});

// Carrier-inferred routing (+256752 -> Airtel Uganda, +254712 -> Safaricom M-Pesa)
const result = await router.collect(
  new PaymentRequest({
    amount: "5000",
    currency: "UGX",
    payerMsisdn: "+256752123456",
  }),
);
console.log(result.provider, result.referenceId, result.status);

// Explicit provider selection
const payout = await router.disburse(
  new DisbursementRequest({
    amount: "2000",
    currency: "XOF",
    payeeMsisdn: "+221771234567",
  }),
  { provider: "wave" },
);
console.log(payout.referenceId);

await router.close();
```

## Safe failover semantics

When `fallback: true` is set on `router.collect()` or `router.disburse()`:

- By default, `PaymentRouter` only fails over on **unambiguous pre-flight failures** (`AuthenticationError` and `MissingCredentialsError`) so an ambiguous HTTP `5xx` cannot double-charge a subscriber across two rails.
- If your ledger reconciles across rails, pass `allowAmbiguousWriteFallback: true`. `PaymentRouter` pre-generates a shared `referenceId` before attempting the first rail, records `priorFailedAttempts` on the winning `PaymentResult.raw`, and attaches `attemptedReferences` to the thrown error if every rail fails.

## Orange Money context store

Orange Money Web Payment status queries require `orderId`, `amount`, and `payToken`. In multi-worker deployments, pass a shared `OrangePaymentContextStore` (for example backed by Redis or Postgres) into `OrangeMoneyClient`:

```ts
import { OrangeMoneyClient, OrangeMoneyConfig } from "js-momo-sdk";

const orange = new OrangeMoneyClient(
  new OrangeMoneyConfig({
    clientId: process.env.ORANGE_CLIENT_ID!,
    clientSecret: process.env.ORANGE_CLIENT_SECRET!,
    merchantKey: process.env.ORANGE_MERCHANT_KEY!,
    environment: "production",
    apiPathPrefix: "/orange-money-webpay/sn/v1",
    returnUrl: "https://shop.example.com/return",
    cancelUrl: "https://shop.example.com/cancel",
    notifUrl: "https://shop.example.com/webhooks/orange",
  }),
  {
    contextStore: myRedisContextStore,
  },
);
```
