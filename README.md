<div align="center">
  <h1>JS MoMo SDK</h1>
  <p><b>Strictly typed TypeScript &amp; JavaScript SDK for MTN Mobile Money, Airtel Money, Wave, Safaricom M-Pesa, Paystack, Flutterwave, and Orange Money</b></p>

  [![npm version](https://img.shields.io/npm/v/js-momo-sdk.svg)](https://www.npmjs.com/package/js-momo-sdk)
  [![Node versions](https://img.shields.io/node/v/js-momo-sdk.svg)](https://www.npmjs.com/package/js-momo-sdk)
  [![Build status](https://github.com/wkambale/jsmomo/actions/workflows/ci.yml/badge.svg)](https://github.com/wkambale/jsmomo/actions)
  [![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
</div>

JS MoMo SDK (`js-momo-sdk` 1.2.2) is a zero-runtime-dependency, strictly typed TypeScript and JavaScript client library for MTN Mobile Money (MoMo), Airtel Money, Wave, Safaricom M-Pesa (Daraja), Paystack, Flutterwave, and Orange Money behind a unified `PaymentRouter`. It ships dual ESM and CommonJS bundles with full `.d.ts` declarations, automatic OAuth2 token caching, strict input validation, structured error diagnostics, and verified webhook security.

- **npm package:** [js-momo-sdk](https://www.npmjs.com/package/js-momo-sdk) (`1.2.2`, inspectable via `VERSION`)
- **Runtime support:** Node.js 18+ (zero runtime dependencies, backed by native `fetch` and `node:crypto`)
- **Documentation:** [https://wkambale.github.io/jsmomo/](https://wkambale.github.io/jsmomo/)
- **Repository:** [https://github.com/wkambale/jsmomo](https://github.com/wkambale/jsmomo)

## Features

- **Zero runtime dependencies & dual ESM/CJS:** Native `fetch`, `node:crypto`, and `node:http` with strict TypeScript types (`dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`, `dist/index.d.cts`).
- **Automated token caching:** Single-flight OAuth2 token refresh with monotonic expiry tracking, conditional `expectedToken` invalidation, and automatic 401 retry-once logic.
- **Comprehensive African payment coverage:** MTN MoMo Collection (including `preApprove`, `requestToPayDeliveryNotification`, CIBA `bcAuthorize`, and OAuth2 token exchange/refresh), Disbursement (`transfer`, `deposit`, `refund`), Remittance (`transfer`, cross-border `cashTransfer`), and Sandbox Provisioning; Airtel Money (`AirtelClient` with native RSA `encryptAirtelPin()`); Wave (full outbound `Wave-Signature` signing and HMAC/Shared-Secret webhooks); Safaricom M-Pesa Daraja (`normaliseMpesaMsisdn()`, STK Push/Query, B2C, Transaction Status, Account Balance, Reversal); Paystack (`chargeMobileMoney`, `listBanks`, `createRefund`, transfers); Flutterwave (`chargeMobileMoney`, `verifyTransaction`, `createRefund`, `getTransferByReference`); and Orange Money WebPay behind `PaymentRouter`.
- **Resilience and observability:** Bounded idempotent retries with `Retry-After` and CSPRNG jitter, streaming `maxResponseBytes` caps, HTTP `3xx` redirect rejection, `waitForSettlement()`, `TelemetryHook` observability events, 19-market / 151-prefix MSISDN carrier detection with currency-aware router fallback, Express/Fastify/Fetch API webhook verifiers, and a local `js-momo-sdk mock` simulator.
- **Structured error diagnostics:** Every error preserves `referenceId`, `statusCode`, `errorCode`, `reason`, `provider`, recursively redacted `responseBody`, and `attemptedReferences` across multi-rail failovers.
- **Built-in CLI:** Executable `js-momo-sdk` binary for sandbox provisioning, collections, disbursements, remittances, Airtel PIN encryption, webhook verification, carrier lookup, and local mock server hosting.

## Installation

Install `js-momo-sdk` from npm:

```bash
npm install js-momo-sdk
```

Or with pnpm / yarn:

```bash
pnpm add js-momo-sdk
yarn add js-momo-sdk
```

## Quickstart

### Check installed version and provision sandbox credentials

```ts
import { JsMomoSDK, JsMomoSDKConfig, VERSION } from "js-momo-sdk";

console.log(VERSION);

const config = new JsMomoSDKConfig({ environment: "sandbox" });
const client = new JsMomoSDK(config);

try {
  const provisioner = client.createSandboxProvisioner(
    "your-sandbox-subscription-key",
  );
  const credentials = await provisioner.provision({
    callbackHost: "example.com",
  });

  console.log(`API user: ${credentials.apiUser}`);
  console.log(`API key: ${credentials.apiKey}`);
} finally {
  client.close();
}
```

### Collection (Request to Pay + settlement polling)

```ts
import {
  JsMomoSDK,
  JsMomoSDKConfig,
  ProductConfig,
  waitForSettlement,
} from "js-momo-sdk";

const config = new JsMomoSDKConfig({
  environment: "sandbox",
  collection: new ProductConfig({
    subscriptionKey: "your-collection-subscription-key",
    apiUser: "550e8400-e29b-41d4-a716-446655440000",
    apiKey: "your-api-key",
    callbackUrl: "https://example.com/webhook",
  }),
});

const client = new JsMomoSDK(config);

try {
  const balance = await client.collection.getBalance();
  console.log(
    `Available balance: ${balance.availableBalance} ${balance.currency}`,
  );

  const referenceId = await client.collection.requestToPay({
    amount: "1000",
    currency: "UGX",
    payerMsisdn: "256771234567",
    externalId: "ext-tx-12345",
    payerMessage: "Payment for invoice 123",
    payeeNote: "Thank you for shopping with us",
  });

  const tx = await waitForSettlement(
    () => client.collection.getPaymentStatus(referenceId),
    { timeout: 60, interval: 2, referenceId },
  );
  console.log(`Transaction status: ${tx.status}`);
} finally {
  client.close();
}
```

### Multi-provider routing (`PaymentRouter`)

```ts
import {
  AirtelClient,
  AirtelMoneyProvider,
  JsMomoSDK,
  MtnMomoProvider,
  PaymentRequest,
  PaymentRouter,
  ProductConfig,
} from "js-momo-sdk";

const mtn = new MtnMomoProvider(
  new JsMomoSDK({
    environment: "sandbox",
    collection: new ProductConfig({
      subscriptionKey: process.env.JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY!,
      apiUser: process.env.JS_MOMO_SDK_COLLECTION_API_USER!,
      apiKey: process.env.JS_MOMO_SDK_COLLECTION_API_KEY!,
    }),
  }),
);

const airtel = new AirtelMoneyProvider(
  new AirtelClient({
    clientId: process.env.JS_MOMO_SDK_AIRTEL_CLIENT_ID!,
    clientSecret: process.env.JS_MOMO_SDK_AIRTEL_CLIENT_SECRET!,
    country: "UG",
    currency: "UGX",
  }),
);

const router = new PaymentRouter({
  providers: [mtn, airtel],
  defaultProvider: "mtn_momo",
});

// Automatically routes +256752... to Airtel Uganda and +256772... to MTN Uganda
const result = await router.collect(
  new PaymentRequest({
    amount: "5000",
    currency: "UGX",
    payerMsisdn: "+256752123456",
  }),
);
console.log(result.provider, result.referenceId, result.status);
await router.close();
```

## CLI usage

Export credentials via `JS_MOMO_SDK_*` environment variables or `--*-file` flags so secrets are never recorded in shell history:

```bash
export JS_MOMO_SDK_ENVIRONMENT="sandbox"
export JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY="your-key"
export JS_MOMO_SDK_COLLECTION_API_USER="550e8400-e29b-41d4-a716-446655440000"
export JS_MOMO_SDK_COLLECTION_API_KEY="your-api-key"

npx js-momo-sdk --version
npx js-momo-sdk sandbox provision --callback-host "example.com" --output-file ./creds.json
npx js-momo-sdk collection balance
npx js-momo-sdk carrier +256772123456
npx js-momo-sdk mock --port 8090
```

Run `npx js-momo-sdk --help` to list all commands and options.

## Development & testing

```bash
npm ci
npm run verify
```

`npm run verify` executes ESLint, Prettier format verification, strict `tsc --noEmit`, Vitest with the 90% coverage gate, and dual ESM/CJS/DTS/CLI builds.

## License

MIT License. Copyright (c) 2026 Wesley Kambale. See [LICENSE](LICENSE) for details.
