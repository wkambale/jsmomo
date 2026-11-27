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
  validateEmailAddress,
  validateHeaderValue,
  validateMaxRetries,
  validateRetryBackoff,
  validateTimeout,
} from "../utils.js";
import { verifyConstantTimeToken } from "./_signatures.js";
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

export const FLUTTERWAVE_BASE_URL = "https://api.flutterwave.com";

const FLUTTERWAVE_CAPABILITIES = new ProviderCapabilities({
  providerId: "flutterwave",
  supportsCollection: true,
  supportsDisbursement: true,
  supportsBalance: true,
  supportsWebhookHmac: false,
  currencies: ["NGN", "GHS", "KES", "UGX", "RWF", "TZS", "ZMW", "XOF", "XAF", "USD"],
});

const VALID_FLUTTERWAVE_ENVIRONMENTS = new Set(["sandbox", "production"]);

export interface FlutterwaveConfigOptions {
  secretKey: string;
  environment?: "sandbox" | "production";
  webhookHash?: string | null;
  redirectUrl?: string | null;
  defaultCustomerEmail?: string | null;
  defaultAccountBank?: string | null;
  defaultCurrency?: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  telemetry?: TelemetryHook | null;
}

/** Credentials and settings for Flutterwave v3 API. */
export class FlutterwaveConfig {
  public readonly secretKey: string;
  public readonly environment: "sandbox" | "production";
  public readonly webhookHash: string | null;
  public readonly redirectUrl: string | null;
  public readonly defaultCustomerEmail: string | null;
  public readonly defaultAccountBank: string | null;
  public readonly defaultCurrency: string;
  public readonly baseUrl: string;
  public readonly timeout: number;
  public readonly maxRetries: number;
  public readonly retryBackoff: number;
  public readonly telemetry: TelemetryHook | null;

  constructor(options: FlutterwaveConfigOptions) {
    if (typeof options.secretKey !== "string" || !options.secretKey.trim()) {
      throw new RangeError("secretKey must be a non-empty string");
    }
    this.secretKey = validateHeaderValue(options.secretKey, {
      fieldName: "secretKey",
    });
    const isLiveKey =
      this.secretKey.startsWith("FLWSECK-") &&
      !this.secretKey.startsWith("FLWSECK_TEST");
    const env = options.environment ?? (isLiveKey ? "production" : "sandbox");
    if (!VALID_FLUTTERWAVE_ENVIRONMENTS.has(env)) {
      throw new RangeError("environment must be 'sandbox' or 'production'");
    }
    if (env === "sandbox" && isLiveKey) {
      throw new RangeError(
        "Flutterwave live secretKey ('FLWSECK-*') cannot be used with sandbox environment",
      );
    }
    const allowLocalhost = env === "sandbox";
    this.environment = env;
    if (options.webhookHash !== undefined && options.webhookHash !== null) {
      if (typeof options.webhookHash !== "string" || !options.webhookHash.trim()) {
        throw new RangeError("webhookHash must not be blank");
      }
      this.webhookHash = validateHeaderValue(options.webhookHash, {
        fieldName: "webhookHash",
      });
    } else {
      this.webhookHash = null;
    }
    this.redirectUrl =
      options.redirectUrl !== undefined && options.redirectUrl !== null
        ? validateCallbackUrl(options.redirectUrl, { allowLocalhost })
        : null;
    this.defaultCustomerEmail =
      options.defaultCustomerEmail !== undefined &&
      options.defaultCustomerEmail !== null
        ? validateEmailAddress(options.defaultCustomerEmail)
        : null;
    if (
      options.defaultAccountBank !== undefined &&
      options.defaultAccountBank !== null
    ) {
      if (
        typeof options.defaultAccountBank !== "string" ||
        !options.defaultAccountBank.trim()
      ) {
        throw new RangeError("defaultAccountBank must not be blank");
      }
      this.defaultAccountBank = validateHeaderValue(options.defaultAccountBank.trim(), {
        fieldName: "defaultAccountBank",
      });
    } else {
      this.defaultAccountBank = null;
    }
    this.defaultCurrency = validateCurrency(options.defaultCurrency ?? "NGN");
    this.baseUrl = validateBaseUrl(options.baseUrl ?? FLUTTERWAVE_BASE_URL, {
      allowLocalhost,
    });
    this.timeout = validateTimeout(options.timeout ?? 30.0);
    this.maxRetries = validateMaxRetries(options.maxRetries ?? 0);
    this.retryBackoff = validateRetryBackoff(options.retryBackoff ?? 0.5);
    this.telemetry = options.telemetry ?? null;
    Object.freeze(this);
  }

  public toString(): string {
    return `FlutterwaveConfig(secretKey=<redacted>, webhookHash=<redacted>, baseUrl=${JSON.stringify(this.baseUrl)}, timeout=${this.timeout})`;
  }

  public [inspect.custom](): string {
    return this.toString();
  }

  public toJSON(): Record<string, unknown> {
    return {
      secretKey: "<redacted>",
      webhookHash: this.webhookHash ? "<redacted>" : null,
      baseUrl: this.baseUrl,
      timeout: this.timeout,
    };
  }
}

function mapFlwStatus(rawStatus: string): NormalizedStatus {
  const norm = rawStatus.trim().toLowerCase();
  if (norm === "successful" || norm === "success" || norm === "completed") {
    return NormalizedStatus.SUCCEEDED;
  }
  if (norm === "reversed") return NormalizedStatus.REVERSED;
  if (norm === "failed" || norm === "cancelled" || norm === "canceled") {
    return NormalizedStatus.FAILED;
  }
  return NormalizedStatus.PENDING;
}

function validateFlwAccountNumber(accountNumber: string): string {
  if (typeof accountNumber !== "string" || !accountNumber.trim()) {
    throw new RangeError("accountNumber must be a non-empty string");
  }
  return validateHeaderValue(accountNumber.trim(), {
    fieldName: "accountNumber",
  });
}

function encodeFlwQueryRef(txRef: string): string {
  if (typeof txRef !== "string" || !txRef.trim()) {
    throw new RangeError("txRef must be a non-empty string");
  }
  const cleaned = validateHeaderValue(txRef.trim(), { fieldName: "txRef" });
  return encodeURIComponent(cleaned);
}

function unwrapFlwData(
  res: Record<string, unknown>,
  referenceId?: string | null,
): Record<string, unknown> {
  if (
    String(res["status"] ?? "")
      .trim()
      .toLowerCase() === "error"
  ) {
    const msg = res["message"];
    throw new JsMomoSDKError(
      typeof msg === "string" && msg ? msg : "Flutterwave request failed",
      {
        referenceId: referenceId ?? null,
        provider: "Flutterwave",
        responseBody: res,
      },
    );
  }
  const data = res["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new JsMomoSDKError(
      "Malformed Flutterwave response: expected object in 'data'",
      { referenceId: referenceId ?? null, provider: "Flutterwave" },
    );
  }
  return data as Record<string, unknown>;
}

function unwrapFlwBalance(res: Record<string, unknown>): [string, string] {
  const data = unwrapFlwData(res);
  const avail = data["available_balance"];
  const currency = data["currency"];
  if (
    avail === undefined ||
    avail === null ||
    typeof avail === "boolean" ||
    typeof currency !== "string" ||
    !currency
  ) {
    throw new JsMomoSDKError("Malformed Flutterwave balance response", {
      provider: "Flutterwave",
    });
  }
  return [String(avail), currency];
}

export interface FlutterwaveClientOptions {
  fetch?: FetchLike;
  maxResponseBytes?: number;
  telemetry?: TelemetryHook | null;
}

export interface FlutterwavePaymentParams {
  amount: string;
  currency: string;
  phoneNumber: string;
  email?: string | null;
  txRef?: string | null;
  redirectUrl?: string | null;
}

export interface FlutterwaveTransferParams {
  amount: string;
  currency: string;
  accountNumber: string;
  accountBank?: string | null;
  beneficiaryName?: string | null;
  debitCurrency?: string | null;
  meta?: Record<string, unknown> | readonly Record<string, unknown>[] | null;
  reference?: string | null;
  narration?: string;
  callbackUrl?: string | null;
}

/** Flutterwave v3 API client for payments, transfers, balances, and verif-hash webhooks. */
export class FlutterwaveClient {
  public readonly config: FlutterwaveConfig;
  private readonly http: HttpClient;

  constructor(
    config: FlutterwaveConfig | FlutterwaveConfigOptions,
    options: FlutterwaveClientOptions = {},
  ) {
    this.config =
      config instanceof FlutterwaveConfig ? config : new FlutterwaveConfig(config);
    this.http = new HttpClient({
      baseUrl: this.config.baseUrl,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      retryBackoff: this.config.retryBackoff,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      fetch: options.fetch,
      telemetry:
        options.telemetry !== undefined ? options.telemetry : this.config.telemetry,
      providerName: "Flutterwave",
      allowLocalhost: this.config.environment === "sandbox",
    });
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.secretKey}`,
      "Content-Type": "application/json",
    };
  }

  public async createPayment(
    params: FlutterwavePaymentParams,
  ): Promise<Record<string, unknown>> {
    const currency = validateCurrency(params.currency);
    const amount = validateAmount(params.amount, { currency });
    const resolvedEmail = params.email ?? this.config.defaultCustomerEmail;
    if (!resolvedEmail) {
      throw new RangeError(
        "email or FlutterwaveConfig.defaultCustomerEmail is required for Flutterwave payments",
      );
    }
    const email = validateEmailAddress(resolvedEmail);
    const allowLocalhost = this.config.environment === "sandbox";
    if (params.redirectUrl !== undefined && params.redirectUrl !== null) {
      validateCallbackUrl(params.redirectUrl, { allowLocalhost });
    }
    const resolvedRedirect = params.redirectUrl ?? this.config.redirectUrl;
    const ref = params.txRef ?? generateReferenceId();
    const cleanMsisdn = normaliseMsisdn(params.phoneNumber);
    const payload: Record<string, unknown> = {
      tx_ref: ref,
      amount,
      currency,
      customer: { email, phonenumber: cleanMsisdn },
    };
    if (resolvedRedirect !== null) {
      payload["redirect_url"] = resolvedRedirect;
    }
    const response = await this.http.request("POST", "/v3/payments", {
      headers: this.headers(),
      json: payload,
      referenceId: ref,
    });
    return parseJsonObject(response, ref);
  }

  public async verifyByReference(txRef: string): Promise<Record<string, unknown>> {
    const encoded = encodeFlwQueryRef(txRef);
    const response = await this.http.request(
      "GET",
      `/v3/transactions/verify_by_reference?tx_ref=${encoded}`,
      { headers: this.headers(), referenceId: txRef },
    );
    return parseJsonObject(response, txRef);
  }

  public async createTransfer(
    params: FlutterwaveTransferParams,
  ): Promise<Record<string, unknown>> {
    const currency = validateCurrency(params.currency);
    const amount = validateAmount(params.amount, { currency });
    const resolvedBank = params.accountBank ?? this.config.defaultAccountBank;
    if (!resolvedBank || !resolvedBank.trim()) {
      throw new RangeError(
        "accountBank or FlutterwaveConfig.defaultAccountBank is required for Flutterwave transfers",
      );
    }
    const accountBank = validateHeaderValue(resolvedBank.trim(), {
      fieldName: "accountBank",
    });
    const accountNumber = validateFlwAccountNumber(params.accountNumber);
    if (params.callbackUrl !== undefined && params.callbackUrl !== null) {
      validateCallbackUrl(params.callbackUrl, {
        allowLocalhost: this.config.environment === "sandbox",
      });
    }
    const ref = params.reference ?? generateReferenceId();
    const payload: Record<string, unknown> = {
      account_bank: accountBank,
      account_number: accountNumber,
      amount,
      currency,
      narration: params.narration ?? "Payout",
      reference: ref,
    };
    if (params.beneficiaryName !== undefined && params.beneficiaryName !== null) {
      if (
        typeof params.beneficiaryName !== "string" ||
        !params.beneficiaryName.trim()
      ) {
        throw new RangeError("beneficiaryName must not be blank");
      }
      payload["beneficiary_name"] = validateHeaderValue(params.beneficiaryName.trim(), {
        fieldName: "beneficiaryName",
      });
    }
    if (params.debitCurrency !== undefined && params.debitCurrency !== null) {
      payload["debit_currency"] = validateCurrency(params.debitCurrency);
    }
    if (params.meta !== undefined && params.meta !== null) {
      if (typeof params.meta !== "object") {
        throw new RangeError("meta must be an object or array of objects");
      }
      payload["meta"] = params.meta;
    }
    if (params.callbackUrl !== undefined && params.callbackUrl !== null) {
      payload["callback_url"] = params.callbackUrl;
    }
    const response = await this.http.request("POST", "/v3/transfers", {
      headers: this.headers(),
      json: payload,
      referenceId: ref,
    });
    return parseJsonObject(response, ref);
  }

  public async getTransfer(transferId: string): Promise<Record<string, unknown>> {
    const encoded = encodePathSegment(transferId, "transferId");
    const response = await this.http.request("GET", `/v3/transfers/${encoded}`, {
      headers: this.headers(),
      referenceId: transferId,
    });
    return parseJsonObject(response, transferId);
  }

  public async getBalance(currency?: string | null): Promise<Record<string, unknown>> {
    const iso = validateCurrency(currency ?? this.config.defaultCurrency);
    const response = await this.http.request("GET", `/v3/balances/${iso}`, {
      headers: this.headers(),
    });
    return parseJsonObject(response);
  }

  public verifyWebhookHash(verifHash: string): void {
    verifyConstantTimeToken(verifHash, this.config.webhookHash ?? "");
  }

  public close(): void {
    this.http.close();
  }
}

/** Unified provider adapter for Flutterwave. */
export class FlutterwaveProvider implements PaymentProvider {
  public readonly name = "flutterwave";
  public readonly capabilities = FLUTTERWAVE_CAPABILITIES;
  private readonly client: FlutterwaveClient;

  constructor(client: FlutterwaveClient) {
    this.client = client;
  }

  public async collect(request: PaymentRequest): Promise<PaymentResult> {
    const ref = request.referenceId ?? generateReferenceId();
    const res = await this.client.createPayment({
      amount: request.amount,
      currency: request.currency,
      phoneNumber: request.payerMsisdn,
      email: request.payerEmail,
      txRef: ref,
      redirectUrl: request.callbackUrl,
    });
    const data = unwrapFlwData(res, ref);
    return new PaymentResult({
      provider: this.name,
      referenceId: ref,
      status: NormalizedStatus.PENDING,
      amount: request.amount,
      currency: request.currency,
      externalId: request.externalId || ref,
      checkoutUrl: typeof data["link"] === "string" ? data["link"] : null,
      raw: res,
    });
  }

  public async disburse(request: DisbursementRequest): Promise<PaymentResult> {
    const ref = request.referenceId ?? generateReferenceId();
    const res = await this.client.createTransfer({
      amount: request.amount,
      currency: request.currency,
      accountNumber: request.payeeMsisdn,
      accountBank: request.payeeBankCode,
      reference: ref,
      narration: request.payerMessage || "Payout",
      callbackUrl: request.callbackUrl,
    });
    const data = unwrapFlwData(res, ref);
    const idOrRef = data["id"] ?? data["reference"] ?? ref;
    return new PaymentResult({
      provider: this.name,
      referenceId: String(idOrRef),
      status: mapFlwStatus(String(data["status"] ?? "pending")),
      amount: request.amount,
      currency: request.currency,
      externalId: String(data["reference"] ?? ref),
      raw: res,
    });
  }

  public async getStatus(
    referenceId: string,
    options: ProviderStatusOptions = {},
  ): Promise<PaymentResult> {
    const kind = validateOperationKind(options.kind ?? "collection");
    const res =
      kind === "disbursement"
        ? await this.client.getTransfer(referenceId)
        : await this.client.verifyByReference(referenceId);
    const data = unwrapFlwData(res, referenceId);
    const amount =
      data["amount"] !== undefined && data["amount"] !== null
        ? String(data["amount"])
        : null;
    const txId =
      data["id"] !== undefined && data["id"] !== null ? String(data["id"]) : null;
    const reasonVal = data["complete_message"] ?? data["processor_response"];
    const reason = typeof reasonVal === "string" && reasonVal ? reasonVal : null;
    return new PaymentResult({
      provider: this.name,
      referenceId,
      status: mapFlwStatus(String(data["status"] ?? "pending")),
      amount,
      currency: typeof data["currency"] === "string" ? data["currency"] : null,
      providerTransactionId: txId,
      reason,
      raw: res,
    });
  }

  public async getBalance(
    options: ProviderBalanceOptions = {},
  ): Promise<BalanceResult> {
    validateOperationKind(options.kind ?? "collection");
    const res = await this.client.getBalance(options.currency ?? null);
    const [availableBalance, currency] = unwrapFlwBalance(res);
    return {
      provider: this.name,
      availableBalance,
      currency,
      raw: res,
    };
  }

  public close(): void {
    this.client.close();
  }
}
