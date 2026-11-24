import { inspect } from "node:util";

// eslint-disable-next-line no-control-regex
const UNSAFE_MSG_CHAR_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g;
const MAX_ERROR_MESSAGE_LEN = 512;

const SENSITIVE_BODY_KEYS: ReadonlySet<string> = new Set([
  "accesstoken",
  "refreshtoken",
  "token",
  "idtoken",
  "apikey",
  "clientsecret",
  "consumersecret",
  "subscriptionkey",
  "ocpapimsubscriptionkey",
  "secret",
  "secretkey",
  "webhooksecret",
  "webhookhash",
  "passkey",
  "password",
  "pin",
  "authorization",
  "securitycredential",
  "authreqid",
  "merchantkey",
  "paytoken",
  "notiftoken",
]);

export interface AttemptedReference {
  provider: string;
  referenceId: string | null;
}

export interface JsMomoSDKErrorOptions {
  referenceId?: string | null;
  statusCode?: number | null;
  errorCode?: string | null;
  reason?: string | null;
  responseBody?: Record<string, unknown> | null;
  provider?: string | null;
  attemptedReferences?: AttemptedReference[];
}

/**
 * Strip ASCII control / newline characters and cap length on server-controlled messages.
 */
export function sanitizeErrorMessage(
  message: string,
  defaultMessage = "Bad request",
): string {
  const cleaned = String(message).replace(UNSAFE_MSG_CHAR_RE, " ").trim();
  if (cleaned.length > MAX_ERROR_MESSAGE_LEN) {
    return `${cleaned.slice(0, MAX_ERROR_MESSAGE_LEN - 3).trimEnd()}...`;
  }
  return cleaned || defaultMessage;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "<truncated>";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = k.toLowerCase().replace(/[_-]/g, "");
      if (SENSITIVE_BODY_KEYS.has(normalizedKey)) {
        out[k] = "<redacted>";
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Return a copy of an upstream response dictionary with sensitive keys recursively redacted.
 */
export function redactResponseBody(
  body: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  const redacted = redactValue(body);
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return {};
}

/** Base exception for all JS MoMo SDK errors. */
export class JsMomoSDKError extends Error {
  public referenceId: string | null;
  public readonly statusCode: number | null;
  public readonly errorCode: string | null;
  public readonly reason: string | null;
  public readonly responseBody: Record<string, unknown>;
  public provider: string | null;
  public attemptedReferences: AttemptedReference[];

  constructor(message = "", options: JsMomoSDKErrorOptions = {}) {
    const safeMessage = message ? sanitizeErrorMessage(message, "") : "";
    super(safeMessage);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);

    this.referenceId = options.referenceId ?? null;
    this.statusCode = options.statusCode ?? null;
    this.errorCode =
      options.errorCode !== undefined && options.errorCode !== null
        ? sanitizeErrorMessage(options.errorCode, "") || null
        : null;
    this.reason =
      options.reason !== undefined && options.reason !== null
        ? sanitizeErrorMessage(options.reason, "") || null
        : null;
    this.responseBody = redactResponseBody(options.responseBody);
    this.provider = options.provider ?? null;
    this.attemptedReferences = options.attemptedReferences
      ? options.attemptedReferences.map((a) => ({ ...a }))
      : [];
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      referenceId: this.referenceId,
      statusCode: this.statusCode,
      errorCode: this.errorCode,
      reason: this.reason,
      provider: this.provider,
      attemptedReferences: this.attemptedReferences,
    };
  }

  public [inspect.custom](): string {
    const parts: string[] = [JSON.stringify(this.message)];
    if (this.referenceId !== null) {
      parts.push(`referenceId=${JSON.stringify(this.referenceId)}`);
    }
    if (this.statusCode !== null) {
      parts.push(`statusCode=${this.statusCode}`);
    }
    if (this.errorCode !== null) {
      parts.push(`errorCode=${JSON.stringify(this.errorCode)}`);
    }
    if (this.provider !== null) {
      parts.push(`provider=${JSON.stringify(this.provider)}`);
    }
    return `${this.name}(${parts.join(", ")})`;
  }
}

/** Raised when authentication or token acquisition fails (HTTP 401). */
export class AuthenticationError extends JsMomoSDKError {}

/** Raised when a product is accessed without configured credentials. */
export class MissingCredentialsError extends JsMomoSDKError {}

/** Raised on HTTP 400 or 422. Carries structured reason and redacted response body. */
export class BadRequestError extends JsMomoSDKError {
  constructor(
    message: string,
    responseBody?: Record<string, unknown> | null,
    options: Omit<JsMomoSDKErrorOptions, "responseBody"> = {},
  ) {
    const safeMessage = sanitizeErrorMessage(message, "Bad request");
    super(safeMessage, {
      ...options,
      statusCode: options.statusCode !== undefined ? options.statusCode : 400,
      reason: options.reason ?? safeMessage,
      responseBody,
    });
  }
}

/** Raised on HTTP 404. */
export class ResourceNotFoundError extends JsMomoSDKError {}

/** Raised on HTTP 409 (duplicate request reference / conflict). */
export class ConflictError extends JsMomoSDKError {
  constructor(message: string, options: JsMomoSDKErrorOptions = {}) {
    super(message, {
      ...options,
      statusCode: options.statusCode !== undefined ? options.statusCode : 409,
    });
  }
}

/** Raised on HTTP 5xx from an upstream payment gateway API. */
export class JsMomoSDKServerError extends JsMomoSDKError {}

/** Raised when a polled or synchronous transaction resolves to FAILED status. */
export class TransactionFailedError extends JsMomoSDKError {
  constructor(
    referenceId: string,
    reason?: string | null,
    options: Omit<JsMomoSDKErrorOptions, "referenceId" | "reason"> = {},
  ) {
    const safeReason =
      reason !== undefined && reason !== null
        ? sanitizeErrorMessage(reason, "") || null
        : null;
    const msg = `Transaction ${referenceId} failed${safeReason ? `: ${safeReason}` : ""}`;
    super(msg, {
      ...options,
      referenceId,
      reason: safeReason,
    });
  }
}

/** Raised when a webhook payload fails signature, IP, replay, or format verification. */
export class WebhookVerificationError extends JsMomoSDKError {}
