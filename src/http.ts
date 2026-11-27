import { randomInt } from "node:crypto";

import type { TokenCache } from "./auth.js";
import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  JsMomoSDKError,
  JsMomoSDKServerError,
  ResourceNotFoundError,
} from "./exceptions.js";
import type { TelemetryHook } from "./telemetry.js";
import {
  validateBaseUrl,
  validateHeaderValue,
  validateMaxRetries,
  validateRequestPath,
  validateRetryBackoff,
  validateTimeout,
} from "./utils.js";

export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576; // 1 MiB
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  429, 502, 503, 504,
]);
const SAFE_RETRY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const PII_PATH_RE = /(\/accountholder\/[^/]+\/)[^/]+/gi;
const APIUSER_PATH_RE = /(\/v1_0\/apiuser\/)[^/]+/gi;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  text(): string;
  json(): unknown;
}

class BoundedHttpResponse implements HttpResponse {
  public readonly status: number;
  public readonly headers: Headers;
  public readonly body: Uint8Array;
  private decodedText: string | null = null;

  constructor(status: number, headers: Headers, body: Uint8Array) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }

  public text(): string {
    if (this.decodedText === null) {
      this.decodedText = new TextDecoder("utf-8").decode(this.body);
    }
    return this.decodedText;
  }

  public json(): unknown {
    return JSON.parse(this.text());
  }
}

class ResponseTooLargeError extends JsMomoSDKError {}

/** Strip query strings and redact sensitive identifiers before logging or emitting telemetry. */
export function sanitizeTelemetryPath(path: string): string {
  const withoutQuery = path.split("?", 1)[0] ?? path;
  const redactedPii = withoutQuery.replace(PII_PATH_RE, "$1<redacted>");
  return redactedPii.replace(APIUSER_PATH_RE, "$1<redacted>");
}

export function getHeaderCI(
  headers: Record<string, string>,
  name: string,
): string | null {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return v;
    }
  }
  return null;
}

export function extractBearerToken(headers: Record<string, string>): string | null {
  const auth = getHeaderCI(headers, "Authorization");
  if (!auth) {
    return null;
  }
  const match = auth.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1]! : null;
}

export function isRetryableRequest(
  method: string,
  headers: Record<string, string>,
  idempotent?: boolean | null,
): boolean {
  if (idempotent !== undefined && idempotent !== null) {
    return Boolean(idempotent);
  }
  const upper = method.toUpperCase();
  if (SAFE_RETRY_METHODS.has(upper)) {
    return true;
  }
  if (upper === "POST") {
    const ref = getHeaderCI(headers, "X-Reference-Id");
    const idem = getHeaderCI(headers, "Idempotency-Key");
    return Boolean((ref && ref.trim()) || (idem && idem.trim()));
  }
  return false;
}

/** Parse RFC 9110 Retry-After delay-seconds or HTTP-date into clamped seconds (<=30s). */
export function parseRetryAfter(rawValue: string): number | null {
  const stripped = rawValue.trim();
  if (!stripped) {
    return null;
  }
  if (/^\d+(?:\.\d+)?$/.test(stripped)) {
    const parsed = Number(stripped);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(parsed, 30.0);
    }
    return null;
  }
  const parsedMs = Date.parse(stripped);
  if (!Number.isNaN(parsedMs)) {
    const deltaSec = (parsedMs - Date.now()) / 1000;
    return Math.min(Math.max(deltaSec, 0.0), 30.0);
  }
  return null;
}

export function computeRetryDelay(
  attempt: number,
  baseBackoff: number,
  headers: Headers | null,
): number {
  if (headers) {
    const retryAfter = headers.get("retry-after");
    if (retryAfter !== null) {
      const parsed = parseRetryAfter(retryAfter);
      if (parsed !== null) {
        if (parsed === 0) {
          return 0;
        }
        const maxJitterMs = Math.floor(Math.min(250, parsed * 100));
        const jitter = maxJitterMs > 0 ? randomInt(0, maxJitterMs) / 1000 : 0;
        return Math.min(parsed + jitter, 30.0);
      }
    }
  }
  const jitter = randomInt(0, 250) / 1000;
  const exp = Math.min(Math.max(attempt, 0), 30);
  return Math.min(baseBackoff * 2 ** exp + jitter, 30.0);
}

function cleanText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  return null;
}

function summarizeValidationDetails(raw: unknown): string | null {
  if (Array.isArray(raw) && raw.length > 0) {
    const items: string[] = [];
    for (const entry of raw.slice(0, 5)) {
      if (typeof entry === "string" && entry.trim()) {
        items.push(entry.trim());
      } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const rec = entry as Record<string, unknown>;
        const loc = rec["loc"] ?? rec["field"] ?? rec["param"];
        const msg = rec["msg"] ?? rec["message"] ?? rec["reason"] ?? rec["detail"];
        const locStr = Array.isArray(loc)
          ? loc.map(String).join(".")
          : typeof loc === "string"
            ? loc
            : "";
        if (typeof msg === "string" && msg.trim()) {
          items.push(locStr ? `${locStr}: ${msg.trim()}` : msg.trim());
        }
      }
    }
    return items.length > 0 ? items.join("; ") : null;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 5)) {
      if (Array.isArray(v) && v.length > 0) {
        parts.push(`${k}: ${v.slice(0, 3).map(String).join(", ")}`);
      } else if (typeof v === "string" && v.trim()) {
        parts.push(`${k}: ${v.trim()}`);
      }
    }
    return parts.length > 0 ? parts.join("; ") : null;
  }
  return null;
}

/** Extract `[body, errorCode, reason]` across all 7 supported gateway error schemas. */
export function extractErrorDetails(
  response: HttpResponse,
): [Record<string, unknown>, string | null, string | null] {
  let body: Record<string, unknown> = {};
  let parsedJson = false;
  try {
    const parsed = response.json();
    parsedJson = true;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }

  if (Object.keys(body).length === 0) {
    if (parsedJson) {
      return [{}, null, null];
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml")
    ) {
      return [{}, null, null];
    }
    let rawText: string;
    try {
      rawText = response.text().trim();
    } catch {
      rawText = "";
    }
    const lower = rawText.trimStart().toLowerCase();
    if (
      rawText &&
      !lower.startsWith("<!doctype") &&
      !lower.startsWith("<html") &&
      !lower.startsWith("<head") &&
      !lower.startsWith("<body")
    ) {
      const excerpt = rawText.slice(0, 240).trim();
      return [{}, null, excerpt || null];
    }
    return [{}, null, null];
  }

  let errorCode: string | null = null;
  let reason: string | null = null;

  // 1. Nested Airtel-style data.transaction.message
  const dataObj = body["data"];
  if (dataObj && typeof dataObj === "object" && !Array.isArray(dataObj)) {
    const txObj = (dataObj as Record<string, unknown>)["transaction"];
    if (txObj && typeof txObj === "object" && !Array.isArray(txObj)) {
      reason = cleanText((txObj as Record<string, unknown>)["message"]) ?? reason;
    }
  }

  // 2. Nested status object (Airtel)
  const statusObj = body["status"];
  if (statusObj && typeof statusObj === "object" && !Array.isArray(statusObj)) {
    const s = statusObj as Record<string, unknown>;
    errorCode = cleanText(s["result_code"]) ?? cleanText(s["code"]) ?? errorCode;
    reason = cleanText(s["message"]) ?? reason;
  }

  // 3. Nested error / reason dict
  for (const key of ["error", "reason"] as const) {
    const nested = body[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const n = nested as Record<string, unknown>;
      errorCode = cleanText(n["code"]) ?? cleanText(n["errorCode"]) ?? errorCode;
      reason =
        cleanText(n["message"]) ??
        cleanText(n["description"]) ??
        cleanText(n["detail"]) ??
        reason;
    }
  }

  // 4. Top-level error code keys
  if (errorCode === null) {
    for (const key of [
      "code",
      "errorCode",
      "result_code",
      "error_code",
      "ResponseCode",
    ] as const) {
      const val = cleanText(body[key]);
      if (val !== null) {
        errorCode = val;
        break;
      }
    }
  }

  // 5. Top-level message / reason keys
  if (reason === null) {
    for (const key of [
      "message",
      "errorMessage",
      "error_description",
      "description",
      "ResponseDescription",
      "detail",
      "reason",
    ] as const) {
      const val = body[key];
      if (typeof val === "string" && val.trim()) {
        reason = val.trim();
        break;
      }
    }
  }

  // 6. Structured validation details / errors (Wave, Paystack, Flutterwave)
  const detailsSummary =
    summarizeValidationDetails(body["details"]) ??
    summarizeValidationDetails(body["errors"]);
  if (detailsSummary) {
    if (reason && !reason.includes(detailsSummary)) {
      reason = `${reason} (${detailsSummary})`;
    } else if (!reason) {
      reason = detailsSummary;
    }
  }

  // 7. OAuth2 top-level string "error" (Orange, Airtel)
  const topError = body["error"];
  if (typeof topError === "string" && topError.trim()) {
    if (errorCode === null && reason !== null) {
      errorCode = topError.trim();
    } else if (reason === null) {
      reason = topError.trim();
    }
  }

  return [body, errorCode, reason];
}

export function formatErrorDetail(
  errorCode: string | null,
  reason: string | null,
): string | null {
  if (errorCode && reason) {
    if (reason.includes(errorCode)) {
      return reason;
    }
    return `${errorCode}: ${reason}`;
  }
  return reason ?? errorCode;
}

/** Map HTTP status codes to structured SDK exception classes. */
export function raiseForStatus(
  response: HttpResponse,
  options: { providerName?: string | null; referenceId?: string | null } = {},
): void {
  const status = response.status;
  const provider = options.providerName ?? null;
  const referenceId = options.referenceId ?? null;

  if (status >= 200 && status < 300) {
    return;
  }
  if (status >= 300 && status < 400) {
    throw new JsMomoSDKError(`Unexpected redirect HTTP status: ${status}`, {
      statusCode: status,
      referenceId,
      provider,
    });
  }

  const [body, errorCode, reason] = extractErrorDetails(response);
  const detail = formatErrorDetail(errorCode, reason);
  const label = provider ?? "Upstream API";

  if (status === 400) {
    const msg = detail ?? "Bad request";
    throw new BadRequestError(msg, body, {
      referenceId,
      statusCode: 400,
      errorCode,
      reason: reason ?? msg,
      provider,
    });
  }
  if (status === 401) {
    const base = "Invalid or expired credentials";
    const msg = detail ? `${base}: ${detail}` : base;
    throw new AuthenticationError(msg, {
      referenceId,
      statusCode: 401,
      errorCode,
      reason: reason ?? detail,
      responseBody: body,
      provider,
    });
  }
  if (status === 403) {
    const base = `${label} forbidden (HTTP 403)`;
    const msg = detail ? `${base}: ${detail}` : base;
    throw new JsMomoSDKError(msg, {
      referenceId,
      statusCode: 403,
      errorCode,
      reason: reason ?? detail ?? "Forbidden",
      responseBody: body,
      provider,
    });
  }
  if (status === 404) {
    const base = "Resource not found";
    const msg = detail ? `${base}: ${detail}` : base;
    throw new ResourceNotFoundError(msg, {
      referenceId,
      statusCode: 404,
      errorCode,
      reason: reason ?? detail,
      responseBody: body,
      provider,
    });
  }
  if (status === 409) {
    const base = "Duplicate X-Reference-Id";
    const msg = detail ? `${base}: ${detail}` : base;
    throw new ConflictError(msg, {
      referenceId,
      statusCode: 409,
      errorCode,
      reason: reason ?? detail,
      responseBody: body,
      provider,
    });
  }
  if (status === 422) {
    const msg = detail ?? "Unprocessable entity (HTTP 422)";
    throw new BadRequestError(msg, body, {
      referenceId,
      statusCode: 422,
      errorCode,
      reason: reason ?? msg,
      provider,
    });
  }
  if (status === 429) {
    const base = `${label} rate limit exceeded (HTTP 429)`;
    const msg = detail ? `${base}: ${detail}` : base;
    throw new JsMomoSDKError(msg, {
      referenceId,
      statusCode: 429,
      errorCode,
      reason: reason ?? detail ?? "Rate limit exceeded",
      responseBody: body,
      provider,
    });
  }
  if (status >= 500) {
    const base = `${label} server error: ${status}`;
    const msg = detail ? `${base} (${detail})` : base;
    throw new JsMomoSDKServerError(msg, {
      referenceId,
      statusCode: status,
      errorCode,
      reason: reason ?? detail,
      responseBody: body,
      provider,
    });
  }
  const base = `Unexpected HTTP status: ${status}`;
  const msg = detail ? `${base} (${detail})` : base;
  throw new JsMomoSDKError(msg, {
    referenceId,
    statusCode: status,
    errorCode,
    reason: reason ?? detail,
    responseBody: body,
    provider,
  });
}

/** Decode an HTTP response body as a JSON object with referenceId preservation. */
export function parseJsonObject(
  response: HttpResponse,
  referenceId?: string | null,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = response.json();
  } catch {
    throw new JsMomoSDKError("API returned invalid JSON response", {
      referenceId: referenceId ?? null,
      statusCode: response.status,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JsMomoSDKError("API returned unexpected non-object JSON response", {
      referenceId: referenceId ?? null,
      statusCode: response.status,
    });
  }
  return parsed as Record<string, unknown>;
}

/** Read a Fetch Response body safely with a hard streaming byte ceiling. */
export async function readBoundedResponse(
  rawResponse: Response,
  maxResponseBytes: number,
): Promise<HttpResponse> {
  const clHeader = rawResponse.headers.get("content-length");
  if (clHeader !== null) {
    const declared = Number(clHeader.trim());
    if (Number.isInteger(declared) && declared > maxResponseBytes) {
      await rawResponse.body?.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(
        `Response body exceeded maximum allowed size of ${maxResponseBytes} bytes`,
      );
    }
  }

  if (!rawResponse.body) {
    const buf = new Uint8Array(await rawResponse.arrayBuffer());
    if (buf.byteLength > maxResponseBytes) {
      throw new ResponseTooLargeError(
        `Response body exceeded maximum allowed size of ${maxResponseBytes} bytes`,
      );
    }
    return new BoundedHttpResponse(rawResponse.status, rawResponse.headers, buf);
  }

  const reader = rawResponse.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ResponseTooLargeError(
            `Response body exceeded maximum allowed size of ${maxResponseBytes} bytes`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new BoundedHttpResponse(rawResponse.status, rawResponse.headers, merged);
}

export interface HttpClientOptions {
  baseUrl: string;
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  maxResponseBytes?: number;
  fetch?: FetchLike;
  telemetry?: TelemetryHook | null;
  providerName?: string | null;
  allowLocalhost?: boolean;
  sleepFn?: (seconds: number) => Promise<void>;
}

export interface HttpRequestOptions {
  headers: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  productName?: string;
  tokenCache?: TokenCache;
  tokenRefresher?: () => Promise<string>;
  tokenNamespace?: string;
  idempotent?: boolean | null;
  referenceId?: string | null;
}

function sleepSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)));
}

/** Resilient native-fetch HTTP wrapper with retries, bounded reads, and structured errors. */
export class HttpClient {
  public readonly validatedBaseUrl: string;
  private readonly timeoutSec: number;
  private readonly maxRetries: number;
  private readonly retryBackoff: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: FetchLike;
  private readonly telemetry: TelemetryHook | null;
  private readonly providerName: string | null;
  private readonly sleepFn: (seconds: number) => Promise<void>;

  constructor(options: HttpClientOptions) {
    const validatedUrl = validateBaseUrl(options.baseUrl, {
      allowLocalhost: options.allowLocalhost ?? true,
    });
    const timeout = validateTimeout(options.timeout ?? 30.0);
    const maxRetries = validateMaxRetries(options.maxRetries ?? 0);
    const retryBackoff = validateRetryBackoff(options.retryBackoff ?? 0.5);
    const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("maxResponseBytes must be a positive integer");
    }

    this.validatedBaseUrl = validatedUrl.replace(/\/+$/, "");
    this.timeoutSec = timeout;
    this.maxRetries = maxRetries;
    this.retryBackoff = retryBackoff;
    this.maxResponseBytes = maxBytes;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.telemetry = options.telemetry ?? null;
    this.providerName = options.providerName ?? null;
    this.sleepFn = options.sleepFn ?? sleepSeconds;
  }

  private emitTelemetry(
    method: string,
    path: string,
    statusCode: number | null,
    startedMs: number,
    attempt: number,
    correlationId: string | null,
    errorType: string | null = null,
  ): void {
    if (!this.telemetry) {
      return;
    }
    try {
      this.telemetry.onRequest({
        method,
        path: sanitizeTelemetryPath(path),
        statusCode,
        latencyMs: performance.now() - startedMs,
        attempt,
        correlationId,
        errorType,
      });
    } catch {
      // Never allow telemetry hooks to break payment calls
    }
  }

  private async executeBounded(
    method: string,
    path: string,
    headers: Record<string, string>,
    jsonBody: unknown,
    formBody: Record<string, string> | undefined,
  ): Promise<HttpResponse> {
    const url = `${this.validatedBaseUrl}${path}`;
    let body: string | undefined;
    if (jsonBody !== undefined) {
      body = JSON.stringify(jsonBody);
    } else if (formBody !== undefined) {
      body = new URLSearchParams(formBody).toString();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, this.timeoutSec * 1000);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    try {
      const raw = await this.fetchImpl(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      return await readBoundedResponse(raw, this.maxResponseBytes);
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendWithTransientRetries(
    method: string,
    path: string,
    params: {
      headers: Record<string, string>;
      json?: unknown;
      form?: Record<string, string>;
      timeoutMsg: string;
      connMsg: string;
      idempotent?: boolean | null;
      maxRetriesOverride?: number;
      referenceId?: string | null;
    },
  ): Promise<[HttpResponse, number]> {
    const effectiveRetries =
      params.maxRetriesOverride !== undefined
        ? params.maxRetriesOverride
        : this.maxRetries;
    const canRetry =
      effectiveRetries > 0 &&
      isRetryableRequest(method, params.headers, params.idempotent);
    const attempts = canRetry ? effectiveRetries + 1 : 1;
    const correlationId =
      params.referenceId ??
      getHeaderCI(params.headers, "X-Reference-Id") ??
      getHeaderCI(params.headers, "Idempotency-Key");

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const started = performance.now();
      let response: HttpResponse;
      try {
        response = await this.executeBounded(
          method,
          path,
          params.headers,
          params.json,
          params.form,
        );
      } catch (err) {
        if (err instanceof ResponseTooLargeError) {
          this.emitTelemetry(
            method,
            path,
            null,
            started,
            attempt + 1,
            correlationId,
            "ResponseTooLargeError",
          );
          if (err.referenceId === null && correlationId !== null) {
            err.referenceId = correlationId;
          }
          if (err.provider === null && this.providerName !== null) {
            err.provider = this.providerName;
          }
          throw err;
        }
        const isTimeout =
          err instanceof Error &&
          (err.name === "TimeoutError" || err.name === "AbortError");
        const excName =
          err instanceof Error && err.name
            ? err.name
            : isTimeout
              ? "TimeoutError"
              : "NetworkError";
        this.emitTelemetry(
          method,
          path,
          null,
          started,
          attempt + 1,
          correlationId,
          isTimeout ? "TimeoutException" : "RequestError",
        );
        if (attempt + 1 < attempts) {
          await this.sleepFn(computeRetryDelay(attempt, this.retryBackoff, null));
          continue;
        }
        const msg = isTimeout
          ? `${params.timeoutMsg} (${excName})`
          : `${params.connMsg} (${excName})`;
        throw new JsMomoSDKError(msg, {
          referenceId: correlationId,
          reason: excName,
          provider: this.providerName,
        });
      }

      this.emitTelemetry(
        method,
        path,
        response.status,
        started,
        attempt + 1,
        correlationId,
      );
      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt + 1 < attempts) {
        await this.sleepFn(
          computeRetryDelay(attempt, this.retryBackoff, response.headers),
        );
        continue;
      }
      return [response, attempt + 1];
    }

    throw new JsMomoSDKError(params.connMsg, {
      referenceId: correlationId,
      provider: this.providerName,
    });
  }

  public async request(
    method: string,
    path: string,
    options: HttpRequestOptions,
  ): Promise<HttpResponse> {
    if (typeof method !== "string" || !/^[A-Za-z]+$/.test(method)) {
      throw new JsMomoSDKError("HTTP method must be a valid ASCII token", {
        referenceId: options.referenceId ?? null,
        provider: this.providerName,
      });
    }
    if (
      !options.headers ||
      typeof options.headers !== "object" ||
      Array.isArray(options.headers)
    ) {
      throw new JsMomoSDKError("HTTP headers must be a key-value object", {
        referenceId: options.referenceId ?? null,
        provider: this.providerName,
      });
    }
    for (const [key, value] of Object.entries(options.headers)) {
      if (!key || /[\s:]/.test(key)) {
        throw new JsMomoSDKError("HTTP header name is invalid", {
          referenceId: options.referenceId ?? null,
          provider: this.providerName,
        });
      }
      try {
        validateHeaderValue(key, { fieldName: "header name" });
        validateHeaderValue(value, { fieldName: key });
      } catch (err) {
        throw new JsMomoSDKError(
          err instanceof Error ? err.message : "Invalid HTTP header",
          {
            referenceId: options.referenceId ?? null,
            provider: this.providerName,
          },
        );
      }
    }
    validateRequestPath(path);
    const upper = method.toUpperCase();
    const safePath = sanitizeTelemetryPath(path);
    const effectiveRef =
      options.referenceId ??
      getHeaderCI(options.headers, "X-Reference-Id") ??
      getHeaderCI(options.headers, "Idempotency-Key");

    const [initialResponse, attemptsUsed] = await this.sendWithTransientRetries(
      upper,
      path,
      {
        headers: options.headers,
        json: options.json,
        form: options.form,
        timeoutMsg: `Request timed out: ${upper} ${safePath}`,
        connMsg: `Connection error: ${upper} ${safePath}`,
        idempotent: options.idempotent,
        referenceId: effectiveRef,
      },
    );
    let response = initialResponse;

    if (
      response.status === 401 &&
      options.tokenRefresher &&
      options.tokenCache &&
      options.productName
    ) {
      const failedToken = extractBearerToken(options.headers);
      options.tokenCache.invalidate(options.productName, {
        expectedToken: failedToken,
        namespace: options.tokenNamespace ?? "",
      });

      let newToken: string;
      try {
        newToken = await options.tokenRefresher();
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof RangeError) {
          throw new AuthenticationError("Authentication failed during token refresh", {
            referenceId: effectiveRef,
            statusCode: 401,
            provider: this.providerName,
          });
        }
        if (err instanceof JsMomoSDKError) {
          if (err.referenceId === null && effectiveRef !== null) {
            err.referenceId = effectiveRef;
          }
          throw err;
        }
        throw new AuthenticationError("Authentication failed during token refresh", {
          referenceId: effectiveRef,
          statusCode: 401,
          provider: this.providerName,
        });
      }

      const retryHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(options.headers)) {
        if (k.toLowerCase() !== "authorization") {
          retryHeaders[k] = v;
        }
      }
      retryHeaders["Authorization"] = `Bearer ${newToken}`;
      const remainingRetries = Math.max(0, this.maxRetries - (attemptsUsed - 1));

      [response] = await this.sendWithTransientRetries(upper, path, {
        headers: retryHeaders,
        json: options.json,
        form: options.form,
        timeoutMsg: `Request timed out on retry: ${upper} ${safePath}`,
        connMsg: `Connection error on retry: ${upper} ${safePath}`,
        idempotent: options.idempotent,
        maxRetriesOverride: remainingRetries,
        referenceId: effectiveRef,
      });
    }

    raiseForStatus(response, {
      providerName: this.providerName,
      referenceId: effectiveRef,
    });
    return response;
  }

  public close(): void {
    // Native fetch manages connection pools automatically; kept for lifecycle parity
  }
}
