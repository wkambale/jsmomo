import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import {
  AIRTEL_PRODUCTION_BASE_URL,
  AIRTEL_SANDBOX_BASE_URL,
  AirtelAuth,
  AirtelClient,
  AirtelConfig,
  checkAirtelResponseStatus,
  encryptAirtelPin,
  normaliseAirtelMsisdn,
  parseAirtelTokenPayload,
} from "../../src/airtel/index.js";
import { parseAirtelTransactionResponse } from "../../src/airtel/models.js";
import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  JsMomoSDKError,
  JsMomoSDKServerError,
  ResourceNotFoundError,
  TransactionFailedError,
} from "../../src/exceptions.js";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Airtel Money SDK", () => {
  it("encrypts PINs with real RSA-2048 PKCS#1 v1.5 and rejects plaintext PINs in production", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const encrypted = encryptAirtelPin("1234", publicKey);
    const decrypted = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(encrypted, "base64"),
    ).toString("utf8");
    expect(decrypted).toBe("1234");

    // Production config accepts valid encrypted PIN and rejects plaintext numeric PIN
    const prodCfg = new AirtelConfig({
      clientId: "cid",
      clientSecret: "csec",
      country: "ug",
      currency: "ugx",
      environment: "production",
      pin: encrypted,
    });
    expect(prodCfg.baseUrl).toBe(AIRTEL_PRODUCTION_BASE_URL);
    expect(prodCfg.country).toBe("UG");
    expect(prodCfg.currency).toBe("UGX");
    expect(inspect(prodCfg)).not.toContain("csec");
    expect(inspect(prodCfg)).not.toContain(encrypted);
    expect(prodCfg.toJSON()["pin"]).toBe("<redacted>");

    expect(
      () =>
        new AirtelConfig({
          clientId: "cid",
          clientSecret: "csec",
          country: "UG",
          currency: "UGX",
          environment: "production",
          pin: "1234",
        }),
    ).toThrow("RSA-encrypted Base64 PIN");

    expect(
      () =>
        new AirtelConfig({
          clientId: "cid",
          clientSecret: "csec",
          country: "UG",
          currency: "UGX",
          environment: "production",
          pin: Buffer.from("short").toString("base64"),
        }),
    ).toThrow("too short");
  });

  it("normalises Airtel subscriber MSISDNs across countries and inspects HTTP 200 rejections", () => {
    expect(normaliseAirtelMsisdn("+256 752 123 456", "UG")).toBe("752123456");
    expect(normaliseAirtelMsisdn("0752123456", "UG")).toBe("752123456");
    expect(normaliseAirtelMsisdn("254733123456", "KE")).toBe("733123456");

    expect(() =>
      checkAirtelResponseStatus(
        {
          data: { transaction: { status: "TF", message: "Insufficient balance" } },
          status: {
            success: false,
            result_code: "DP00800001001",
            message: "Transaction failed",
          },
        },
        { referenceId: "air-tx-1" },
      ),
    ).toThrow(TransactionFailedError);

    expect(() =>
      checkAirtelResponseStatus(
        {
          status: {
            success: false,
            code: "400",
            result_code: "DP00800001006",
            message: "Invalid amount",
          },
        },
        { referenceId: "air-tx-2" },
      ),
    ).toThrow(BadRequestError);

    expect(() =>
      checkAirtelResponseStatus(
        {
          status: {
            success: false,
            result_code: "DP00800001099",
            message: "Limit exceeded",
          },
        },
        { referenceId: "air-tx-3" },
      ),
    ).toThrow(JsMomoSDKError);
  });

  it("executes Collection, Disbursement, Balance, 401 refresh, and preserves referenceId on errors", async () => {
    let tokenFetches = 0;
    let firstPayCall = true;
    const client = new AirtelClient(
      {
        clientId: "cid",
        clientSecret: "csec",
        country: "UG",
        currency: "UGX",
        pin: "sandbox-pin",
      },
      {
        fetch: async (url, init) => {
          if (url === `${AIRTEL_SANDBOX_BASE_URL}/auth/oauth2/token`) {
            tokenFetches += 1;
            return jsonResp({
              access_token: `air-tok-${tokenFetches}`,
              expires_in: 3600,
            });
          }
          if (url.endsWith("/merchant/v1/payments/")) {
            if (firstPayCall) {
              firstPayCall = false;
              return jsonResp({ message: "Token expired" }, 401);
            }
            const parsed = JSON.parse(String(init?.body));
            expect(parsed.subscriber.msisdn).toBe("752123456");
            return jsonResp({
              status: { code: "200", message: "OK", success: true },
              data: { transaction: { id: parsed.transaction.id, status: "TIP" } },
            });
          }
          if (url.includes("/standard/v1/payments/")) {
            return jsonResp({
              status: { code: "200", message: "OK", result_code: "00", success: true },
              data: { transaction: { id: "ORDER-1", status: "TS" } },
            });
          }
          if (url.endsWith("/standard/v1/disbursements/")) {
            return jsonResp({
              status: { code: "200", message: "OK", success: true },
              data: { transaction: { id: "DISB-1", status: "TIP" } },
            });
          }
          if (url.includes("/standard/v1/disbursements/")) {
            return jsonResp({
              status: { code: "200", message: "OK", result_code: "02", success: true },
              data: { transaction: { id: "DISB-1", status: "TIP" } },
            });
          }
          if (url.endsWith("/merchant/v2/wallets/balance/")) {
            return jsonResp({
              status: { code: "200", message: "OK", success: true },
              data: {
                wallet: {
                  msisdn: "750000000",
                  balance: "45000",
                  currency: "UGX",
                  status: "ACTIVE",
                },
              },
            });
          }
          return jsonResp({}, 404);
        },
      },
    );

    const colRef = await client.collection.requestToPay({
      amount: "5000",
      payerMsisdn: "+256752123456",
      referenceId: "ORDER-1",
    });
    expect(colRef).toBe("ORDER-1");
    expect(tokenFetches).toBe(2); // 401 triggered refresh once

    const colStatus = await client.collection.getPaymentStatus("ORDER-1");
    expect(colStatus.isSuccessful()).toBe(true);
    expect(colStatus.isPending()).toBe(false);
    expect(colStatus.isFailed()).toBe(false);

    const disbRef = await client.disbursement.transfer({
      amount: "5000",
      payeeMsisdn: "+256752123456",
      referenceId: "DISB-1",
      transactionType: "B2C",
      walletType: "NORMAL",
    });
    expect(disbRef).toBe("DISB-1");
    const disbStatus = await client.disbursement.getTransferStatus("DISB-1");
    expect(disbStatus.isPending()).toBe(true);

    const bal = await client.disbursement.getBalance();
    expect(bal.data.wallet.balance).toBe("45000");
    client.close();
  });

  it("maps Airtel HTTP 400/401/403/404/409/422/429/500 and transport errors with referenceId", async () => {
    const statusExpectations: Array<
      [number, new (...args: never[]) => JsMomoSDKError]
    > = [
      [400, BadRequestError],
      [403, JsMomoSDKError],
      [404, ResourceNotFoundError],
      [409, ConflictError],
      [422, BadRequestError],
      [429, JsMomoSDKError],
      [500, JsMomoSDKServerError],
    ];

    for (const [status, ErrCls] of statusExpectations) {
      let seenRef = "";
      const c = new AirtelClient(
        { clientId: "cid", clientSecret: "csec", country: "UG", currency: "UGX" },
        {
          fetch: async (url, init) => {
            if (url.endsWith("/auth/oauth2/token")) {
              return jsonResp({ access_token: "tok", expires_in: 3600 });
            }
            const parsed = JSON.parse(String(init?.body));
            seenRef = parsed.transaction.id;
            return jsonResp(
              { status: { result_code: "DP00800001006", message: `Err ${status}` } },
              status,
            );
          },
        },
      );
      await expect(
        c.collection.requestToPay({ amount: "1000", payerMsisdn: "256752123456" }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ErrCls);
        const e = err as JsMomoSDKError;
        expect(e.referenceId).toBe(seenRef);
        expect(e.statusCode).toBe(status);
        expect(e.provider).toBe("Airtel Money");
        return true;
      });
    }

    // Token endpoint 401 preserves referenceId
    const badAuth = new AirtelClient(
      { clientId: "cid", clientSecret: "bad", country: "UG", currency: "UGX" },
      {
        fetch: async () =>
          jsonResp({ error: "invalid_client", error_description: "Wrong secret" }, 401),
      },
    );
    await expect(
      badAuth.collection.requestToPay({
        amount: "1000",
        payerMsisdn: "256752123456",
        referenceId: "AIR-401-REF",
      }),
    ).rejects.toMatchObject({
      name: AuthenticationError.name,
      referenceId: "AIR-401-REF",
      errorCode: "invalid_client",
    });

    // Timeout preserves referenceId and subtype
    const timeoutClient = new AirtelClient(
      { clientId: "cid", clientSecret: "csec", country: "UG", currency: "UGX" },
      {
        fetch: async (url) => {
          if (url.endsWith("/auth/oauth2/token")) {
            return jsonResp({ access_token: "tok", expires_in: 3600 });
          }
          throw new DOMException("aborted", "TimeoutError");
        },
      },
    );
    await expect(
      timeoutClient.collection.requestToPay({
        amount: "1000",
        payerMsisdn: "256752123456",
        referenceId: "AIR-TO-REF",
      }),
    ).rejects.toMatchObject({
      referenceId: "AIR-TO-REF",
      reason: "TimeoutError",
      provider: "Airtel Money",
    });
  });

  it("handles AirtelAuth token validation edge cases and network errors", async () => {
    const mkResp = (status: number, text: string) => ({
      status,
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode(text),
      text: () => text,
      json: () => JSON.parse(text),
    });

    expect(() => parseAirtelTokenPayload(mkResp(302, "{}"))).toThrow(
      AuthenticationError,
    );
    expect(() =>
      parseAirtelTokenPayload(mkResp(500, JSON.stringify({ message: "down" }))),
    ).toThrow("down");
    expect(() => parseAirtelTokenPayload(mkResp(200, "not-json"))).toThrow(
      "valid JSON",
    );
    expect(() => parseAirtelTokenPayload(mkResp(200, "[]"))).toThrow(
      "did not contain token data",
    );
    expect(() => parseAirtelTokenPayload(mkResp(200, JSON.stringify({})))).toThrow(
      "did not contain token data",
    );
    expect(() =>
      parseAirtelTokenPayload(
        mkResp(200, JSON.stringify({ access_token: "bad\r\ntok", expires_in: 60 })),
      ),
    ).toThrow("invalid access_token");
    expect(() =>
      parseAirtelTokenPayload(
        mkResp(200, JSON.stringify({ access_token: "ok", expires_in: 0 })),
      ),
    ).toThrow("invalid expires_in");
    expect(() =>
      parseAirtelTokenPayload(
        mkResp(200, JSON.stringify({ access_token: "ok", expires_in: "abc" })),
      ),
    ).toThrow("invalid expires_in");
    expect(() =>
      parseAirtelTokenPayload(
        mkResp(200, JSON.stringify({ access_token: "ok", expires_in: "0" })),
      ),
    ).toThrow("invalid expires_in");
    expect(
      parseAirtelTokenPayload(
        mkResp(200, JSON.stringify({ access_token: "ok", expires_in: "180" })),
      ),
    ).toEqual(["ok", 180]);

    const auth = new AirtelAuth("cid", "secret-val", AIRTEL_SANDBOX_BASE_URL);
    expect(inspect(auth)).not.toContain("secret-val");
    expect(auth.toString()).toContain("<redacted>");

    await expect(
      auth.getToken(async () => {
        throw new TypeError("offline");
      }),
    ).rejects.toMatchObject({ reason: "TypeError", provider: "Airtel Money" });

    await expect(
      auth.getToken(async () => {
        throw new DOMException("aborted", "TimeoutError");
      }),
    ).rejects.toMatchObject({ reason: "TimeoutError", provider: "Airtel Money" });
  });

  it("handles AirtelClient retries, header validation, telemetry, redirects, oversize, and disbursement edge cases", async () => {
    const events: Array<{ statusCode: number | null; errorType: string | null }> = [];
    let getAttempts = 0;
    const client = new AirtelClient(
      {
        clientId: "cid",
        clientSecret: "csec",
        country: "UG",
        currency: "UGX",
        maxRetries: 1,
        retryBackoff: 0.001,
        telemetry: {
          onRequest: (e) => {
            events.push({ statusCode: e.statusCode, errorType: e.errorType });
          },
          onWebhook: () => {},
        },
      },
      {
        sleepFn: async () => {},
        fetch: async (url, init) => {
          if (url.endsWith("/auth/oauth2/token")) {
            return jsonResp({ access_token: "tok", expires_in: 3600 });
          }
          if (url.includes("/standard/v1/payments/RETRY-OK")) {
            getAttempts += 1;
            if (getAttempts === 1) {
              return jsonResp({ message: "busy" }, 503);
            }
            const headers = init?.headers as Record<string, string>;
            expect(headers["Authorization"]).toBe("Bearer tok");
            return jsonResp({
              status: { code: "200", message: "OK", success: true },
              data: { transaction: { id: "RETRY-OK", status: "TF" } },
            });
          }
          if (url.includes("/standard/v1/payments/REDIR")) {
            return new Response(null, { status: 302 });
          }
          if (url.includes("/standard/v1/payments/TEAPOT")) {
            return jsonResp({ message: "weird" }, 418);
          }
          if (url.includes("/standard/v1/payments/CONN")) {
            throw new TypeError("socket closed");
          }
          return jsonResp({}, 404);
        },
      },
    );

    // Invalid method & invalid header name/value
    await expect(client.request("BAD METHOD", "/test")).rejects.toThrow("ASCII token");
    await expect(
      client.request("GET", "/test", { headers: { "Bad Header": "1" } }),
    ).rejects.toThrow("header name is invalid");
    await expect(
      client.request("GET", "/test", { headers: { "X-Custom": "bad\r\nval" } }),
    ).rejects.toThrow(JsMomoSDKError);

    // Authorization override ignored + 503 retry succeeds + TF failed status
    const res = await client.request("GET", "/standard/v1/payments/RETRY-OK", {
      headers: { Authorization: "Bearer spoof", "X-Country": "UG" },
    });
    expect(res.status).toBe(200);
    expect(getAttempts).toBe(2);
    const parsed = parseAirtelTransactionResponse(res);
    expect(parsed.isFailed()).toBe(true);
    expect(parsed.isSuccessful()).toBe(false);
    expect(parsed.isPending()).toBe(false);

    // 302 redirect & 418 unexpected status & connection retry exhaustion
    await expect(client.collection.getPaymentStatus("REDIR")).rejects.toThrow(
      "redirect",
    );
    await expect(client.collection.getPaymentStatus("TEAPOT")).rejects.toThrow("418");
    await expect(client.collection.getPaymentStatus("CONN")).rejects.toMatchObject({
      reason: "TypeError",
      provider: "Airtel Money",
    });
    expect(events.length).toBeGreaterThan(0);

    // Disbursement without PIN throws
    await expect(
      client.disbursement.transfer({ amount: "1000", payeeMsisdn: "256752123456" }),
    ).rejects.toThrow(/pin is required/i);

    // 401 refresh failure preserves referenceId
    let authCalls = 0;
    const refreshFailClient = new AirtelClient(
      { clientId: "cid", clientSecret: "csec", country: "UG", currency: "UGX" },
      {
        fetch: async (url) => {
          if (url.endsWith("/auth/oauth2/token")) {
            authCalls += 1;
            if (authCalls === 1) {
              return jsonResp({ access_token: "tok1", expires_in: 3600 });
            }
            return jsonResp({ message: "revoked" }, 401);
          }
          return jsonResp({ message: "expired" }, 401);
        },
      },
    );
    await expect(
      refreshFailClient.collection.requestToPay({
        amount: "1000",
        payerMsisdn: "256752123456",
        referenceId: "REFRESH-FAIL-REF",
      }),
    ).rejects.toMatchObject({
      name: AuthenticationError.name,
      referenceId: "REFRESH-FAIL-REF",
      statusCode: 401,
    });

    // Oversize response attaches referenceId and telemetry
    const bigClient = new AirtelClient(
      { clientId: "cid", clientSecret: "csec", country: "UG", currency: "UGX" },
      {
        maxResponseBytes: 128,
        fetch: async (url) => {
          if (url.endsWith("/auth/oauth2/token")) {
            return jsonResp({ access_token: "tok", expires_in: 3600 });
          }
          return new Response("x".repeat(512), { status: 200 });
        },
      },
    );
    await expect(
      bigClient.collection.requestToPay({
        amount: "1000",
        payerMsisdn: "256752123456",
        referenceId: "BIG-REF",
      }),
    ).rejects.toMatchObject({
      referenceId: "BIG-REF",
      provider: "Airtel Money",
    });

    // Invalid maxResponseBytes rejected
    expect(
      () =>
        new AirtelClient(
          { clientId: "cid", clientSecret: "csec", country: "UG", currency: "UGX" },
          { maxResponseBytes: 0 },
        ),
    ).toThrow(RangeError);
  });
});
