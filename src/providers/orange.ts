import { inspect } from "node:util";

import { TokenCache } from "../auth.js";
import { JsMomoSDKError } from "../exceptions.js";
import type { FetchLike } from "../http.js";
import { DEFAULT_MAX_RESPONSE_BYTES, HttpClient, parseJsonObject } from "../http.js";
import type { TelemetryHook } from "../telemetry.js";
import {
  buildBasicAuthHeader,
  generateReferenceId,
  validateAmount,
  validateBaseUrl,
  validateCallbackUrl,
  validateCurrency,
  validateHeaderValue,
  validateMaxRetries,
  validateRequestPath,
  validateRetryBackoff,
  validateTimeout,
} from "../utils.js";
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

export const ORANGE_BASE_URL = "https://api.orange.com";
export const ORANGE_DEFAULT_API_PATH_PREFIX = "/orange-money-webpay/dev/v1";

const MAX_PAYMENT_CONTEXT = 4096;
const VALID_ORANGE_ENVIRONMENTS = new Set(["sandbox", "production"]);
const ORANGE_INTEGER_CURRENCIES = new Set(["XOF", "XAF", "OUV"]);

const ORANGE_CAPABILITIES = new ProviderCapabilities({
  providerId: "orange_money",
  supportsCollection: true,
  supportsDisbursement: false,
  supportsBalance: false,
  supportsWebhookHmac: false,
  currencies: ["XOF", "XAF", "OUV"],
});

export interface OrangePaymentContext {
  readonly orderId: string;
  readonly amount: string;
  readonly currency: string;
}

/** Pluggable store mapping Orange Money `pay_token` to `(orderId, amount, currency)`. */
export interface OrangePaymentContextStore {
  set(payToken: string, orderId: string, amount: string, currency: string): void;
  get(payToken: string): OrangePaymentContext | null;
}

class InMemoryOrangeContextStore implements OrangePaymentContextStore {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, OrangePaymentContext>();

  constructor(maxEntries = MAX_PAYMENT_CONTEXT) {
    this.maxEntries = maxEntries;
  }

  public set(
    payToken: string,
    orderId: string,
    amount: string,
    currency: string,
  ): void {
    if (!this.entries.has(payToken) && this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(payToken, { orderId, amount, currency });
  }

  public get(payToken: string): OrangePaymentContext | null {
    return this.entries.get(payToken) ?? null;
  }
}

function validateOrangeLang(lang: string): string {
  if (typeof lang !== "string" || !lang.trim()) {
    throw new RangeError(
      "lang must be a 2-letter ISO language code (e.g. 'fr' or 'en')",
    );
  }
  const cleaned = lang.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(cleaned)) {
    throw new RangeError(
      "lang must be a 2-letter ISO language code (e.g. 'fr' or 'en')",
    );
  }
  return cleaned;
}

function formatOrangeAmount(amount: string, currency?: string | null): number | string {
  const validated = validateAmount(amount);
  const [intPart = "0", fracPart = ""] = validated.split(".");
  const isWhole = !fracPart || /^0*$/.test(fracPart);
  if (currency && ORANGE_INTEGER_CURRENCIES.has(currency.trim().toUpperCase())) {
    if (!isWhole) {
      throw new RangeError(
        `Orange Money currency ${currency.trim().toUpperCase()} requires a whole-integer amount`,
      );
    }
    return Number(intPart);
  }
  return isWhole ? Number(intPart) : validated;
}

export interface OrangeMoneyConfigOptions {
  clientId: string;
  clientSecret: string;
  merchantKey: string;
  returnUrl?: string | null;
  cancelUrl?: string | null;
  notifUrl?: string | null;
  environment?: "sandbox" | "production";
  apiPathPrefix?: string | null;
  lang?: string;
  reference?: string | null;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  telemetry?: TelemetryHook | null;
}

/** Credentials and settings for Orange Money Web Payment API. */
export class OrangeMoneyConfig {
  public readonly clientId: string;
  public readonly clientSecret: string;
  public readonly merchantKey: string;
  public readonly returnUrl: string | null;
  public readonly cancelUrl: string | null;
  public readonly notifUrl: string | null;
  public readonly environment: "sandbox" | "production";
  public readonly apiPathPrefix: string;
  public readonly lang: string;
  public readonly reference: string | null;
  public readonly baseUrl: string;
  public readonly timeout: number;
  public readonly maxRetries: number;
  public readonly retryBackoff: number;
  public readonly telemetry: TelemetryHook | null;

  constructor(options: OrangeMoneyConfigOptions) {
    const required: Array<[string, string]> = [
      ["clientId", options.clientId],
      ["clientSecret", options.clientSecret],
      ["merchantKey", options.merchantKey],
    ];
    for (const [name, val] of required) {
      if (typeof val !== "string" || !val.trim()) {
        throw new RangeError(`${name} must be a non-empty string`);
      }
      validateHeaderValue(val, { fieldName: name });
    }
    if (options.clientId.includes(":")) {
      throw new RangeError("clientId must not contain ':'");
    }
    const env = options.environment ?? "sandbox";
    if (!VALID_ORANGE_ENVIRONMENTS.has(env)) {
      throw new RangeError("environment must be 'sandbox' or 'production'");
    }
    this.lang = validateOrangeLang(options.lang ?? "fr");
    if (options.reference !== undefined && options.reference !== null) {
      if (typeof options.reference !== "string" || !options.reference.trim()) {
        throw new RangeError("reference must not be blank");
      }
      this.reference = validateHeaderValue(options.reference.trim(), {
        fieldName: "reference",
      });
    } else {
      this.reference = null;
    }
    this.returnUrl =
      options.returnUrl !== undefined && options.returnUrl !== null
        ? validateCallbackUrl(options.returnUrl)
        : null;
    this.cancelUrl =
      options.cancelUrl !== undefined && options.cancelUrl !== null
        ? validateCallbackUrl(options.cancelUrl)
        : null;
    this.notifUrl =
      options.notifUrl !== undefined && options.notifUrl !== null
        ? validateCallbackUrl(options.notifUrl)
        : null;

    let prefix = options.apiPathPrefix;
    if (prefix === undefined || prefix === null) {
      if (env === "production") {
        throw new RangeError(
          "Production Orange Money requires an explicit country apiPathPrefix (e.g. '/orange-money-webpay/sn/v1')",
        );
      }
      prefix = ORANGE_DEFAULT_API_PATH_PREFIX;
    }
    if (typeof prefix !== "string" || !prefix.trim() || prefix.includes("?")) {
      throw new RangeError("apiPathPrefix must be a valid URL path prefix");
    }
    const cleanedPrefix = prefix.replace(/\/+$/, "");
    if (!cleanedPrefix) {
      throw new RangeError("apiPathPrefix must not be root '/'");
    }
    if (env === "production" && cleanedPrefix === ORANGE_DEFAULT_API_PATH_PREFIX) {
      throw new RangeError(
        "Production Orange Money must not use the sandbox '/dev/v1' apiPathPrefix",
      );
    }
    validateRequestPath(cleanedPrefix);
    this.apiPathPrefix = cleanedPrefix;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.merchantKey = options.merchantKey;
    this.environment = env;
    this.baseUrl = validateBaseUrl(options.baseUrl ?? ORANGE_BASE_URL);
    this.timeout = validateTimeout(options.timeout ?? 30.0);
    this.maxRetries = validateMaxRetries(options.maxRetries ?? 0);
    this.retryBackoff = validateRetryBackoff(options.retryBackoff ?? 0.5);
    this.telemetry = options.telemetry ?? null;
    Object.freeze(this);
  }

  public toString(): string {
    return `OrangeMoneyConfig(clientSecret=<redacted>, merchantKey=<redacted>, environment=${JSON.stringify(this.environment)}, baseUrl=${JSON.stringify(this.baseUrl)})`;
  }

  public [inspect.custom](): string {
    return this.toString();
  }

  public toJSON(): Record<string, unknown> {
    return {
      clientSecret: "<redacted>",
      merchantKey: "<redacted>",
      environment: this.environment,
      apiPathPrefix: this.apiPathPrefix,
      baseUrl: this.baseUrl,
    };
  }
}

function mapOrangeStatus(rawStatus: string): NormalizedStatus {
  const norm = rawStatus.trim().toUpperCase();
  if (norm === "SUCCESS" || norm === "SUCCESSFUL") return NormalizedStatus.SUCCEEDED;
  if (norm === "EXPIRED") return NormalizedStatus.EXPIRED;
  if (norm === "FAILED" || norm === "CANCELLED" || norm === "CANCELED") {
    return NormalizedStatus.FAILED;
  }
  return NormalizedStatus.PENDING;
}

function parseOrangeToken(raw: Record<string, unknown>): [string, number] {
  const token = raw["access_token"];
  if (typeof token !== "string" || !token.trim()) {
    throw new JsMomoSDKError("Orange Money token response missing access_token", {
      provider: "Orange Money",
    });
  }
  validateHeaderValue(token, { fieldName: "access_token" });
  const expRaw = raw["expires_in"] ?? 3600;
  let expiresIn: number;
  if (typeof expRaw === "number" && Number.isInteger(expRaw) && expRaw > 0) {
    expiresIn = expRaw;
  } else if (
    typeof expRaw === "string" &&
    /^\d{1,12}$/.test(expRaw.trim()) &&
    Number(expRaw.trim()) > 0
  ) {
    expiresIn = Number(expRaw.trim());
  } else {
    throw new JsMomoSDKError("Orange Money token response had invalid expires_in", {
      provider: "Orange Money",
    });
  }
  return [token, expiresIn];
}

export interface OrangeMoneyClientOptions {
  fetch?: FetchLike;
  maxResponseBytes?: number;
  telemetry?: TelemetryHook | null;
  contextStore?: OrangePaymentContextStore;
}

export interface OrangeWebPaymentParams {
  amount: string;
  currency: string;
  orderId?: string | null;
  returnUrl?: string | null;
  cancelUrl?: string | null;
  notifUrl?: string | null;
  lang?: string | null;
  reference?: string | null;
}

/** Orange Money Web Payment API client with pluggable payment context persistence. */
export class OrangeMoneyClient {
  public readonly config: OrangeMoneyConfig;
  private readonly cache = new TokenCache();
  private readonly contextStore: OrangePaymentContextStore;
  private readonly http: HttpClient;

  constructor(
    config: OrangeMoneyConfig | OrangeMoneyConfigOptions,
    options: OrangeMoneyClientOptions = {},
  ) {
    this.config =
      config instanceof OrangeMoneyConfig ? config : new OrangeMoneyConfig(config);
    this.contextStore = options.contextStore ?? new InMemoryOrangeContextStore();
    this.http = new HttpClient({
      baseUrl: this.config.baseUrl,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      retryBackoff: this.config.retryBackoff,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      fetch: options.fetch,
      telemetry:
        options.telemetry !== undefined ? options.telemetry : this.config.telemetry,
      providerName: "Orange Money",
    });
  }

  public lookupPaymentContext(payToken: string): OrangePaymentContext | null {
    return this.contextStore.get(payToken);
  }

  private getToken = async (): Promise<string> => {
    return this.cache.getOrRefresh("orange_money", async () => {
      const response = await this.http.request("POST", "/oauth/v3/token", {
        headers: {
          Authorization: buildBasicAuthHeader(
            this.config.clientId,
            this.config.clientSecret,
          ),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        form: { grant_type: "client_credentials" },
        idempotent: true,
      });
      const [token, expiresIn] = parseOrangeToken(parseJsonObject(response));
      this.cache.set("orange_money", token, expiresIn);
      return token;
    });
  };

  private async authHeaders(
    referenceId?: string | null,
  ): Promise<Record<string, string>> {
    let token: string;
    try {
      token = await this.getToken();
    } catch (err) {
      if (
        err instanceof JsMomoSDKError &&
        err.referenceId === null &&
        referenceId !== undefined &&
        referenceId !== null
      ) {
        err.referenceId = referenceId;
      }
      throw err;
    }
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  public async createWebPayment(
    params: OrangeWebPaymentParams,
  ): Promise<Record<string, unknown>> {
    const currency = validateCurrency(params.currency);
    const formattedAmount = formatOrangeAmount(params.amount, currency);
    const resolvedLang =
      params.lang !== undefined && params.lang !== null
        ? validateOrangeLang(params.lang)
        : this.config.lang;
    let resolvedRefLabel =
      params.reference !== undefined ? params.reference : this.config.reference;
    if (resolvedRefLabel !== null && resolvedRefLabel !== undefined) {
      if (typeof resolvedRefLabel !== "string" || !resolvedRefLabel.trim()) {
        throw new RangeError("reference must not be blank");
      }
      resolvedRefLabel = validateHeaderValue(resolvedRefLabel.trim(), {
        fieldName: "reference",
      });
    }
    for (const u of [params.returnUrl, params.cancelUrl, params.notifUrl]) {
      if (u !== undefined && u !== null) {
        validateCallbackUrl(u);
      }
    }
    const resolvedNotif = params.notifUrl ?? this.config.notifUrl;
    const resolvedReturn = params.returnUrl ?? this.config.returnUrl;
    const resolvedCancel = params.cancelUrl ?? this.config.cancelUrl;
    if (!resolvedNotif || !resolvedReturn || !resolvedCancel) {
      throw new RangeError(
        "returnUrl, cancelUrl, and notifUrl are required for Orange Money",
      );
    }
    const ref = params.orderId ?? generateReferenceId();
    validateHeaderValue(ref, { fieldName: "orderId" });
    const payload: Record<string, unknown> = {
      merchant_key: this.config.merchantKey,
      currency,
      order_id: ref,
      amount: formattedAmount,
      return_url: resolvedReturn,
      cancel_url: resolvedCancel,
      notif_url: resolvedNotif,
      lang: resolvedLang,
    };
    if (resolvedRefLabel !== null && resolvedRefLabel !== undefined) {
      payload["reference"] = resolvedRefLabel;
    }
    const response = await this.http.request(
      "POST",
      `${this.config.apiPathPrefix}/webpayment`,
      {
        headers: await this.authHeaders(ref),
        json: payload,
        productName: "orange_money",
        tokenCache: this.cache,
        tokenRefresher: this.getToken,
        referenceId: ref,
      },
    );
    const res = parseJsonObject(response, ref);
    const payToken = res["pay_token"];
    if (typeof payToken === "string" && payToken.trim()) {
      this.contextStore.set(payToken.trim(), ref, String(formattedAmount), currency);
    }
    return res;
  }

  public async getTransactionStatus(
    orderId: string,
    amount: string,
    payToken: string,
    options: { currency?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    if (typeof orderId !== "string" || !orderId.trim()) {
      throw new RangeError("orderId must be a non-empty string");
    }
    if (typeof payToken !== "string" || !payToken.trim()) {
      throw new RangeError("payToken must be a non-empty string");
    }
    validateHeaderValue(orderId, { fieldName: "orderId" });
    validateHeaderValue(payToken, { fieldName: "payToken" });
    const formattedAmount = formatOrangeAmount(amount, options.currency ?? null);
    const response = await this.http.request(
      "POST",
      `${this.config.apiPathPrefix}/transactionstatus`,
      {
        headers: await this.authHeaders(orderId),
        json: {
          order_id: orderId,
          amount: formattedAmount,
          pay_token: payToken,
        },
        productName: "orange_money",
        tokenCache: this.cache,
        tokenRefresher: this.getToken,
        idempotent: true,
        referenceId: orderId,
      },
    );
    return parseJsonObject(response, orderId);
  }

  public close(): void {
    this.http.close();
  }
}

function extractOrangePayToken(res: Record<string, unknown>): string {
  const raw = res["pay_token"];
  if (typeof raw !== "string" || !raw.trim()) {
    const msg = res["message"] ?? res["description"];
    const detail = typeof msg === "string" && msg.trim() ? `: ${msg.trim()}` : "";
    throw new JsMomoSDKError(`Orange Money response missing 'pay_token'${detail}`, {
      provider: "Orange Money",
      responseBody: res,
    });
  }
  return raw.trim();
}

/** Unified provider adapter for Orange Money. */
export class OrangeMoneyProvider implements PaymentProvider {
  public readonly name = "orange_money";
  public readonly capabilities = ORANGE_CAPABILITIES;
  private readonly client: OrangeMoneyClient;

  constructor(client: OrangeMoneyClient) {
    this.client = client;
  }

  public async collect(request: PaymentRequest): Promise<PaymentResult> {
    const orderId =
      request.referenceId ?? (request.externalId || generateReferenceId());
    const res = await this.client.createWebPayment({
      amount: request.amount,
      currency: request.currency,
      orderId,
      notifUrl: request.callbackUrl,
    });
    const payToken = extractOrangePayToken(res);
    return new PaymentResult({
      provider: this.name,
      referenceId: payToken,
      status: NormalizedStatus.PENDING,
      amount: request.amount,
      currency: request.currency,
      externalId: orderId,
      checkoutUrl: typeof res["payment_url"] === "string" ? res["payment_url"] : null,
      raw: res,
    });
  }

  public async disburse(_request: DisbursementRequest): Promise<PaymentResult> {
    throw new JsMomoSDKError("Orange Money adapter supports collections only", {
      provider: "Orange Money",
    });
  }

  public async getStatus(
    referenceId: string,
    options: ProviderStatusOptions = {},
  ): Promise<PaymentResult> {
    const kind = validateOperationKind(options.kind ?? "collection");
    if (kind === "disbursement") {
      throw new JsMomoSDKError("Orange Money adapter supports collections only", {
        referenceId,
        provider: "Orange Money",
      });
    }
    let resolvedOrderId = options.orderId;
    let resolvedAmount = options.amount;
    let resolvedCurrency = options.currency;
    if (!resolvedOrderId || !resolvedAmount) {
      const ctx = this.client.lookupPaymentContext(referenceId);
      if (!ctx) {
        throw new JsMomoSDKError(
          "Orange Money status queries require orderId and amount; pass { orderId, amount } or configure a shared contextStore",
          { referenceId, provider: "Orange Money" },
        );
      }
      resolvedOrderId = resolvedOrderId ?? ctx.orderId;
      resolvedAmount = resolvedAmount ?? ctx.amount;
      resolvedCurrency = resolvedCurrency ?? ctx.currency;
    }
    const res = await this.client.getTransactionStatus(
      resolvedOrderId,
      resolvedAmount,
      referenceId,
      { currency: resolvedCurrency ?? null },
    );
    return new PaymentResult({
      provider: this.name,
      referenceId,
      status: mapOrangeStatus(String(res["status"] ?? "PENDING")),
      amount: resolvedAmount,
      currency: resolvedCurrency ?? null,
      externalId: resolvedOrderId,
      raw: res,
    });
  }

  public async getBalance(
    options: ProviderBalanceOptions = {},
  ): Promise<BalanceResult> {
    validateOperationKind(options.kind ?? "collection");
    throw new JsMomoSDKError("Orange Money Web Payment does not expose balances", {
      provider: "Orange Money",
    });
  }

  public close(): void {
    this.client.close();
  }
}
