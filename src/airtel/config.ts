import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import { inspect } from "node:util";

import type { TelemetryHook } from "../telemetry.js";
import {
  validateBaseUrl,
  validateCountryCode,
  validateCurrency,
  validateEnvironmentName,
  validateHeaderValue,
  validateMaxRetries,
  validateRetryBackoff,
  validateTimeout,
} from "../utils.js";

export const AIRTEL_SANDBOX_BASE_URL = "https://openapiuat.airtel.africa";
export const AIRTEL_PRODUCTION_BASE_URL = "https://openapi.airtel.africa";
const VALID_AIRTEL_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "sandbox",
  "production",
]);
const STRICT_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function validateEncryptedPin(pin: string): void {
  const stripped = pin.trim();
  if (/^\d+$/.test(stripped)) {
    throw new RangeError(
      "Airtel production disbursements require an RSA-encrypted Base64 PIN; use encryptAirtelPin() rather than a plaintext numeric PIN",
    );
  }
  if (!stripped || stripped.length % 4 !== 0 || !STRICT_BASE64_RE.test(stripped)) {
    throw new RangeError(
      "Airtel production disbursements require a valid Base64-encoded RSA PIN",
    );
  }
  const decoded = Buffer.from(stripped, "base64");
  if (decoded.byteLength < 64) {
    throw new RangeError(
      "Airtel production PIN ciphertext is too short; expected RSA-encrypted Base64 PIN",
    );
  }
}

/**
 * Encrypt an Airtel disbursement PIN with Airtel's RSA public key (PKCS#1 v1.5)
 * using Node's built-in `node:crypto` module.
 */
export function encryptAirtelPin(pin: string, publicKeyPem: string): string {
  if (typeof pin !== "string" || !pin.trim()) {
    throw new RangeError("pin must be a non-empty string");
  }
  validateHeaderValue(pin, { fieldName: "pin" });
  if (typeof publicKeyPem !== "string" || !publicKeyPem.trim()) {
    throw new RangeError("publicKeyPem must be a non-empty PEM string");
  }

  const keyObj = createPublicKey(publicKeyPem);
  if (keyObj.asymmetricKeyType !== "rsa") {
    throw new TypeError("publicKeyPem must contain an RSA public key");
  }
  const ciphertext = publicEncrypt(
    {
      key: keyObj,
      padding: constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(pin, "utf8"),
  );
  return ciphertext.toString("base64");
}

export interface AirtelConfigOptions {
  clientId: string;
  clientSecret: string;
  country: string;
  currency: string;
  pin?: string | null;
  environment?: "sandbox" | "production" | string;
  baseUrl?: string | null;
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  telemetry?: TelemetryHook | null;
}

/** Immutable credentials and settings for Airtel Money Open API. */
export class AirtelConfig {
  public readonly clientId: string;
  public readonly clientSecret: string;
  public readonly country: string;
  public readonly currency: string;
  public readonly pin: string | null;
  public readonly environment: string;
  public readonly baseUrl: string;
  public readonly timeout: number;
  public readonly maxRetries: number;
  public readonly retryBackoff: number;
  public readonly telemetry: TelemetryHook | null;

  constructor(options: AirtelConfigOptions) {
    if (typeof options.clientId !== "string" || !options.clientId.trim()) {
      throw new RangeError("clientId must be a non-empty string");
    }
    if (typeof options.clientSecret !== "string" || !options.clientSecret.trim()) {
      throw new RangeError("clientSecret must be a non-empty string");
    }
    validateHeaderValue(options.clientId, { fieldName: "clientId" });
    validateHeaderValue(options.clientSecret, { fieldName: "clientSecret" });

    const country = validateCountryCode(options.country);
    const currency = validateCurrency(options.currency);
    const environment = options.environment ?? "sandbox";
    validateEnvironmentName(environment);
    if (!VALID_AIRTEL_ENVIRONMENTS.has(environment)) {
      throw new RangeError("environment must be 'sandbox' or 'production'");
    }

    let pin: string | null = null;
    if (options.pin !== undefined && options.pin !== null) {
      if (typeof options.pin !== "string" || !options.pin.trim()) {
        throw new RangeError("pin must be a non-empty string");
      }
      validateHeaderValue(options.pin, { fieldName: "pin" });
      if (environment === "production") {
        validateEncryptedPin(options.pin);
      }
      pin = options.pin;
    }

    const timeout = validateTimeout(options.timeout ?? 30.0);
    const maxRetries = validateMaxRetries(options.maxRetries ?? 0);
    const retryBackoff = validateRetryBackoff(options.retryBackoff ?? 0.5);
    const baseUrl =
      options.baseUrl !== undefined && options.baseUrl !== null
        ? validateBaseUrl(options.baseUrl, {
            allowLocalhost: environment === "sandbox",
          })
        : environment === "sandbox"
          ? AIRTEL_SANDBOX_BASE_URL
          : AIRTEL_PRODUCTION_BASE_URL;

    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.country = country;
    this.currency = currency;
    this.pin = pin;
    this.environment = environment;
    this.baseUrl = baseUrl;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.retryBackoff = retryBackoff;
    this.telemetry = options.telemetry ?? null;
    Object.freeze(this);
  }

  public toString(): string {
    return `AirtelConfig(clientId=${JSON.stringify(this.clientId)}, clientSecret=<redacted>, country=${JSON.stringify(this.country)}, currency=${JSON.stringify(this.currency)}, pin=<redacted>, environment=${JSON.stringify(this.environment)}, baseUrl=${JSON.stringify(this.baseUrl)}, timeout=${this.timeout})`;
  }

  public toJSON(): Record<string, unknown> {
    return {
      clientId: this.clientId,
      clientSecret: "<redacted>",
      country: this.country,
      currency: this.currency,
      pin: "<redacted>",
      environment: this.environment,
      baseUrl: this.baseUrl,
      timeout: this.timeout,
    };
  }

  public [inspect.custom](): string {
    return this.toString();
  }
}
