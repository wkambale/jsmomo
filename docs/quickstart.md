# Quickstart

Get started with **JS MoMo SDK** (`js-momo-sdk`) in under two minutes.

## Installation

Install `js-momo-sdk` on Node.js 18 or newer:

```bash
npm install js-momo-sdk
```

`js-momo-sdk` has **zero runtime dependencies** and includes the CLI (`npx js-momo-sdk`), native RSA PIN encryption for Airtel Money, Express/Fastify/Fetch webhook verifiers, and the local mock gateway server out of the box.

## 1. Provision MTN sandbox credentials

```ts
import { JsMomoSDK, JsMomoSDKConfig } from "js-momo-sdk";

const client = new JsMomoSDK(new JsMomoSDKConfig({ environment: "sandbox" }));

try {
  const provisioner = client.createSandboxProvisioner(
    process.env.JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY!,
  );
  const { apiUser, apiKey } = await provisioner.provision({
    callbackHost: "https://example.com",
  });
  console.log({ apiUser, apiKey });
} finally {
  client.close();
}
```

## 2. Collect a payment and poll for settlement

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
    subscriptionKey: process.env.JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY!,
    apiUser: process.env.JS_MOMO_SDK_COLLECTION_API_USER!,
    apiKey: process.env.JS_MOMO_SDK_COLLECTION_API_KEY!,
  }),
});

const client = new JsMomoSDK(config);

try {
  const referenceId = await client.collection.requestToPay({
    amount: "5000",
    currency: "UGX",
    payerMsisdn: "256772123456",
    externalId: "order-1001",
    payerMessage: "Order #1001",
    payeeNote: "Thank you",
  });

  const tx = await waitForSettlement(
    () => client.collection.getPaymentStatus(referenceId),
    { timeout: 60, interval: 2, referenceId },
  );
  console.log("Settled:", tx.status, tx.financialTransactionId);
} finally {
  client.close();
}
```

## 3. Test locally without live credentials

Start the built-in local simulator for all 7 payment rails:

```bash
npx js-momo-sdk mock --port 8090
```

Or embed it directly inside your test suite using `startMockServer()`:

```ts
import { JsMomoSDK, ProductConfig, startMockServer } from "js-momo-sdk";

const mock = await startMockServer({ defaultStatus: "SUCCESSFUL" });
try {
  const sdk = new JsMomoSDK({
    baseUrl: mock.url,
    collection: new ProductConfig({
      subscriptionKey: "sub",
      apiUser: "user",
      apiKey: "key",
    }),
  });
  const balance = await sdk.collection.getBalance();
  console.log(balance);
} finally {
  await mock.close();
}
```
