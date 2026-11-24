# TypeScript and ESM/CJS usage

JS MoMo SDK is written in strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`) and builds dual **ESM** and **CommonJS** bundles targeting **Node.js 18+** with zero runtime dependencies.

## ESM (TypeScript & modern Node.js)

```ts
import {
  JsMomoSDK,
  JsMomoSDKConfig,
  ProductConfig,
  TransactionStatus,
  VERSION,
} from "js-momo-sdk";
```

## CommonJS (`require`)

```js
const {
  JsMomoSDK,
  JsMomoSDKConfig,
  ProductConfig,
  VERSION,
} = require("js-momo-sdk");
```

## Native async/await across every rail

Every network method in `js-momo-sdk` returns a typed `Promise<T>` backed by Node's native `fetch` API and `AbortController` timeouts. You can inject a custom `fetch` implementation into any client constructor (`JsMomoSDK`, `AirtelClient`, `WaveClient`, `MpesaClient`, `PaystackClient`, `FlutterwaveClient`, `OrangeMoneyClient`) for deterministic unit tests, custom proxies, or mTLS agents:

```ts
import { JsMomoSDK, ProductConfig } from "js-momo-sdk";

const client = new JsMomoSDK(
  {
    environment: "sandbox",
    collection: new ProductConfig({
      subscriptionKey: "sub",
      apiUser: "user",
      apiKey: "key",
    }),
  },
  {
    fetch: customFetchImplementation,
  },
);
```

## Package exports

| Entrypoint | File | Declarations |
| --- | --- | --- |
| ESM `import` | `dist/index.js` | `dist/index.d.ts` |
| CommonJS `require` | `dist/index.cjs` | `dist/index.d.cts` |
| CLI binary (`js-momo-sdk`) | `dist/cli.js` | — |
