import { createHmac } from "node:crypto";
import { inspect } from "node:util";

import { JsMomoSDKError } from "../exceptions.js";
import type { FetchLike } from "../http.js";
import { DEFAULT_MAX_RESPONSE_BYTES, HttpClient, parseJsonObject } from "../http.js";
import type { TelemetryHook } from "../telemetry.js";
import {
  encodePathSegment,
  generateReferenceId,
  normaliseMsisdn,
  validateAmount,
  validateBaseUrl,
  validateCallbackUrl,
  validateCurrency,
  validateHeaderValue,
  validateMaxRetries,
  validateRetryBackoff,
  validateTimeout,
} from "../utils.js";
import { verifyTimestampedHmacSignature } from "./_signatures.js";
import type {
  PaymentProvider,
  ProviderBalanceOptions,
  ProviderStatusOptions,
} from "./base.js";
import type { BalanceResult, DisbursementRequest, PaymentRequest } from "./models.js";
import {
  NormalizedStatus,
  PaymentResult,
  ProviderCapabilities,
  validateOperationKind,
} from "./models.js";

export const WAVE_BASE_URL = "https://api.wave.com";

const WAVE_CAPABILITIES = new ProviderCapabilities({
  providerId: "wave",
  supportsCollection: true,
  supportsDisbursement: true,
  supportsBalance: true,
  supportsWebhookHmac: true,
  currencies: ["XOF", "UGX", "GMD"],
});

const VALID_WAVE_ENVIRONMENTS = new Set(["sandbox", "production"]);
const WAVE_PROD_KEY_RE = /^wave_(?:[a-z]{2}_)?prod_/i;

export interface WaveConfigOptions {
  apiKey: string;
  environment?: "sandbox" | "production";
  webhookSecret?: string | null;
  signingSecret?: string | null;
  successUrl?: string | null;
  errorUrl?: string | null;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  telemetry?: TelemetryHook | null;
}

/** Credentials and settings for Wave Mobile Money API. */
export class WaveConfig {
  public readonly apiKey: string;
  public readonly environment: "sandbox" | "production";
  public readonly webhookSecret: string | null;
  public readonly signingSecret: string | null;
  public readonly successUrl: string | null;
  public readonly errorUrl: string | null;
  public readonly baseUrl: string;
  public readonly timeout: number;
  public readonly maxRetries: number;
  public readonly retryBackoff: number;
  public readonly telemetry: TelemetryHook | null;

  constructor(options: WaveConfigOptions) {
    if (typeof options.apiKey !== "string" || !options.apiKey.trim()) {
      throw new RangeError("apiKey must be a non-empty string");
    }
    this.apiKey = validateHeaderValue(options.apiKey, { fieldName: "apiKey" });
    const isLiveKey = WAVE_PROD_KEY_RE.test(this.apiKey);
    const env = options.environment ?? (isLiveKey ? "production" : "sandbox");
    if (!VALID_WAVE_ENVIRONMENTS.has(env)) {
      throw new RangeError("environment must be 'sandbox' or 'production'");
    }
    if (env === "sandbox" && isLiveKey) {
      throw new RangeError(
        "Wave production apiKey ('wave_*_prod_*') cannot be used with sandbox environment",
      );
    }
    const allowLocalhost = env === "sandbox";
    this.environment = env;
    if (options.webhookSecret !== undefined && options.webhookSecret !== null) {
      if (typeof options.webhookSecret !== "string" || !options.webhookSecret.trim()) {
        throw new RangeError("webhookSecret must not be blank");
      }
      this.webhookSecret = validateHeaderValue(options.webhookSecret, {
        fieldName: "webhookSecret",
      });
    } else {
      this.webhookSecret = null;
    }
    if (options.signingSecret !== undefined && options.signingSecret !== null) {
      if (typeof options.signingSecret !== "string" || !options.signingSecret.trim()) {
        throw new RangeError("signingSecret must not be blank");
      }
      this.signingSecret = validateHeaderValue(options.signingSecret, {
        fieldName: "signingSecret",
      });
    } else {
      this.signingSecret = null;
    }
    this.successUrl =
      options.successUrl !== undefined && options.successUrl !== null
        ? validateCallbackUrl(options.successUrl, { allowLocalhost })
        : null;
    this.errorUrl =
      options.errorUrl !== undefined && options.errorUrl !== null
        ? validateCallbackUrl(options.errorUrl, { allowLocalhost })
        : null;
    this.baseUrl = validateBaseUrl(options.baseUrl ?? WAVE_BASE_URL, {
      allowLocalhost,
    });
    this.timeout = validateTimeout(options.timeout ?? 30.0);
    this.maxRetries = validateMaxRetries(options.maxRetries ?? 0);
    this.retryBackoff = validateRetryBackoff(options.retryBackoff ?? 0.5);
    this.telemetry = options.telemetry ?? null;
    Object.freeze(this);
  }

  public toString(): string {
    return `WaveConfig(apiKey=<redacted>, webhookSecret=<redacted>, signingSecret=<redacted>, baseUrl=${JSON.stringify(this.baseUrl)}, timeout=${this.timeout})`;
  }

  public [inspect.custom](): string {
    return this.toString();
  }

  public toJSON(): Record<string, unknown> {
    return {
      apiKey: "<redacted>",
      webhookSecret: this.webhookSecret ? "<redacted>" : null,
      signingSecret: this.signingSecret ? "<redacted>" : null,
      baseUrl: this.baseUrl,
      timeout: this.timeout,
    };
  }
}

export interface WaveCheckoutSession {
  readonly id: string;
  readonly amount: string;
  readonly currency: string;
  readonly checkoutStatus: string;
  readonly paymentStatus: string;
  readonly waveLaunchUrl: string | null;
  readonly clientReference: string | null;
  readonly transactionId: string | null;
  readonly whenCompleted: string | null;
  readonly lastPaymentError: Record<string, unknown> | string | null;
}

export interface WavePayoutResponse {
  readonly id: string;
  readonly receiveAmount: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  readonly clientReference: string | null;
  readonly transactionId: string | null;
  readonly whenCompleted: string | null;
  readonly payoutError: Record<string, unknown> | string | null;
}

export interface WaveBalanceResponse {
  readonly amount: string;
  readonly currency: string;
}

function optStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function extractWaveError(
  err: Record<string, unknown> | string | null | undefined,
): string | null {
  if (err === null || err === undefined) return null;
  if (typeof err === "string") return err.trim() || null;
  if (typeof err === "object" && !Array.isArray(err)) {
    const code = err["code"];
    const msg = err["message"];
    if (code && msg) return `${String(code)}: ${String(msg)}`;
    if (msg) return String(msg);
    if (code) return String(code);
  }
  return null;
}

function mapWaveStatus(rawStatus: string): NormalizedStatus {
  const norm = rawStatus.trim().toLowerCase();
  if (norm === "succeeded" || norm === "complete" || norm === "completed") {
    return NormalizedStatus.SUCCEEDED;
  }
  if (norm === "expired") return NormalizedStatus.EXPIRED;
  if (norm === "reversed") return NormalizedStatus.REVERSED;
  if (norm === "cancelled" || norm === "canceled" || norm === "failed") {
    return NormalizedStatus.FAILED;
  }
  return NormalizedStatus.PENDING;
}

function mapWaveSessionStatus(session: WaveCheckoutSession): NormalizedStatus {
  const mapped = mapWaveStatus(session.paymentStatus);
  if (mapped === NormalizedStatus.SUCCEEDED || mapped === NormalizedStatus.REVERSED) {
    return mapped;
  }
  if (session.checkoutStatus.trim().toLowerCase() === "expired") {
    return NormalizedStatus.EXPIRED;
  }
  return mapped;
}

function parseWaveSession(
  raw: Record<string, unknown>,
  referenceId?: string | null,
): WaveCheckoutSession {
  const id = optStr(raw["id"]);
  const amount =
    typeof raw["amount"] === "number" ? String(raw["amount"]) : optStr(raw["amount"]);
  const currency = optStr(raw["currency"]);
  if (!id || amount === null || !currency) {
    throw new JsMomoSDKError(
      "API response did not match expected WaveCheckoutSession schema",
      { referenceId: referenceId ?? null, provider: "Wave" },
    );
  }
  const errVal = raw["last_payment_error"];
  return Object.freeze({
    id,
    amount,
    currency,
    checkoutStatus: optStr(raw["checkout_status"]) ?? "open",
    paymentStatus: optStr(raw["payment_status"]) ?? "processing",
    waveLaunchUrl: optStr(raw["wave_launch_url"]),
    clientReference: optStr(raw["client_reference"]),
    transactionId: optStr(raw["transaction_id"]),
    whenCompleted: optStr(raw["when_completed"]),
    lastPaymentError:
      typeof errVal === "string" ||
      (errVal && typeof errVal === "object" && !Array.isArray(errVal))
        ? (errVal as Record<string, unknown> | string)
        : null,
  });
}

function parseWavePayout(
  raw: Record<string, unknown>,
  referenceId?: string | null,
): WavePayoutResponse {
  const id = optStr(raw["id"]);
  const amtRaw = raw["receive_amount"] ?? raw["amount"];
  const receiveAmount = typeof amtRaw === "number" ? String(amtRaw) : optStr(amtRaw);
  const currency = optStr(raw["currency"]);
  if (!id || receiveAmount === null || !currency) {
    throw new JsMomoSDKError(
      "API response did not match expected WavePayoutResponse schema",
      { referenceId: referenceId ?? null, provider: "Wave" },
    );
  }
  const errVal = raw["payout_error"];
  return Object.freeze({
    id,
    receiveAmount,
    amount: receiveAmount,
    currency,
    status: optStr(raw["status"]) ?? "processing",
    clientReference: optStr(raw["client_reference"]),
    transactionId: optStr(raw["transaction_id"]),
    whenCompleted: optStr(raw["when_completed"]),
    payoutError:
      typeof errVal === "string" ||
      (errVal && typeof errVal === "object" && !Array.isArray(errVal))
        ? (errVal as Record<string, unknown> | string)
        : null,
  });
}

function parseWaveBalance(raw: Record<string, unknown>): WaveBalanceResponse {
  const amount =
    typeof raw["amount"] === "number" ? String(raw["amount"]) : optStr(raw["amount"]);
  const currency = optStr(raw["currency"]);
  if (amount === null || !currency) {
    throw new JsMomoSDKError(
      "API response did not match expected WaveBalanceResponse schema",
      { provider: "Wave" },
    );
  }
  return Object.freeze({ amount, currency });
}

export interface WaveClientOptions {
  fetch?: FetchLike;
  maxResponseBytes?: number;
  telemetry?: TelemetryHook | null;
}

export interface WaveCheckoutParams {
  amount: string;
  currency: string;
  clientReference?: string | null;
  restrictPayerMobile?: string | null;
  successUrl?: string | null;
  errorUrl?: string | null;
}

export interface WavePayoutParams {
  amount: string;
  currency: string;
  mobile: string;
  clientReference?: string | null;
  name?: string | null;
  paymentReason?: string | null;
  nationalId?: string | null;
  aggregatedMerchantId?: string | null;
}

/** Wave Mobile Money client for Checkout Sessions, Payouts, Balances, and Webhooks. */
export class WaveClient {
  public readonly config: WaveConfig;
  private readonly http: HttpClient;

  constructor(config: WaveConfig | WaveConfigOptions, options: WaveClientOptions = {}) {
    this.config = config instanceof WaveConfig ? config : new WaveConfig(config);
    this.http = new HttpClient({
      baseUrl: this.config.baseUrl,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      retryBackoff: this.config.retryBackoff,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      fetch: options.fetch,
      telemetry:
        options.telemetry !== undefined ? options.telemetry : this.config.telemetry,
      providerName: "Wave",
      allowLocalhost: this.config.environment === "sandbox",
    });
  }

  private headers(
    idempotencyKey?: string | null,
    signedJsonBody?: string | null,
  ): Record<string, string> {
    const out: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
    };
    if (idempotencyKey) {
      validateHeaderValue(idempotencyKey, { fieldName: "clientReference" });
      out["Idempotency-Key"] = idempotencyKey;
    }
    if (
      signedJsonBody !== undefined &&
      signedJsonBody !== null &&
      this.config.signingSecret
    ) {
      const ts = Math.floor(Date.now() / 1000);
      const mac = createHmac("sha256", Buffer.from(this.config.signingSecret, "utf8"))
        .update(`${ts}${signedJsonBody}`)
        .digest("hex");
      out["Wave-Signature"] = `t=${ts},v1=${mac}`;
    }
    return out;
  }

  public async createCheckoutSession(
    params: WaveCheckoutParams,
  ): Promise<WaveCheckoutSession> {
    const currency = validateCurrency(params.currency);
    const amount = validateAmount(params.amount, { currency });
    const allowLocalhost = this.config.environment === "sandbox";
    if (params.successUrl !== undefined && params.successUrl !== null) {
      validateCallbackUrl(params.successUrl, { allowLocalhost });
    }
    if (params.errorUrl !== undefined && params.errorUrl !== null) {
      validateCallbackUrl(params.errorUrl, { allowLocalhost });
    }
    const resolvedSuccess = params.successUrl ?? this.config.successUrl;
    const resolvedError = params.errorUrl ?? this.config.errorUrl;
    if (!resolvedSuccess || !resolvedError) {
      throw new RangeError(
        "successUrl and errorUrl are required for Wave checkout sessions",
      );
    }
    const ref = params.clientReference ?? generateReferenceId();
    const payload: Record<string, unknown> = {
      amount,
      currency,
      success_url: resolvedSuccess,
      error_url: resolvedError,
      client_reference: ref,
    };
    if (
      params.restrictPayerMobile !== undefined &&
      params.restrictPayerMobile !== null
    ) {
      payload["restrict_payer_mobile"] =
        `+${normaliseMsisdn(params.restrictPayerMobile)}`;
    }
    const response = await this.http.request("POST", "/v1/checkout/sessions", {
      headers: this.headers(ref),
      json: payload,
      idempotent: true,
      referenceId: ref,
    });
    return parseWaveSession(parseJsonObject(response, ref), ref);
  }

  public async getCheckoutSession(sessionId: string): Promise<WaveCheckoutSession> {
    const encoded = encodePathSegment(sessionId, "sessionId");
    const response = await this.http.request(
      "GET",
      `/v1/checkout/sessions/${encoded}`,
      {
        headers: this.headers(),
        referenceId: sessionId,
      },
    );
    return parseWaveSession(parseJsonObject(response, sessionId), sessionId);
  }

  public async refundCheckoutSession(sessionId: string): Promise<void> {
    const encoded = encodePathSegment(sessionId, "sessionId");
    await this.http.request("POST", `/v1/checkout/sessions/${encoded}/refund`, {
      headers: this.headers(),
      referenceId: sessionId,
    });
  }

  public async expireCheckoutSession(sessionId: string): Promise<void> {
    const encoded = encodePathSegment(sessionId, "sessionId");
    await this.http.request("POST", `/v1/checkout/sessions/${encoded}/expire`, {
      headers: this.headers(),
      referenceId: sessionId,
    });
  }

  public async searchCheckoutSessions(
    clientReference: string,
  ): Promise<WaveCheckoutSession[]> {
    if (typeof clientReference !== "string" || !clientReference.trim()) {
      throw new RangeError("clientReference must be a non-empty string");
    }
    const cleaned = clientReference.trim();
    const response = await this.http.request(
      "GET",
      `/v1/checkout/sessions/search?client_reference=${encodeURIComponent(cleaned)}`,
      {
        headers: this.headers(),
        referenceId: cleaned,
      },
    );
    const body = parseJsonObject(response, cleaned);
    const items = body["result"];
    if (!Array.isArray(items)) {
      throw new JsMomoSDKError(
        "API response did not match expected Wave checkout search schema",
        { referenceId: cleaned, provider: "Wave" },
      );
    }
    return items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new JsMomoSDKError(
          "API response did not match expected WaveCheckoutSession schema",
          { referenceId: cleaned, provider: "Wave" },
        );
      }
      return parseWaveSession(item as Record<string, unknown>, cleaned);
    });
  }

  public async createPayout(params: WavePayoutParams): Promise<WavePayoutResponse> {
    const currency = validateCurrency(params.currency);
    const amount = validateAmount(params.amount, { currency });
    const ref = params.clientReference ?? generateReferenceId();
    const payload: Record<string, unknown> = {
      receive_amount: amount,
      currency,
      mobile: `+${normaliseMsisdn(params.mobile)}`,
      client_reference: ref,
    };
    const optionalFields: Array<[string, string | null | undefined]> = [
      ["name", params.name],
      ["payment_reason", params.paymentReason],
      ["national_id", params.nationalId],
      ["aggregated_merchant_id", params.aggregatedMerchantId],
    ];
    for (const [key, val] of optionalFields) {
      if (val !== undefined && val !== null) {
        if (typeof val !== "string" || !val.trim()) {
          throw new RangeError(`${key} must not be blank`);
        }
        payload[key] = val.trim();
      }
    }
    const serialized = this.config.signingSecret ? JSON.stringify(payload) : null;
    const response = await this.http.request("POST", "/v1/payout", {
      headers: this.headers(ref, serialized),
      json: payload,
      idempotent: true,
      referenceId: ref,
    });
    return parseWavePayout(parseJsonObject(response, ref), ref);
  }

  public async getPayout(payoutId: string): Promise<WavePayoutResponse> {
    const encoded = encodePathSegment(payoutId, "payoutId");
    const response = await this.http.request("GET", `/v1/payout/${encoded}`, {
      headers: this.headers(),
      referenceId: payoutId,
    });
    return parseWavePayout(parseJsonObject(response, payoutId), payoutId);
  }

  public async reversePayout(payoutId: string): Promise<void> {
    const encoded = encodePathSegment(payoutId, "payoutId");
    await this.http.request("POST", `/v1/payout/${encoded}/reverse`, {
      headers: this.headers(),
      referenceId: payoutId,
    });
  }

  public async searchPayouts(clientReference: string): Promise<WavePayoutResponse[]> {
    if (typeof clientReference !== "string" || !clientReference.trim()) {
      throw new RangeError("clientReference must be a non-empty string");
    }
    const cleaned = clientReference.trim();
    const response = await this.http.request(
      "GET",
      `/v1/payouts/search?client_reference=${encodeURIComponent(cleaned)}`,
      {
        headers: this.headers(),
        referenceId: cleaned,
      },
    );
    const body = parseJsonObject(response, cleaned);
    const items = body["result"];
    if (!Array.isArray(items)) {
      throw new JsMomoSDKError(
        "API response did not match expected Wave payout search schema",
        { referenceId: cleaned, provider: "Wave" },
      );
    }
    return items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new JsMomoSDKError(
          "API response did not match expected WavePayoutResponse schema",
          { referenceId: cleaned, provider: "Wave" },
        );
      }
      return parseWavePayout(item as Record<string, unknown>, cleaned);
    });
  }

  public async getBalance(): Promise<WaveBalanceResponse> {
    const response = await this.http.request("GET", "/v1/balance", {
      headers: this.headers(),
    });
    return parseWaveBalance(parseJsonObject(response));
  }

  public verifyWebhook(
    payload: Uint8Array | Buffer | string,
    signatureHeader: string,
    options: {
      toleranceSeconds?: number;
      maxFutureSkewSeconds?: number;
      now?: number;
    } = {},
  ): void {
    verifyTimestampedHmacSignature(
      payload,
      signatureHeader,
      this.config.webhookSecret ?? "",
      {
        toleranceSeconds: options.toleranceSeconds ?? 300,
        maxFutureSkewSeconds: options.maxFutureSkewSeconds ?? 30,
        timestampSeparator: "",
        now: options.now,
      },
    );
  }

  public close(): void {
    this.http.close();
  }
}

/** Unified provider adapter for Wave. */
export class WaveProvider implements PaymentProvider {
  public readonly name = "wave";
  public readonly capabilities = WAVE_CAPABILITIES;
  private readonly client: WaveClient;

  constructor(client: WaveClient) {
    this.client = client;
  }

  public async collect(request: PaymentRequest): Promise<PaymentResult> {
    const session = await this.client.createCheckoutSession({
      amount: request.amount,
      currency: request.currency,
      clientReference: request.referenceId ?? (request.externalId || null),
      restrictPayerMobile: request.payerMsisdn,
      successUrl: request.callbackUrl,
      errorUrl: this.client.config.errorUrl ? null : request.callbackUrl,
    });
    return new PaymentResult({
      provider: this.name,
      referenceId: session.id,
      status: mapWaveSessionStatus(session),
      amount: session.amount,
      currency: session.currency,
      externalId: session.clientReference,
      providerTransactionId: session.transactionId,
      checkoutUrl: session.waveLaunchUrl,
      reason: extractWaveError(session.lastPaymentError),
      raw: { ...session },
    });
  }

  public async disburse(request: DisbursementRequest): Promise<PaymentResult> {
    const payout = await this.client.createPayout({
      amount: request.amount,
      currency: request.currency,
      mobile: request.payeeMsisdn,
      clientReference: request.referenceId ?? (request.externalId || null),
      paymentReason: request.payerMessage || null,
    });
    return new PaymentResult({
      provider: this.name,
      referenceId: payout.id,
      status: mapWaveStatus(payout.status),
      amount: payout.receiveAmount,
      currency: payout.currency,
      externalId: payout.clientReference,
      providerTransactionId: payout.transactionId,
      reason: extractWaveError(payout.payoutError),
      raw: { ...payout },
    });
  }

  public async getStatus(
    referenceId: string,
    options: ProviderStatusOptions = {},
  ): Promise<PaymentResult> {
    const kind = validateOperationKind(options.kind ?? "collection");
    if (kind === "disbursement") {
      const payout = await this.client.getPayout(referenceId);
      return new PaymentResult({
        provider: this.name,
        referenceId: payout.id,
        status: mapWaveStatus(payout.status),
        amount: payout.receiveAmount,
        currency: payout.currency,
        externalId: payout.clientReference,
        providerTransactionId: payout.transactionId,
        reason: extractWaveError(payout.payoutError),
        raw: { ...payout },
      });
    }
    const session = await this.client.getCheckoutSession(referenceId);
    return new PaymentResult({
      provider: this.name,
      referenceId: session.id,
      status: mapWaveSessionStatus(session),
      amount: session.amount,
      currency: session.currency,
      externalId: session.clientReference,
      providerTransactionId: session.transactionId,
      checkoutUrl: session.waveLaunchUrl,
      reason: extractWaveError(session.lastPaymentError),
      raw: { ...session },
    });
  }

  public async getBalance(
    options: ProviderBalanceOptions = {},
  ): Promise<BalanceResult> {
    validateOperationKind(options.kind ?? "collection");
    const balance = await this.client.getBalance();
    return {
      provider: this.name,
      availableBalance: balance.amount,
      currency: balance.currency,
      raw: { ...balance },
    };
  }

  public close(): void {
    this.client.close();
  }
}
