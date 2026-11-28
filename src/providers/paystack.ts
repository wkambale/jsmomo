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
  validatePrintableText,
  validateRetryBackoff,
  validateTimeout,
} from "../utils.js";
import { verifyHmacSignature } from "./_signatures.js";
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

export const PAYSTACK_BASE_URL = "https://api.paystack.co";

const PAYSTACK_CAPABILITIES = new ProviderCapabilities({
  providerId: "paystack",
  supportsCollection: true,
  supportsDisbursement: true,
  supportsBalance: true,
  supportsWebhookHmac: true,
  currencies: ["NGN", "GHS", "KES", "ZAR", "XOF", "USD"],
});

const PAYSTACK_ZERO_DECIMAL_CURRENCIES = new Set(["XOF", "XAF"]);
const VALID_PAYSTACK_ENVIRONMENTS = new Set(["sandbox", "production"]);
const PAYSTACK_TRANSFER_REFERENCE_RE = /^[a-z0-9_-]{16,50}$/;
const PAYSTACK_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface PaystackConfigOptions {
  secretKey: string;
  environment?: "sandbox" | "production";
  callbackUrl?: string | null;
  defaultCustomerEmail?: string | null;
  defaultCurrency?: string | null;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  telemetry?: TelemetryHook | null;
}

/** Credentials and settings for Paystack API. */
export class PaystackConfig {
  public readonly secretKey: string;
  public readonly environment: "sandbox" | "production";
  public readonly callbackUrl: string | null;
  public readonly defaultCustomerEmail: string | null;
  public readonly defaultCurrency: string | null;
  public readonly baseUrl: string;
  public readonly timeout: number;
  public readonly maxRetries: number;
  public readonly retryBackoff: number;
  public readonly telemetry: TelemetryHook | null;

  constructor(options: PaystackConfigOptions) {
    if (typeof options.secretKey !== "string" || !options.secretKey.trim()) {
      throw new RangeError("secretKey must be a non-empty string");
    }
    this.secretKey = validateHeaderValue(options.secretKey.trim(), {
      fieldName: "secretKey",
    });
    const isLiveKey = this.secretKey.startsWith("sk_live_");
    const env = options.environment ?? (isLiveKey ? "production" : "sandbox");
    if (!VALID_PAYSTACK_ENVIRONMENTS.has(env)) {
      throw new RangeError("environment must be 'sandbox' or 'production'");
    }
    if (env === "sandbox" && isLiveKey) {
      throw new RangeError(
        "Paystack live secretKey ('sk_live_*') cannot be used with sandbox environment",
      );
    }
    const allowLocalhost = env === "sandbox";
    this.environment = env;
    this.callbackUrl =
      options.callbackUrl !== undefined && options.callbackUrl !== null
        ? validateCallbackUrl(options.callbackUrl, { allowLocalhost })
        : null;
    this.defaultCustomerEmail =
      options.defaultCustomerEmail !== undefined &&
      options.defaultCustomerEmail !== null
        ? validateEmailAddress(options.defaultCustomerEmail)
        : null;
    this.defaultCurrency =
      options.defaultCurrency !== undefined && options.defaultCurrency !== null
        ? validateCurrency(options.defaultCurrency)
        : null;
    this.baseUrl = validateBaseUrl(options.baseUrl ?? PAYSTACK_BASE_URL, {
      allowLocalhost,
    });
    this.timeout = validateTimeout(options.timeout ?? 30.0);
    this.maxRetries = validateMaxRetries(options.maxRetries ?? 0);
    this.retryBackoff = validateRetryBackoff(options.retryBackoff ?? 0.5);
    this.telemetry = options.telemetry ?? null;
    Object.freeze(this);
  }

  public toString(): string {
    return `PaystackConfig(secretKey=<redacted>, baseUrl=${JSON.stringify(this.baseUrl)}, timeout=${this.timeout})`;
  }

  public [inspect.custom](): string {
    return this.toString();
  }

  public toJSON(): Record<string, unknown> {
    return {
      secretKey: "<redacted>",
      baseUrl: this.baseUrl,
      timeout: this.timeout,
    };
  }
}

/** Exact decimal-to-minor-units scaling without floating-point drift. */
function toMinorUnits(amount: string, currency?: string | null): number {
  const validated = validateAmount(amount);
  const [intPart = "0", fracPart = ""] = validated.split(".");
  if (
    currency &&
    PAYSTACK_ZERO_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase()) &&
    fracPart &&
    !/^0*$/.test(fracPart)
  ) {
    throw new RangeError(
      `Currency ${currency.trim().toUpperCase()} does not support fractional minor units`,
    );
  }
  const trimmedFrac = fracPart.replace(/0+$/, "");
  if (trimmedFrac.length > 2) {
    throw new RangeError(
      "Amount cannot have more than 2 decimal places for minor-unit conversion",
    );
  }
  const paddedFrac = trimmedFrac.padEnd(2, "0");
  const minorBig = BigInt(intPart) * 100n + BigInt(paddedFrac);
  const minorNum = Number(minorBig);
  if (!Number.isSafeInteger(minorNum)) {
    throw new RangeError("Amount exceeds safe integer minor-unit limit");
  }
  return minorNum;
}

function fromMinorUnits(minor: unknown): string {
  if (
    typeof minor === "boolean" ||
    (typeof minor !== "number" && typeof minor !== "string")
  ) {
    throw new JsMomoSDKError("Malformed Paystack minor-unit amount", {
      provider: "Paystack",
    });
  }
  const str = String(minor).trim();
  if (!/^-?\d+$/.test(str)) {
    throw new JsMomoSDKError("Malformed Paystack minor-unit amount", {
      provider: "Paystack",
    });
  }
  const val = BigInt(str);
  const neg = val < 0n;
  const abs = neg ? -val : val;
  const major = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${major.toString()}.${cents}`;
}

function unwrapPaystackData(
  res: Record<string, unknown>,
  referenceId?: string | null,
): Record<string, unknown> {
  if (res["status"] === false) {
    const msg = res["message"];
    throw new JsMomoSDKError(
      typeof msg === "string" && msg ? msg : "Paystack request failed",
      { referenceId: referenceId ?? null, provider: "Paystack", responseBody: res },
    );
  }
  const data = res["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new JsMomoSDKError("Malformed Paystack response: expected object in 'data'", {
      referenceId: referenceId ?? null,
      provider: "Paystack",
    });
  }
  return data as Record<string, unknown>;
}

function unwrapPaystackBalance(
  res: Record<string, unknown>,
  currency?: string | null,
): [string, string] {
  if (res["status"] === false) {
    const msg = res["message"];
    throw new JsMomoSDKError(
      typeof msg === "string" && msg ? msg : "Paystack request failed",
      { provider: "Paystack", responseBody: res },
    );
  }
  const items = res["data"];
  if (!Array.isArray(items) || items.length === 0) {
    throw new JsMomoSDKError("Malformed Paystack balance response", {
      provider: "Paystack",
    });
  }
  const target = currency ? validateCurrency(currency) : null;
  let selected: Record<string, unknown> | null = null;
  if (target !== null) {
    for (const item of items) {
      if (
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>)["currency"] === "string" &&
        String((item as Record<string, unknown>)["currency"])
          .trim()
          .toUpperCase() === target
      ) {
        selected = item as Record<string, unknown>;
        break;
      }
    }
    if (!selected) {
      throw new JsMomoSDKError(`Paystack balance for currency '${target}' not found`, {
        provider: "Paystack",
      });
    }
  } else if (items[0] && typeof items[0] === "object" && !Array.isArray(items[0])) {
    selected = items[0] as Record<string, unknown>;
  }
  if (
    !selected ||
    selected["balance"] === undefined ||
    typeof selected["currency"] !== "string" ||
    !selected["currency"]
  ) {
    throw new JsMomoSDKError("Malformed Paystack balance response", {
      provider: "Paystack",
    });
  }
  return [fromMinorUnits(selected["balance"]), selected["currency"]];
}

function mapPaystackStatus(rawStatus: string): NormalizedStatus {
  const norm = rawStatus.trim().toLowerCase();
  if (norm === "success" || norm === "succeeded") return NormalizedStatus.SUCCEEDED;
  if (
    norm === "failed" ||
    norm === "abandoned" ||
    norm === "rejected" ||
    norm === "blocked"
  ) {
    return NormalizedStatus.FAILED;
  }
  if (norm === "reversed") return NormalizedStatus.REVERSED;
  return NormalizedStatus.PENDING;
}

function validatePaystackReference(reference?: string | null): string {
  if (reference === undefined || reference === null) {
    return generateReferenceId();
  }
  if (typeof reference !== "string" || !reference.trim()) {
    throw new RangeError("reference must be a non-empty string");
  }
  const cleaned = reference.trim();
  encodePathSegment(cleaned, "reference");
  return cleaned;
}

function validatePaystackTransferReference(reference?: string | null): string {
  if (reference === undefined || reference === null) {
    return generateReferenceId();
  }
  if (typeof reference !== "string" || !reference.trim()) {
    throw new RangeError("reference must be a non-empty string");
  }
  const cleaned = reference.trim();
  if (!PAYSTACK_TRANSFER_REFERENCE_RE.test(cleaned)) {
    throw new RangeError(
      "Paystack transfer reference must be 16 to 50 characters containing only lowercase alphanumeric, '_', or '-'",
    );
  }
  return cleaned;
}

function resolvePaystackRecipient(request: DisbursementRequest): string {
  const candidate = (request.payeeBankCode ?? request.payeeMsisdn).trim();
  if (!candidate.startsWith("RCP_")) {
    throw new RangeError(
      "Paystack disbursements require a Paystack recipient code starting with 'RCP_'",
    );
  }
  return candidate;
}

function resolvePaystackRef(data: Record<string, unknown>, fallback: string): string {
  const raw = data["reference"];
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

export interface PaystackClientOptions {
  fetch?: FetchLike;
  maxResponseBytes?: number;
  telemetry?: TelemetryHook | null;
}

export interface PaystackInitializeParams {
  email: string;
  amount: string;
  currency: string;
  reference?: string | null;
  callbackUrl?: string | null;
  channels?: readonly string[] | null;
  metadata?: Record<string, unknown> | null;
}

export interface PaystackMobileMoneyChargeParams {
  email?: string | null;
  amount: string;
  currency: string;
  phone: string;
  provider: string;
  reference?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PaystackListBanksParams {
  country?: string | null;
  currency?: string | null;
  type?: string | null;
  payWithBank?: boolean;
  useCursor?: boolean;
  perPage?: number;
}

export interface PaystackRefundParams {
  transaction: string | number;
  amount?: string | null;
  currency?: string | null;
  customerNote?: string | null;
  merchantNote?: string | null;
}

export interface PaystackTransferRecipientParams {
  type: "mobile_money" | "nuban" | "ghipss" | "basa" | "kepss" | string;
  name: string;
  accountNumber: string;
  bankCode: string;
  currency: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PaystackTransferParams {
  amount: string;
  currency: string;
  recipient: string;
  reference?: string | null;
  reason?: string;
}

/** Paystack API client for transactions, transfers, balances, and HMAC-SHA512 webhooks. */
export class PaystackClient {
  public readonly config: PaystackConfig;
  private readonly http: HttpClient;

  constructor(
    config: PaystackConfig | PaystackConfigOptions,
    options: PaystackClientOptions = {},
  ) {
    this.config =
      config instanceof PaystackConfig ? config : new PaystackConfig(config);
    this.http = new HttpClient({
      baseUrl: this.config.baseUrl,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      retryBackoff: this.config.retryBackoff,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      fetch: options.fetch,
      telemetry:
        options.telemetry !== undefined ? options.telemetry : this.config.telemetry,
      providerName: "Paystack",
      allowLocalhost: this.config.environment === "sandbox",
    });
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.secretKey}`,
      "Content-Type": "application/json",
    };
  }

  public async initializeTransaction(
    params: PaystackInitializeParams,
  ): Promise<Record<string, unknown>> {
    const email = validateEmailAddress(params.email);
    const currency = validateCurrency(params.currency);
    const minorAmount = toMinorUnits(params.amount, currency);
    if (params.callbackUrl !== undefined && params.callbackUrl !== null) {
      validateCallbackUrl(params.callbackUrl, {
        allowLocalhost: this.config.environment === "sandbox",
      });
    }
    const resolvedCb = params.callbackUrl ?? this.config.callbackUrl;
    const ref = validatePaystackReference(params.reference);
    const payload: Record<string, unknown> = {
      email,
      amount: minorAmount,
      currency,
      reference: ref,
    };
    if (resolvedCb !== null) {
      payload["callback_url"] = resolvedCb;
    }
    if (params.channels !== undefined && params.channels !== null) {
      if (!Array.isArray(params.channels) || params.channels.length === 0) {
        throw new RangeError("channels must be a non-empty array of channel names");
      }
      payload["channels"] = params.channels.map((ch) => {
        if (typeof ch !== "string" || !ch.trim()) {
          throw new RangeError("channel must be a non-empty string");
        }
        return validateHeaderValue(ch.trim(), {
          fieldName: "channel",
          allowWhitespace: false,
        });
      });
    }
    if (params.metadata !== undefined && params.metadata !== null) {
      if (typeof params.metadata !== "object" || Array.isArray(params.metadata)) {
        throw new RangeError("metadata must be a JSON object");
      }
      payload["metadata"] = params.metadata;
    }
    const response = await this.http.request("POST", "/transaction/initialize", {
      headers: this.headers(),
      json: payload,
      idempotent: false,
      referenceId: ref,
    });
    return parseJsonObject(response, ref);
  }

  /** Initiate a direct server-to-server Paystack mobile money charge (`POST /charge`). */
  public async chargeMobileMoney(
    params: PaystackMobileMoneyChargeParams,
  ): Promise<Record<string, unknown>> {
    const rawEmail = params.email ?? this.config.defaultCustomerEmail;
    if (!rawEmail) {
      throw new RangeError(
        "email or PaystackConfig.defaultCustomerEmail is required for Paystack mobile money charges",
      );
    }
    const email = validateEmailAddress(rawEmail);
    const currency = validateCurrency(params.currency);
    const minorAmount = toMinorUnits(params.amount, currency);
    const digits = normaliseMsisdn(params.phone);
    const phone = params.phone.trim().startsWith("+") ? `+${digits}` : digits;
    if (typeof params.provider !== "string" || !params.provider.trim()) {
      throw new RangeError("provider must be a non-empty mobile money provider code");
    }
    const provider = validateHeaderValue(params.provider.trim().toLowerCase(), {
      fieldName: "provider",
      allowWhitespace: false,
    });
    const ref = validatePaystackReference(params.reference);
    const payload: Record<string, unknown> = {
      email,
      amount: minorAmount,
      currency,
      reference: ref,
      mobile_money: {
        phone,
        provider,
      },
    };
    if (params.metadata !== undefined && params.metadata !== null) {
      if (typeof params.metadata !== "object" || Array.isArray(params.metadata)) {
        throw new RangeError("metadata must be a JSON object");
      }
      payload["metadata"] = params.metadata;
    }
    const response = await this.http.request("POST", "/charge", {
      headers: this.headers(),
      json: payload,
      idempotent: false,
      referenceId: ref,
    });
    return parseJsonObject(response, ref);
  }

  /** List supported Paystack banks and mobile money providers (`GET /bank`). */
  public async listBanks(
    params: PaystackListBanksParams = {},
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    if (params.country !== undefined && params.country !== null) {
      query.set(
        "country",
        validatePrintableText(params.country, { fieldName: "country", maxLength: 64 }),
      );
    }
    if (params.currency !== undefined && params.currency !== null) {
      query.set("currency", validateCurrency(params.currency));
    }
    if (params.type !== undefined && params.type !== null) {
      query.set(
        "type",
        validateHeaderValue(params.type.trim(), {
          fieldName: "type",
          allowWhitespace: false,
        }),
      );
    }
    if (params.payWithBank !== undefined) {
      query.set("pay_with_bank", String(Boolean(params.payWithBank)));
    }
    if (params.useCursor !== undefined) {
      query.set("use_cursor", String(Boolean(params.useCursor)));
    }
    if (params.perPage !== undefined) {
      if (
        typeof params.perPage !== "number" ||
        !Number.isInteger(params.perPage) ||
        params.perPage < 1 ||
        params.perPage > 100
      ) {
        throw new RangeError("perPage must be an integer between 1 and 100");
      }
      query.set("perPage", String(params.perPage));
    }
    const qs = query.toString();
    const path = qs ? `/bank?${qs}` : "/bank";
    const response = await this.http.request("GET", path, {
      headers: this.headers(),
    });
    return parseJsonObject(response);
  }

  /** Create a full or partial refund for a settled Paystack transaction (`POST /refund`). */
  public async createRefund(
    params: PaystackRefundParams,
  ): Promise<Record<string, unknown>> {
    let txIdentifier: string | number;
    if (typeof params.transaction === "number") {
      if (!Number.isSafeInteger(params.transaction) || params.transaction <= 0) {
        throw new RangeError("transaction must be a positive integer ID or reference");
      }
      txIdentifier = params.transaction;
    } else if (typeof params.transaction === "string" && params.transaction.trim()) {
      txIdentifier = validateHeaderValue(params.transaction.trim(), {
        fieldName: "transaction",
        allowWhitespace: false,
      });
    } else {
      throw new RangeError("transaction must be a non-empty reference or positive ID");
    }
    const payload: Record<string, unknown> = {
      transaction: txIdentifier,
    };
    const normCurrency =
      params.currency !== undefined && params.currency !== null
        ? validateCurrency(params.currency)
        : null;
    if (normCurrency !== null) {
      payload["currency"] = normCurrency;
    }
    if (params.amount !== undefined && params.amount !== null) {
      payload["amount"] = toMinorUnits(params.amount, normCurrency);
    }
    if (params.customerNote !== undefined && params.customerNote !== null) {
      payload["customer_note"] = validatePrintableText(params.customerNote, {
        fieldName: "customerNote",
      });
    }
    if (params.merchantNote !== undefined && params.merchantNote !== null) {
      payload["merchant_note"] = validatePrintableText(params.merchantNote, {
        fieldName: "merchantNote",
      });
    }
    const refId = String(txIdentifier);
    const response = await this.http.request("POST", "/refund", {
      headers: this.headers(),
      json: payload,
      idempotent: false,
      referenceId: refId,
    });
    return parseJsonObject(response, refId);
  }

  public async verifyTransaction(reference: string): Promise<Record<string, unknown>> {
    const encoded = encodePathSegment(reference, "reference");
    const response = await this.http.request("GET", `/transaction/verify/${encoded}`, {
      headers: this.headers(),
      referenceId: reference,
    });
    return parseJsonObject(response, reference);
  }

  public async createTransferRecipient(
    params: PaystackTransferRecipientParams,
  ): Promise<Record<string, unknown>> {
    if (typeof params.type !== "string" || !params.type.trim()) {
      throw new RangeError("type must be a non-empty string");
    }
    if (typeof params.name !== "string" || !params.name.trim()) {
      throw new RangeError("name must be a non-empty string");
    }
    if (typeof params.accountNumber !== "string" || !params.accountNumber.trim()) {
      throw new RangeError("accountNumber must be a non-empty string");
    }
    if (typeof params.bankCode !== "string" || !params.bankCode.trim()) {
      throw new RangeError("bankCode must be a non-empty string");
    }
    const type = validateHeaderValue(params.type.trim(), { fieldName: "type" });
    const name = params.name.trim();
    const accountNumber = validateHeaderValue(params.accountNumber.trim(), {
      fieldName: "accountNumber",
    });
    const bankCode = validateHeaderValue(params.bankCode.trim(), {
      fieldName: "bankCode",
    });
    const currency = validateCurrency(params.currency);
    const payload: Record<string, unknown> = {
      type,
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency,
    };
    if (params.description !== undefined && params.description !== null) {
      if (typeof params.description !== "string" || !params.description.trim()) {
        throw new RangeError("description must not be blank");
      }
      payload["description"] = params.description.trim();
    }
    if (params.metadata !== undefined && params.metadata !== null) {
      if (typeof params.metadata !== "object" || Array.isArray(params.metadata)) {
        throw new RangeError("metadata must be a JSON object");
      }
      payload["metadata"] = params.metadata;
    }
    const response = await this.http.request("POST", "/transferrecipient", {
      headers: this.headers(),
      json: payload,
    });
    return parseJsonObject(response);
  }

  public async initiateTransfer(
    params: PaystackTransferParams,
  ): Promise<Record<string, unknown>> {
    const currency = validateCurrency(params.currency);
    const minorAmount = toMinorUnits(params.amount, currency);
    if (typeof params.recipient !== "string" || !params.recipient.trim()) {
      throw new RangeError("recipient must be a non-empty recipient code");
    }
    const recipient = validateHeaderValue(params.recipient.trim(), {
      fieldName: "recipient",
    });
    const ref = validatePaystackTransferReference(params.reference);
    const response = await this.http.request("POST", "/transfer", {
      headers: this.headers(),
      json: {
        source: "balance",
        amount: minorAmount,
        currency,
        recipient,
        reference: ref,
        reason: params.reason ?? "Payout",
      },
      idempotent: false,
      referenceId: ref,
    });
    return parseJsonObject(response, ref);
  }

  public async verifyTransfer(reference: string): Promise<Record<string, unknown>> {
    const encoded = encodePathSegment(reference, "reference");
    const response = await this.http.request("GET", `/transfer/verify/${encoded}`, {
      headers: this.headers(),
      referenceId: reference,
    });
    return parseJsonObject(response, reference);
  }

  public async getBalance(): Promise<Record<string, unknown>> {
    const response = await this.http.request("GET", "/balance", {
      headers: this.headers(),
    });
    return parseJsonObject(response);
  }

  public verifyWebhook(payload: Uint8Array | Buffer | string, signature: string): void {
    verifyHmacSignature(payload, signature, this.config.secretKey, {
      algorithm: "sha512",
    });
  }

  public close(): void {
    this.http.close();
  }
}

/** Unified provider adapter for Paystack. */
export class PaystackProvider implements PaymentProvider {
  public readonly name = "paystack";
  public readonly capabilities = PAYSTACK_CAPABILITIES;
  private readonly client: PaystackClient;

  constructor(client: PaystackClient) {
    this.client = client;
  }

  public async collect(request: PaymentRequest): Promise<PaymentResult> {
    const email = request.payerEmail ?? this.client.config.defaultCustomerEmail;
    if (!email) {
      throw new RangeError(
        "payerEmail or PaystackConfig.defaultCustomerEmail is required for Paystack collections",
      );
    }
    const ref = validatePaystackReference(request.referenceId);
    const res = await this.client.initializeTransaction({
      email,
      amount: request.amount,
      currency: request.currency,
      reference: ref,
      callbackUrl: request.callbackUrl,
    });
    const data = unwrapPaystackData(res, ref);
    return new PaymentResult({
      provider: this.name,
      referenceId: resolvePaystackRef(data, ref),
      status: NormalizedStatus.PENDING,
      amount: request.amount,
      currency: request.currency,
      externalId: request.externalId || null,
      checkoutUrl:
        typeof data["authorization_url"] === "string"
          ? data["authorization_url"]
          : null,
      raw: res,
    });
  }

  public async disburse(request: DisbursementRequest): Promise<PaymentResult> {
    const recipient = resolvePaystackRecipient(request);
    const normalizedRef =
      request.referenceId !== null && PAYSTACK_UUID_RE.test(request.referenceId)
        ? request.referenceId.toLowerCase()
        : request.referenceId;
    const ref = validatePaystackTransferReference(normalizedRef);
    const res = await this.client.initiateTransfer({
      amount: request.amount,
      currency: request.currency,
      recipient,
      reference: ref,
      reason: request.payerMessage || "Payout",
    });
    const data = unwrapPaystackData(res, ref);
    return new PaymentResult({
      provider: this.name,
      referenceId: resolvePaystackRef(data, ref),
      status: mapPaystackStatus(String(data["status"] ?? "pending")),
      amount: request.amount,
      currency: request.currency,
      externalId: request.externalId || null,
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
        ? await this.client.verifyTransfer(referenceId)
        : await this.client.verifyTransaction(referenceId);
    const data = unwrapPaystackData(res, referenceId);
    const amount =
      data["amount"] !== undefined && data["amount"] !== null
        ? fromMinorUnits(data["amount"])
        : null;
    const txId =
      data["id"] !== undefined && data["id"] !== null ? String(data["id"]) : null;
    const reasonVal = data["gateway_response"] ?? data["reason"];
    const reason = typeof reasonVal === "string" && reasonVal ? reasonVal : null;
    return new PaymentResult({
      provider: this.name,
      referenceId,
      status: mapPaystackStatus(String(data["status"] ?? "pending")),
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
    const res = await this.client.getBalance();
    const [available, resolvedCurrency] = unwrapPaystackBalance(
      res,
      options.currency ?? this.client.config.defaultCurrency,
    );
    return {
      provider: this.name,
      availableBalance: available,
      currency: resolvedCurrency,
      raw: res,
    };
  }

  public close(): void {
    this.client.close();
  }
}
