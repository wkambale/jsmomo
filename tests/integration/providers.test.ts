import {
  constants,
  createHmac,
  generateKeyPairSync,
  privateDecrypt,
} from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { AirtelClient } from "../../src/airtel/client.js";
import { JsMomoSDK } from "../../src/client.js";
import { ProductConfig } from "../../src/config.js";
import { JsMomoSDKError, WebhookVerificationError } from "../../src/exceptions.js";
import {
  verifyHmacSignature,
  verifyTimestampedHmacSignature,
} from "../../src/providers/_signatures.js";
import {
  AirtelMoneyProvider,
  DisbursementRequest,
  FlutterwaveClient,
  FlutterwaveConfig,
  FlutterwaveProvider,
  MpesaClient,
  MpesaConfig,
  MpesaProvider,
  MtnMomoProvider,
  NormalizedStatus,
  OrangeMoneyClient,
  OrangeMoneyConfig,
  OrangeMoneyProvider,
  PaymentRequest,
  PaystackClient,
  PaystackConfig,
  PaystackProvider,
  WaveClient,
  WaveConfig,
  WaveProvider,
  encryptMpesaSecurityCredential,
  normaliseMpesaMsisdn,
  parseMpesaB2CCallback,
  parseMpesaStkCallback,
} from "../../src/providers/index.js";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Pan-African Providers Integration", () => {
  it("runs MtnMomoProvider & AirtelMoneyProvider unified flows", async () => {
    const mtnSdk = new JsMomoSDK(
      {
        collection: new ProductConfig({
          subscriptionKey: "sub-c",
          apiUser: "u-c",
          apiKey: "k-c",
        }),
        disbursement: new ProductConfig({
          subscriptionKey: "sub-d",
          apiUser: "u-d",
          apiKey: "k-d",
        }),
      },
      {
        fetch: async (url) => {
          if (url.endsWith("/token/")) {
            return jsonResp({
              access_token: "mtn-tok",
              token_type: "access_token",
              expires_in: 3600,
            });
          }
          if (url.endsWith("/requesttopay") || url.endsWith("/transfer")) {
            return new Response(null, { status: 202 });
          }
          if (url.includes("/requesttopay/")) {
            return jsonResp({
              status: "SUCCESSFUL",
              amount: "5000",
              currency: "UGX",
              financialTransactionId: "ft-1",
            });
          }
          if (url.includes("/transfer/")) {
            return jsonResp({ status: "FAILED", reason: "LOW_FUNDS" });
          }
          if (url.includes("/account/balance")) {
            return jsonResp({ availableBalance: "90000", currency: "UGX" });
          }
          return jsonResp({}, 404);
        },
      },
    );
    const mtn = new MtnMomoProvider(mtnSdk);
    const cRes = await mtn.collect(
      new PaymentRequest({
        amount: "5000",
        currency: "UGX",
        payerMsisdn: "256772123456",
      }),
    );
    expect(cRes.isPending()).toBe(true);
    const sRes = await mtn.getStatus(cRes.referenceId);
    expect(sRes.isSuccessful()).toBe(true);
    const dRes = await mtn.disburse(
      new DisbursementRequest({
        amount: "2000",
        currency: "UGX",
        payeeMsisdn: "256772123456",
      }),
    );
    const dsRes = await mtn.getStatus(dRes.referenceId, { kind: "disbursement" });
    expect(dsRes.isFailed()).toBe(true);
    expect((await mtn.getBalance({ currency: "UGX" })).availableBalance).toBe("90000");
    mtn.close();

    const airClient = new AirtelClient(
      {
        clientId: "cid",
        clientSecret: "csec",
        country: "UG",
        currency: "UGX",
        pin: "pin-sandbox",
      },
      {
        fetch: async (url) => {
          if (url.endsWith("/auth/oauth2/token")) {
            return jsonResp({ access_token: "air-tok", expires_in: 3600 });
          }
          if (url.endsWith("/merchant/v1/payments/")) {
            return jsonResp({
              status: { code: "200", message: "OK", success: true },
              data: { transaction: { id: "A1", status: "TIP" } },
            });
          }
          if (url.includes("/standard/v1/payments/")) {
            return jsonResp({
              status: { code: "200", message: "OK", success: true },
              data: {
                transaction: {
                  id: "A1",
                  status: "TS",
                  amount: "5000",
                  currency: "UGX",
                },
              },
            });
          }
          if (url.endsWith("/standard/v1/disbursements/")) {
            return jsonResp({
              status: { code: "200", message: "OK", success: true },
              data: { transaction: { id: "D1", status: "TIP" } },
            });
          }
          if (url.includes("/standard/v1/disbursements/")) {
            return jsonResp({
              status: { code: "200", message: "OK", success: true },
              data: { transaction: { id: "D1", status: "TF", message: "Declined" } },
            });
          }
          if (url.endsWith("/standard/v1/users/balance")) {
            return jsonResp({
              status: { code: "200", message: "OK", success: true },
              data: {
                balance: "33000",
                currency: "UGX",
                account_status: "Active",
              },
            });
          }
          return jsonResp({}, 404);
        },
      },
    );
    const air = new AirtelMoneyProvider(airClient);
    await expect(
      air.collect(
        new PaymentRequest({
          amount: "5000",
          currency: "KES",
          payerMsisdn: "256752123456",
        }),
      ),
    ).rejects.toThrow("does not match");
    const ac = await air.collect(
      new PaymentRequest({
        amount: "5000",
        currency: "UGX",
        payerMsisdn: "256752123456",
        referenceId: "A1",
      }),
    );
    expect((await air.getStatus(ac.referenceId)).status).toBe(
      NormalizedStatus.SUCCEEDED,
    );
    const ad = await air.disburse(
      new DisbursementRequest({
        amount: "1000",
        currency: "UGX",
        payeeMsisdn: "256752123456",
        referenceId: "D1",
      }),
    );
    expect((await air.getStatus(ad.referenceId, { kind: "disbursement" })).status).toBe(
      NormalizedStatus.FAILED,
    );
    expect((await air.getBalance({ currency: "UGX" })).availableBalance).toBe("33000");
    air.close();
  });

  it("runs WaveClient & WaveProvider flows including timestamped webhook verification", async () => {
    const cfg = new WaveConfig({
      apiKey: "wave_secret_key",
      webhookSecret: "whsec_wave",
      signingSecret: "signsec_wave",
      successUrl: "https://shop.example.com/ok",
      errorUrl: "https://shop.example.com/err",
    });
    expect(inspect(cfg)).not.toContain("wave_secret_key");
    expect(inspect(cfg)).not.toContain("signsec_wave");
    expect(cfg.toJSON()["apiKey"]).toBe("<redacted>");
    expect(cfg.toJSON()["signingSecret"]).toBe("<redacted>");

    let capturedWaveCheckoutBody: Record<string, unknown> | null = null;
    let capturedPayoutSig: string | null = null;
    let capturedPayoutBody: string | null = null;
    const signedWaveCalls: Array<{ path: string; sig: string | null; body: string }> =
      [];
    const calledWavePaths: string[] = [];
    const client = new WaveClient(cfg, {
      fetch: async (url, init) => {
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        const rawSentBody = typeof init?.body === "string" ? init.body : "";
        signedWaveCalls.push({
          path: `${init?.method ?? "GET"} ${new URL(url).pathname}`,
          sig: hdrs["Wave-Signature"] ?? null,
          body: rawSentBody,
        });
        calledWavePaths.push(
          `${init?.method ?? "GET"} ${new URL(url).pathname}${new URL(url).search}`,
        );
        if (url.endsWith("/v1/checkout/sessions")) {
          capturedWaveCheckoutBody = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          return jsonResp({
            id: "cos-1",
            amount: "1000",
            currency: "XOF",
            checkout_status: "open",
            payment_status: "processing",
            wave_launch_url: "https://pay.wave.com/c/cos-1",
            client_reference: "ord-1",
          });
        }
        if (url.endsWith("/v1/checkout/sessions/cos-1")) {
          return jsonResp({
            id: "cos-1",
            amount: "1000",
            currency: "XOF",
            checkout_status: "complete",
            payment_status: "succeeded",
            transaction_id: "tx-w1",
          });
        }
        if (
          url.endsWith("/v1/checkout/sessions/cos-1/refund") ||
          url.endsWith("/v1/checkout/sessions/cos-1/expire") ||
          url.endsWith("/v1/payout/pt-1/reverse")
        ) {
          return new Response(null, { status: 200 });
        }
        if (url.includes("/v1/checkout/sessions/search?client_reference=ord-1")) {
          return jsonResp({
            result: [
              {
                id: "cos-1",
                amount: "1000",
                currency: "XOF",
                checkout_status: "complete",
                payment_status: "succeeded",
                client_reference: "ord-1",
              },
            ],
          });
        }
        if (url.endsWith("/v1/payout")) {
          const hdrs = (init?.headers ?? {}) as Record<string, string>;
          capturedPayoutSig = hdrs["Wave-Signature"] ?? null;
          capturedPayoutBody = String(init?.body ?? "");
          return jsonResp({
            id: "pt-1",
            receive_amount: "2000",
            currency: "XOF",
            status: "processing",
            client_reference: "p-1",
          });
        }
        if (url.endsWith("/v1/payout/pt-1")) {
          return jsonResp({
            id: "pt-1",
            receive_amount: "2000",
            currency: "XOF",
            status: "failed",
            payout_error: { code: "E1", message: "Wallet full" },
          });
        }
        if (url.includes("/v1/payouts/search?client_reference=p-1")) {
          return jsonResp({
            result: [
              {
                id: "pt-1",
                receive_amount: "2000",
                currency: "XOF",
                status: "succeeded",
                client_reference: "p-1",
              },
            ],
          });
        }
        if (url.endsWith("/v1/balance")) {
          return jsonResp({ amount: "75000", currency: "XOF" });
        }
        return jsonResp({}, 404);
      },
    });
    const wave = new WaveProvider(client);
    expect(wave.capabilities.currencies).toContain("GMD");
    const col = await wave.collect(
      new PaymentRequest({
        amount: "1000",
        currency: "XOF",
        payerMsisdn: "+221771234567",
      }),
    );
    expect(capturedWaveCheckoutBody).toMatchObject({
      restrict_payer_mobile: "+221771234567",
      success_url: "https://shop.example.com/ok",
      error_url: "https://shop.example.com/err",
    });
    expect(col.checkoutUrl).toBe("https://pay.wave.com/c/cos-1");

    // Issue #39: WaveProvider falls back errorUrl to request.callbackUrl when config.errorUrl is unset
    let fallbackWaveBody: Record<string, unknown> | null = null;
    const waveFallback = new WaveProvider(
      new WaveClient(
        { apiKey: "wave_secret_key" },
        {
          fetch: async (_url, init) => {
            fallbackWaveBody = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            return jsonResp({
              id: "cos-2",
              amount: "500",
              currency: "GMD",
              checkout_status: "open",
              payment_status: "processing",
              wave_launch_url: "https://pay.wave.com/c/cos-2",
            });
          },
        },
      ),
    );
    await waveFallback.collect(
      new PaymentRequest({
        amount: "500",
        currency: "GMD",
        payerMsisdn: "2207123456",
        callbackUrl: "https://shop.example.com/return",
      }),
    );
    expect(fallbackWaveBody).toMatchObject({
      amount: "500",
      currency: "GMD",
      restrict_payer_mobile: "+2207123456",
      success_url: "https://shop.example.com/return",
      error_url: "https://shop.example.com/return",
    });
    waveFallback.close();
    expect((await wave.getStatus("cos-1")).isSuccessful()).toBe(true);
    const dis = await wave.disburse(
      new DisbursementRequest({
        amount: "2000",
        currency: "XOF",
        payeeMsisdn: "+221771234567",
        payerMessage:
          "Salary disbursement for November 2026 exceeding forty characters limit",
      }),
    );
    expect(dis.referenceId).toBe("pt-1");
    expect(
      String(
        (JSON.parse(capturedPayoutBody ?? "{}") as Record<string, unknown>)[
          "payment_reason"
        ],
      ).length,
    ).toBeLessThanOrEqual(40);
    const disSt = await wave.getStatus("pt-1", { kind: "disbursement" });
    expect(disSt.isFailed()).toBe(true);
    expect(disSt.reason).toBe("E1: Wallet full");
    expect((await wave.getBalance()).availableBalance).toBe("75000");

    // Issue #56 & #87: Outbound Wave-Signature on ALL Wave endpoints (including GET & bodyless POST)
    expect(capturedPayoutSig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    verifyTimestampedHmacSignature(
      capturedPayoutBody ?? "",
      capturedPayoutSig ?? "",
      "signsec_wave",
      { timestampSeparator: "" },
    );
    await client.createCheckoutSession({
      amount: "1000",
      currency: "XOF",
      aggregatedMerchantId: "am-senegal-01",
    });
    expect(capturedWaveCheckoutBody?.["aggregated_merchant_id"]).toBe("am-senegal-01");
    await client.refundCheckoutSession("cos-1");
    await client.expireCheckoutSession("cos-1");
    await client.reversePayout("pt-1");
    const foundSessions = await client.searchCheckoutSessions("ord-1");
    expect(foundSessions).toHaveLength(1);
    expect(foundSessions[0]?.id).toBe("cos-1");
    const foundPayouts = await client.searchPayouts("p-1");
    expect(foundPayouts).toHaveLength(1);
    expect(foundPayouts[0]?.id).toBe("pt-1");
    expect(signedWaveCalls.length).toBeGreaterThanOrEqual(10);
    for (const call of signedWaveCalls) {
      expect(call.sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      verifyTimestampedHmacSignature(call.body, call.sig ?? "", "signsec_wave", {
        timestampSeparator: "",
      });
    }
    expect(calledWavePaths).toContain("POST /v1/checkout/sessions/cos-1/refund");
    expect(calledWavePaths).toContain("POST /v1/checkout/sessions/cos-1/expire");
    expect(calledWavePaths).toContain("POST /v1/payout/pt-1/reverse");
    await expect(client.searchCheckoutSessions("   ")).rejects.toThrow("non-empty");
    await expect(client.searchPayouts("   ")).rejects.toThrow("non-empty");
    await expect(client.searchCheckoutSessions("x".repeat(256))).rejects.toThrow(
      "255 characters",
    );
    await expect(client.searchPayouts("x".repeat(256))).rejects.toThrow(
      "255 characters",
    );
    await expect(
      client.createCheckoutSession({
        amount: "1000",
        currency: "XOF",
        clientReference: "x".repeat(256),
      }),
    ).rejects.toThrow("255 characters");
    await expect(
      client.createPayout({
        amount: "1000",
        currency: "XOF",
        mobile: "+221771234567",
        paymentReason: "r".repeat(41),
      }),
    ).rejects.toThrow("40 characters");

    // Wave Shared Secret webhook verification (Authorization: Bearer <secret>)
    client.verifySharedSecretWebhook("Bearer whsec_wave");
    expect(() => client.verifySharedSecretWebhook("")).toThrow(
      WebhookVerificationError,
    );
    expect(() => client.verifySharedSecretWebhook("Basic dGVzdA==")).toThrow(
      WebhookVerificationError,
    );
    expect(() => client.verifySharedSecretWebhook("Bearer wrong_secret")).toThrow(
      WebhookVerificationError,
    );
    const waveNoWhSec = new WaveClient({ apiKey: "k" });
    expect(() => waveNoWhSec.verifySharedSecretWebhook("Bearer x")).toThrow(
      "webhookSecret",
    );

    // Wave webhook uses empty separator between ts and payload and 30s default future skew
    const now = 1700000000;
    const rawBody = Buffer.from('{"id":"ev1"}', "utf8");
    const sig = createHmac("sha256", "whsec_wave")
      .update(`${now}`)
      .update(rawBody)
      .digest("hex");
    client.verifyWebhook(rawBody, `t=${now},v1=${sig}`, { now });
    const sig45Future = createHmac("sha256", "whsec_wave")
      .update(`${now + 45}`)
      .update(rawBody)
      .digest("hex");
    expect(() =>
      client.verifyWebhook(rawBody, `t=${now + 45},v1=${sig45Future}`, { now }),
    ).toThrow("future");
    expect(() =>
      client.verifyWebhook(rawBody, `t=${now},v1=deadbeef`, { now }),
    ).toThrow(WebhookVerificationError);

    // Zero-decimal currency validation enforced across models, WaveClient, and FlutterwaveClient (Issue #37)
    expect(
      () =>
        new PaymentRequest({
          amount: "100.50",
          currency: "UGX",
          payerMsisdn: "+256771234567",
        }),
    ).toThrow("zero-decimal");
    expect(
      () =>
        new DisbursementRequest({
          amount: "500.25",
          currency: "XOF",
          payeeMsisdn: "+221771234567",
        }),
    ).toThrow("zero-decimal");
    await expect(
      client.createCheckoutSession({ amount: "100.50", currency: "XOF" }),
    ).rejects.toThrow("zero-decimal");
    await expect(
      client.createPayout({
        amount: "200.50",
        currency: "UGX",
        mobile: "+256771234567",
      }),
    ).rejects.toThrow("zero-decimal");
    wave.close();
  });

  it("runs MpesaClient & MpesaProvider STK Push, STK Query, and B2C flows", async () => {
    const cfg = new MpesaConfig({
      consumerKey: "ckey",
      consumerSecret: "csec",
      shortCode: "174379",
      passkey: "pass123",
      callbackUrl: "https://shop.example.com/mpesa",
      securityCredential: "sec-cred",
    });
    expect(inspect(cfg)).not.toContain("csec");
    expect(cfg.toJSON()["passkey"]).toBe("<redacted>");

    let seenStkPhone = "";
    let seenB2cPhone = "";
    let seenBalancePayload: Record<string, unknown> = {};
    let seenReversalPayload: Record<string, unknown> = {};
    const client = new MpesaClient(cfg, {
      fetch: async (url, init) => {
        if (url.includes("/oauth/v1/generate")) {
          return jsonResp({ access_token: "mpesa-tok", expires_in: "3599" });
        }
        if (url.endsWith("/mpesa/stkpush/v1/processrequest")) {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          seenStkPhone = String(parsed["PhoneNumber"] ?? "");
          return jsonResp({
            MerchantRequestID: "mr-1",
            CheckoutRequestID: "ws_CO_1",
            ResponseCode: "0",
            ResponseDescription: "Success",
          });
        }
        if (url.endsWith("/mpesa/stkpushquery/v1/query")) {
          return jsonResp({
            CheckoutRequestID: "ws_CO_1",
            ResultCode: "0",
            ResultDesc: "Processed successfully",
          });
        }
        if (url.endsWith("/mpesa/b2c/v3/paymentrequest")) {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          seenB2cPhone = String(parsed["PartyB"] ?? "");
          return jsonResp({
            ConversationID: "conv-1",
            OriginatorConversationID: "orig-1",
            ResponseCode: "0",
            ResponseDescription: "Accepted",
          });
        }
        if (url.endsWith("/mpesa/accountbalance/v1/query")) {
          seenBalancePayload = JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          return jsonResp({
            ConversationID: "bal-conv-1",
            OriginatorConversationID: "bal-orig-1",
            ResponseCode: "0",
            ResponseDescription: "Accepted",
          });
        }
        if (url.endsWith("/mpesa/reversal/v1/request")) {
          seenReversalPayload = JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          return jsonResp({
            ConversationID: "rev-conv-1",
            OriginatorConversationID: "rev-orig-1",
            ResponseCode: "0",
            ResponseDescription: "Accepted",
          });
        }
        return jsonResp({}, 404);
      },
    });
    // Issue #86: Kenyan local 07/01/7/1/+25407 phone normalization & rejection of non-Kenyan numbers
    expect(normaliseMpesaMsisdn("0712345678")).toBe("254712345678");
    expect(normaliseMpesaMsisdn("0112345678")).toBe("254112345678");
    expect(normaliseMpesaMsisdn("712345678")).toBe("254712345678");
    expect(normaliseMpesaMsisdn("112345678")).toBe("254112345678");
    expect(normaliseMpesaMsisdn("+254 0712 345678")).toBe("254712345678");
    expect(normaliseMpesaMsisdn("00254712345678")).toBe("254712345678");
    expect(() => normaliseMpesaMsisdn("+256772123456")).toThrow("Kenyan mobile number");
    expect(() => normaliseMpesaMsisdn("0812345678")).toThrow("Kenyan mobile number");

    const mpesa = new MpesaProvider(client);
    const col = await mpesa.collect(
      new PaymentRequest({
        amount: "500",
        currency: "KES",
        payerMsisdn: "0712345678",
        externalId: "INV-001",
      }),
    );
    expect(seenStkPhone).toBe("254712345678");
    expect(col.referenceId).toBe("ws_CO_1");
    expect((await mpesa.getStatus("ws_CO_1")).isSuccessful()).toBe(true);

    const disb = await mpesa.disburse(
      new DisbursementRequest({
        amount: "500",
        currency: "KES",
        payeeMsisdn: "0112345678",
      }),
    );
    expect(seenB2cPhone).toBe("254112345678");
    expect(disb.referenceId).toBe("conv-1");

    const balRes = await client.accountBalance({
      remarks: "Daily Reconciliation",
      originatorConversationId: "bal-orig-1",
    });
    expect(balRes.conversationId).toBe("bal-conv-1");
    expect(seenBalancePayload["CommandID"]).toBe("AccountBalance");
    expect(seenBalancePayload["IdentifierType"]).toBe("4");
    expect(seenBalancePayload["OriginatorConversationID"]).toBe("bal-orig-1");

    const revRes = await client.reverseTransaction({
      transactionId: "QWE123RTY",
      amount: "500",
      remarks: "Duplicate charge",
      originatorConversationId: "rev-orig-1",
    });
    expect(revRes.conversationId).toBe("rev-conv-1");
    expect(seenReversalPayload["CommandID"]).toBe("TransactionReversal");
    expect(seenReversalPayload["TransactionID"]).toBe("QWE123RTY");
    expect(seenReversalPayload["Amount"]).toBe(500);
    expect(seenReversalPayload["RecieverIdentifierType"]).toBe("11");
    expect(seenReversalPayload["OriginatorConversationID"]).toBe("rev-orig-1");
    await expect(mpesa.getStatus("conv-1", { kind: "disbursement" })).rejects.toThrow(
      JsMomoSDKError,
    );
    await expect(mpesa.getBalance()).rejects.toThrow(JsMomoSDKError);
    await expect(
      client.stkPush({ amount: "10.50", phoneNumber: "254712345678" }),
    ).rejects.toThrow("whole integer");
    await expect(
      client.stkPush({
        amount: "100",
        phoneNumber: "254712345678",
        transactionDesc: "This description is way too long for Daraja",
      }),
    ).rejects.toThrow("13 characters");

    // Issue #34: Pending 500.001.1001 maps to PENDING, provider truncates >13-char payerMessage, transactionStatus & callback parsers work
    let stkQueryCall = 0;
    let seenTxDesc = "";
    const realDarajaClient = new MpesaClient(cfg, {
      fetch: async (url, init) => {
        if (url.includes("/oauth/v1/generate")) {
          return jsonResp({ access_token: "mpesa-tok", expires_in: "3599" });
        }
        if (url.endsWith("/mpesa/stkpush/v1/processrequest")) {
          seenTxDesc = JSON.parse(String(init?.body)).TransactionDesc;
          return jsonResp({
            MerchantRequestID: "mr-2",
            CheckoutRequestID: "ws_CO_2",
            ResponseCode: "0",
            ResponseDescription: "Success",
          });
        }
        if (url.endsWith("/mpesa/stkpushquery/v1/query")) {
          stkQueryCall += 1;
          if (stkQueryCall === 1) {
            return jsonResp(
              {
                requestId: "req-1",
                errorCode: "500.001.1001",
                errorMessage: "The transaction is being processed",
              },
              500,
            );
          }
          if (stkQueryCall === 2) {
            return jsonResp(
              {
                requestId: "req-2",
                errorCode: "500.001.1001",
                errorMessage: "Merchant does not exist",
              },
              500,
            );
          }
          return jsonResp({
            CheckoutRequestID: "ws_CO_2",
            ResultCode: "0",
            ResultDesc: "Processed",
          });
        }
        if (url.endsWith("/mpesa/transactionstatus/v1/query")) {
          return jsonResp({
            ConversationID: "ts-conv-1",
            OriginatorConversationID: "ts-orig-1",
            ResponseCode: "0",
            ResponseDescription: "Accept the service request successfully.",
          });
        }
        return jsonResp({}, 404);
      },
    });
    const realMpesa = new MpesaProvider(realDarajaClient);
    await realMpesa.collect(
      new PaymentRequest({
        amount: "200",
        currency: "KES",
        payerMsisdn: "+254712345678",
        payerMessage: "Order #1234567890 long message",
      }),
    );
    expect(seenTxDesc.length).toBeLessThanOrEqual(13);

    const pendingRes = await realMpesa.getStatus("ws_CO_2");
    expect(pendingRes.isPending()).toBe(true);
    expect(pendingRes.reason).toContain("being processed");
    // Real non-processing 500.001.1001 still throws
    await expect(realMpesa.getStatus("ws_CO_2")).rejects.toThrow(
      "Merchant does not exist",
    );
    expect((await realMpesa.getStatus("ws_CO_2")).isSuccessful()).toBe(true);

    const tsRes = await realDarajaClient.transactionStatus({
      originalConversationId: "orig-1",
    });
    expect(tsRes.conversationId).toBe("ts-conv-1");

    const parsedStk = parseMpesaStkCallback({
      Body: {
        stkCallback: {
          MerchantRequestID: "mr-1",
          CheckoutRequestID: "ws_CO_1",
          ResultCode: 0,
          ResultDesc: "The service request is processed successfully.",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: 500 },
              { Name: "MpesaReceiptNumber", Value: "QWE123RTY" },
            ],
          },
        },
      },
    });
    expect(parsedStk.isSuccessful()).toBe(true);
    expect(parsedStk.providerTransactionId).toBe("QWE123RTY");
    expect(parsedStk.amount).toBe("500");

    const parsedB2c = parseMpesaB2CCallback({
      Result: {
        ConversationID: "conv-1",
        OriginatorConversationID: "orig-1",
        ResultCode: 0,
        ResultDesc: "Processed successfully",
        TransactionID: "B2C999",
        ResultParameters: {
          ResultParameter: [
            { Key: "TransactionAmount", Value: 1500 },
            { Key: "TransactionReceipt", Value: "B2C999" },
          ],
        },
      },
    });
    expect(parsedB2c.isSuccessful()).toBe(true);
    expect(parsedB2c.providerTransactionId).toBe("B2C999");
    expect(parsedB2c.amount).toBe("1500");
    expect(() => parseMpesaStkCallback({})).toThrow(WebhookVerificationError);
    expect(() => parseMpesaB2CCallback({})).toThrow(WebhookVerificationError);

    // Issue #36: RSA encryption helper & production plaintext SecurityCredential rejection
    const { publicKey: mpesaPub, privateKey: mpesaPriv } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const encSecCred = encryptMpesaSecurityCredential("InitiatorPass123", mpesaPub);
    const decSecCred = privateDecrypt(
      { key: mpesaPriv, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(encSecCred, "base64"),
    ).toString("utf8");
    expect(decSecCred).toBe("InitiatorPass123");

    const prodMpesaCfg = new MpesaConfig({
      consumerKey: "ck",
      consumerSecret: "cs",
      shortCode: "174379",
      passkey: "pk",
      environment: "production",
      securityCredential: encSecCred,
    });
    expect(prodMpesaCfg.securityCredential).toBe(encSecCred);

    expect(
      () =>
        new MpesaConfig({
          consumerKey: "ck",
          consumerSecret: "cs",
          shortCode: "174379",
          passkey: "pk",
          environment: "production",
          securityCredential: "plaintext-password",
        }),
    ).toThrow("RSA-encrypted Base64");
    expect(
      () =>
        new MpesaConfig({
          consumerKey: "ck",
          consumerSecret: "cs",
          shortCode: "174379",
          passkey: "pk",
          environment: "production",
          securityCredential: Buffer.from("short").toString("base64"),
        }),
    ).toThrow("too short");
    const { publicKey: ecPub } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    expect(() => encryptMpesaSecurityCredential("pass", ecPub)).toThrow(TypeError);
    mpesa.close();
  });

  it("runs PaystackClient & PaystackProvider with exact minor units and HMAC-SHA512 webhooks", async () => {
    const cfg = new PaystackConfig({
      secretKey: "sk_test_12345",
      defaultCustomerEmail: "buyer@example.com",
      defaultCurrency: "NGN",
    });
    expect(inspect(cfg)).not.toContain("sk_test_12345");
    let capturedAmount = 0;
    const client = new PaystackClient(cfg, {
      fetch: async (url, init) => {
        if (url.endsWith("/transaction/initialize")) {
          const body = JSON.parse(String(init?.body));
          capturedAmount = body.amount;
          return jsonResp({
            status: true,
            data: {
              authorization_url: "https://checkout.paystack.com/abc",
              reference: body.reference,
            },
          });
        }
        if (url.includes("/transaction/verify/")) {
          return jsonResp({
            status: true,
            data: {
              id: 99,
              status: "success",
              amount: 12345,
              currency: "NGN",
              gateway_response: "Approved",
            },
          });
        }
        if (url.endsWith("/transferrecipient")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return jsonResp(
            {
              status: true,
              message: "Transfer recipient created successfully",
              data: {
                active: true,
                recipient_code: "RCP_abc123",
                type: body["type"],
                name: body["name"],
                currency: body["currency"],
                details: {
                  account_number: body["account_number"],
                  bank_code: body["bank_code"],
                },
              },
            },
            201,
          );
        }
        if (url.endsWith("/transfer")) {
          const body = JSON.parse(String(init?.body));
          return jsonResp({
            status: true,
            data: { reference: body.reference, status: "pending" },
          });
        }
        if (url.includes("/transfer/verify/")) {
          return jsonResp({
            status: true,
            data: { id: 88, status: "reversed", amount: 50000, currency: "NGN" },
          });
        }
        if (url.endsWith("/balance")) {
          return jsonResp({
            status: true,
            data: [
              { currency: "GHS", balance: 10000 },
              { currency: "NGN", balance: 250050 },
            ],
          });
        }
        return jsonResp({}, 404);
      },
    });
    const ps = new PaystackProvider(client);
    const col = await ps.collect(
      new PaymentRequest({
        amount: "123.45",
        currency: "NGN",
        payerMsisdn: "+2348012345678",
        referenceId: "ps-ref-1",
      }),
    );
    expect(capturedAmount).toBe(12345);
    expect(col.checkoutUrl).toBe("https://checkout.paystack.com/abc");
    const st = await ps.getStatus("ps-ref-1");
    expect(st.isSuccessful()).toBe(true);
    expect(st.amount).toBe("123.45");

    // Rejects fractional XOF
    await expect(
      client.initializeTransaction({
        email: "a@b.com",
        amount: "10.50",
        currency: "XOF",
      }),
    ).rejects.toThrow("fractional minor units");

    // Rejects non-RCP_ recipient code
    await expect(
      ps.disburse(
        new DisbursementRequest({
          amount: "500",
          currency: "NGN",
          payeeMsisdn: "+2348012345678",
        }),
      ),
    ).rejects.toThrow("RCP_");

    // Issue #43: createTransferRecipient creates mobile_money / bank recipients returning RCP_*
    const recipientRes = await client.createTransferRecipient({
      type: "mobile_money",
      name: "Ama Mensah",
      accountNumber: "0551234567",
      bankCode: "MTN",
      currency: "GHS",
      description: "Supplier payout",
      metadata: { source: "sdk" },
    });
    const recipientData = recipientRes["data"] as Record<string, unknown>;
    expect(recipientData["recipient_code"]).toBe("RCP_abc123");
    expect(recipientData["type"]).toBe("mobile_money");
    expect(recipientData["currency"]).toBe("GHS");
    await expect(
      client.createTransferRecipient({
        type: " ",
        name: "Ama",
        accountNumber: "0551234567",
        bankCode: "MTN",
        currency: "GHS",
      }),
    ).rejects.toThrow("type");
    await expect(
      client.createTransferRecipient({
        type: "nuban",
        name: "Ama",
        accountNumber: "0123456789",
        bankCode: "044",
        currency: "NGN",
        description: "   ",
      }),
    ).rejects.toThrow("description");

    const dis = await ps.disburse(
      new DisbursementRequest({
        amount: "500",
        currency: "NGN",
        payeeMsisdn: "+2348012345678",
        payeeBankCode: "RCP_abc123",
        referenceId: "ps-t-1",
      }),
    );
    expect(dis.referenceId).toBe("ps-t-1");
    expect((await ps.getStatus("ps-t-1", { kind: "disbursement" })).status).toBe(
      NormalizedStatus.REVERSED,
    );
    const bal = await ps.getBalance();
    expect(bal.availableBalance).toBe("2500.50");
    expect(bal.currency).toBe("NGN");

    const raw = Buffer.from('{"event":"charge.success"}', "utf8");
    const sig = createHmac("sha512", "sk_test_12345").update(raw).digest("hex");
    client.verifyWebhook(raw, sig);
    expect(() => client.verifyWebhook(raw, "bad")).toThrow(WebhookVerificationError);

    // Issue #47: Paystack transfers & transaction init do NOT auto-retry on 503/500 and preserve referenceId
    let psRetryCalls = 0;
    const psNoRetry = new PaystackClient(
      { secretKey: "sk_test_12345", maxRetries: 2, retryBackoff: 0.01 },
      {
        fetch: async () => {
          psRetryCalls += 1;
          return new Response("upstream busy", { status: 503 });
        },
      },
    );
    await expect(
      psNoRetry.initiateTransfer({
        amount: "500",
        currency: "NGN",
        recipient: "RCP_abc123",
        reference: "ps-no-retry-tr",
      }),
    ).rejects.toMatchObject({ referenceId: "ps-no-retry-tr", statusCode: 503 });
    await expect(
      psNoRetry.initializeTransaction({
        email: "a@b.com",
        amount: "500",
        currency: "NGN",
        reference: "ps-no-retry-tx",
      }),
    ).rejects.toMatchObject({ referenceId: "ps-no-retry-tx", statusCode: 503 });
    expect(psRetryCalls).toBe(2);
    psNoRetry.close();
    ps.close();
  });

  it("runs FlutterwaveClient & FlutterwaveProvider flows including verif-hash", async () => {
    const cfg = new FlutterwaveConfig({
      secretKey: "FLWSECK_TEST-123",
      webhookHash: "my-flw-hash",
      defaultCustomerEmail: "user@example.com",
      defaultAccountBank: "044",
    });
    expect(inspect(cfg)).not.toContain("FLWSECK_TEST-123");

    let capturedFlwTransferBody: Record<string, unknown> | null = null;
    const client = new FlutterwaveClient(cfg, {
      fetch: async (url, init) => {
        if (url.endsWith("/v3/payments")) {
          return jsonResp({
            status: "success",
            data: { link: "https://checkout.flutterwave.com/pay/1" },
          });
        }
        if (url.includes("/v3/transactions/verify_by_reference")) {
          return jsonResp({
            status: "success",
            data: {
              id: 501,
              status: "successful",
              amount: 1000,
              currency: "NGN",
              processor_response: "Approved",
            },
          });
        }
        if (url.endsWith("/v3/transfers")) {
          capturedFlwTransferBody = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          return jsonResp({
            status: "success",
            data: { id: 777, reference: "flw-tr-1", status: "NEW" },
          });
        }
        if (url.endsWith("/v3/transfers/777")) {
          return jsonResp({
            status: "success",
            data: { id: 777, status: "SUCCESSFUL", amount: 500, currency: "NGN" },
          });
        }
        if (url.endsWith("/v3/balances/NGN")) {
          return jsonResp({
            status: "success",
            data: { available_balance: 12000, currency: "NGN" },
          });
        }
        return jsonResp({}, 404);
      },
    });
    const flw = new FlutterwaveProvider(client);
    const col = await flw.collect(
      new PaymentRequest({
        amount: "1000",
        currency: "NGN",
        payerMsisdn: "+2348012345678",
        referenceId: "flw-ref-1",
      }),
    );
    expect(col.checkoutUrl).toBe("https://checkout.flutterwave.com/pay/1");
    expect((await flw.getStatus("flw-ref-1")).isSuccessful()).toBe(true);
    const tr = await flw.disburse(
      new DisbursementRequest({
        amount: "500",
        currency: "NGN",
        payeeMsisdn: "0690000040",
        referenceId: "flw-tr-1",
      }),
    );
    expect(tr.referenceId).toBe("777");
    expect((await flw.getStatus("777", { kind: "disbursement" })).isSuccessful()).toBe(
      true,
    );
    // Issue #38: Mobile money transfer supports beneficiary_name, debit_currency, and meta
    await client.createTransfer({
      amount: "1200",
      currency: "KES",
      accountBank: "MPS",
      accountNumber: "254712345678",
      beneficiaryName: "Akinyi Kimwei",
      debitCurrency: "NGN",
      meta: [
        {
          sender: "Acme Corp",
          sender_country: "KE",
          mobile_number: "254712345678",
        },
      ],
    });
    expect(capturedFlwTransferBody).toMatchObject({
      account_bank: "MPS",
      beneficiary_name: "Akinyi Kimwei",
      debit_currency: "NGN",
      meta: [
        { sender: "Acme Corp", sender_country: "KE", mobile_number: "254712345678" },
      ],
    });
    await expect(
      client.createTransfer({
        amount: "1200",
        currency: "KES",
        accountBank: "MPS",
        accountNumber: "254712345678",
        beneficiaryName: "   ",
      }),
    ).rejects.toThrow("beneficiaryName");
    expect((await flw.getBalance()).availableBalance).toBe("12000");

    client.verifyWebhookHash("my-flw-hash");
    expect(() => client.verifyWebhookHash("wrong")).toThrow(WebhookVerificationError);
    await expect(
      client.createPayment({
        amount: "100.50",
        currency: "UGX",
        phoneNumber: "+256771234567",
      }),
    ).rejects.toThrow("zero-decimal");
    await expect(
      client.createTransfer({
        amount: "100.50",
        currency: "RWF",
        accountNumber: "+250781234567",
      }),
    ).rejects.toThrow("zero-decimal");

    // Production / live-key configs reject plaintext localhost URLs (Issue #31)
    expect(
      () =>
        new PaystackConfig({
          secretKey: "sk_live_secret123",
          baseUrl: "http://127.0.0.1:8080",
        }),
    ).toThrow(JsMomoSDKError);
    expect(
      () =>
        new PaystackConfig({
          secretKey: "sk_live_secret123",
          callbackUrl: "http://localhost:3000/cb",
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new PaystackConfig({
          secretKey: "sk_live_secret123",
          environment: "sandbox",
        }),
    ).toThrow("cannot be used with sandbox");
    const prodPs = new PaystackClient(
      { secretKey: "sk_live_secret123" },
      { fetch: async () => jsonResp({}) },
    );
    await expect(
      prodPs.initializeTransaction({
        email: "a@b.com",
        amount: "100",
        currency: "NGN",
        callbackUrl: "http://127.0.0.1:8080/cb",
      }),
    ).rejects.toThrow(RangeError);

    expect(
      () =>
        new FlutterwaveConfig({
          secretKey: "FLWSECK-livekey-X",
          baseUrl: "http://127.0.0.1:8080",
        }),
    ).toThrow(JsMomoSDKError);
    expect(
      () =>
        new FlutterwaveConfig({
          secretKey: "FLWSECK-livekey-X",
          redirectUrl: "http://localhost:3000/cb",
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new FlutterwaveConfig({
          secretKey: "FLWSECK-livekey-X",
          environment: "sandbox",
        }),
    ).toThrow("cannot be used with sandbox");
    const prodFlw = new FlutterwaveClient(
      {
        secretKey: "FLWSECK-livekey-X",
        defaultCustomerEmail: "a@b.com",
        defaultAccountBank: "044",
      },
      { fetch: async () => jsonResp({}) },
    );
    await expect(
      prodFlw.createPayment({
        amount: "100",
        currency: "NGN",
        phoneNumber: "+2348012345678",
        redirectUrl: "http://localhost:3000/ok",
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      prodFlw.createTransfer({
        amount: "100",
        currency: "NGN",
        accountNumber: "0690000040",
        callbackUrl: "http://127.0.0.1:3000/cb",
      }),
    ).rejects.toThrow(RangeError);

    expect(
      () =>
        new WaveConfig({
          apiKey: "wave_sn_prod_secret123",
          baseUrl: "http://127.0.0.1:8080",
        }),
    ).toThrow(JsMomoSDKError);
    expect(
      () =>
        new WaveConfig({
          apiKey: "wave_sn_prod_secret123",
          successUrl: "http://localhost:3000/ok",
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new WaveConfig({
          apiKey: "wave_sn_prod_secret123",
          environment: "sandbox",
        }),
    ).toThrow("cannot be used with sandbox");
    const prodWave = new WaveClient(
      {
        apiKey: "wave_sn_prod_secret123",
        successUrl: "https://shop.example.com/ok",
        errorUrl: "https://shop.example.com/err",
      },
      { fetch: async () => jsonResp({}) },
    );
    await expect(
      prodWave.createCheckoutSession({
        amount: "1000",
        currency: "XOF",
        errorUrl: "http://localhost:3000/err",
      }),
    ).rejects.toThrow(RangeError);
    flw.close();
  });

  it("runs OrangeMoneyClient & OrangeMoneyProvider flows with context store & production prefix check", async () => {
    expect(
      () =>
        new OrangeMoneyConfig({
          clientId: "cid",
          clientSecret: "csec",
          merchantKey: "mkey",
          environment: "production",
        }),
    ).toThrow("explicit country apiPathPrefix");

    expect(
      () =>
        new OrangeMoneyConfig({
          clientId: "cid",
          clientSecret: "csec",
          merchantKey: "mkey",
          environment: "production",
          apiPathPrefix: "/orange-money-webpay/dev/v1",
        }),
    ).toThrow("must not use the sandbox");

    // Production Orange Money rejects plaintext localhost / loopback URLs (Issue #12)
    expect(
      () =>
        new OrangeMoneyConfig({
          clientId: "cid",
          clientSecret: "csec",
          merchantKey: "mkey",
          environment: "production",
          apiPathPrefix: "/orange-money-webpay/sn/v1",
          baseUrl: "http://127.0.0.1:8080",
        }),
    ).toThrow(JsMomoSDKError);
    expect(
      () =>
        new OrangeMoneyConfig({
          clientId: "cid",
          clientSecret: "csec",
          merchantKey: "mkey",
          environment: "production",
          apiPathPrefix: "/orange-money-webpay/sn/v1",
          notifUrl: "http://localhost:3000/notif",
        }),
    ).toThrow(RangeError);
    const prodOrangeClient = new OrangeMoneyClient(
      {
        clientId: "cid",
        clientSecret: "csec",
        merchantKey: "mkey",
        environment: "production",
        apiPathPrefix: "/orange-money-webpay/sn/v1",
        returnUrl: "https://shop.example.com/ret",
        cancelUrl: "https://shop.example.com/cancel",
        notifUrl: "https://shop.example.com/notif",
      },
      { fetch: async () => jsonResp({}) },
    );
    await expect(
      prodOrangeClient.createWebPayment({
        amount: "1000",
        currency: "XOF",
        notifUrl: "http://[::1]:9000/hook",
      }),
    ).rejects.toThrow(RangeError);

    const cfg = new OrangeMoneyConfig({
      clientId: "cid",
      clientSecret: "csec",
      merchantKey: "mkey",
      reference: "Boutique Sénégal",
      returnUrl: "https://shop.example.com/ret",
      cancelUrl: "https://shop.example.com/cancel",
      notifUrl: "https://shop.example.com/notif",
    });
    expect(cfg.reference).toBe("Boutique Sénégal");
    expect(inspect(cfg)).not.toContain("csec");

    let omCallIdx = 0;
    const capturedOrangePayloads: Array<Record<string, unknown>> = [];
    const client = new OrangeMoneyClient(cfg, {
      fetch: async (url, init) => {
        if (url.endsWith("/oauth/v3/token")) {
          return jsonResp({ access_token: "om-tok", expires_in: 3600 });
        }
        if (url.endsWith("/orange-money-webpay/dev/v1/webpayment")) {
          omCallIdx += 1;
          capturedOrangePayloads.push(
            JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
          );
          return jsonResp({
            pay_token: `pt-om-${omCallIdx}`,
            notif_token: `nt-om-secret-${omCallIdx}`,
            payment_url: `https://webpayment.orange.com/pay/pt-om-${omCallIdx}`,
          });
        }
        if (url.endsWith("/orange-money-webpay/dev/v1/transactionstatus")) {
          return jsonResp({
            status: "SUCCESS",
            order_id: "ord-om-1",
            txnid: "OM-TXN-2026-1",
          });
        }
        return jsonResp({}, 404);
      },
    });
    const orange = new OrangeMoneyProvider(client);
    const col = await orange.collect(
      new PaymentRequest({
        amount: "1500",
        currency: "XOF",
        payerMsisdn: "+221771234567",
        referenceId: "ord-om-1",
      }),
    );
    expect(col.referenceId).toBe("pt-om-1");
    expect(col.checkoutUrl).toBe("https://webpayment.orange.com/pay/pt-om-1");
    expect(capturedOrangePayloads[0]?.["reference"]).toBe("Boutique Sénégal");

    // Default orderId generation, short externalId, UUID compaction, and long non-UUID compaction (Issue #85)
    const defaultClientPay = await client.createWebPayment({
      amount: "2500",
      currency: "MGA",
      reference: "Café Côte d'Ivoire",
    });
    expect(defaultClientPay["pay_token"]).toBe("pt-om-2");
    const mgaPayload = capturedOrangePayloads[1]!;
    expect(String(mgaPayload["order_id"]).length).toBeLessThanOrEqual(30);
    expect(mgaPayload["amount"]).toBe(2500);
    expect(mgaPayload["reference"]).toBe("Café Côte d'Ivoire");

    const defaultProvCol = await orange.collect(
      new PaymentRequest({
        amount: "1500",
        currency: "XOF",
        payerMsisdn: "+221771234567",
      }),
    );
    expect((defaultProvCol.externalId ?? "").length).toBeLessThanOrEqual(30);

    const shortExtCol = await orange.collect(
      new PaymentRequest({
        amount: "1500",
        currency: "XOF",
        payerMsisdn: "+221771234567",
        externalId: "inv-2026-01",
      }),
    );
    expect(shortExtCol.externalId).toBe("inv-2026-01");

    const uuidRefCol = await orange.collect(
      new PaymentRequest({
        amount: "1500",
        currency: "XOF",
        payerMsisdn: "+221771234567",
        referenceId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    );
    expect((uuidRefCol.externalId ?? "").length).toBeLessThanOrEqual(30);

    const longRefCol = await orange.collect(
      new PaymentRequest({
        amount: "1500",
        currency: "XOF",
        payerMsisdn: "+221771234567",
        referenceId: "merchant-order-reference-exceeding-thirty-chars",
      }),
    );
    expect((longRefCol.externalId ?? "").length).toBeLessThanOrEqual(30);
    // Context store automatically supplies orderId/amount/currency/notifToken and getStatus populates txnid (Issue #35)
    const st = await orange.getStatus("pt-om-1");
    expect(st.isSuccessful()).toBe(true);
    expect(st.providerTransactionId).toBe("OM-TXN-2026-1");
    const verifiedCtx = client.verifyNotification("pt-om-1", "nt-om-secret-1");
    expect(verifiedCtx?.orderId).toBe("ord-om-1");
    expect(() => client.verifyNotification("pt-om-1", "wrong-token")).toThrow(
      WebhookVerificationError,
    );
    expect(() => client.verifyNotification("unknown-token", "nt-om-secret-1")).toThrow(
      WebhookVerificationError,
    );
    client.verifyNotification("external-pt", "explicit-nt", {
      expectedNotifToken: "explicit-nt",
    });
    await expect(orange.getStatus("unknown-token")).rejects.toThrow("orderId");
    await expect(
      orange.disburse(
        new DisbursementRequest({
          amount: "1500",
          currency: "XOF",
          payeeMsisdn: "+221771234567",
        }),
      ),
    ).rejects.toThrow("collections only");
    await expect(orange.getBalance()).rejects.toThrow("does not expose balances");
    orange.close();
  });

  it("validates provider configs, malformed responses, and signature edge cases", async () => {
    // Wave config & payout validation + expired/reversed session statuses
    expect(() => new WaveConfig({ apiKey: "  " })).toThrow("non-empty");
    expect(() => new WaveConfig({ apiKey: "k", webhookSecret: "   " })).toThrow(
      "blank",
    );
    const waveNoUrls = new WaveClient(
      { apiKey: "k" },
      { fetch: async () => jsonResp({}) },
    );
    await expect(
      waveNoUrls.createCheckoutSession({ amount: "100", currency: "XOF" }),
    ).rejects.toThrow("successUrl");
    await expect(
      waveNoUrls.createPayout({
        amount: "100",
        currency: "XOF",
        mobile: "221771234567",
        name: "   ",
      }),
    ).rejects.toThrow("blank");
    const waveEdge = new WaveProvider(
      new WaveClient(
        {
          apiKey: "k",
          successUrl: "https://a.example.com/ok",
          errorUrl: "https://a.example.com/err",
        },
        {
          fetch: async (url) => {
            if (url.endsWith("/v1/checkout/sessions/exp-1")) {
              return jsonResp({
                id: "exp-1",
                amount: "100",
                currency: "XOF",
                checkout_status: "expired",
                payment_status: "processing",
                last_payment_error: "timed out",
              });
            }
            if (url.endsWith("/v1/payout/rev-1")) {
              return jsonResp({
                id: "rev-1",
                amount: "100",
                currency: "XOF",
                status: "reversed",
                payout_error: { code: "REV" },
              });
            }
            if (url.endsWith("/v1/balance")) {
              return jsonResp({ bad: true });
            }
            return jsonResp({ bad: true });
          },
        },
      ),
    );
    expect((await waveEdge.getStatus("exp-1")).status).toBe(NormalizedStatus.EXPIRED);
    const rev = await waveEdge.getStatus("rev-1", { kind: "disbursement" });
    expect(rev.status).toBe(NormalizedStatus.REVERSED);
    expect(rev.reason).toBe("REV");
    await expect(waveEdge.getBalance()).rejects.toThrow("WaveBalanceResponse");

    // M-Pesa config & method validations
    expect(
      () =>
        new MpesaConfig({
          consumerKey: "a:b",
          consumerSecret: "s",
          shortCode: "1",
          passkey: "p",
        }),
    ).toThrow("':'");
    expect(
      () =>
        new MpesaConfig({
          consumerKey: "a",
          consumerSecret: "s",
          shortCode: "1",
          passkey: "p",
          environment: "production",
          baseUrl: "http://127.0.0.1:8000",
        }),
    ).toThrow();
    const mpesaNoSec = new MpesaClient(
      {
        consumerKey: "ck",
        consumerSecret: "cs",
        shortCode: "174379",
        passkey: "pk",
      },
      {
        fetch: async (url) => {
          if (url.includes("/oauth/v1/generate")) {
            return jsonResp({ access_token: "tok", expires_in: 60 });
          }
          if (url.endsWith("/mpesa/stkpushquery/v1/query")) {
            return jsonResp({
              CheckoutRequestID: "c1",
              ResultCode: "1032",
              ResultDesc: "Cancelled",
            });
          }
          return jsonResp({}, 500);
        },
      },
    );
    await expect(
      mpesaNoSec.stkPush({ amount: "100", phoneNumber: "254712345678" }),
    ).rejects.toThrow("callbackUrl");
    await expect(
      mpesaNoSec.stkPush({
        amount: "100",
        phoneNumber: "254712345678",
        accountReference: "TOOLONGREFERENCE123",
      }),
    ).rejects.toThrow("12 characters");
    await expect(
      mpesaNoSec.b2cTransfer({ amount: "100", phoneNumber: "254712345678" }),
    ).rejects.toThrow("securityCredential");
    await expect(mpesaNoSec.accountBalance()).rejects.toThrow("securityCredential");
    await expect(
      mpesaNoSec.reverseTransaction({ transactionId: "QWE123", amount: "100" }),
    ).rejects.toThrow("securityCredential");
    await expect(mpesaNoSec.stkQuery("   ")).rejects.toThrow("non-empty");
    const mpesaProv = new MpesaProvider(mpesaNoSec);
    expect((await mpesaProv.getStatus("c1")).isFailed()).toBe(true);
    await expect(
      mpesaProv.collect(
        new PaymentRequest({
          amount: "100",
          currency: "UGX",
          payerMsisdn: "+254712345678",
        }),
      ),
    ).rejects.toThrow("KES only");

    // Paystack config, minor units & error envelopes
    expect(() => new PaystackConfig({ secretKey: " " })).toThrow("non-empty");
    const psErrClient = new PaystackClient(
      { secretKey: "sk_test_x" },
      {
        fetch: async (url) => {
          if (url.endsWith("/balance")) {
            return jsonResp({
              status: true,
              data: [{ currency: "GHS", balance: 100 }],
            });
          }
          return jsonResp({ status: false, message: "Insufficient funds" });
        },
      },
    );
    await expect(
      psErrClient.initializeTransaction({
        email: "a@b.com",
        amount: "10.123",
        currency: "NGN",
      }),
    ).rejects.toThrow("2 decimal places");
    const psErrProv = new PaystackProvider(psErrClient);
    await expect(
      psErrProv.collect(
        new PaymentRequest({
          amount: "100",
          currency: "NGN",
          payerMsisdn: "+2348012345678",
        }),
      ),
    ).rejects.toThrow("payerEmail");
    await expect(psErrProv.getStatus("ref-x")).rejects.toThrow("Insufficient funds");
    await expect(psErrProv.getBalance({ currency: "USD" })).rejects.toThrow(
      "not found",
    );

    // Flutterwave error envelope & validation
    expect(() => new FlutterwaveConfig({ secretKey: "" })).toThrow("non-empty");
    expect(() => new FlutterwaveConfig({ secretKey: "sk", webhookHash: "  " })).toThrow(
      "blank",
    );
    const flwErr = new FlutterwaveProvider(
      new FlutterwaveClient(
        { secretKey: "sk" },
        {
          fetch: async () => jsonResp({ status: "error", message: "Declined" }),
        },
      ),
    );
    await expect(
      flwErr.collect(
        new PaymentRequest({
          amount: "100",
          currency: "NGN",
          payerMsisdn: "+2348012345678",
        }),
      ),
    ).rejects.toThrow("email");
    await expect(
      flwErr.disburse(
        new DisbursementRequest({
          amount: "100",
          currency: "NGN",
          payeeMsisdn: "0690000040",
        }),
      ),
    ).rejects.toThrow("accountBank");
    await expect(flwErr.getStatus("tx-1")).rejects.toThrow("Declined");

    // Orange Money config validation, fractional XOF rejection, missing pay_token
    expect(
      () =>
        new OrangeMoneyConfig({
          clientId: "a:b",
          clientSecret: "s",
          merchantKey: "m",
        }),
    ).toThrow("':'");
    expect(
      () =>
        new OrangeMoneyConfig({
          clientId: "a",
          clientSecret: "s",
          merchantKey: "m",
          lang: "english",
        }),
    ).toThrow("2-letter");
    const omNoPayClient = new OrangeMoneyClient(
      {
        clientId: "cid",
        clientSecret: "csec",
        merchantKey: "mkey",
        returnUrl: "https://a.example.com/r",
        cancelUrl: "https://a.example.com/c",
        notifUrl: "https://a.example.com/n",
      },
      {
        fetch: async (url) => {
          if (url.endsWith("/oauth/v3/token")) {
            return jsonResp({ access_token: "tok", expires_in: "120" });
          }
          if (url.endsWith("/transactionstatus")) {
            return jsonResp({ status: "EXPIRED" });
          }
          return jsonResp({ message: "Merchant inactive" });
        },
      },
    );
    const omNoPayToken = new OrangeMoneyProvider(omNoPayClient);
    await expect(
      omNoPayClient.createWebPayment({
        amount: "10.5",
        currency: "OUV",
      }),
    ).rejects.toThrow("whole-integer");
    await expect(
      omNoPayClient.createWebPayment({
        amount: "100.5",
        currency: "MGA",
      }),
    ).rejects.toThrow("whole-integer");
    await expect(
      omNoPayClient.createWebPayment({
        amount: "1000",
        currency: "XOF",
        orderId: "x".repeat(31),
      }),
    ).rejects.toThrow("30 characters");
    await expect(
      omNoPayClient.createWebPayment({
        amount: "1000",
        currency: "XOF",
        orderId: "   ",
      }),
    ).rejects.toThrow("non-empty");
    await expect(
      omNoPayClient.createWebPayment({
        amount: "1000",
        currency: "XOF",
        reference: "x".repeat(31),
      }),
    ).rejects.toThrow("30 characters");
    const over120Url = `https://a.example.com/${"p".repeat(110)}`;
    expect(
      () =>
        new OrangeMoneyConfig({
          clientId: "cid",
          clientSecret: "csec",
          merchantKey: "mkey",
          returnUrl: over120Url,
        }),
    ).toThrow("120 characters");
    await expect(
      omNoPayClient.createWebPayment({
        amount: "1000",
        currency: "XOF",
        notifUrl: over120Url,
      }),
    ).rejects.toThrow("120 characters");
    await expect(
      omNoPayClient.getTransactionStatus("x".repeat(31), "1000", "pt-1"),
    ).rejects.toThrow("30 characters");
    await expect(
      omNoPayToken.collect(
        new PaymentRequest({
          amount: "1000",
          currency: "XOF",
          payerMsisdn: "+221771234567",
        }),
      ),
    ).rejects.toThrow("Merchant inactive");
    expect(
      (
        await omNoPayToken.getStatus("pt-1", {
          orderId: "o1",
          amount: "1000",
          currency: "XOF",
        })
      ).status,
    ).toBe(NormalizedStatus.EXPIRED);

    // Signature verification edge cases via Wave & Paystack & Flutterwave
    const waveSig = new WaveClient({ apiKey: "k", webhookSecret: "sec" });
    const now = 1700000000;
    const body = Buffer.from("{}", "utf8");
    expect(() => waveSig.verifyWebhook(body, "", { now })).toThrow("empty");
    expect(() => waveSig.verifyWebhook(body, "malformed", { now })).toThrow(
      "Malformed",
    );
    expect(() =>
      waveSig.verifyWebhook(body, `t=${now},t=${now},v1=abc`, { now }),
    ).toThrow("Duplicate");
    expect(() => waveSig.verifyWebhook(body, `t=${now - 999},v1=abc`, { now })).toThrow(
      "expired",
    );
    expect(() => waveSig.verifyWebhook(body, `t=${now + 999},v1=abc`, { now })).toThrow(
      "future",
    );
    expect(() => waveSig.verifyWebhook(body, "t=01234,v1=abc", { now })).toThrow(
      "Invalid timestamp",
    );
    const psSig = new PaystackClient({ secretKey: "sk_test" });
    expect(() => psSig.verifyWebhook(body, "")).toThrow("empty");
    const flwSig = new FlutterwaveClient({ secretKey: "sk" });
    expect(() => flwSig.verifyWebhookHash("abc")).toThrow("empty");

    // Token error referenceId propagation on M-Pesa & Orange Money
    const mpesaAuthFail = new MpesaClient(
      {
        consumerKey: "ck",
        consumerSecret: "bad",
        shortCode: "174379",
        passkey: "pk",
        callbackUrl: "https://a.example.com/cb",
      },
      { fetch: async () => jsonResp({ errorMessage: "Invalid creds" }, 401) },
    );
    await expect(
      mpesaAuthFail.stkPush({
        amount: "100",
        phoneNumber: "254712345678",
        accountReference: "REF123",
      }),
    ).rejects.toMatchObject({ referenceId: "REF123", statusCode: 401 });

    const omAuthFail = new OrangeMoneyClient(
      {
        clientId: "cid",
        clientSecret: "bad",
        merchantKey: "mk",
        returnUrl: "https://a.example.com/r",
        cancelUrl: "https://a.example.com/c",
        notifUrl: "https://a.example.com/n",
      },
      { fetch: async () => jsonResp({ error_description: "Bad secret" }, 401) },
    );
    await expect(
      omAuthFail.createWebPayment({
        amount: "1000",
        currency: "XOF",
        orderId: "OM-REF-1",
      }),
    ).rejects.toMatchObject({ referenceId: "OM-REF-1", statusCode: 401 });

    // Orange Money missing callback URLs & blank orderId/payToken
    const omNoUrls = new OrangeMoneyClient(
      { clientId: "cid", clientSecret: "cs", merchantKey: "mk" },
      { fetch: async () => jsonResp({}) },
    );
    await expect(
      omNoUrls.createWebPayment({ amount: "1000", currency: "XOF" }),
    ).rejects.toThrow("returnUrl");
    await expect(omNoUrls.getTransactionStatus("", "1000", "pt")).rejects.toThrow(
      "orderId",
    );
    await expect(omNoUrls.getTransactionStatus("o1", "1000", "")).rejects.toThrow(
      "payToken",
    );

    // Mpesa B2C non-KES rejected via provider
    const mpesaB2cProv = new MpesaProvider(mpesaAuthFail);
    await expect(
      mpesaB2cProv.disburse(
        new DisbursementRequest({
          amount: "100",
          currency: "UGX",
          payeeMsisdn: "+254712345678",
        }),
      ),
    ).rejects.toThrow("KES only");

    // Direct signature edge cases (algorithm check, prefix, replayCheck)
    const hmacSig = createHmac("sha256", "mysec").update("hello").digest("hex");
    verifyHmacSignature("hello", `sha256=${hmacSig}`, "mysec");
    expect(() =>
      verifyHmacSignature("hello", hmacSig, "mysec", { algorithm: "md5" }),
    ).toThrow("Unsupported");
    expect(() => verifyHmacSignature("hello", hmacSig, "")).toThrow("empty");
    const tsSig = createHmac("sha256", "mysec").update(`${now}.hello`).digest("hex");
    expect(() =>
      verifyTimestampedHmacSignature("hello", `t=${now},v1=${tsSig}`, "mysec", {
        now,
        replayCheck: () => false,
      }),
    ).toThrow("replay");
    expect(() =>
      verifyTimestampedHmacSignature("hello", `t=${now},v1=${tsSig}`, "mysec", {
        now,
        toleranceSeconds: -1,
      }),
    ).toThrow("positive");
  });
});
