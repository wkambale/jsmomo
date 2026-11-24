import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import {
  JsMomoSDKConfig,
  MTN_GHANA,
  MTN_RWANDA,
  MTN_UGANDA,
  PRODUCTION_BASE_URL,
  ProductConfig,
  SANDBOX,
  SANDBOX_BASE_URL,
} from "../../src/config.js";
import { JsMomoSDKError, MissingCredentialsError } from "../../src/exceptions.js";

describe("config", () => {
  it("constructs frozen ProductConfig and redacts secrets in string/JSON/inspect", () => {
    const prod = new ProductConfig({
      subscriptionKey: "sub-secret-key",
      apiUser: "550e8400-e29b-41d4-a716-446655440000",
      apiKey: "api-secret-key",
      callbackUrl: "https://merchant.example.com/hook",
    });
    expect(Object.isFrozen(prod)).toBe(true);
    for (const rendered of [String(prod), inspect(prod), JSON.stringify(prod)]) {
      expect(rendered).not.toContain("sub-secret-key");
      expect(rendered).not.toContain("api-secret-key");
      expect(rendered).not.toContain("550e8400");
      expect(rendered).toContain("<redacted>");
    }
  });

  it("rejects empty credentials, colons in apiUser, and non-ASCII headers", () => {
    expect(
      () =>
        new ProductConfig({
          subscriptionKey: " ",
          apiUser: "usr",
          apiKey: "key",
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new ProductConfig({
          subscriptionKey: "sub",
          apiUser: "user:colon",
          apiKey: "key",
        }),
    ).toThrow("':'");
    expect(
      () =>
        new ProductConfig({
          subscriptionKey: "sub\u0100key",
          apiUser: "user",
          apiKey: "key",
        }),
    ).toThrow("printable ASCII");
  });

  it("resolves sandbox vs production base URLs and rejects localhost in production", () => {
    const sandbox = new JsMomoSDKConfig();
    expect(sandbox.environment).toBe(SANDBOX);
    expect(sandbox.baseUrl).toBe(SANDBOX_BASE_URL);
    expect(Object.isFrozen(sandbox)).toBe(true);

    const prod = new JsMomoSDKConfig({ environment: MTN_UGANDA });
    expect(prod.baseUrl).toBe(PRODUCTION_BASE_URL);
    expect(MTN_RWANDA).toBe("mtnrwanda");

    expect(
      () =>
        new JsMomoSDKConfig({
          environment: MTN_GHANA,
          baseUrl: "http://127.0.0.1:8000",
        }),
    ).toThrow(JsMomoSDKError);

    expect(
      () =>
        new JsMomoSDKConfig({
          environment: MTN_GHANA,
          collection: {
            subscriptionKey: "sub",
            apiUser: "user",
            apiKey: "key",
            callbackUrl: "http://localhost:3000/cb",
          },
        }),
    ).toThrow(RangeError);
  });

  it("loads configuration from JS_MOMO_SDK_* environment variables and validates numeric fields", () => {
    const cfg = JsMomoSDKConfig.fromEnv({
      JS_MOMO_SDK_ENVIRONMENT: "mtnuganda",
      JS_MOMO_SDK_TIMEOUT: "15.5",
      JS_MOMO_SDK_MAX_RETRIES: "2",
      JS_MOMO_SDK_RETRY_BACKOFF: "0.25",
      JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY: "sub-1",
      JS_MOMO_SDK_COLLECTION_API_USER: "usr-1",
      JS_MOMO_SDK_COLLECTION_API_KEY: "key-1",
      JS_MOMO_SDK_COLLECTION_CALLBACK_URL: "https://merchant.example.com/cb",
    });
    expect(cfg.environment).toBe("mtnuganda");
    expect(cfg.timeout).toBe(15.5);
    expect(cfg.maxRetries).toBe(2);
    expect(cfg.retryBackoff).toBe(0.25);
    expect(cfg.collection?.subscriptionKey).toBe("sub-1");
    expect(cfg.disbursement).toBeNull();
    expect(cfg.remittance).toBeNull();

    // Blank strings fall back cleanly
    const defaults = JsMomoSDKConfig.fromEnv({
      JS_MOMO_SDK_ENVIRONMENT: "  ",
      JS_MOMO_SDK_BASE_URL: "",
    });
    expect(defaults.environment).toBe(SANDBOX);
    expect(defaults.baseUrl).toBe(SANDBOX_BASE_URL);

    // Partial credentials raise MissingCredentialsError
    expect(() =>
      JsMomoSDKConfig.fromEnv({
        JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY: "only-sub",
      }),
    ).toThrow(MissingCredentialsError);

    // Invalid numeric vars raise RangeError
    expect(() => JsMomoSDKConfig.fromEnv({ JS_MOMO_SDK_TIMEOUT: "abc" })).toThrow(
      RangeError,
    );
    expect(() => JsMomoSDKConfig.fromEnv({ JS_MOMO_SDK_MAX_RETRIES: "-1" })).toThrow(
      RangeError,
    );
    expect(() => JsMomoSDKConfig.fromEnv({ JS_MOMO_SDK_RETRY_BACKOFF: "0" })).toThrow(
      RangeError,
    );
  });
});
