# Sandbox provisioning

Before calling MTN MoMo Sandbox endpoints, you must create a sandbox **API User** (a UUID v4) and generate its **API Key** using your product's `Ocp-Apim-Subscription-Key`.

## Programmatic provisioning

```ts
import { JsMomoSDK, JsMomoSDKConfig } from "js-momo-sdk";

const client = new JsMomoSDK(new JsMomoSDKConfig({ environment: "sandbox" }));

try {
  const provisioner = client.createSandboxProvisioner(
    process.env.JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY!,
  );

  // One-step provision (creates user + generates key)
  const { apiUser, apiKey } = await provisioner.provision({
    callbackHost: "https://example.com",
  });
  console.log("API User:", apiUser);
  console.log("API Key:", apiKey);

  // Inspect existing API user
  const userInfo = await provisioner.getApiUser(apiUser);
  console.log(userInfo.providerCallbackHost, userInfo.targetEnvironment);
} finally {
  client.close();
}
```

## CLI provisioning

Save credentials directly to a mode-`0600` file instead of printing raw secrets to stdout:

```bash
export JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY="your-sandbox-subscription-key"
npx js-momo-sdk sandbox provision \
  --callback-host "example.com" \
  --output-file ./sandbox-creds.json
```

Or redact the `api_key` in terminal output:

```bash
npx js-momo-sdk sandbox provision --callback-host "example.com" --redact-secret
```
