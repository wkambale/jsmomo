import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  JsMomoSDKError,
  JsMomoSDKServerError,
  ResourceNotFoundError,
} from "../exceptions.js";
import type { FetchLike, HttpResponse } from "../http.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  RETRYABLE_STATUS_CODES,
  computeRetryDelay,
  extractErrorDetails,
  formatErrorDetail,
  getHeaderCI,
  isRetryableRequest,
  readBoundedResponse,
  sanitizeTelemetryPath,
} from "../http.js";
import type { TelemetryHook } from "../telemetry.js";
import { validateHeaderValue, validateRequestPath } from "../utils.js";
import { AirtelAuth } from "./auth.js";
import type { AirtelConfigOptions } from "./config.js";
import { AirtelConfig } from "./config.js";
import { AirtelCollection } from "./products/collection.js";
import { AirtelDisbursement } from "./products/disbursement.js";

function mergeAirtelHeaders(
  country: string,
  currency: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const reqHeaders: Record<string, string> = {
    "X-Country": country,
    "X-Currency": currency,
    "Content-Type": "application/json",
  };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (!key || /[\s:]/.test(key)) {
        throw new JsMomoSDKError("HTTP header name is invalid", {
          provider: "Airtel Money",
        });
      }
      try {
        validateHeaderValue(key, { fieldName: "header name" });
        validateHeaderValue(value, { fieldName: key });
      } catch (err) {
        throw new JsMomoSDKError(
          err instanceof Error ? err.message : "Invalid HTTP header",
          { provider: "Airtel Money" },
        );
      }
      const lower = key.toLowerCase();
      if (lower === "authorization") {
        continue;
      }
      for (const existingKey of Object.keys(reqHeaders)) {
        if (existingKey.toLowerCase() === lower) {
          delete reqHeaders[existingKey];
        }
      }
      reqHeaders[key] = value;
    }
  }
  return reqHeaders;
}

/** Map Airtel HTTP status codes to structured SDK exception classes. */
export function raiseForAirtelStatus(
  response: HttpResponse,
  options: { referenceId?: string | null } = {},
): void {
  const status = response.status;
  const referenceId = options.referenceId ?? null;
  if (status >= 200 && status < 300) {
    return;
  }
  if (status >= 300 && status < 400) {
    throw new JsMomoSDKError(`Unexpected Airtel redirect HTTP status: ${status}`, {
      statusCode: status,
      referenceId,
      provider: "Airtel Money",
    });
  }

  const [body, errorCode, reason] = extractErrorDetails(response);
  const detail = formatErrorDetail(errorCode, reason);

  if (status === 400) {
    const msg = detail ?? "Bad request";
    throw new BadRequestError(msg, body, {
      referenceId,
      statusCode: 400,
      errorCode,
      reason: reason ?? msg,
      provider: "Airtel Money",
    });
  }
  if (status === 401) {
    const base = "Invalid or expired Airtel credentials";
    throw new AuthenticationError(detail ? `${base}: ${detail}` : base, {
      referenceId,
      statusCode: 401,
      errorCode,
      reason: reason ?? detail,
      responseBody: body,
      provider: "Airtel Money",
    });
  }
  if (status === 403) {
    const base = "Airtel Money forbidden (HTTP 403)";
    throw new JsMomoSDKError(detail ? `${base}: ${detail}` : base, {
      referenceId,
      statusCode: 403,
      errorCode,
      reason: reason ?? detail ?? "Forbidden",
      responseBody: body,
      provider: "Airtel Money",
    });
  }
  if (status === 404) {
    const base = "Resource not found";
    throw new ResourceNotFoundError(detail ? `${base}: ${detail}` : base, {
      referenceId,
      statusCode: 404,
      errorCode,
      reason: reason ?? detail,
      responseBody: body,
      provider: "Airtel Money",
    });
  }
  if (status === 409) {
    const msg = detail ?? "Duplicate transaction reference";
    throw new ConflictError(msg, {
      referenceId,
      statusCode: 409,
      errorCode,
      reason: reason ?? msg,
      responseBody: body,
      provider: "Airtel Money",
    });
  }
  if (status === 422) {
    const msg = detail ?? "Unprocessable entity (HTTP 422)";
    throw new BadRequestError(msg, body, {
      referenceId,
      statusCode: 422,
      errorCode,
      reason: reason ?? msg,
      provider: "Airtel Money",
    });
  }
  if (status === 429) {
    const base = "Airtel Money rate limit exceeded (HTTP 429)";
    throw new JsMomoSDKError(detail ? `${base}: ${detail}` : base, {
      referenceId,
      statusCode: 429,
      errorCode,
      reason: reason ?? detail ?? "Rate limit exceeded",
      responseBody: body,
      provider: "Airtel Money",
    });
  }
  if (status >= 500) {
    const base = `Airtel server error: ${status}`;
    throw new JsMomoSDKServerError(detail ? `${base} (${detail})` : base, {
      referenceId,
      statusCode: status,
      errorCode,
      reason: reason ?? detail,
      responseBody: body,
      provider: "Airtel Money",
    });
  }
  const base = `Unexpected Airtel HTTP status: ${status}`;
  throw new JsMomoSDKError(detail ? `${base} (${detail})` : base, {
    referenceId,
    statusCode: status,
    errorCode,
    reason: reason ?? detail,
    responseBody: body,
    provider: "Airtel Money",
  });
}

export interface AirtelClientOptions {
  fetch?: FetchLike;
  maxResponseBytes?: number;
  telemetry?: TelemetryHook | null;
  sleepFn?: (seconds: number) => Promise<void>;
}

function defaultSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)));
}

/** Airtel Money Open API client with Collection & Disbursement products. */
export class AirtelClient {
  public readonly config: AirtelConfig;
  private readonly baseUrl: string;
  private readonly auth: AirtelAuth;
  private readonly fetchImpl: FetchLike;
  private readonly maxResponseBytes: number;
  private readonly telemetry: TelemetryHook | null;
  private readonly sleepFn: (seconds: number) => Promise<void>;
  private _collection: AirtelCollection | null = null;
  private _disbursement: AirtelDisbursement | null = null;

  constructor(
    config: AirtelConfig | AirtelConfigOptions,
    options: AirtelClientOptions = {},
  ) {
    this.config = config instanceof AirtelConfig ? config : new AirtelConfig(config);
    const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("maxResponseBytes must be a positive integer");
    }
    this.baseUrl = this.config.baseUrl.replace(/\/+$/, "");
    this.maxResponseBytes = maxBytes;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.telemetry =
      options.telemetry !== undefined ? options.telemetry : this.config.telemetry;
    this.sleepFn = options.sleepFn ?? defaultSleep;
    this.auth = new AirtelAuth(
      this.config.clientId,
      this.config.clientSecret,
      this.baseUrl,
      { timeout: this.config.timeout, maxResponseBytes: this.maxResponseBytes },
    );
  }

  public get collection(): AirtelCollection {
    if (!this._collection) {
      this._collection = new AirtelCollection(this);
    }
    return this._collection;
  }

  public get disbursement(): AirtelDisbursement {
    if (!this._disbursement) {
      this._disbursement = new AirtelDisbursement(this);
    }
    return this._disbursement;
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
    if (!this.telemetry) return;
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
      // Ignore telemetry failures
    }
  }

  private async executeBounded(
    method: string,
    path: string,
    headers: Record<string, string>,
    jsonBody?: unknown,
  ): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, this.config.timeout * 1000);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    try {
      const raw = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
        redirect: "manual",
        signal: controller.signal,
      });
      return await readBoundedResponse(raw, this.maxResponseBytes);
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendWithRetries(
    method: string,
    path: string,
    params: {
      headers: Record<string, string>;
      json?: unknown;
      timeoutMsg: string;
      connMsg: string;
      referenceId?: string | null;
    },
  ): Promise<HttpResponse> {
    const canRetry =
      this.config.maxRetries > 0 && isRetryableRequest(method, params.headers);
    const attempts = canRetry ? this.config.maxRetries + 1 : 1;
    const correlationId =
      params.referenceId ?? getHeaderCI(params.headers, "X-Reference-Id");

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const started = performance.now();
      let response: HttpResponse;
      try {
        response = await this.executeBounded(method, path, params.headers, params.json);
      } catch (err) {
        if (err instanceof JsMomoSDKError) {
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
          if (err.provider === null) {
            err.provider = "Airtel Money";
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
          await this.sleepFn(
            computeRetryDelay(attempt, this.config.retryBackoff, null),
          );
          continue;
        }
        throw new JsMomoSDKError(
          isTimeout
            ? `${params.timeoutMsg} (${excName})`
            : `${params.connMsg} (${excName})`,
          {
            referenceId: correlationId,
            reason: excName,
            provider: "Airtel Money",
          },
        );
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
          computeRetryDelay(attempt, this.config.retryBackoff, response.headers),
        );
        continue;
      }
      return response;
    }

    throw new JsMomoSDKError(params.connMsg, {
      referenceId: correlationId,
      provider: "Airtel Money",
    });
  }

  public async request(
    method: string,
    path: string,
    options: {
      headers?: Record<string, string>;
      json?: unknown;
      referenceId?: string | null;
    } = {},
  ): Promise<HttpResponse> {
    if (typeof method !== "string" || !/^[A-Za-z]+$/.test(method)) {
      throw new JsMomoSDKError("HTTP method must be a valid ASCII token", {
        referenceId: options.referenceId ?? null,
        provider: "Airtel Money",
      });
    }
    const upper = method.toUpperCase();
    validateRequestPath(path);
    const reqHeaders = mergeAirtelHeaders(
      this.config.country,
      this.config.currency,
      options.headers,
    );
    const effectiveRef =
      options.referenceId ?? getHeaderCI(reqHeaders, "X-Reference-Id");

    let token: string;
    try {
      token = await this.auth.getToken(this.fetchImpl);
    } catch (err) {
      if (
        err instanceof JsMomoSDKError &&
        err.referenceId === null &&
        effectiveRef !== null
      ) {
        err.referenceId = effectiveRef;
      }
      throw err;
    }
    reqHeaders["Authorization"] = `Bearer ${token}`;

    const safePath = sanitizeTelemetryPath(path);
    let response = await this.sendWithRetries(upper, path, {
      headers: reqHeaders,
      json: options.json,
      timeoutMsg: `Airtel request timed out: ${upper} ${safePath}`,
      connMsg: `Airtel connection error: ${upper} ${safePath}`,
      referenceId: effectiveRef,
    });

    if (response.status === 401) {
      this.auth.invalidate({ expectedToken: token });
      let newToken: string;
      try {
        newToken = await this.auth.getToken(this.fetchImpl);
      } catch {
        throw new AuthenticationError(
          "Airtel authentication failed during token refresh",
          {
            referenceId: effectiveRef,
            statusCode: 401,
            provider: "Airtel Money",
          },
        );
      }
      const retryHeaders = { ...reqHeaders, Authorization: `Bearer ${newToken}` };
      response = await this.sendWithRetries(upper, path, {
        headers: retryHeaders,
        json: options.json,
        timeoutMsg: `Airtel request timed out on retry: ${upper} ${safePath}`,
        connMsg: `Airtel connection error on retry: ${upper} ${safePath}`,
        referenceId: effectiveRef,
      });
    }

    raiseForAirtelStatus(response, { referenceId: effectiveRef });
    return response;
  }

  public close(): void {
    // Lifecycle parity
  }
}
