import { inspect } from "node:util";

import { JsMomoSDKError } from "./exceptions.js";
import type { HttpResponse } from "./http.js";
import { parseJsonObject } from "./http.js";
import { validateHeaderValue } from "./utils.js";

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;
const MAX_NOTE_LENGTH = 160;

export enum TransactionStatus {
  PENDING = "PENDING",
  SUCCESSFUL = "SUCCESSFUL",
  FAILED = "FAILED",
}

export enum AccountHolderIdType {
  MSISDN = "msisdn",
  EMAIL = "email",
  PARTY_CODE = "party_code",
}

export interface Party {
  readonly partyIdType: string;
  readonly partyId: string;
}

export interface Balance {
  readonly availableBalance: string;
  readonly currency: string;
}

export interface BasicUserInfo {
  readonly sub: string | null;
  readonly name: string | null;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly birthdate: string | null;
  readonly locale: string | null;
  readonly gender: string | null;
  readonly status: string | null;
}

export interface ApiUserInfo {
  readonly providerCallbackHost: string | null;
  readonly targetEnvironment: string | null;
}

export function validateExternalId(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RangeError("externalId must be a non-empty string");
  }
  return validateHeaderValue(value, { fieldName: "externalId" });
}

export function validateNoteText(value: string, fieldName: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${fieldName} must be a string`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new RangeError(`${fieldName} must not contain control characters`);
  }
  if (value.length > MAX_NOTE_LENGTH) {
    throw new RangeError(`${fieldName} must not exceed ${MAX_NOTE_LENGTH} characters`);
  }
  return value;
}

function parsePositiveIntField(value: unknown, fieldName: string): number {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
    throw new RangeError(`${fieldName} must be a positive integer`);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  throw new RangeError(`${fieldName} must be a positive integer`);
}

function parseOptionalNonNegIntField(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0) {
      return value;
    }
    throw new RangeError(`${fieldName} must be a non-negative integer`);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  throw new RangeError(`${fieldName} must be a non-negative integer`);
}

function optionalStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseParty(raw: unknown): Party | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const partyIdType = obj["partyIdType"] ?? obj["party_id_type"];
  const partyId = obj["partyId"] ?? obj["party_id"];
  if (typeof partyIdType === "string" && typeof partyId === "string") {
    return Object.freeze({ partyIdType, partyId });
  }
  return null;
}

/** OAuth2 client-credentials token response with redacted inspect/toString/toJSON. */
export class TokenResponse {
  public readonly accessToken: string;
  public readonly tokenType: string;
  public readonly expiresIn: number;

  constructor(data: Record<string, unknown>) {
    const accessToken = data["access_token"];
    const tokenType = data["token_type"];
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new RangeError("access_token must not be empty");
    }
    validateHeaderValue(accessToken, {
      fieldName: "access_token",
      allowWhitespace: false,
    });
    if (typeof tokenType !== "string" || !tokenType.trim()) {
      throw new RangeError("token_type must not be empty");
    }
    this.accessToken = accessToken;
    this.tokenType = tokenType;
    this.expiresIn = parsePositiveIntField(data["expires_in"], "expires_in");
    Object.freeze(this);
  }

  public toString(): string {
    return `TokenResponse(accessToken=<redacted>, tokenType=${JSON.stringify(this.tokenType)}, expiresIn=${this.expiresIn})`;
  }

  public toJSON(): Record<string, unknown> {
    return {
      accessToken: "<redacted>",
      tokenType: this.tokenType,
      expiresIn: this.expiresIn,
    };
  }

  public [inspect.custom](): string {
    return this.toString();
  }
}

/** CIBA / OAuth2 user token response with redacted tokens. */
export class OAuth2TokenResponse {
  public readonly accessToken: string;
  public readonly tokenType: string;
  public readonly expiresIn: number;
  public readonly scope: string | null;
  public readonly refreshToken: string | null;
  public readonly refreshTokenExpiredIn: number | null;

  constructor(data: Record<string, unknown>) {
    const accessToken = data["access_token"];
    const tokenType = data["token_type"];
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new RangeError("access_token must not be empty");
    }
    validateHeaderValue(accessToken, {
      fieldName: "access_token",
      allowWhitespace: false,
    });
    if (typeof tokenType !== "string" || !tokenType.trim()) {
      throw new RangeError("token_type must not be empty");
    }
    const rawRefresh = data["refresh_token"];
    let refreshToken: string | null = null;
    if (rawRefresh !== undefined && rawRefresh !== null) {
      if (typeof rawRefresh !== "string" || !rawRefresh.trim()) {
        throw new RangeError("refresh_token must not be empty");
      }
      validateHeaderValue(rawRefresh, {
        fieldName: "refresh_token",
        allowWhitespace: false,
      });
      refreshToken = rawRefresh;
    }
    this.accessToken = accessToken;
    this.tokenType = tokenType;
    this.expiresIn = parsePositiveIntField(data["expires_in"], "expires_in");
    this.scope = optionalStr(data["scope"]);
    this.refreshToken = refreshToken;
    this.refreshTokenExpiredIn = parseOptionalNonNegIntField(
      data["refresh_token_expired_in"],
      "refresh_token_expired_in",
    );
    Object.freeze(this);
  }

  public toString(): string {
    const refStr = this.refreshToken !== null ? "<redacted>" : "null";
    return `OAuth2TokenResponse(accessToken=<redacted>, tokenType=${JSON.stringify(this.tokenType)}, expiresIn=${this.expiresIn}, scope=${JSON.stringify(this.scope)}, refreshToken=${refStr})`;
  }

  public toJSON(): Record<string, unknown> {
    return {
      accessToken: "<redacted>",
      tokenType: this.tokenType,
      expiresIn: this.expiresIn,
      scope: this.scope,
      refreshToken: this.refreshToken !== null ? "<redacted>" : null,
      refreshTokenExpiredIn: this.refreshTokenExpiredIn,
    };
  }

  public [inspect.custom](): string {
    return this.toString();
  }
}

/** Backchannel authorization response with redacted authReqId. */
export class BcAuthorizeResponse {
  public readonly authReqId: string;
  public readonly expiresIn: number;
  public readonly interval: number | null;

  constructor(data: Record<string, unknown>) {
    const authReqId = data["auth_req_id"];
    if (typeof authReqId !== "string" || !authReqId.trim()) {
      throw new RangeError("auth_req_id must not be empty");
    }
    validateHeaderValue(authReqId, {
      fieldName: "auth_req_id",
      allowWhitespace: false,
    });
    this.authReqId = authReqId;
    this.expiresIn = parsePositiveIntField(data["expires_in"], "expires_in");
    this.interval = parseOptionalNonNegIntField(data["interval"], "interval");
    Object.freeze(this);
  }

  public toString(): string {
    return `BcAuthorizeResponse(authReqId=<redacted>, expiresIn=${this.expiresIn}, interval=${this.interval})`;
  }

  public toJSON(): Record<string, unknown> {
    return {
      authReqId: "<redacted>",
      expiresIn: this.expiresIn,
      interval: this.interval,
    };
  }

  public [inspect.custom](): string {
    return this.toString();
  }
}

/** MTN MoMo transaction status result with ErrorReason normalization and status helpers. */
export class TransactionResult {
  public readonly financialTransactionId: string | null;
  public readonly externalId: string | null;
  public readonly amount: string | null;
  public readonly currency: string | null;
  public readonly payer: Party | null;
  public readonly payee: Party | null;
  public readonly payerMessage: string | null;
  public readonly payeeNote: string | null;
  public readonly status: TransactionStatus;
  public readonly reason: string | null;
  public readonly reasonCode: string | null;

  constructor(data: Record<string, unknown>) {
    const rawStatus = data["status"];
    if (
      rawStatus !== TransactionStatus.PENDING &&
      rawStatus !== TransactionStatus.SUCCESSFUL &&
      rawStatus !== TransactionStatus.FAILED
    ) {
      throw new RangeError("Invalid TransactionResult status");
    }

    let reason: string | null = null;
    let reasonCode: string | null = optionalStr(
      data["reasonCode"] ?? data["reason_code"],
    );
    const rawReason = data["reason"];
    if (typeof rawReason === "string") {
      reason = rawReason.trim() || null;
    } else if (
      rawReason &&
      typeof rawReason === "object" &&
      !Array.isArray(rawReason)
    ) {
      const r = rawReason as Record<string, unknown>;
      const code = typeof r["code"] === "string" ? r["code"].trim() : "";
      const msg = typeof r["message"] === "string" ? r["message"].trim() : "";
      if (code && msg) {
        reason = `${code}: ${msg}`;
      } else if (code || msg) {
        reason = code || msg;
      }
      if (code && !reasonCode) {
        reasonCode = code;
      }
    }

    this.financialTransactionId = optionalStr(
      data["financialTransactionId"] ?? data["financial_transaction_id"],
    );
    this.externalId = optionalStr(data["externalId"] ?? data["external_id"]);
    this.amount = optionalStr(data["amount"]);
    this.currency = optionalStr(data["currency"]);
    this.payer = parseParty(data["payer"]);
    this.payee = parseParty(data["payee"]);
    this.payerMessage = optionalStr(data["payerMessage"] ?? data["payer_message"]);
    this.payeeNote = optionalStr(data["payeeNote"] ?? data["payee_note"]);
    this.status = rawStatus;
    this.reason = reason;
    this.reasonCode = reasonCode;
    Object.freeze(this);
  }

  public isSuccessful(): boolean {
    return this.status === TransactionStatus.SUCCESSFUL;
  }

  public isPending(): boolean {
    return this.status === TransactionStatus.PENDING;
  }

  public isFailed(): boolean {
    return this.status === TransactionStatus.FAILED;
  }
}

/** MTN MoMo Collection PreApproval v2 status result. */
export class PreApprovalResult {
  public readonly payer: Party | null;
  public readonly payerCurrency: string | null;
  public readonly payerMessage: string | null;
  public readonly status: TransactionStatus;
  public readonly expirationDateTime: number | string | null;
  public readonly reason: string | null;
  public readonly reasonCode: string | null;

  constructor(data: Record<string, unknown>) {
    const rawStatus = data["status"];
    if (
      rawStatus !== TransactionStatus.PENDING &&
      rawStatus !== TransactionStatus.SUCCESSFUL &&
      rawStatus !== TransactionStatus.FAILED
    ) {
      throw new RangeError("Invalid PreApprovalResult status");
    }

    let reason: string | null = null;
    let reasonCode: string | null = optionalStr(
      data["reasonCode"] ?? data["reason_code"],
    );
    const rawReason = data["reason"];
    if (typeof rawReason === "string") {
      reason = rawReason.trim() || null;
    } else if (
      rawReason &&
      typeof rawReason === "object" &&
      !Array.isArray(rawReason)
    ) {
      const r = rawReason as Record<string, unknown>;
      const code = typeof r["code"] === "string" ? r["code"].trim() : "";
      const msg = typeof r["message"] === "string" ? r["message"].trim() : "";
      if (code && msg) {
        reason = `${code}: ${msg}`;
      } else if (code || msg) {
        reason = code || msg;
      }
      if (code && !reasonCode) {
        reasonCode = code;
      }
    }

    const expRaw = data["expirationDateTime"] ?? data["expiration_date_time"];
    this.payer = parseParty(data["payer"]);
    this.payerCurrency = optionalStr(data["payerCurrency"] ?? data["payer_currency"]);
    this.payerMessage = optionalStr(data["payerMessage"] ?? data["payer_message"]);
    this.status = rawStatus;
    this.expirationDateTime =
      typeof expRaw === "number" || typeof expRaw === "string" ? expRaw : null;
    this.reason = reason;
    this.reasonCode = reasonCode;
    Object.freeze(this);
  }

  public isSuccessful(): boolean {
    return this.status === TransactionStatus.SUCCESSFUL;
  }

  public isPending(): boolean {
    return this.status === TransactionStatus.PENDING;
  }

  public isFailed(): boolean {
    return this.status === TransactionStatus.FAILED;
  }
}

/** Sandbox API key response with secret redaction. */
export class ApiKeyResult {
  public readonly apiKey: string;

  constructor(data: Record<string, unknown>) {
    const apiKey = data["apiKey"] ?? data["api_key"];
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      throw new RangeError("apiKey must not be empty");
    }
    validateHeaderValue(apiKey, { fieldName: "apiKey", allowWhitespace: false });
    this.apiKey = apiKey;
    Object.freeze(this);
  }

  public toString(): string {
    return "ApiKeyResult(apiKey=<redacted>)";
  }

  public toJSON(): Record<string, string> {
    return { apiKey: "<redacted>" };
  }

  public [inspect.custom](): string {
    return this.toString();
  }
}

/** Sandbox provisioning result with secret-redacted inspect/toString/toJSON. */
export class ProvisionResult {
  public readonly apiUser: string;
  public readonly apiKey: string;

  constructor(apiUser: string, apiKey: string) {
    this.apiUser = apiUser;
    this.apiKey = apiKey;
    Object.freeze(this);
  }

  public toString(): string {
    return "ProvisionResult(apiUser=<redacted>, apiKey=<redacted>)";
  }

  public toJSON(): Record<string, string> {
    return { apiUser: "<redacted>", apiKey: "<redacted>" };
  }

  public [inspect.custom](): string {
    return this.toString();
  }
}

export function parseBalanceResponse(
  response: HttpResponse,
  referenceId?: string | null,
): Balance {
  const data = parseJsonObject(response, referenceId);
  const availableBalance = data["availableBalance"] ?? data["available_balance"];
  const currency = data["currency"];
  if (typeof availableBalance !== "string" || typeof currency !== "string") {
    throw new JsMomoSDKError("API response did not match expected Balance schema", {
      referenceId: referenceId ?? null,
      statusCode: response.status,
    });
  }
  return Object.freeze({ availableBalance, currency });
}

export function parseTransactionResultResponse(
  response: HttpResponse,
  referenceId?: string | null,
): TransactionResult {
  const data = parseJsonObject(response, referenceId);
  try {
    return new TransactionResult(data);
  } catch {
    throw new JsMomoSDKError(
      "API response did not match expected TransactionResult schema",
      { referenceId: referenceId ?? null, statusCode: response.status },
    );
  }
}

export function parsePreApprovalResultResponse(
  response: HttpResponse,
  referenceId?: string | null,
): PreApprovalResult {
  const data = parseJsonObject(response, referenceId);
  try {
    return new PreApprovalResult(data);
  } catch {
    throw new JsMomoSDKError(
      "API response did not match expected PreApprovalResult schema",
      { referenceId: referenceId ?? null, statusCode: response.status },
    );
  }
}

export function parseBasicUserInfoResponse(
  response: HttpResponse,
  referenceId?: string | null,
): BasicUserInfo {
  const data = parseJsonObject(response, referenceId);
  return Object.freeze({
    sub: optionalStr(data["sub"]),
    name: optionalStr(data["name"]),
    givenName: optionalStr(data["given_name"] ?? data["givenName"]),
    familyName: optionalStr(data["family_name"] ?? data["familyName"]),
    birthdate: optionalStr(data["birthdate"]),
    locale: optionalStr(data["locale"]),
    gender: optionalStr(data["gender"]),
    status: optionalStr(data["status"]),
  });
}

export function parseApiUserInfoResponse(
  response: HttpResponse,
  referenceId?: string | null,
): ApiUserInfo {
  const data = parseJsonObject(response, referenceId);
  return Object.freeze({
    providerCallbackHost: optionalStr(
      data["providerCallbackHost"] ?? data["provider_callback_host"],
    ),
    targetEnvironment: optionalStr(
      data["targetEnvironment"] ?? data["target_environment"],
    ),
  });
}

export function parseTokenResponse(
  response: HttpResponse,
  referenceId?: string | null,
): TokenResponse {
  const data = parseJsonObject(response, referenceId);
  try {
    return new TokenResponse(data);
  } catch {
    throw new JsMomoSDKError(
      "API response did not match expected TokenResponse schema",
      { referenceId: referenceId ?? null, statusCode: response.status },
    );
  }
}

export function parseOAuth2TokenResponse(
  response: HttpResponse,
  referenceId?: string | null,
): OAuth2TokenResponse {
  const data = parseJsonObject(response, referenceId);
  try {
    return new OAuth2TokenResponse(data);
  } catch {
    throw new JsMomoSDKError(
      "API response did not match expected OAuth2TokenResponse schema",
      { referenceId: referenceId ?? null, statusCode: response.status },
    );
  }
}

export function parseBcAuthorizeResponse(
  response: HttpResponse,
  referenceId?: string | null,
): BcAuthorizeResponse {
  const data = parseJsonObject(response, referenceId);
  try {
    return new BcAuthorizeResponse(data);
  } catch {
    throw new JsMomoSDKError(
      "API response did not match expected BcAuthorizeResponse schema",
      { referenceId: referenceId ?? null, statusCode: response.status },
    );
  }
}

export function parseApiKeyResponse(
  response: HttpResponse,
  referenceId?: string | null,
): ApiKeyResult {
  const data = parseJsonObject(response, referenceId);
  try {
    return new ApiKeyResult(data);
  } catch {
    throw new JsMomoSDKError(
      "API response did not match expected ApiKeyResult schema",
      { referenceId: referenceId ?? null, statusCode: response.status },
    );
  }
}
