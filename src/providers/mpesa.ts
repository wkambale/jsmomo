import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import { inspect } from "node:util";

import { TokenCache } from "../auth.js";
import {
  JsMomoSDKError,
  JsMomoSDKServerError,
  WebhookVerificationError,
} from "../exceptions.js";
import type { FetchLike } from "../http.js";
import { DEFAULT_MAX_RESPONSE_BYTES, HttpClient, parseJsonObject } from "../http.js";
import type { TelemetryHook } from "../telemetry.js";
import {
  buildBasicAuthHeader,
  generateReferenceId,
  normaliseMsisdn,
  validateAmount,
  validateBaseUrl,
  validateCallbackUrl,
  validateHeaderValue,
  validateMaxRetries,
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

export const MPESA_SANDBOX_BASE_URL = "https://sandbox.safaricom.co.ke";
export const MPESA_PRODUCTION_BASE_URL = "https://api.safaricom.co.ke";

const MPESA_CAPABILITIES = new ProviderCapabilities({
  providerId: "mpesa",
  supportsCollection: true,
  supportsDisbursement: true,
  supportsBalance: false,
  supportsWebhookHmac: false,
  currencies: ["KES"],
});

const VALID_MPESA_ENVIRONMENTS = new Set(["sandbox", "production"]);
const VALID_MPESA_TRANSACTION_TYPES = new Set([
  "CustomerPayBillOnline",
  "CustomerBuyGoodsOnline",
]);
const VALID_MPESA_COMMAND_IDS = new Set([
  "BusinessPayment",
  "SalaryPayment",
  "PromotionPayment",
]);
const MAX_MPESA_ACCOUNT_REFERENCE_LEN = 12;
const MAX_MPESA_TRANSACTION_DESC_LEN = 13;
const VALID_MPESA_IDENTIFIER_TYPES = new Set(["1", "2", "4"]);
const STRICT_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function validateEncryptedSecurityCredential(credential: string): void {
  const stripped = credential.trim();
  if (!stripped || stripped.length % 4 !== 0 || !STRICT_BASE64_RE.test(stripped)) {
    throw new RangeError(
      "M-Pesa production requires an RSA-encrypted Base64 securityCredential; use encryptMpesaSecurityCredential() rather than a plaintext password",
    );
  }
  const decoded = Buffer.from(stripped, "base64");
  if (decoded.byteLength < 64) {
    throw new RangeError(
      "M-Pesa production securityCredential ciphertext is too short; expected RSA-encrypted Base64 ciphertext",
    );
  }
}

/**
 * Encrypt a Safaricom M-Pesa Daraja initiator password with Safaricom's X.509
 * certificate or RSA public key PEM using PKCS#1 v1.5 (`RSA_PKCS1_PADDING`).
 */
export function encryptMpesaSecurityCredential(
  initiatorPassword: string,
  certificateOrPublicKeyPem: string,
): string {
  if (typeof initiatorPassword !== "string" || !initiatorPassword.trim()) {
    throw new RangeError("initiatorPassword must be a non-empty string");
  }
  validateHeaderValue(initiatorPassword, { fieldName: "initiatorPassword" });
  if (
    typeof certificateOrPublicKeyPem !== "string" ||
    !certificateOrPublicKeyPem.trim()
  ) {
    throw new RangeError("certificateOrPublicKeyPem must be a non-empty PEM string");
  }
  const keyObj = createPublicKey(certificateOrPublicKeyPem);
  if (keyObj.asymmetricKeyType !== "rsa") {
    throw new TypeError("certificateOrPublicKeyPem must contain an RSA public key");
  }
  const ciphertext = publicEncrypt(
    {
      key: keyObj,
      padding: constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(initiatorPassword, "utf8"),
  );
  return ciphertext.toString("base64");
}

function toMpesaIntAmount(amount: string): number {
  const validated = validateAmount(amount);
  if (validated.includes(".")) {
    const [, frac = ""] = validated.split(".");
    if (!/^0*$/.test(frac)) {
      throw new RangeError(
        "M-Pesa amount must be a whole integer without fractional minor units",
      );
    }
  }
  const intVal = Number(validated.split(".")[0]);
  if (!Number.isSafeInteger(intVal) || intVal <= 0) {
    throw new RangeError("M-Pesa amount must be a positive safe integer");
  }
  return intVal;
}

function validateAccountReference(accountReference: string): string {
  if (typeof accountReference !== "string" || !accountReference.trim()) {
    throw new RangeError("accountReference must be a non-empty string");
  }
  const cleaned = validateHeaderValue(accountReference.trim(), {
    fieldName: "accountReference",
  });
  if (cleaned.length > MAX_MPESA_ACCOUNT_REFERENCE_LEN) {
    throw new RangeError(
      `accountReference must not exceed ${MAX_MPESA_ACCOUNT_REFERENCE_LEN} characters`,
    );
  }
  return cleaned;
}

function validateTransactionDesc(transactionDesc: string): string {
  if (typeof transactionDesc !== "string" || !transactionDesc.trim()) {
    throw new RangeError("transactionDesc must be a non-empty string");
  }
  const cleaned = validateHeaderValue(transactionDesc.trim(), {
    fieldName: "transactionDesc",
  });
  if (cleaned.length > MAX_MPESA_TRANSACTION_DESC_LEN) {
    throw new RangeError(
      `transactionDesc must not exceed ${MAX_MPESA_TRANSACTION_DESC_LEN} characters`,
    );
  }
  return cleaned;
}

function buildStkPassword(shortCode: string, passkey: string): [string, string] {
  // Daraja expects East Africa Time (UTC+3) formatted as YYYYMMDDHHmmss
  const eatMs = Date.now() + 3 * 60 * 60 * 1000;
  const d = new Date(eatMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const encoded = Buffer.from(`${shortCode}${passkey}${timestamp}`, "utf8").toString(
    "base64",
  );
  return [encoded, timestamp];
}

export interface MpesaConfigOptions {
  consumerKey: string;
  consumerSecret: string;
  shortCode: string;
  passkey: string;
  callbackUrl?: string | null;
  queueTimeoutUrl?: string | null;
  initiatorName?: string | null;
  securityCredential?: string | null;
  transactionType?: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
  partyB?: string | null;
  commandId?: "BusinessPayment" | "SalaryPayment" | "PromotionPayment";
  environment?: "sandbox" | "production";
  baseUrl?: string | null;
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  telemetry?: TelemetryHook | null;
}

/** Credentials and settings for Safaricom M-Pesa Daraja API. */
export class MpesaConfig {
  public readonly consumerKey: string;
  public readonly consumerSecret: string;
  public readonly shortCode: string;
  public readonly passkey: string;
  public readonly callbackUrl: string | null;
  public readonly queueTimeoutUrl: string | null;
  public readonly initiatorName: string | null;
  public readonly securityCredential: string | null;
  public readonly transactionType: string;
  public readonly partyB: string | null;
  public readonly commandId: string;
  public readonly environment: "sandbox" | "production";
  public readonly baseUrl: string;
  public readonly timeout: number;
  public readonly maxRetries: number;
  public readonly retryBackoff: number;
  public readonly telemetry: TelemetryHook | null;

  constructor(options: MpesaConfigOptions) {
    const required: Array<[string, string]> = [
      ["consumerKey", options.consumerKey],
      ["consumerSecret", options.consumerSecret],
      ["shortCode", options.shortCode],
      ["passkey", options.passkey],
    ];
    for (const [name, val] of required) {
      if (typeof val !== "string" || !val.trim()) {
        throw new RangeError(`${name} must be a non-empty string`);
      }
      validateHeaderValue(val, { fieldName: name });
    }
    if (options.consumerKey.includes(":")) {
      throw new RangeError("consumerKey must not contain ':'");
    }
    const env = options.environment ?? "sandbox";
    if (!VALID_MPESA_ENVIRONMENTS.has(env)) {
      throw new RangeError("environment must be 'sandbox' or 'production'");
    }
    const txType = options.transactionType ?? "CustomerPayBillOnline";
    if (!VALID_MPESA_TRANSACTION_TYPES.has(txType)) {
      throw new RangeError(
        "transactionType must be 'CustomerPayBillOnline' or 'CustomerBuyGoodsOnline'",
      );
    }
    const cmdId = options.commandId ?? "BusinessPayment";
    if (!VALID_MPESA_COMMAND_IDS.has(cmdId)) {
      throw new RangeError(
        "commandId must be 'BusinessPayment', 'SalaryPayment', or 'PromotionPayment'",
      );
    }

    let partyB: string | null = null;
    if (options.partyB !== undefined && options.partyB !== null) {
      if (typeof options.partyB !== "string" || !options.partyB.trim()) {
        throw new RangeError("partyB must not be blank");
      }
      partyB = validateHeaderValue(options.partyB.trim(), { fieldName: "partyB" });
    }

    const allowLocalhost = env === "sandbox";
    this.callbackUrl =
      options.callbackUrl !== undefined && options.callbackUrl !== null
        ? validateCallbackUrl(options.callbackUrl, { allowLocalhost })
        : null;
    this.queueTimeoutUrl =
      options.queueTimeoutUrl !== undefined && options.queueTimeoutUrl !== null
        ? validateCallbackUrl(options.queueTimeoutUrl, { allowLocalhost })
        : null;

    let initName = options.initiatorName ?? (env === "sandbox" ? "testapi" : null);
    if (initName !== null) {
      if (typeof initName !== "string" || !initName.trim()) {
        throw new RangeError("initiatorName must not be blank");
      }
      initName = validateHeaderValue(initName, { fieldName: "initiatorName" });
    }

    let secCred: string | null = null;
    if (
      options.securityCredential !== undefined &&
      options.securityCredential !== null
    ) {
      if (
        typeof options.securityCredential !== "string" ||
        !options.securityCredential.trim()
      ) {
        throw new RangeError("securityCredential must not be blank");
      }
      secCred = validateHeaderValue(options.securityCredential, {
        fieldName: "securityCredential",
      });
      if (env === "production") {
        validateEncryptedSecurityCredential(secCred);
      }
    }

    this.consumerKey = options.consumerKey;
    this.consumerSecret = options.consumerSecret;
    this.shortCode = options.shortCode;
    this.passkey = options.passkey;
    this.initiatorName = initName;
    this.securityCredential = secCred;
    this.transactionType = txType;
    this.partyB = partyB;
    this.commandId = cmdId;
    this.environment = env;
    this.timeout = validateTimeout(options.timeout ?? 30.0);
    this.maxRetries = validateMaxRetries(options.maxRetries ?? 0);
    this.retryBackoff = validateRetryBackoff(options.retryBackoff ?? 0.5);
    this.baseUrl =
      options.baseUrl !== undefined && options.baseUrl !== null
        ? validateBaseUrl(options.baseUrl, { allowLocalhost })
        : env === "sandbox"
          ? MPESA_SANDBOX_BASE_URL
          : MPESA_PRODUCTION_BASE_URL;
    this.telemetry = options.telemetry ?? null;
    Object.freeze(this);
  }

  public toString(): string {
    return `MpesaConfig(shortCode=${JSON.stringify(this.shortCode)}, consumerKey=<redacted>, consumerSecret=<redacted>, passkey=<redacted>, environment=${JSON.stringify(this.environment)})`;
  }

  public [inspect.custom](): string {
    return this.toString();
  }

  public toJSON(): Record<string, unknown> {
    return {
      shortCode: this.shortCode,
      consumerKey: "<redacted>",
      consumerSecret: "<redacted>",
      passkey: "<redacted>",
      environment: this.environment,
      baseUrl: this.baseUrl,
    };
  }
}

export interface MpesaStkPushResponse {
  readonly merchantRequestId: string;
  readonly checkoutRequestId: string;
  readonly responseCode: string;
  readonly responseDescription: string;
}

export interface MpesaStkQueryResponse {
  readonly checkoutRequestId: string;
  readonly resultCode: string | number | null;
  readonly resultDesc: string;
}

export interface MpesaB2CResponse {
  readonly conversationId: string;
  readonly originatorConversationId: string;
  readonly responseCode: string;
  readonly responseDescription: string;
}

export interface MpesaTransactionStatusParams {
  transactionId?: string | null;
  originalConversationId?: string | null;
  identifierType?: "1" | "2" | "4";
  remarks?: string;
  occasion?: string;
  callbackUrl?: string | null;
  queueTimeoutUrl?: string | null;
}

export interface MpesaTransactionStatusResponse {
  readonly conversationId: string;
  readonly originatorConversationId: string;
  readonly responseCode: string;
  readonly responseDescription: string;
}

function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseMpesaToken(raw: Record<string, unknown>): [string, number] {
  const token = raw["access_token"];
  const expiresRaw = raw["expires_in"];
  if (typeof token !== "string" || !token.trim()) {
    throw new JsMomoSDKError("M-Pesa token response missing access_token", {
      provider: "M-Pesa",
    });
  }
  validateHeaderValue(token, { fieldName: "access_token" });
  let expiresIn: number;
  if (
    typeof expiresRaw === "number" &&
    Number.isInteger(expiresRaw) &&
    expiresRaw > 0
  ) {
    expiresIn = expiresRaw;
  } else if (
    typeof expiresRaw === "string" &&
    /^\d{1,12}$/.test(expiresRaw.trim()) &&
    Number(expiresRaw.trim()) > 0
  ) {
    expiresIn = Number(expiresRaw.trim());
  } else {
    throw new JsMomoSDKError("M-Pesa token response had invalid expires_in", {
      provider: "M-Pesa",
    });
  }
  return [token, expiresIn];
}

export interface MpesaClientOptions {
  fetch?: FetchLike;
  maxResponseBytes?: number;
  telemetry?: TelemetryHook | null;
}

export interface MpesaStkPushParams {
  amount: string;
  phoneNumber: string;
  accountReference?: string;
  transactionDesc?: string;
  callbackUrl?: string | null;
  transactionType?: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline" | null;
  partyB?: string | null;
}

export interface MpesaB2CParams {
  amount: string;
  phoneNumber: string;
  remarks?: string;
  occasion?: string;
  callbackUrl?: string | null;
  queueTimeoutUrl?: string | null;
  commandId?: "BusinessPayment" | "SalaryPayment" | "PromotionPayment" | null;
  originatorConversationId?: string | null;
}

/** Safaricom M-Pesa Daraja API client (STK Push, STK Query, B2C Payouts). */
export class MpesaClient {
  public readonly config: MpesaConfig;
  private readonly cache = new TokenCache();
  private readonly http: HttpClient;

  constructor(
    config: MpesaConfig | MpesaConfigOptions,
    options: MpesaClientOptions = {},
  ) {
    this.config = config instanceof MpesaConfig ? config : new MpesaConfig(config);
    this.http = new HttpClient({
      baseUrl: this.config.baseUrl,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      retryBackoff: this.config.retryBackoff,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      fetch: options.fetch,
      telemetry:
        options.telemetry !== undefined ? options.telemetry : this.config.telemetry,
      providerName: "M-Pesa",
      allowLocalhost: this.config.environment === "sandbox",
    });
  }

  private getToken = async (): Promise<string> => {
    return this.cache.getOrRefresh("mpesa", async () => {
      const response = await this.http.request(
        "GET",
        "/oauth/v1/generate?grant_type=client_credentials",
        {
          headers: {
            Authorization: buildBasicAuthHeader(
              this.config.consumerKey,
              this.config.consumerSecret,
            ),
          },
          idempotent: true,
        },
      );
      const [token, expiresIn] = parseMpesaToken(parseJsonObject(response));
      this.cache.set("mpesa", token, expiresIn);
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

  public async stkPush(params: MpesaStkPushParams): Promise<MpesaStkPushResponse> {
    const intAmount = toMpesaIntAmount(params.amount);
    const validatedRef = validateAccountReference(params.accountReference ?? "Payment");
    const validatedDesc = validateTransactionDesc(params.transactionDesc ?? "Payment");
    const resolvedTxType = params.transactionType ?? this.config.transactionType;
    if (!VALID_MPESA_TRANSACTION_TYPES.has(resolvedTxType)) {
      throw new RangeError(
        "transactionType must be 'CustomerPayBillOnline' or 'CustomerBuyGoodsOnline'",
      );
    }
    let resolvedPartyB: string;
    if (params.partyB !== undefined && params.partyB !== null) {
      if (typeof params.partyB !== "string" || !params.partyB.trim()) {
        throw new RangeError("partyB must not be blank");
      }
      resolvedPartyB = validateHeaderValue(params.partyB.trim(), {
        fieldName: "partyB",
      });
    } else {
      resolvedPartyB = this.config.partyB ?? this.config.shortCode;
    }
    const allowLocalhost = this.config.environment === "sandbox";
    if (params.callbackUrl !== undefined && params.callbackUrl !== null) {
      validateCallbackUrl(params.callbackUrl, { allowLocalhost });
    }
    const cb = params.callbackUrl ?? this.config.callbackUrl;
    if (!cb) {
      throw new RangeError("callbackUrl is required for M-Pesa STK Push");
    }
    const [password, timestamp] = buildStkPassword(
      this.config.shortCode,
      this.config.passkey,
    );
    const msisdn = normaliseMsisdn(params.phoneNumber);
    const response = await this.http.request(
      "POST",
      "/mpesa/stkpush/v1/processrequest",
      {
        headers: await this.authHeaders(validatedRef),
        json: {
          BusinessShortCode: this.config.shortCode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: resolvedTxType,
          Amount: intAmount,
          PartyA: msisdn,
          PartyB: resolvedPartyB,
          PhoneNumber: msisdn,
          CallBackURL: cb,
          AccountReference: validatedRef,
          TransactionDesc: validatedDesc,
        },
        productName: "mpesa",
        tokenCache: this.cache,
        tokenRefresher: this.getToken,
        referenceId: validatedRef,
      },
    );
    const raw = parseJsonObject(response, validatedRef);
    return Object.freeze({
      merchantRequestId: strOrEmpty(raw["MerchantRequestID"]),
      checkoutRequestId: strOrEmpty(raw["CheckoutRequestID"]),
      responseCode: strOrEmpty(raw["ResponseCode"]),
      responseDescription: strOrEmpty(raw["ResponseDescription"]),
    });
  }

  public async stkQuery(checkoutRequestId: string): Promise<MpesaStkQueryResponse> {
    if (typeof checkoutRequestId !== "string" || !checkoutRequestId.trim()) {
      throw new RangeError("checkoutRequestId must be a non-empty string");
    }
    const cleanedId = validateHeaderValue(checkoutRequestId.trim(), {
      fieldName: "checkoutRequestId",
    });
    const [password, timestamp] = buildStkPassword(
      this.config.shortCode,
      this.config.passkey,
    );
    let response;
    try {
      response = await this.http.request("POST", "/mpesa/stkpushquery/v1/query", {
        headers: await this.authHeaders(cleanedId),
        json: {
          BusinessShortCode: this.config.shortCode,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: cleanedId,
        },
        productName: "mpesa",
        tokenCache: this.cache,
        tokenRefresher: this.getToken,
        idempotent: true,
        referenceId: cleanedId,
      });
    } catch (err) {
      if (
        err instanceof JsMomoSDKServerError &&
        err.errorCode === "500.001.1001" &&
        /being\s+processed/i.test(err.reason ?? err.message)
      ) {
        return Object.freeze({
          checkoutRequestId: cleanedId,
          resultCode: null,
          resultDesc: err.reason || "The transaction is being processed",
        });
      }
      throw err;
    }
    const raw = parseJsonObject(response, cleanedId);
    const rc = raw["ResultCode"];
    return Object.freeze({
      checkoutRequestId: strOrEmpty(raw["CheckoutRequestID"]),
      resultCode: typeof rc === "string" || typeof rc === "number" ? rc : null,
      resultDesc: strOrEmpty(raw["ResultDesc"]),
    });
  }

  public async b2cTransfer(params: MpesaB2CParams): Promise<MpesaB2CResponse> {
    const intAmount = toMpesaIntAmount(params.amount);
    if (!this.config.securityCredential) {
      throw new RangeError("securityCredential is required for M-Pesa B2C payouts");
    }
    if (!this.config.initiatorName) {
      throw new RangeError("initiatorName is required for M-Pesa B2C payouts");
    }
    const resolvedCmd = params.commandId ?? this.config.commandId;
    if (!VALID_MPESA_COMMAND_IDS.has(resolvedCmd)) {
      throw new RangeError(
        "commandId must be 'BusinessPayment', 'SalaryPayment', or 'PromotionPayment'",
      );
    }
    const allowLocalhost = this.config.environment === "sandbox";
    if (params.callbackUrl !== undefined && params.callbackUrl !== null) {
      validateCallbackUrl(params.callbackUrl, { allowLocalhost });
    }
    if (params.queueTimeoutUrl !== undefined && params.queueTimeoutUrl !== null) {
      validateCallbackUrl(params.queueTimeoutUrl, { allowLocalhost });
    }
    const cb = params.callbackUrl ?? this.config.callbackUrl;
    if (!cb) {
      throw new RangeError("callbackUrl is required for M-Pesa B2C payouts");
    }
    const timeoutCb = params.queueTimeoutUrl ?? this.config.queueTimeoutUrl ?? cb;
    let origId: string;
    if (
      params.originatorConversationId !== undefined &&
      params.originatorConversationId !== null
    ) {
      if (
        typeof params.originatorConversationId !== "string" ||
        !params.originatorConversationId.trim()
      ) {
        throw new RangeError("originatorConversationId must not be blank");
      }
      origId = validateHeaderValue(params.originatorConversationId.trim(), {
        fieldName: "originatorConversationId",
      });
    } else {
      origId = generateReferenceId();
    }
    const msisdn = normaliseMsisdn(params.phoneNumber);
    const response = await this.http.request("POST", "/mpesa/b2c/v3/paymentrequest", {
      headers: await this.authHeaders(origId),
      json: {
        OriginatorConversationID: origId,
        InitiatorName: this.config.initiatorName,
        SecurityCredential: this.config.securityCredential,
        CommandID: resolvedCmd,
        Amount: intAmount,
        PartyA: this.config.shortCode,
        PartyB: msisdn,
        Remarks: params.remarks ?? "Payout",
        QueueTimeOutURL: timeoutCb,
        ResultURL: cb,
        Occasion: params.occasion ?? "Payout",
      },
      productName: "mpesa",
      tokenCache: this.cache,
      tokenRefresher: this.getToken,
      referenceId: origId,
    });
    const raw = parseJsonObject(response, origId);
    return Object.freeze({
      conversationId: strOrEmpty(raw["ConversationID"]),
      originatorConversationId: strOrEmpty(raw["OriginatorConversationID"]),
      responseCode: strOrEmpty(raw["ResponseCode"]),
      responseDescription: strOrEmpty(raw["ResponseDescription"]),
    });
  }

  /** Query the status of a Daraja transaction (e.g. B2C) asynchronously via ResultURL. */
  public async transactionStatus(
    params: MpesaTransactionStatusParams,
  ): Promise<MpesaTransactionStatusResponse> {
    if (!this.config.securityCredential) {
      throw new RangeError(
        "securityCredential is required for M-Pesa transaction status queries",
      );
    }
    if (!this.config.initiatorName) {
      throw new RangeError(
        "initiatorName is required for M-Pesa transaction status queries",
      );
    }
    const txId =
      typeof params.transactionId === "string" && params.transactionId.trim()
        ? validateHeaderValue(params.transactionId.trim(), {
            fieldName: "transactionId",
          })
        : "";
    const origConvId =
      typeof params.originalConversationId === "string" &&
      params.originalConversationId.trim()
        ? validateHeaderValue(params.originalConversationId.trim(), {
            fieldName: "originalConversationId",
          })
        : "";
    if (!txId && !origConvId) {
      throw new RangeError(
        "transactionId or originalConversationId is required for M-Pesa transaction status queries",
      );
    }
    const identifierType = params.identifierType ?? "4";
    if (!VALID_MPESA_IDENTIFIER_TYPES.has(identifierType)) {
      throw new RangeError("identifierType must be '1', '2', or '4'");
    }
    const allowLocalhost = this.config.environment === "sandbox";
    if (params.callbackUrl !== undefined && params.callbackUrl !== null) {
      validateCallbackUrl(params.callbackUrl, { allowLocalhost });
    }
    if (params.queueTimeoutUrl !== undefined && params.queueTimeoutUrl !== null) {
      validateCallbackUrl(params.queueTimeoutUrl, { allowLocalhost });
    }
    const cb = params.callbackUrl ?? this.config.callbackUrl;
    if (!cb) {
      throw new RangeError("callbackUrl is required for M-Pesa transaction status");
    }
    const timeoutCb = params.queueTimeoutUrl ?? this.config.queueTimeoutUrl ?? cb;
    const refId = txId || origConvId;
    const payload: Record<string, unknown> = {
      Initiator: this.config.initiatorName,
      SecurityCredential: this.config.securityCredential,
      CommandID: "TransactionStatusQuery",
      TransactionID: txId,
      PartyA: this.config.shortCode,
      IdentifierType: identifierType,
      ResultURL: cb,
      QueueTimeOutURL: timeoutCb,
      Remarks: params.remarks ?? "StatusQuery",
      Occasion: params.occasion ?? "StatusQuery",
    };
    if (origConvId) {
      payload["OriginalConversationID"] = origConvId;
    }
    const response = await this.http.request(
      "POST",
      "/mpesa/transactionstatus/v1/query",
      {
        headers: await this.authHeaders(refId),
        json: payload,
        productName: "mpesa",
        tokenCache: this.cache,
        tokenRefresher: this.getToken,
        idempotent: true,
        referenceId: refId,
      },
    );
    const raw = parseJsonObject(response, refId);
    return Object.freeze({
      conversationId: strOrEmpty(raw["ConversationID"]),
      originatorConversationId: strOrEmpty(raw["OriginatorConversationID"]),
      responseCode: strOrEmpty(raw["ResponseCode"]),
      responseDescription: strOrEmpty(raw["ResponseDescription"]),
    });
  }

  public close(): void {
    this.http.close();
  }
}

function readNamedValues(
  items: unknown,
  nameKey: string,
  valueKey: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const k = rec[nameKey];
      if (typeof k === "string" && k) {
        out[k] = rec[valueKey];
      }
    }
  }
  return out;
}

/** Parse a Safaricom Daraja STK Push callback payload (`Body.stkCallback`) into a `PaymentResult`. */
export function parseMpesaStkCallback(body: unknown): PaymentResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new WebhookVerificationError(
      "M-Pesa STK callback body must be a JSON object",
    );
  }
  const root = body as Record<string, unknown>;
  const bodyObj = root["Body"];
  const cbObj =
    bodyObj && typeof bodyObj === "object" && !Array.isArray(bodyObj)
      ? (bodyObj as Record<string, unknown>)["stkCallback"]
      : null;
  if (!cbObj || typeof cbObj !== "object" || Array.isArray(cbObj)) {
    throw new WebhookVerificationError(
      "M-Pesa STK callback is missing Body.stkCallback",
    );
  }
  const cb = cbObj as Record<string, unknown>;
  const checkoutRequestId = strOrEmpty(cb["CheckoutRequestID"]).trim();
  const merchantRequestId = strOrEmpty(cb["MerchantRequestID"]).trim();
  const rawCode = cb["ResultCode"];
  if (
    (!checkoutRequestId && !merchantRequestId) ||
    (typeof rawCode !== "number" && typeof rawCode !== "string")
  ) {
    throw new WebhookVerificationError(
      "M-Pesa STK callback is missing CheckoutRequestID or ResultCode",
    );
  }
  const code = String(rawCode).trim();
  const metaObj = cb["CallbackMetadata"];
  const items =
    metaObj && typeof metaObj === "object" && !Array.isArray(metaObj)
      ? readNamedValues((metaObj as Record<string, unknown>)["Item"], "Name", "Value")
      : {};
  const amountVal = items["Amount"];
  const receiptVal = items["MpesaReceiptNumber"];
  return new PaymentResult({
    provider: "mpesa",
    referenceId: checkoutRequestId || merchantRequestId,
    status: code === "0" ? NormalizedStatus.SUCCEEDED : NormalizedStatus.FAILED,
    amount:
      typeof amountVal === "number" || typeof amountVal === "string"
        ? String(amountVal)
        : null,
    currency: "KES",
    providerTransactionId:
      typeof receiptVal === "string" && receiptVal.trim() ? receiptVal.trim() : null,
    externalId: merchantRequestId || null,
    reason: strOrEmpty(cb["ResultDesc"]) || null,
    raw: root,
  });
}

/** Parse a Safaricom Daraja B2C / Transaction Status callback payload (`Result`) into a `PaymentResult`. */
export function parseMpesaB2CCallback(body: unknown): PaymentResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new WebhookVerificationError(
      "M-Pesa B2C callback body must be a JSON object",
    );
  }
  const root = body as Record<string, unknown>;
  const resObj = root["Result"];
  if (!resObj || typeof resObj !== "object" || Array.isArray(resObj)) {
    throw new WebhookVerificationError("M-Pesa B2C callback is missing Result object");
  }
  const res = resObj as Record<string, unknown>;
  const conversationId = strOrEmpty(res["ConversationID"]).trim();
  const originatorConversationId = strOrEmpty(res["OriginatorConversationID"]).trim();
  const rawCode = res["ResultCode"];
  if (
    (!conversationId && !originatorConversationId) ||
    (typeof rawCode !== "number" && typeof rawCode !== "string")
  ) {
    throw new WebhookVerificationError(
      "M-Pesa B2C callback is missing ConversationID or ResultCode",
    );
  }
  const code = String(rawCode).trim();
  const paramsObj = res["ResultParameters"];
  const params =
    paramsObj && typeof paramsObj === "object" && !Array.isArray(paramsObj)
      ? readNamedValues(
          (paramsObj as Record<string, unknown>)["ResultParameter"],
          "Key",
          "Value",
        )
      : {};
  const amountVal = params["TransactionAmount"];
  const receiptVal = params["TransactionReceipt"] ?? res["TransactionID"];
  return new PaymentResult({
    provider: "mpesa",
    referenceId: conversationId || originatorConversationId,
    status: code === "0" ? NormalizedStatus.SUCCEEDED : NormalizedStatus.FAILED,
    amount:
      typeof amountVal === "number" || typeof amountVal === "string"
        ? String(amountVal)
        : null,
    currency: "KES",
    providerTransactionId:
      typeof receiptVal === "string" && receiptVal.trim() ? receiptVal.trim() : null,
    externalId: originatorConversationId || null,
    reason: strOrEmpty(res["ResultDesc"]) || null,
    raw: root,
  });
}

function mapMpesaQuery(
  referenceId: string,
  result: MpesaStkQueryResponse,
): PaymentResult {
  const code = result.resultCode === null ? "" : String(result.resultCode).trim();
  const status = !code
    ? NormalizedStatus.PENDING
    : code === "0"
      ? NormalizedStatus.SUCCEEDED
      : NormalizedStatus.FAILED;
  return new PaymentResult({
    provider: "mpesa",
    referenceId,
    status,
    reason: result.resultDesc || null,
    raw: { ...result },
  });
}

/** Unified provider adapter for Safaricom M-Pesa. */
export class MpesaProvider implements PaymentProvider {
  public readonly name = "mpesa";
  public readonly capabilities = MPESA_CAPABILITIES;
  private readonly client: MpesaClient;

  constructor(client: MpesaClient) {
    this.client = client;
  }

  public async collect(request: PaymentRequest): Promise<PaymentResult> {
    if (request.currency.toUpperCase() !== "KES") {
      throw new RangeError(
        `Safaricom M-Pesa Daraja supports KES only, got '${request.currency}'`,
      );
    }
    const acctRef = (request.externalId.trim() || "Payment").slice(
      0,
      MAX_MPESA_ACCOUNT_REFERENCE_LEN,
    );
    const txDesc = (request.payerMessage.trim() || "Payment").slice(
      0,
      MAX_MPESA_TRANSACTION_DESC_LEN,
    );
    const res = await this.client.stkPush({
      amount: request.amount,
      phoneNumber: request.payerMsisdn,
      accountReference: acctRef,
      transactionDesc: txDesc,
      callbackUrl: request.callbackUrl,
    });
    return new PaymentResult({
      provider: this.name,
      referenceId: res.checkoutRequestId || res.merchantRequestId,
      status:
        res.responseCode === "0" ? NormalizedStatus.PENDING : NormalizedStatus.FAILED,
      amount: request.amount,
      currency: request.currency,
      externalId: request.externalId || null,
      reason: res.responseDescription || null,
      raw: { ...res },
    });
  }

  public async disburse(request: DisbursementRequest): Promise<PaymentResult> {
    if (request.currency.toUpperCase() !== "KES") {
      throw new RangeError(
        `Safaricom M-Pesa Daraja supports KES only, got '${request.currency}'`,
      );
    }
    const res = await this.client.b2cTransfer({
      amount: request.amount,
      phoneNumber: request.payeeMsisdn,
      remarks: request.payerMessage || "Payout",
      occasion: request.externalId || "Payout",
      callbackUrl: request.callbackUrl,
      originatorConversationId: request.referenceId,
    });
    return new PaymentResult({
      provider: this.name,
      referenceId: res.conversationId || res.originatorConversationId,
      status:
        res.responseCode === "0" ? NormalizedStatus.PENDING : NormalizedStatus.FAILED,
      amount: request.amount,
      currency: request.currency,
      externalId: request.externalId || null,
      reason: res.responseDescription || null,
      raw: { ...res },
    });
  }

  public async getStatus(
    referenceId: string,
    options: ProviderStatusOptions = {},
  ): Promise<PaymentResult> {
    const kind = validateOperationKind(options.kind ?? "collection");
    if (kind === "disbursement") {
      throw new JsMomoSDKError(
        "M-Pesa B2C disbursements deliver status asynchronously via callback ResultURL",
        { referenceId, provider: "M-Pesa" },
      );
    }
    const res = await this.client.stkQuery(referenceId);
    return mapMpesaQuery(referenceId, res);
  }

  public async getBalance(
    options: ProviderBalanceOptions = {},
  ): Promise<BalanceResult> {
    validateOperationKind(options.kind ?? "collection");
    throw new JsMomoSDKError(
      "M-Pesa Daraja account balance queries are callback-only and not exposed synchronously",
      { provider: "M-Pesa" },
    );
  }

  public close(): void {
    this.client.close();
  }
}
