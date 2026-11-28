import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AirtelClient } from "../../src/airtel/client.js";
import { JsMomoSDK } from "../../src/client.js";
import { ProductConfig } from "../../src/config.js";
import { ConflictError } from "../../src/exceptions.js";
import type { RunningMockServer } from "../../src/mock-server.js";
import { createMockServer, startMockServer } from "../../src/mock-server.js";
import {
  FlutterwaveClient,
  MpesaClient,
  OrangeMoneyClient,
  PaystackClient,
  WaveClient,
} from "../../src/providers/index.js";

describe("Local Mock Gateway Server", () => {
  let mock: RunningMockServer;

  beforeAll(async () => {
    mock = await startMockServer({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await mock.close();
  });

  it("refuses non-loopback bind without allowNonLoopback and validates options", () => {
    expect(() => createMockServer({ host: "0.0.0.0" })).toThrow("non-loopback");
    expect(() => createMockServer({ defaultStatus: "INVALID" })).toThrow(
      "defaultStatus",
    );
    expect(() => createMockServer({ port: 70000 })).toThrow("port");
    expect(() => createMockServer({ maxBodyBytes: 0 })).toThrow("maxBodyBytes");
  });

  it("enforces total requestTimeout against slow-drip POST bodies (Issue #16)", async () => {
    const slowSrv = await startMockServer({
      host: "127.0.0.1",
      port: 0,
      maxConcurrentRequests: 2,
      requestTimeout: 0.25,
    });
    const sockets: ReturnType<typeof connect>[] = [];
    let dripTimer: ReturnType<typeof setInterval> | undefined;
    try {
      expect(slowSrv.server.requestTimeout).toBe(250);
      expect(slowSrv.server.headersTimeout).toBe(250);
      const openSlowPost = () =>
        new Promise<void>((resolve) => {
          const sock = connect({ host: "127.0.0.1", port: slowSrv.port }, () => {
            sock.write(
              "POST /collection/v1_0/requesttopay HTTP/1.1\r\n" +
                "Host: 127.0.0.1\r\n" +
                "Content-Length: 1000\r\n" +
                "Content-Type: application/json\r\n\r\n" +
                "{",
            );
            sockets.push(sock);
            resolve();
          });
          sock.on("error", () => resolve());
        });
      await openSlowPost();
      await openSlowPost();
      dripTimer = setInterval(() => {
        for (const s of sockets) {
          if (!s.destroyed) s.write(" ");
        }
      }, 75);
      await new Promise((r) => setTimeout(r, 450));
      const resp = await fetch(`${slowSrv.url}/v1/balance`);
      expect(resp.status).toBe(200);
    } finally {
      if (dripTimer) clearInterval(dripTimer);
      for (const s of sockets) s.destroy();
      slowSrv.server.closeAllConnections?.();
      await slowSrv.close();
    }
  });

  it("serves MTN MoMo, Sandbox, Airtel, Wave, M-Pesa, Paystack, Flutterwave, and Orange Money end-to-end", async () => {
    // 1. MTN Sandbox + Collection + 409 Conflict + Disbursement + Balance
    const mtn = new JsMomoSDK({
      baseUrl: mock.url,
      collection: new ProductConfig({
        subscriptionKey: "sub",
        apiUser: "u",
        apiKey: "k",
      }),
      disbursement: new ProductConfig({
        subscriptionKey: "sub",
        apiUser: "u",
        apiKey: "k",
      }),
      remittance: new ProductConfig({
        subscriptionKey: "sub",
        apiUser: "u",
        apiKey: "k",
      }),
    });
    const prov = mtn.createSandboxProvisioner("sub");
    const creds = await prov.provision({ callbackHost: "https://example.com" });
    expect(creds.apiKey).toContain("mock-api-key-");
    expect((await prov.getApiUser(creds.apiUser)).providerCallbackHost).toBe(
      "example.com",
    );
    expect((await prov.getApiUser(creds.apiUser)).targetEnvironment).toBe("sandbox");
    expect(
      (
        await fetch(`${mock.url}/v1_0/apiuser`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerCallbackHost: "https://example.com" }),
        })
      ).status,
    ).toBe(400);

    const ref = await mtn.collection.requestToPay({
      amount: "500",
      currency: "UGX",
      payerMsisdn: "256772123456",
      externalId: "e1",
    });
    expect((await mtn.collection.getPaymentStatus(ref)).isSuccessful()).toBe(true);
    await mtn.collection.requestToPayDeliveryNotification(ref, "Order delivered");
    expect(
      (
        await fetch(
          `${mock.url}/collection/v1_0/requesttopay/${ref}/deliverynotification`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ notificationMessage: "" }),
          },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          `${mock.url}/collection/v1_0/requesttopay/missing/deliverynotification`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ notificationMessage: "hi" }),
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${mock.url}/remittance/v2_0/cashtransfer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ amount: "100", currency: "UGX" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${mock.url}/collection/v2_0/preapproval/missing`)).status,
    ).toBe(404);
    const paRef = await mtn.collection.preApprove({
      payerMsisdn: "256772123456",
      payerCurrency: "UGX",
      validityTime: 3600,
    });
    expect((await mtn.collection.getPreApprovalStatus(paRef)).isSuccessful()).toBe(
      true,
    );
    const ctRef = await mtn.remittance.cashTransfer({
      amount: "500",
      currency: "UGX",
      payeeMsisdn: "256772123456",
      externalId: "ct-1",
      originatingCountry: "UG",
    });
    expect((await mtn.remittance.getCashTransferStatus(ctRef)).isSuccessful()).toBe(
      true,
    );
    await expect(
      mtn.collection.requestToPay({
        amount: "500",
        currency: "UGX",
        payerMsisdn: "256772123456",
        externalId: "e1",
        referenceId: ref,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await mtn.collection.getBalance()).availableBalance).toBe("10000.00");
    expect((await mtn.collection.getBalanceForCurrency("UGX")).currency).toBe("UGX");
    expect(await mtn.collection.isAccountHolderActive("256772123456")).toBe(true);
    expect((await mtn.collection.getBasicUserInfo("256772123456")).givenName).toBe(
      "Mock",
    );
    expect(
      (
        await mtn.collection.bcAuthorize({
          loginHint: "ID:256772123456/MSISDN",
        })
      ).authReqId,
    ).toBe("mock-auth-req-id");

    // 2. Airtel Money
    const air = new AirtelClient({
      clientId: "cid",
      clientSecret: "csec",
      country: "UG",
      currency: "UGX",
      pin: "1234",
      baseUrl: mock.url,
    });
    const airRef = await air.collection.requestToPay({
      amount: "500",
      payerMsisdn: "256752123456",
      referenceId: "MOCK-AIR-1",
    });
    expect((await air.collection.getPaymentStatus(airRef)).isSuccessful()).toBe(true);
    expect((await air.disbursement.getBalance()).data.wallet.balance).toBe("5000.00");

    // 3. Wave
    const wave = new WaveClient({
      apiKey: "wk",
      successUrl: "https://a.example.com/ok",
      errorUrl: "https://a.example.com/err",
      baseUrl: mock.url,
    });
    const sess = await wave.createCheckoutSession({
      amount: "1000",
      currency: "XOF",
    });
    expect((await wave.getCheckoutSession(sess.id)).paymentStatus).toBe("succeeded");
    const payout = await wave.createPayout({
      amount: "500",
      currency: "XOF",
      mobile: "221771234567",
    });
    expect((await wave.getPayout(payout.id)).status).toBe("succeeded");
    expect((await wave.getBalance()).amount).toBe("25000");
    expect(
      (
        await fetch(`${mock.url}/v1/payout`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payment_reason: "r".repeat(41) }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${mock.url}/v1/checkout/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_reference: "c".repeat(256) }),
        })
      ).status,
    ).toBe(400);

    // 4. M-Pesa
    const mpesa = new MpesaClient({
      consumerKey: "ck",
      consumerSecret: "cs",
      shortCode: "174379",
      passkey: "pk",
      callbackUrl: "https://a.example.com/cb",
      securityCredential: "sec",
      baseUrl: mock.url,
    });
    const stk = await mpesa.stkPush({
      amount: "100",
      phoneNumber: "0712345678",
    });
    expect((await mpesa.stkQuery(stk.checkoutRequestId)).resultCode).toBe("0");
    expect(
      (await mpesa.b2cTransfer({ amount: "100", phoneNumber: "0112345678" }))
        .responseCode,
    ).toBe("0");
    expect((await mpesa.accountBalance()).responseCode).toBe("0");
    expect(
      (
        await mpesa.reverseTransaction({
          transactionId: "QWE123RTY",
          amount: "100",
        })
      ).responseCode,
    ).toBe("0");
    expect(
      (
        await fetch(`${mock.url}/mpesa/stkpush/v1/processrequest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ PartyA: "0712345678", PhoneNumber: "0712345678" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${mock.url}/mpesa/b2c/v3/paymentrequest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ PartyB: "0712345678" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${mock.url}/mpesa/reversal/v1/request`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ TransactionID: "" }),
        })
      ).status,
    ).toBe(400);

    // 5. Paystack
    const ps = new PaystackClient({ secretKey: "sk", baseUrl: mock.url });
    const psRec = await ps.createTransferRecipient({
      type: "mobile_money",
      name: "Kofi Boateng",
      accountNumber: "0551234567",
      bankCode: "MTN",
      currency: "GHS",
    });
    expect(
      String((psRec["data"] as Record<string, unknown>)["recipient_code"]),
    ).toMatch(/^RCP_mock_/);
    await ps.initializeTransaction({
      email: "a@b.com",
      amount: "50",
      currency: "NGN",
      reference: "ps-mock-1",
    });
    expect(
      ((await ps.verifyTransaction("ps-mock-1"))["data"] as Record<string, unknown>)[
        "status"
      ],
    ).toBe("success");
    expect(((await ps.getBalance())["data"] as unknown[]).length).toBe(1);
    const psCharge = await ps.chargeMobileMoney({
      email: "a@b.com",
      amount: "25",
      currency: "GHS",
      phone: "0551234567",
      provider: "mtn",
      reference: "ps-charge-mock-1",
    });
    expect(
      (
        (await ps.verifyTransaction("ps-charge-mock-1"))["data"] as Record<
          string,
          unknown
        >
      )["status"],
    ).toBe("success");
    expect(psCharge["status"]).toBe(true);
    expect(
      (
        (await ps.listBanks({ currency: "GHS", type: "mobile_money" }))[
          "data"
        ] as unknown[]
      ).length,
    ).toBe(1);
    expect(
      (
        await ps.createRefund({
          transaction: "ps-mock-1",
          amount: "10",
          currency: "NGN",
        })
      )["status"],
    ).toBe(true);
    expect(
      (
        await fetch(`${mock.url}/transfer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reference: "BAD_SHORT" }),
        })
      ).status,
    ).toBe(400);

    // 6. Flutterwave
    const flw = new FlutterwaveClient({
      secretKey: "sk",
      defaultCustomerEmail: "a@b.com",
      defaultAccountBank: "044",
      baseUrl: mock.url,
    });
    await flw.createPayment({
      amount: "50",
      currency: "NGN",
      phoneNumber: "2348012345678",
      txRef: "flw-mock-1",
    });
    expect(
      ((await flw.verifyByReference("flw-mock-1"))["data"] as Record<string, unknown>)[
        "status"
      ],
    ).toBe("successful");
    expect(
      ((await flw.getBalance("NGN"))["data"] as Record<string, unknown>)[
        "available_balance"
      ],
    ).toBe(10000);

    // 7. Orange Money
    const om = new OrangeMoneyClient({
      clientId: "cid",
      clientSecret: "csec",
      merchantKey: "mk",
      returnUrl: "https://a.example.com/r",
      cancelUrl: "https://a.example.com/c",
      notifUrl: "https://a.example.com/n",
      baseUrl: mock.url,
    });
    const omInit = await om.createWebPayment({
      amount: "1000",
      currency: "XOF",
      orderId: "om-1",
    });
    const omDefaultInit = await om.createWebPayment({
      amount: "2000",
      currency: "MGA",
      reference: "Boutique Sénégal",
    });
    expect(typeof omDefaultInit["pay_token"]).toBe("string");
    expect(
      (
        await fetch(`${mock.url}/orange-money-webpay/dev/v1/webpayment`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ order_id: "x".repeat(31) }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${mock.url}/orange-money-webpay/dev/v1/webpayment`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ order_id: "om-ok", reference: "x".repeat(31) }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${mock.url}/orange-money-webpay/dev/v1/webpayment`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            order_id: "om-ok",
            notif_url: `https://a.example.com/${"u".repeat(110)}`,
          }),
        })
      ).status,
    ).toBe(400);
    const omSt = await om.getTransactionStatus(
      "om-1",
      "1000",
      String(omInit["pay_token"]),
    );
    expect(omSt["status"]).toBe("SUCCESS");

    // 413 payload too large, 400 invalid JSON, 404 unknown path, 405 unsupported method, FAILED status mode & bounded eviction
    const tiny = await startMockServer({
      maxBodyBytes: 16,
      defaultStatus: "FAILED",
      maxEntries: 1,
    });
    try {
      const r413 = await fetch(`${tiny.url}/collection/v1_0/requesttopay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: "x".repeat(64) }),
      });
      expect(r413.status).toBe(413);

      const r400 = await fetch(`${tiny.url}/collection/v1_0/requesttopay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad",
      });
      expect(r400.status).toBe(400);

      const r404 = await fetch(`${tiny.url}/unknown/path`);
      expect(r404.status).toBe(404);

      const r405 = await fetch(`${tiny.url}/v1/balance`, { method: "DELETE" });
      expect(r405.status).toBe(405);

      // Eviction when maxEntries=1 and FAILED status propagation
      const r1 = await fetch(`${tiny.url}/collection/v1_0/requesttopay`, {
        method: "POST",
        headers: { "X-Reference-Id": "ref-1" },
        body: "{}",
      });
      expect(r1.status).toBe(202);
      const r2 = await fetch(`${tiny.url}/collection/v1_0/requesttopay`, {
        method: "POST",
        headers: { "X-Reference-Id": "ref-2" },
        body: "{}",
      });
      expect(r2.status).toBe(202);
      expect(
        (await fetch(`${tiny.url}/collection/v1_0/requesttopay/ref-1`)).status,
      ).toBe(404);
      const st2 = (await (
        await fetch(`${tiny.url}/collection/v1_0/requesttopay/ref-2`)
      ).json()) as { status: string };
      expect(st2.status).toBe("FAILED");

      // 404 lookups across all providers & PENDING status mode
      for (const p of [
        "/v1_0/apiuser/missing",
        "/standard/v1/payments/missing",
        "/v1/checkout/sessions/missing",
        "/v1/payout/missing",
        "/transaction/verify/missing",
        "/v3/transactions/verify_by_reference?tx_ref=missing",
        "/v3/transfers/missing",
      ]) {
        expect((await fetch(`${tiny.url}${p}`)).status).toBe(404);
      }
      expect(
        (
          await fetch(`${tiny.url}/v1_0/apiuser/missing/apikey`, {
            method: "POST",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(`${mock.url}/mpesa/stkpushquery/v1/query`, {
            method: "POST",
            body: JSON.stringify({ CheckoutRequestID: "missing" }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(`${mock.url}/orange-money-webpay/dev/v1/transactionstatus`, {
            method: "POST",
            body: JSON.stringify({ pay_token: "missing" }),
          })
        ).status,
      ).toBe(404);
    } finally {
      await tiny.close();
    }

    const pendingSrv = await startMockServer({ defaultStatus: "PENDING" });
    try {
      await fetch(`${pendingSrv.url}/v3/transfers`, {
        method: "POST",
        body: JSON.stringify({ reference: "flw-p1", amount: "10", currency: "NGN" }),
      });
      const flwGet = (await (
        await fetch(`${pendingSrv.url}/v3/transfers/flw-p1`)
      ).json()) as { data: { status: string } };
      expect(flwGet.data.status).toBe("pending");
    } finally {
      await pendingSrv.close();
    }
  });
});
