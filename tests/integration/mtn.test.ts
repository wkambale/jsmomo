import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { JsMomoSDK } from "../../src/client.js";
import { MTN_UGANDA, SANDBOX } from "../../src/config.js";
import {
  AuthenticationError,
  JsMomoSDKError,
  JsMomoSDKServerError,
  MissingCredentialsError,
} from "../../src/exceptions.js";
import { TransactionStatus } from "../../src/models.js";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("MTN MoMo SDK (JsMomoSDK)", () => {
  it("raises MissingCredentialsError lazily when accessing unconfigured products", () => {
    const sdk = new JsMomoSDK({ environment: SANDBOX });
    expect(() => sdk.collection).toThrow(MissingCredentialsError);
    expect(() => sdk.disbursement).toThrow(MissingCredentialsError);
    expect(() => sdk.remittance).toThrow(MissingCredentialsError);
    sdk.close();
  });

  it("executes full MTN Collection, Disbursement, Remittance, and CIBA OAuth2 flows", async () => {
    const requests: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | undefined;
    }> = [];
    const sdk = new JsMomoSDK(
      {
        environment: SANDBOX,
        collection: {
          subscriptionKey: "col-sub",
          apiUser: VALID_UUID,
          apiKey: "col-key",
          callbackUrl: "https://merchant.example.com/cb",
        },
        disbursement: {
          subscriptionKey: "disb-sub",
          apiUser: VALID_UUID,
          apiKey: "disb-key",
        },
        remittance: {
          subscriptionKey: "rem-sub",
          apiUser: VALID_UUID,
          apiKey: "rem-key",
        },
      },
      {
        fetch: async (url, init) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          requests.push({
            url,
            method: init?.method ?? "GET",
            headers,
            body: typeof init?.body === "string" ? init.body : undefined,
          });
          if (url.endsWith("/oauth2/token/")) {
            return jsonResp({
              access_token: "user-tok-secret",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "refresh-secret-1",
              refresh_token_expired_in: 86400,
            });
          }
          if (url.endsWith("/token/")) {
            return jsonResp({
              access_token: "mtn-access-tok",
              token_type: "access_token",
              expires_in: 3600,
            });
          }
          if (url.endsWith("/requesttopay") || url.endsWith("/requesttowithdraw")) {
            return new Response(null, { status: 202 });
          }
          if (url.includes("/requesttopay/") || url.includes("/requesttowithdraw/")) {
            return jsonResp({
              financialTransactionId: "fin-1",
              externalId: "ord-1",
              amount: "1000",
              currency: "UGX",
              status: "FAILED",
              reason: { code: "PAYER_NOT_FOUND", message: "Payer wallet inactive" },
            });
          }
          if (
            url.endsWith("/account/balance") ||
            url.endsWith("/account/balance/UGX")
          ) {
            return jsonResp({ availableBalance: "250000", currency: "UGX" });
          }
          if (url.endsWith("/active")) {
            return jsonResp({ result: true });
          }
          if (url.endsWith("/basicuserinfo")) {
            return jsonResp({
              given_name: "Ada",
              family_name: "Lovelace",
              locale: "en_UG",
            });
          }
          if (url.endsWith("/bc-authorize")) {
            return jsonResp({
              auth_req_id: "secret-auth-req-1",
              expires_in: 300,
              interval: 5,
            });
          }
          if (url.endsWith("/oauth2/token/")) {
            return jsonResp({
              access_token: "user-tok-secret",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "refresh-secret-1",
              refresh_token_expired_in: 86400,
            });
          }
          if (
            url.endsWith("/transfer") ||
            url.endsWith("/deposit") ||
            url.endsWith("/refund")
          ) {
            return new Response(null, { status: 202 });
          }
          if (
            url.includes("/transfer/") ||
            url.includes("/deposit/") ||
            url.includes("/refund/")
          ) {
            return jsonResp({
              financialTransactionId: "fin-2",
              externalId: "ext-2",
              amount: "500",
              currency: "UGX",
              status: "SUCCESSFUL",
            });
          }
          return new Response("not found", { status: 404 });
        },
      },
    );

    // Collection
    const payRef = await sdk.collection.requestToPay({
      amount: "1000",
      currency: "UGX",
      payerMsisdn: "+256 771 234 567",
      externalId: "ord-1",
      payerMessage: "Order 1",
      payeeNote: "Thanks",
    });
    const payStatus = await sdk.collection.getPaymentStatus(payRef);
    expect(payStatus.status).toBe(TransactionStatus.FAILED);
    expect(payStatus.isFailed()).toBe(true);
    expect(payStatus.isPending()).toBe(false);
    expect(payStatus.isSuccessful()).toBe(false);
    expect(payStatus.reasonCode).toBe("PAYER_NOT_FOUND");
    expect(payStatus.reason).toBe("PAYER_NOT_FOUND: Payer wallet inactive");

    const wRef = await sdk.collection.requestToWithdraw({
      amount: "1000",
      currency: "UGX",
      payerMsisdn: "256771234567",
      externalId: "wd-1",
    });
    await sdk.collection.getWithdrawStatus(wRef);

    expect((await sdk.collection.getBalance()).availableBalance).toBe("250000");
    expect((await sdk.collection.getBalanceForCurrency("ugx")).currency).toBe("UGX");
    expect(await sdk.collection.isAccountHolderActive("256771234567")).toBe(true);
    expect((await sdk.collection.getBasicUserInfo("256771234567")).givenName).toBe(
      "Ada",
    );
    expect(
      (await sdk.collection.getBasicUserInfoByReference(VALID_UUID)).familyName,
    ).toBe("Lovelace");

    const bc = await sdk.collection.bcAuthorize({ loginHint: "256771234567" });
    expect(bc.authReqId).toBe("secret-auth-req-1");
    expect(inspect(bc)).not.toContain("secret-auth-req-1");

    const oauth = await sdk.collection.createOAuth2Token({ authReqId: bc.authReqId });
    expect(oauth.accessToken).toBe("user-tok-secret");
    expect(inspect(oauth)).not.toContain("user-tok-secret");
    expect(inspect(oauth)).not.toContain("refresh-secret-1");

    const refreshed = await sdk.collection.createOAuth2Token({
      grantType: "refresh_token",
      refreshToken: oauth.refreshToken,
    });
    expect(refreshed.accessToken).toBe("user-tok-secret");

    // Disbursement
    const trRef = await sdk.disbursement.transfer({
      amount: "500",
      currency: "UGX",
      payeeMsisdn: "256771234567",
      externalId: "tr-1",
    });
    expect((await sdk.disbursement.getTransferStatus(trRef)).isSuccessful()).toBe(true);

    const depRef = await sdk.disbursement.deposit({
      amount: "500",
      currency: "UGX",
      payeeMsisdn: "256771234567",
      externalId: "dep-1",
    });
    expect((await sdk.disbursement.getDepositStatus(depRef)).isSuccessful()).toBe(true);

    const refndRef = await sdk.disbursement.refund({
      amount: "500",
      currency: "UGX",
      referenceIdToRefund: trRef,
      externalId: "rf-1",
    });
    expect((await sdk.disbursement.getRefundStatus(refndRef)).isSuccessful()).toBe(
      true,
    );

    // Remittance
    const remRef = await sdk.remittance.transfer({
      amount: "500",
      currency: "UGX",
      payeeMsisdn: "256771234567",
      externalId: "rem-1",
    });
    expect((await sdk.remittance.getTransferStatus(remRef)).isSuccessful()).toBe(true);
    expect(requests.length).toBeGreaterThan(10);
  });

  it("provisions sandbox credentials with redacted output and blocks production provisioning", async () => {
    const sdk = new JsMomoSDK(
      { environment: SANDBOX },
      {
        fetch: async (url) => {
          if (url.endsWith("/v1_0/apiuser")) {
            return new Response(null, { status: 201 });
          }
          if (url.endsWith("/apikey")) {
            return jsonResp({ apiKey: "sandbox-secret-key" });
          }
          return jsonResp({
            providerCallbackHost: "merchant.example.com",
            targetEnvironment: "sandbox",
          });
        },
      },
    );
    const provisioner = sdk.createSandboxProvisioner("sandbox-sub-key");
    expect(inspect(provisioner)).not.toContain("sandbox-sub-key");

    const creds = await provisioner.provision({ callbackHost: "merchant.example.com" });
    expect(creds.apiKey).toBe("sandbox-secret-key");
    expect(inspect(creds)).not.toContain("sandbox-secret-key");
    expect(inspect(creds)).not.toContain(creds.apiUser);

    const info = await provisioner.getApiUser(creds.apiUser);
    expect(info.providerCallbackHost).toBe("merchant.example.com");

    // Production environment refuses SandboxProvisioner
    const prodSdk = new JsMomoSDK({ environment: MTN_UGANDA });
    expect(() => prodSdk.createSandboxProvisioner("sub")).toThrow(JsMomoSDKError);

    // sdk.sandbox getter uses configured product subscriptionKey
    const sandboxWithCol = new JsMomoSDK(
      {
        environment: SANDBOX,
        collection: { subscriptionKey: "col-sub", apiUser: VALID_UUID, apiKey: "k" },
      },
      {
        fetch: async () => new Response(null, { status: 201 }),
      },
    );
    const createdUser = await sandboxWithCol.sandbox.createApiUser({
      apiUser: VALID_UUID,
      callbackHost: "merchant.example.com",
    });
    expect(createdUser).toBe(VALID_UUID);
  });

  it("validates models, redaction JSON serializers, and schema error handling", async () => {
    const {
      ApiKeyResult,
      BcAuthorizeResponse,
      OAuth2TokenResponse,
      ProvisionResult,
      TokenResponse,
      TransactionResult,
      parseApiKeyResponse,
      parseBalanceResponse,
      parseBcAuthorizeResponse,
      parseOAuth2TokenResponse,
      parseTokenResponse,
      parseTransactionResultResponse,
    } = await import("../../src/models.js");
    const { readBoundedResponse } = await import("../../src/http.js");

    const tok = new TokenResponse({
      access_token: "secret-t",
      token_type: "Bearer",
      expires_in: "3600",
    });
    expect(tok.toJSON()["accessToken"]).toBe("<redacted>");
    expect(inspect(tok)).not.toContain("secret-t");

    const oauth = new OAuth2TokenResponse({
      access_token: "secret-o",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "secret-r",
      refresh_token_expired_in: "7200",
    });
    expect(oauth.toJSON()["refreshToken"]).toBe("<redacted>");

    const bc = new BcAuthorizeResponse({
      auth_req_id: "secret-bc",
      expires_in: 300,
      interval: 5,
    });
    expect(bc.toJSON()["authReqId"]).toBe("<redacted>");

    const key = new ApiKeyResult({ apiKey: "secret-k" });
    expect(key.toJSON()["apiKey"]).toBe("<redacted>");
    expect(inspect(key)).not.toContain("secret-k");

    const prov = new ProvisionResult("u-1", "k-1");
    expect(prov.toJSON()).toEqual({ apiUser: "<redacted>", apiKey: "<redacted>" });

    const tx = new TransactionResult({
      status: "PENDING",
      payer: { partyIdType: "MSISDN", partyId: "256771234567" },
    });
    expect(tx.isPending()).toBe(true);
    expect(tx.payer?.partyId).toBe("256771234567");

    // Schema mismatch raises JsMomoSDKError preserving referenceId
    const bad = await readBoundedResponse(jsonResp({ unexpected: true }), 1024);
    for (const fn of [
      () => parseBalanceResponse(bad, "r1"),
      () => parseTransactionResultResponse(bad, "r1"),
      () => parseTokenResponse(bad, "r1"),
      () => parseOAuth2TokenResponse(bad, "r1"),
      () => parseBcAuthorizeResponse(bad, "r1"),
      () => parseApiKeyResponse(bad, "r1"),
    ]) {
      expect(fn).toThrow(JsMomoSDKError);
    }

    // Input validation rejections on collection/disbursement/remittance
    const sdk = new JsMomoSDK(
      {
        environment: SANDBOX,
        collection: { subscriptionKey: "s", apiUser: VALID_UUID, apiKey: "k" },
      },
      { fetch: async () => jsonResp({ result: "not-a-bool" }) },
    );
    await expect(
      sdk.collection.requestToPay({
        amount: "10.50",
        currency: "UGX",
        payerMsisdn: "256771234567",
        externalId: "e1",
      }),
    ).rejects.toThrow("zero-decimal");
    await expect(
      sdk.collection.bcAuthorize({ loginHint: "256771234567", accessType: "invalid" }),
    ).rejects.toThrow(RangeError);
    await expect(
      sdk.collection.createOAuth2Token({
        grantType: "refresh_token",
        refreshToken: "",
      }),
    ).rejects.toThrow(RangeError);
    await expect(sdk.collection.getBalance()).rejects.toThrow(AuthenticationError);

    let activeCalls = 0;
    const sdkActive = new JsMomoSDK(
      {
        environment: SANDBOX,
        collection: { subscriptionKey: "s", apiUser: VALID_UUID, apiKey: "k" },
      },
      {
        fetch: async (url) => {
          if (url.endsWith("/token/")) {
            return jsonResp({
              access_token: "tok",
              token_type: "access_token",
              expires_in: 3600,
            });
          }
          activeCalls += 1;
          return jsonResp(
            activeCalls === 1 ? { result: "false" } : { result: "invalid" },
          );
        },
      },
    );
    expect(await sdkActive.collection.isAccountHolderActive("256771234567")).toBe(
      false,
    );
    await expect(
      sdkActive.collection.isAccountHolderActive("256771234567"),
    ).rejects.toThrow(JsMomoSDKError);
  });

  it("preserves referenceId on MTN 500 errors and pre-request OAuth token 401 failures", async () => {
    let seenRef = "";
    const sdk500 = new JsMomoSDK(
      {
        environment: SANDBOX,
        collection: { subscriptionKey: "sub", apiUser: VALID_UUID, apiKey: "key" },
      },
      {
        fetch: async (url, init) => {
          if (url.endsWith("/token/")) {
            return jsonResp({
              access_token: "tok",
              token_type: "access_token",
              expires_in: 3600,
            });
          }
          seenRef = (init?.headers as Record<string, string>)["X-Reference-Id"] ?? "";
          return jsonResp({ code: "INTERNAL_ERROR", message: "Ledger busy" }, 500);
        },
      },
    );
    await expect(
      sdk500.collection.requestToPay({
        amount: "100",
        currency: "EUR",
        payerMsisdn: "256771234567",
        externalId: "ord-500",
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as JsMomoSDKServerError;
      expect(e).toBeInstanceOf(JsMomoSDKServerError);
      expect(e.referenceId).toBe(seenRef);
      expect(e.errorCode).toBe("INTERNAL_ERROR");
      return true;
    });

    // Token endpoint 401 still preserves explicit/auto-generated referenceId
    const sdk401 = new JsMomoSDK(
      {
        environment: SANDBOX,
        collection: { subscriptionKey: "sub", apiUser: VALID_UUID, apiKey: "bad-key" },
      },
      {
        fetch: async () => jsonResp({ message: "Unauthorized" }, 401),
      },
    );
    await expect(
      sdk401.collection.requestToPay({
        amount: "100",
        currency: "EUR",
        payerMsisdn: "256771234567",
        externalId: "ord-401",
        referenceId: VALID_UUID,
      }),
    ).rejects.toMatchObject({
      name: AuthenticationError.name,
      referenceId: VALID_UUID,
    });
  });
});
