# Authentication

JS MoMo SDK manages OAuth 2.0 tokens automatically in memory per product or provider, with single-flight locking, monotonic expiry margins, and conditional 401 refresh.

## Per-product MTN MoMo configuration

MTN MoMo issues separate `subscriptionKey`, `apiUser`, and `apiKey` credentials for **Collection**, **Disbursement**, and **Remittance**.

```ts
import {
  JsMomoSDK,
  JsMomoSDKConfig,
  MTN_UGANDA,
  ProductConfig,
} from "js-momo-sdk";

const config = new JsMomoSDKConfig({
  environment: MTN_UGANDA,
  timeout: 30,
  maxRetries: 2,
  collection: new ProductConfig({
    subscriptionKey: process.env.JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY!,
    apiUser: process.env.JS_MOMO_SDK_COLLECTION_API_USER!,
    apiKey: process.env.JS_MOMO_SDK_COLLECTION_API_KEY!,
    callbackUrl: "https://api.example.com/webhooks/mtn/collection",
  }),
  disbursement: new ProductConfig({
    subscriptionKey: process.env.JS_MOMO_SDK_DISBURSEMENT_SUBSCRIPTION_KEY!,
    apiUser: process.env.JS_MOMO_SDK_DISBURSEMENT_API_USER!,
    apiKey: process.env.JS_MOMO_SDK_DISBURSEMENT_API_KEY!,
  }),
});

const client = new JsMomoSDK(config);
```

Accessing a product whose credentials were not provided raises `MissingCredentialsError` at call time rather than construction time.

## Loading configuration from environment variables

Use `JsMomoSDKConfig.fromEnv()` to hydrate configuration from `JS_MOMO_SDK_*` variables:

| Environment variable | Description |
| --- | --- |
| `JS_MOMO_SDK_ENVIRONMENT` | Target environment (`sandbox`, `mtnuganda`, `mtnghana`, etc.) |
| `JS_MOMO_SDK_BASE_URL` | Optional API base URL override |
| `JS_MOMO_SDK_TIMEOUT` | Request timeout in seconds (default `30`) |
| `JS_MOMO_SDK_MAX_RETRIES` | Max idempotent retries (default `0`) |
| `JS_MOMO_SDK_RETRY_BACKOFF` | Retry exponential backoff base in seconds (default `0.5`) |
| `JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY` | Collection `Ocp-Apim-Subscription-Key` |
| `JS_MOMO_SDK_COLLECTION_API_USER` | Collection API User UUID |
| `JS_MOMO_SDK_COLLECTION_API_KEY` | Collection API Key |
| `JS_MOMO_SDK_COLLECTION_CALLBACK_URL` | Optional HTTPS callback URL |
| `JS_MOMO_SDK_DISBURSEMENT_*` | Disbursement credentials (`SUBSCRIPTION_KEY`, `API_USER`, `API_KEY`, `CALLBACK_URL`) |
| `JS_MOMO_SDK_REMITTANCE_*` | Remittance credentials (`SUBSCRIPTION_KEY`, `API_USER`, `API_KEY`, `CALLBACK_URL`) |

```ts
import { JsMomoSDK, JsMomoSDKConfig } from "js-momo-sdk";

const config = JsMomoSDKConfig.fromEnv();
const client = new JsMomoSDK(config);
```

## Supported MTN environments

Exported constants from `js-momo-sdk`:

- `SANDBOX` (`"sandbox"`)
- `SANDBOX_BASE_URL` (`"https://sandbox.momodeveloper.mtn.com"`)
- `PRODUCTION_BASE_URL` (`"https://proxy.momoapi.mtn.com"`)
- `ONE_API_PRODUCTION_BASE_URL` (`"https://momoapi.momo.africa"`)
- `MTN_UGANDA` (`"mtnuganda"`)
- `MTN_GHANA` (`"mtnghana"`)
- `MTN_CONGO` (`"mtncongo"`)
- `MTN_IVORY_COAST` (`"mtnivorycoast"`)
- `MTN_CAMEROON` (`"mtncameroon"`)
- `MTN_ZAMBIA` (`"mtnzambia"`)
- `MTN_BENIN` (`"mtnbenin"`)
- `MTN_SWAZILAND` (`"mtnswaziland"`)
- `MTN_GUINEA_CONAKRY` (`"mtnguineaconakry"`)
- `MTN_SOUTH_AFRICA` (`"mtnsouthafrica"`)
- `MTN_LIBERIA` (`"mtnliberia"`)
- `MTN_RWANDA` (`"mtnrwanda"`)

## Secret redaction

All config objects (`ProductConfig`, `JsMomoSDKConfig`, `AirtelConfig`, `WaveConfig`, `MpesaConfig`, `PaystackConfig`, `FlutterwaveConfig`, `OrangeMoneyConfig`) and token models implement custom `toString()`, `toJSON()`, and `util.inspect.custom` redaction so secrets never appear in logs, serialized JSON, or console output.
