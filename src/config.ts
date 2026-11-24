import { inspect } from "node:util";

import { MissingCredentialsError } from "./exceptions.js";
import type { TelemetryHook } from "./telemetry.js";
import {
  validateBaseUrl,
  validateCallbackUrl,
  validateEnvironmentName,
  validateHeaderValue,
  validateMaxRetries,
  validateRetryBackoff,
  validateTimeout,
} from "./utils.js";

// MTN MoMo environment string constants
export const SANDBOX = "sandbox";
export const MTN_GHANA = "mtnghana";
export const MTN_UGANDA = "mtnuganda";
export const MTN_CONGO = "mtncongo";
export const MTN_IVORY_COAST = "mtnivorycoast";
export const MTN_CAMEROON = "mtncameroon";
export const MTN_ZAMBIA = "mtnzambia";
export const MTN_BENIN = "mtnbenin";
export const MTN_SWAZILAND = "mtnswaziland";
export const MTN_GUINEA_CONAKRY = "mtnguineaconakry";
export const MTN_SOUTH_AFRICA = "mtnsouthafrica";
export const MTN_LIBERIA = "mtnliberia";
export const MTN_RWANDA = "mtnrwanda";

export const SANDBOX_BASE_URL = "https://sandbox.momodeveloper.mtn.com";
export const PRODUCTION_BASE_URL = "https://proxy.momoapi.mtn.com";

export interface ProductConfigOptions {
  subscriptionKey: string;
  apiUser: string;
  apiKey: string;
  callbackUrl?: string | null;
}

/** Immutable credentials and settings for a single MTN MoMo product. */
export class ProductConfig {
  public readonly subscriptionKey: string;
  public readonly apiUser: string;
  public readonly apiKey: string;
  public readonly callbackUrl: string | null;

  constructor(options: ProductConfigOptions) {
    for (const [fieldName, val] of [
      ["subscriptionKey", options.subscriptionKey],
      ["apiUser", options.apiUser],
      ["apiKey", options.apiKey],
    ] as const) {
      if (typeof val !== "string" || !val.trim()) {
        throw new RangeError(`${fieldName} must be a non-empty string`);
      }
      validateHeaderValue(val, { fieldName });
    }
    if (options.apiUser.includes(":")) {
      throw new RangeError("apiUser must not contain ':'");
    }
    if (options.callbackUrl !== undefined && options.callbackUrl !== null) {
      validateCallbackUrl(options.callbackUrl);
    }

    this.subscriptionKey = options.subscriptionKey;
    this.apiUser = options.apiUser;
    this.apiKey = options.apiKey;
    this.callbackUrl = options.callbackUrl ?? null;
    Object.freeze(this);
  }

  public toString(): string {
    return "ProductConfig(apiUser=<redacted>, apiKey=<redacted>, subscriptionKey=<redacted>)";
  }

  public toJSON(): Record<string, string | null> {
    return {
      apiUser: "<redacted>",
      apiKey: "<redacted>",
      subscriptionKey: "<redacted>",
      callbackUrl: this.callbackUrl,
    };
  }

  public [inspect.custom](): string {
    return this.toString();
  }
}

export interface JsMomoSDKConfigOptions {
  environment?: string;
  baseUrl?: string | null;
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  collection?: ProductConfig | ProductConfigOptions | null;
  disbursement?: ProductConfig | ProductConfigOptions | null;
  remittance?: ProductConfig | ProductConfigOptions | null;
  telemetry?: TelemetryHook | null;
}

function toProductConfig(
  cfg: ProductConfig | ProductConfigOptions | null | undefined,
): ProductConfig | null {
  if (!cfg) {
    return null;
  }
  return cfg instanceof ProductConfig ? cfg : new ProductConfig(cfg);
}

function envStripped(
  env: Record<string, string | undefined>,
  name: string,
): string | null {
  const raw = env[name];
  if (raw === undefined) {
    return null;
  }
  const stripped = raw.trim();
  return stripped || null;
}

function productFromEnv(
  env: Record<string, string | undefined>,
  prefix: string,
  productLabel: string,
): ProductConfig | null {
  const subscriptionKey = envStripped(env, `${prefix}_SUBSCRIPTION_KEY`);
  const apiUser = envStripped(env, `${prefix}_API_USER`);
  const apiKey = envStripped(env, `${prefix}_API_KEY`);
  const callbackUrl = envStripped(env, `${prefix}_CALLBACK_URL`);
  if (!subscriptionKey && !apiUser && !apiKey) {
    return null;
  }
  if (!subscriptionKey || !apiUser || !apiKey) {
    throw new MissingCredentialsError(
      `Incomplete ${productLabel} credentials in environment variables`,
    );
  }
  return new ProductConfig({
    subscriptionKey,
    apiUser,
    apiKey,
    callbackUrl,
  });
}

/** Immutable top-level configuration for a JsMomoSDK instance. */
export class JsMomoSDKConfig {
  public readonly environment: string;
  public readonly baseUrl: string;
  public readonly timeout: number;
  public readonly maxRetries: number;
  public readonly retryBackoff: number;
  public readonly collection: ProductConfig | null;
  public readonly disbursement: ProductConfig | null;
  public readonly remittance: ProductConfig | null;
  public readonly telemetry: TelemetryHook | null;

  constructor(options: JsMomoSDKConfigOptions = {}) {
    const environment = options.environment ?? SANDBOX;
    validateEnvironmentName(environment);
    const allowLocalhost = environment === SANDBOX;

    const timeout = validateTimeout(options.timeout ?? 30.0);
    const maxRetries = validateMaxRetries(options.maxRetries ?? 0);
    const retryBackoff = validateRetryBackoff(options.retryBackoff ?? 0.5);

    let baseUrl: string;
    if (options.baseUrl === undefined || options.baseUrl === null) {
      baseUrl = environment === SANDBOX ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL;
    } else {
      baseUrl = validateBaseUrl(options.baseUrl, { allowLocalhost });
    }

    const collection = toProductConfig(options.collection);
    const disbursement = toProductConfig(options.disbursement);
    const remittance = toProductConfig(options.remittance);

    for (const productCfg of [collection, disbursement, remittance]) {
      if (productCfg && productCfg.callbackUrl !== null) {
        validateCallbackUrl(productCfg.callbackUrl, { allowLocalhost });
      }
    }

    this.environment = environment;
    this.baseUrl = baseUrl;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.retryBackoff = retryBackoff;
    this.collection = collection;
    this.disbursement = disbursement;
    this.remittance = remittance;
    this.telemetry = options.telemetry ?? null;
    Object.freeze(this);
  }

  /**
   * Create a JsMomoSDKConfig instance by reading `JS_MOMO_SDK_*` environment variables.
   */
  public static fromEnv(
    env: Record<string, string | undefined> = process.env,
  ): JsMomoSDKConfig {
    const environment = envStripped(env, "JS_MOMO_SDK_ENVIRONMENT") ?? SANDBOX;
    const baseUrl = envStripped(env, "JS_MOMO_SDK_BASE_URL");

    const timeoutStr = envStripped(env, "JS_MOMO_SDK_TIMEOUT");
    let timeout = 30.0;
    if (timeoutStr !== null) {
      const parsed = Number(timeoutStr);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new RangeError("JS_MOMO_SDK_TIMEOUT must be a positive finite number");
      }
      timeout = validateTimeout(parsed);
    }

    const retriesStr = envStripped(env, "JS_MOMO_SDK_MAX_RETRIES");
    let maxRetries = 0;
    if (retriesStr !== null) {
      if (!/^\d+$/.test(retriesStr)) {
        throw new RangeError("JS_MOMO_SDK_MAX_RETRIES must be a non-negative integer");
      }
      maxRetries = validateMaxRetries(Number(retriesStr));
    }

    const backoffStr = envStripped(env, "JS_MOMO_SDK_RETRY_BACKOFF");
    let retryBackoff = 0.5;
    if (backoffStr !== null) {
      const parsed = Number(backoffStr);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new RangeError(
          "JS_MOMO_SDK_RETRY_BACKOFF must be a positive finite number",
        );
      }
      retryBackoff = validateRetryBackoff(parsed);
    }

    const collection = productFromEnv(env, "JS_MOMO_SDK_COLLECTION", "collection");
    const disbursement = productFromEnv(
      env,
      "JS_MOMO_SDK_DISBURSEMENT",
      "disbursement",
    );
    const remittance = productFromEnv(env, "JS_MOMO_SDK_REMITTANCE", "remittance");

    return new JsMomoSDKConfig({
      environment,
      baseUrl,
      timeout,
      maxRetries,
      retryBackoff,
      collection,
      disbursement,
      remittance,
    });
  }
}
