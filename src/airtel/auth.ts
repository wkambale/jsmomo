import { inspect } from "node:util";

import { TokenCache } from "../auth.js";
import { AuthenticationError, JsMomoSDKError } from "../exceptions.js";
import type { FetchLike, HttpResponse } from "../http.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  extractErrorDetails,
  formatErrorDetail,
  readBoundedResponse,
} from "../http.js";
import { validateBaseUrl, validateHeaderValue, validateTimeout } from "../utils.js";

const MAX_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

/** Validate an Airtel OAuth2 token HTTP response and return `[accessToken, expiresIn]`. */
export function parseAirtelTokenPayload(response: HttpResponse): [string, number] {
  const status = response.status;
  if (status >= 300 && status < 400) {
    throw new AuthenticationError(
      `Airtel authentication unexpected redirect: HTTP ${status}`,
      { statusCode: status, provider: "Airtel Money" },
    );
  }
  if (status === 401) {
    const [body, errorCode, reason] = extractErrorDetails(response);
    const detail = formatErrorDetail(errorCode, reason);
    const base = "Invalid or expired Airtel client credentials";
    throw new AuthenticationError(detail ? `${base}: ${detail}` : base, {
      statusCode: 401,
      errorCode,
      reason: reason ?? detail,
      responseBody: body,
      provider: "Airtel Money",
    });
  }
  if (status >= 400) {
    const [body, errorCode, reason] = extractErrorDetails(response);
    const detail = formatErrorDetail(errorCode, reason);
    const base = `Airtel authentication failed: HTTP ${status}`;
    throw new AuthenticationError(detail ? `${base} (${detail})` : base, {
      statusCode: status,
      errorCode,
      reason: reason ?? detail,
      responseBody: body,
      provider: "Airtel Money",
    });
  }

  let parsed: unknown;
  try {
    parsed = response.json();
  } catch {
    throw new AuthenticationError("Airtel OAuth response was not valid JSON", {
      statusCode: status,
      provider: "Airtel Money",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AuthenticationError("Airtel OAuth response did not contain token data", {
      statusCode: status,
      provider: "Airtel Money",
    });
  }

  const data = parsed as Record<string, unknown>;
  const token = data["access_token"];
  const expiresIn = data["expires_in"];
  if (
    typeof token !== "string" ||
    !token.trim() ||
    expiresIn === undefined ||
    expiresIn === null
  ) {
    throw new AuthenticationError("Airtel OAuth response did not contain token data", {
      statusCode: status,
      provider: "Airtel Money",
    });
  }
  try {
    validateHeaderValue(token, { fieldName: "access_token", allowWhitespace: false });
  } catch {
    throw new AuthenticationError(
      "Airtel OAuth response contained invalid access_token",
      { statusCode: status, provider: "Airtel Money" },
    );
  }

  let expiresInInt: number;
  if (typeof expiresIn === "number") {
    if (!Number.isInteger(expiresIn) || expiresIn <= 0) {
      throw new AuthenticationError("Airtel OAuth response had invalid expires_in", {
        statusCode: status,
        provider: "Airtel Money",
      });
    }
    expiresInInt = expiresIn;
  } else if (typeof expiresIn === "string" && /^\d{1,18}$/.test(expiresIn.trim())) {
    expiresInInt = Number(expiresIn.trim());
    if (!Number.isSafeInteger(expiresInInt) || expiresInInt <= 0) {
      throw new AuthenticationError("Airtel OAuth response had invalid expires_in", {
        statusCode: status,
        provider: "Airtel Money",
      });
    }
  } else {
    throw new AuthenticationError("Airtel OAuth response had invalid expires_in", {
      statusCode: status,
      provider: "Airtel Money",
    });
  }

  return [token, Math.min(expiresInInt, MAX_TOKEN_TTL_SECONDS)];
}

/** Airtel OAuth2 client-credentials authentication manager. */
export class AirtelAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly timeoutSec: number;
  private readonly maxResponseBytes: number;
  private readonly cache = new TokenCache();

  constructor(
    clientId: string,
    clientSecret: string,
    baseUrl: string,
    options: {
      timeout?: number;
      maxResponseBytes?: number;
      allowLocalhost?: boolean;
    } = {},
  ) {
    if (typeof clientId !== "string" || !clientId.trim()) {
      throw new RangeError("clientId must be a non-empty string");
    }
    if (typeof clientSecret !== "string" || !clientSecret.trim()) {
      throw new RangeError("clientSecret must be a non-empty string");
    }
    validateHeaderValue(clientId, { fieldName: "clientId" });
    validateHeaderValue(clientSecret, { fieldName: "clientSecret" });
    const validatedBaseUrl = validateBaseUrl(baseUrl, {
      allowLocalhost: options.allowLocalhost ?? true,
    });
    const timeout = validateTimeout(options.timeout ?? 30.0);
    const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("maxResponseBytes must be a positive integer");
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl = validatedBaseUrl.replace(/\/+$/, "");
    this.timeoutSec = timeout;
    this.maxResponseBytes = maxBytes;
  }

  public async getToken(fetchImpl: FetchLike = globalThis.fetch): Promise<string> {
    return this.cache.getOrRefresh("airtel", async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new DOMException("Request timed out", "TimeoutError"));
      }, this.timeoutSec * 1000);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }

      let response: HttpResponse;
      try {
        const raw = await fetchImpl(`${this.baseUrl}/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: "client_credentials",
          }),
          redirect: "manual",
          signal: controller.signal,
        });
        response = await readBoundedResponse(raw, this.maxResponseBytes);
      } catch (err) {
        if (err instanceof JsMomoSDKError) {
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
        throw new JsMomoSDKError(
          isTimeout
            ? `Airtel authentication request timed out (${excName})`
            : `Airtel authentication request connection error (${excName})`,
          { reason: excName, provider: "Airtel Money" },
        );
      } finally {
        clearTimeout(timer);
      }

      const [token, expiresIn] = parseAirtelTokenPayload(response);
      this.cache.set("airtel", token, expiresIn);
      return token;
    });
  }

  public invalidate(options: { expectedToken?: string | null } = {}): void {
    this.cache.invalidate("airtel", { expectedToken: options.expectedToken });
  }

  public toString(): string {
    return `AirtelAuth(clientId=${JSON.stringify(this.clientId)}, clientSecret=<redacted>, baseUrl=${JSON.stringify(this.baseUrl)})`;
  }

  public toJSON(): Record<string, unknown> {
    return {
      clientId: this.clientId,
      clientSecret: "<redacted>",
      baseUrl: this.baseUrl,
    };
  }

  public [inspect.custom](): string {
    return this.toString();
  }
}
