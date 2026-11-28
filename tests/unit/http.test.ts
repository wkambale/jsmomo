import { describe, expect, it } from "vitest";

import { TokenCache } from "../../src/auth.js";
import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  JsMomoSDKError,
  JsMomoSDKServerError,
  ResourceNotFoundError,
} from "../../src/exceptions.js";
import {
  HttpClient,
  computeRetryDelay,
  parseJsonObject,
  parseRetryAfter,
  readBoundedResponse,
  sanitizeTelemetryPath,
} from "../../src/http.js";
import type { RequestTelemetryEvent, TelemetryHook } from "../../src/telemetry.js";

function jsonResp(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("HttpClient and error extraction", () => {
  it("extracts structured codes and reasons across all 7 gateway schemas and HTTP statuses", async () => {
    const cases: Array<{
      status: number;
      body: unknown;
      provider: string;
      expectedErr: new (...args: never[]) => JsMomoSDKError;
      expectedCode?: string;
      matchMsg: string;
      ref?: string;
    }> = [
      {
        status: 400,
        body: { code: "INVALID_CALLBACK_URL_HOST", message: "Host mismatch" },
        provider: "MTN MoMo",
        expectedErr: BadRequestError,
        expectedCode: "INVALID_CALLBACK_URL_HOST",
        matchMsg: "INVALID_CALLBACK_URL_HOST: Host mismatch",
        ref: "ref-mtn-1",
      },
      {
        status: 400,
        body: { errorCode: "400.002.02", errorMessage: "Invalid Amount" },
        provider: "M-Pesa",
        expectedErr: BadRequestError,
        expectedCode: "400.002.02",
        matchMsg: "400.002.02: Invalid Amount",
      },
      {
        status: 422,
        body: {
          code: "validation-error",
          message: "Bad payload",
          details: [{ loc: ["amount"], msg: "must be positive" }],
        },
        provider: "Wave",
        expectedErr: BadRequestError,
        expectedCode: "validation-error",
        matchMsg: "amount: must be positive",
      },
      {
        status: 400,
        body: {
          status: false,
          message: "Validation failed",
          errors: { email: ["must be valid"] },
        },
        provider: "Paystack",
        expectedErr: BadRequestError,
        matchMsg: "email: must be valid",
      },
      {
        status: 400,
        body: { status: { result_code: "DP00800001006", message: "Bad MSISDN" } },
        provider: "Airtel Money",
        expectedErr: BadRequestError,
        expectedCode: "DP00800001006",
        matchMsg: "DP00800001006: Bad MSISDN",
      },
      {
        status: 401,
        body: { error: "invalid_client", error_description: "Secret expired" },
        provider: "Orange Money",
        expectedErr: AuthenticationError,
        expectedCode: "invalid_client",
        matchMsg: "Invalid or expired credentials: invalid_client: Secret expired",
      },
      {
        status: 403,
        body: { code: "FORBIDDEN_SCOPE", message: "Missing scope" },
        provider: "MTN MoMo",
        expectedErr: JsMomoSDKError,
        expectedCode: "FORBIDDEN_SCOPE",
        matchMsg: "MTN MoMo forbidden (HTTP 403): FORBIDDEN_SCOPE: Missing scope",
      },
      {
        status: 404,
        body: { code: "NOT_FOUND", message: "Tx missing" },
        provider: "MTN MoMo",
        expectedErr: ResourceNotFoundError,
        expectedCode: "NOT_FOUND",
        matchMsg: "Resource not found: NOT_FOUND: Tx missing",
      },
      {
        status: 409,
        body: { code: "DUPLICATE_REF", message: "Already used" },
        provider: "MTN MoMo",
        expectedErr: ConflictError,
        expectedCode: "DUPLICATE_REF",
        matchMsg: "Duplicate X-Reference-Id: DUPLICATE_REF: Already used",
        ref: "dup-409",
      },
      {
        status: 429,
        body: { code: "RATE_LIMIT", message: "Slow down" },
        provider: "Wave",
        expectedErr: JsMomoSDKError,
        expectedCode: "RATE_LIMIT",
        matchMsg: "Wave rate limit exceeded (HTTP 429): RATE_LIMIT: Slow down",
      },
      {
        status: 500,
        body: { code: "INTERNAL_ERROR", message: "Ledger offline" },
        provider: "MTN MoMo",
        expectedErr: JsMomoSDKServerError,
        expectedCode: "INTERNAL_ERROR",
        matchMsg: "MTN MoMo server error: 500 (INTERNAL_ERROR: Ledger offline)",
      },
      {
        status: 418,
        body: { message: "Teapot" },
        provider: "Wave",
        expectedErr: JsMomoSDKError,
        matchMsg: "Unexpected HTTP status: 418 (Teapot)",
      },
    ];

    for (const tc of cases) {
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        providerName: tc.provider,
        fetch: async () => jsonResp(tc.body, tc.status),
      });
      await expect(
        client.request("POST", "/v1/test", {
          headers: tc.ref ? { "X-Reference-Id": tc.ref } : {},
          referenceId: tc.ref,
        }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(tc.expectedErr);
        const e = err as JsMomoSDKError;
        expect(e.statusCode).toBe(tc.status);
        expect(e.provider).toBe(tc.provider);
        expect(e.message).toContain(tc.matchMsg);
        if (tc.expectedCode) {
          expect(e.errorCode).toBe(tc.expectedCode);
        }
        if (tc.ref) {
          expect(e.referenceId).toBe(tc.ref);
        }
        return true;
      });
    }
  });

  it("handles plain-text errors, suppresses HTML error pages, and rejects 3xx redirects", async () => {
    const plainClient = new HttpClient({
      baseUrl: "https://api.example.com",
      providerName: "Wave",
      fetch: async () =>
        new Response("Maintenance window active", {
          status: 503,
          headers: { "content-type": "text/plain" },
        }),
    });
    await expect(
      plainClient.request("GET", "/v1/balance", { headers: {} }),
    ).rejects.toMatchObject({
      name: JsMomoSDKServerError.name,
      reason: "Maintenance window active",
    });

    const htmlClient = new HttpClient({
      baseUrl: "https://api.example.com",
      providerName: "Wave",
      fetch: async () =>
        new Response("<!DOCTYPE html><html><body>502 Bad Gateway</body></html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    });
    await expect(
      htmlClient.request("GET", "/v1/balance", { headers: {} }),
    ).rejects.toMatchObject({
      message: "Wave server error: 502",
      reason: null,
    });

    const list400Client = new HttpClient({
      baseUrl: "https://api.example.com",
      fetch: async () => jsonResp(["not", "an", "object"], 400),
    });
    await expect(
      list400Client.request("GET", "/v1/bad", { headers: {} }),
    ).rejects.toMatchObject({
      name: BadRequestError.name,
      message: "Bad request",
      responseBody: {},
    });

    const redirectClient = new HttpClient({
      baseUrl: "https://api.example.com",
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.com" },
        }),
    });
    await expect(
      redirectClient.request("GET", "/v1/balance", { headers: {} }),
    ).rejects.toThrow("Unexpected redirect HTTP status: 302");
  });

  it("enforces streaming maxResponseBytes, retries idempotent requests with Retry-After, and emits redacted telemetry", async () => {
    // 1. Streaming chunked response exceeding maxResponseBytes
    const events: RequestTelemetryEvent[] = [];
    const hook: TelemetryHook = {
      onRequest: (e) => events.push(e),
      onWebhook: () => {},
    };
    const streamClient = new HttpClient({
      baseUrl: "https://api.example.com",
      maxResponseBytes: 32,
      telemetry: hook,
      providerName: "MTN MoMo",
      fetch: async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(20));
            controller.enqueue(new Uint8Array(20));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    await expect(
      streamClient.request(
        "GET",
        "/collection/v1_0/accountholder/msisdn/256771234567/active?debug=1",
        {
          headers: {},
          referenceId: "ref-big",
        },
      ),
    ).rejects.toMatchObject({
      referenceId: "ref-big",
      provider: "MTN MoMo",
    });
    expect(events[0]?.errorType).toBe("ResponseTooLargeError");
    expect(events[0]?.path).toBe(
      "/collection/v1_0/accountholder/msisdn/<redacted>/active",
    );
    expect(sanitizeTelemetryPath("/v1_0/apiuser/1111-2222/apikey")).toBe(
      "/v1_0/apiuser/<redacted>/apikey",
    );

    // 2. Retry-After parsing & clamping
    expect(parseRetryAfter("60")).toBe(30);
    expect(parseRetryAfter("0")).toBe(0);
    const futureDate = new Date(Date.now() + 8000).toUTCString();
    const parsedDate = parseRetryAfter(futureDate);
    expect(parsedDate).not.toBeNull();
    expect(parsedDate!).toBeGreaterThanOrEqual(4);
    expect(parsedDate!).toBeLessThanOrEqual(10);
    expect(computeRetryDelay(0, 0.5, new Headers({ "Retry-After": "0" }))).toBe(0);

    // 3. Idempotent retry succeeds after 503; non-idempotent POST does NOT retry
    let calls = 0;
    const retryClient = new HttpClient({
      baseUrl: "https://api.example.com",
      maxRetries: 2,
      retryBackoff: 0.01,
      sleepFn: async () => {},
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("busy", { status: 503 });
        }
        return jsonResp({ ok: true }, 200);
      },
    });
    const ok = await retryClient.request("GET", "/v1/status", { headers: {} });
    expect(ok.status).toBe(200);
    expect(calls).toBe(2);

    let postCalls = 0;
    const noRetryPost = new HttpClient({
      baseUrl: "https://api.example.com",
      maxRetries: 2,
      sleepFn: async () => {},
      fetch: async () => {
        postCalls += 1;
        return new Response("busy", { status: 503 });
      },
    });
    await expect(
      noRetryPost.request("POST", "/v1/write", {
        headers: { "X-Reference-Id": "ref-auto" },
        idempotent: false,
      }),
    ).rejects.toThrow(JsMomoSDKServerError);
    expect(postCalls).toBe(1);

    // 4. Issue #47: HTTP 500 is NOT retried even on GET, and PUT/DELETE are NOT retried by default
    let calls500 = 0;
    const noRetry500 = new HttpClient({
      baseUrl: "https://api.example.com",
      maxRetries: 2,
      retryBackoff: 0.01,
      sleepFn: async () => {},
      fetch: async () => {
        calls500 += 1;
        return new Response("internal error", { status: 500 });
      },
    });
    await expect(
      noRetry500.request("GET", "/v1/status", { headers: {} }),
    ).rejects.toThrow(JsMomoSDKServerError);
    expect(calls500).toBe(1);

    let unsafeMethodCalls = 0;
    const noRetryUnsafe = new HttpClient({
      baseUrl: "https://api.example.com",
      maxRetries: 2,
      retryBackoff: 0.01,
      sleepFn: async () => {},
      fetch: async () => {
        unsafeMethodCalls += 1;
        return new Response("busy", { status: 503 });
      },
    });
    await expect(
      noRetryUnsafe.request("PUT", "/v1/resource", { headers: {} }),
    ).rejects.toThrow(JsMomoSDKServerError);
    await expect(
      noRetryUnsafe.request("DELETE", "/v1/resource", { headers: {} }),
    ).rejects.toThrow(JsMomoSDKServerError);
    expect(unsafeMethodCalls).toBe(2);
  });

  it("handles CAS 401 refresh, timeout/network subtypes, and parseJsonObject with referenceId", async () => {
    const cache = new TokenCache();
    cache.set("collection", "fresh_T2", 3600);
    let sawCached: string | null = null;
    const authClient = new HttpClient({
      baseUrl: "https://api.example.com",
      providerName: "MTN MoMo",
      fetch: async (_url, init) => {
        const auth = (init?.headers as Record<string, string>)?.["Authorization"];
        if (auth === "Bearer T3") {
          return jsonResp({ ok: true }, 200);
        }
        return jsonResp({ message: "Expired" }, 401);
      },
    });
    const res = await authClient.request("GET", "/v1/balance", {
      headers: { Authorization: "bearer stale_T1" },
      productName: "collection",
      tokenCache: cache,
      tokenRefresher: async () => {
        sawCached = cache.get("collection");
        return "T3";
      },
    });
    expect(res.status).toBe(200);
    expect(sawCached).toBe("fresh_T2");

    // Timeout and network errors preserve subtype and referenceId
    const timeoutClient = new HttpClient({
      baseUrl: "https://api.example.com",
      providerName: "Wave",
      fetch: async () => {
        throw new DOMException("aborted", "TimeoutError");
      },
    });
    await expect(
      timeoutClient.request("POST", "/v1/pay", {
        headers: {},
        referenceId: "ref-to-1",
      }),
    ).rejects.toMatchObject({
      referenceId: "ref-to-1",
      reason: "TimeoutError",
      provider: "Wave",
    });

    const netClient = new HttpClient({
      baseUrl: "https://api.example.com",
      providerName: "Wave",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(
      netClient.request("POST", "/v1/pay", {
        headers: {},
        referenceId: "ref-net-1",
      }),
    ).rejects.toMatchObject({
      referenceId: "ref-net-1",
      reason: "TypeError",
      provider: "Wave",
    });

    // parseJsonObject rejects invalid JSON and non-object JSON while preserving referenceId
    const badJson = await readBoundedResponse(new Response("<html>bad</html>"), 1024);
    expect(() => parseJsonObject(badJson, "ref-parse-1")).toThrow(JsMomoSDKError);
    try {
      parseJsonObject(badJson, "ref-parse-1");
    } catch (e) {
      expect((e as JsMomoSDKError).referenceId).toBe("ref-parse-1");
    }
    const arrJson = await readBoundedResponse(jsonResp([1, 2, 3]), 1024);
    expect(() => parseJsonObject(arrJson, "ref-parse-2")).toThrow("non-object JSON");

    // Content-Length header oversize rejected before streaming
    const clOversize = new HttpClient({
      baseUrl: "https://api.example.com",
      maxResponseBytes: 16,
      fetch: async () =>
        new Response("x".repeat(32), {
          status: 200,
          headers: { "content-length": "32" },
        }),
    });
    await expect(
      clOversize.request("GET", "/v1/cl", { headers: {}, referenceId: "ref-cl" }),
    ).rejects.toMatchObject({ referenceId: "ref-cl" });

    // 401 token refresh failing with 503 preserves JsMomoSDKServerError and referenceId
    const refresh503 = new HttpClient({
      baseUrl: "https://api.example.com",
      providerName: "MTN MoMo",
      fetch: async () => jsonResp({ message: "Expired" }, 401),
    });
    await expect(
      refresh503.request("POST", "/v1/pay", {
        headers: { Authorization: "Bearer old" },
        productName: "collection",
        tokenCache: new TokenCache(),
        tokenRefresher: async () => {
          throw new JsMomoSDKServerError("MTN MoMo server error: 503", {
            statusCode: 503,
            provider: "MTN MoMo",
          });
        },
        referenceId: "ref-503-refresh",
      }),
    ).rejects.toMatchObject({
      name: JsMomoSDKServerError.name,
      referenceId: "ref-503-refresh",
    });

    // 401 token refresh failing with AuthenticationError wraps cleanly with referenceId
    await expect(
      refresh503.request("POST", "/v1/pay", {
        headers: { Authorization: "Bearer old" },
        productName: "collection",
        tokenCache: new TokenCache(),
        tokenRefresher: async () => {
          throw new AuthenticationError("bad creds");
        },
        referenceId: "ref-401-refresh",
      }),
    ).rejects.toMatchObject({
      name: AuthenticationError.name,
      referenceId: "ref-401-refresh",
    });
    refresh503.close();
  });

  it("validates HTTP method and headers upfront without retrying local errors (Issue #45)", async () => {
    let fetchCalls = 0;
    const client = new HttpClient({
      baseUrl: "https://api.example.com",
      providerName: "MTN MoMo",
      maxRetries: 3,
      retryBackoff: 0.001,
      sleepFn: async () => {},
      fetch: async () => {
        fetchCalls += 1;
        return jsonResp({ ok: true });
      },
    });

    await expect(
      client.request("BAD METHOD", "/v1/test", {
        headers: {},
        idempotent: true,
        referenceId: "ref-bad-method",
      }),
    ).rejects.toMatchObject({
      name: JsMomoSDKError.name,
      referenceId: "ref-bad-method",
      provider: "MTN MoMo",
    });

    await expect(
      client.request("GET", "/v1/test", {
        headers: { "Bad Header": "value" },
        idempotent: true,
        referenceId: "ref-bad-hdr-name",
      }),
    ).rejects.toMatchObject({
      name: JsMomoSDKError.name,
      referenceId: "ref-bad-hdr-name",
    });

    await expect(
      client.request("GET", "/v1/test", {
        headers: { "X-Custom": "val\r\nInjected: 1" },
        idempotent: true,
        referenceId: "ref-crlf",
      }),
    ).rejects.toMatchObject({
      name: JsMomoSDKError.name,
      referenceId: "ref-crlf",
    });

    expect(fetchCalls).toBe(0);
    client.close();
  });

  it("redacts MTN and Airtel subscriber identifiers in sanitizeTelemetryPath while preserving balance paths (Issue #93)", () => {
    expect(
      sanitizeTelemetryPath(
        "/collection/v1_0/accountholder/msisdn/256772123456/active?foo=bar",
      ),
    ).toBe("/collection/v1_0/accountholder/msisdn/<redacted>/active");
    expect(
      sanitizeTelemetryPath("/v1_0/apiuser/550e8400-e29b-41d4-a716-446655440000"),
    ).toBe("/v1_0/apiuser/<redacted>");
    expect(sanitizeTelemetryPath("/standard/v1/users/772123456?country=UG")).toBe(
      "/standard/v1/users/<redacted>",
    );
    expect(sanitizeTelemetryPath("/standard/v1/users/balance")).toBe(
      "/standard/v1/users/balance",
    );
    expect(
      sanitizeTelemetryPath("/collection/v2_0/user/256772123456/basicuserinfo"),
    ).toBe("/collection/v2_0/user/<redacted>/basicuserinfo");
  });
});
