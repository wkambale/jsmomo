import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  JsMomoSDKError,
  JsMomoSDKServerError,
  MissingCredentialsError,
} from "../../src/exceptions.js";
import type { PaymentProvider } from "../../src/providers/index.js";
import {
  DisbursementRequest,
  NormalizedStatus,
  PaymentRequest,
  PaymentResult,
  PaymentRouter,
  ProviderCapabilities,
  isPaymentProvider,
} from "../../src/providers/index.js";

function makeStubProvider(
  name: string,
  options: {
    currencies?: string[];
    supportsDisbursement?: boolean;
    supportsBalance?: boolean;
    onCollect?: (req: PaymentRequest) => Promise<PaymentResult>;
    onDisburse?: (req: DisbursementRequest) => Promise<PaymentResult>;
  } = {},
): PaymentProvider {
  return {
    name,
    capabilities: new ProviderCapabilities({
      providerId: name,
      supportsCollection: true,
      supportsDisbursement: options.supportsDisbursement ?? true,
      supportsBalance: options.supportsBalance ?? true,
      currencies: options.currencies ?? ["UGX", "KES"],
    }),
    collect:
      options.onCollect ??
      (async (req) =>
        new PaymentResult({
          provider: name,
          referenceId: req.referenceId ?? `${name}-col-1`,
          status: NormalizedStatus.PENDING,
          amount: req.amount,
          currency: req.currency,
        })),
    disburse:
      options.onDisburse ??
      (async (req) =>
        new PaymentResult({
          provider: name,
          referenceId: req.referenceId ?? `${name}-disb-1`,
          status: NormalizedStatus.PENDING,
          amount: req.amount,
          currency: req.currency,
        })),
    getStatus: async (ref) =>
      new PaymentResult({
        provider: name,
        referenceId: ref,
        status: NormalizedStatus.SUCCEEDED,
      }),
    getBalance: async () => ({
      provider: name,
      availableBalance: "10000",
      currency: "UGX",
      raw: {},
    }),
    close: () => {},
  };
}

describe("PaymentRouter", () => {
  it("routes by MSISDN carrier prefix, explicit provider, and currency capability", async () => {
    const mtn = makeStubProvider("mtn_momo", { currencies: ["UGX"] });
    const airtel = makeStubProvider("airtel_money", { currencies: ["UGX", "KES"] });
    const orange = makeStubProvider("orange_money", {
      currencies: ["XOF"],
      supportsDisbursement: false,
      supportsBalance: false,
    });

    expect(isPaymentProvider(mtn)).toBe(true);
    expect(isPaymentProvider({})).toBe(false);

    const router = new PaymentRouter({
      providers: [mtn, airtel, orange],
      defaultProvider: "mtn_momo",
    });
    expect(router.listProviders()).toEqual([
      "mtn_momo",
      "airtel_money",
      "orange_money",
    ]);

    // +256752 -> Airtel Uganda
    const airRes = await router.collect(
      new PaymentRequest({
        amount: "1000",
        currency: "UGX",
        payerMsisdn: "+256752123456",
      }),
    );
    expect(airRes.provider).toBe("airtel_money");

    // +256772 -> MTN Uganda
    const mtnRes = await router.collect(
      new PaymentRequest({
        amount: "1000",
        currency: "UGX",
        payerMsisdn: "+256772123456",
      }),
    );
    expect(mtnRes.provider).toBe("mtn_momo");

    // Explicit provider rejecting unsupported currency
    await expect(
      router.collect(
        new PaymentRequest({
          amount: "1000",
          currency: "USD",
          payerMsisdn: "+256772123456",
        }),
        { provider: "mtn_momo" },
      ),
    ).rejects.toThrow("does not support collection for currency");

    // Status & balance capability checks
    expect(
      (await router.getStatus("ref-1", { provider: "mtn_momo" })).isSuccessful(),
    ).toBe(true);
    expect((await router.getBalance({ provider: "mtn_momo" })).availableBalance).toBe(
      "10000",
    );
    await expect(
      router.getStatus("ref-1", {
        provider: "orange_money",
        kind: "disbursement",
      }),
    ).rejects.toThrow("does not support disbursement status");
    await expect(router.getBalance({ provider: "orange_money" })).rejects.toThrow(
      "does not support balance",
    );

    await router.close();
  });

  it("enforces safe failover defaults and preserves attemptedReferences / priorFailedAttempts", async () => {
    const seenRefs: string[] = [];
    const primary500 = makeStubProvider("mtn_momo", {
      onCollect: async (req) => {
        if (req.referenceId) seenRefs.push(req.referenceId);
        throw new JsMomoSDKServerError("upstream 502", {
          referenceId: req.referenceId ?? "mtn-gen-ref",
          statusCode: 502,
          provider: "MTN MoMo",
        });
      },
      onDisburse: async (req) => {
        throw new MissingCredentialsError("no disbursement creds", {
          referenceId: req.referenceId ?? "mtn-disb-ref",
          provider: "MTN MoMo",
        });
      },
    });
    const backupOk = makeStubProvider("airtel_money", {
      onCollect: async (req) => {
        if (req.referenceId) seenRefs.push(req.referenceId);
        return new PaymentResult({
          provider: "airtel_money",
          referenceId: req.referenceId ?? "air-ok",
          status: NormalizedStatus.PENDING,
        });
      },
    });

    const router = new PaymentRouter({
      providers: [primary500, backupOk],
      defaultProvider: "mtn_momo",
    });

    // By default fallback=true does NOT fail over on ambiguous 5xx
    await expect(
      router.collect(
        new PaymentRequest({
          amount: "5000",
          currency: "UGX",
          payerMsisdn: "+256772123456",
        }),
        { fallback: true },
      ),
    ).rejects.toMatchObject({
      referenceId: "mtn-gen-ref",
      statusCode: 502,
    });

    // With allowAmbiguousWriteFallback=true, deterministic ref is shared and priorFailedAttempts recorded
    const recovered = await router.collect(
      new PaymentRequest({
        amount: "5000",
        currency: "UGX",
        payerMsisdn: "+256772123456",
      }),
      { fallback: true, allowAmbiguousWriteFallback: true },
    );
    expect(recovered.provider).toBe("airtel_money");
    expect(seenRefs.length).toBe(2);
    expect(seenRefs[0]).toBe(seenRefs[1]);
    expect(recovered.raw["priorFailedAttempts"]).toEqual([
      { provider: "mtn_momo", referenceId: seenRefs[0] },
    ]);

    // Disbursement automatically fails over on MissingCredentialsError
    const recoveredDisb = await router.disburse(
      new DisbursementRequest({
        amount: "2000",
        currency: "UGX",
        payeeMsisdn: "+256772123456",
        referenceId: "disb-shared-1",
      }),
      { fallback: true },
    );
    expect(recoveredDisb.provider).toBe("airtel_money");
    expect(recoveredDisb.raw["priorFailedAttempts"]).toEqual([
      { provider: "mtn_momo", referenceId: "disb-shared-1" },
    ]);

    // When all candidates fail, attemptedReferences lists every rail
    const failAllRouter = new PaymentRouter({
      providers: [
        makeStubProvider("mtn_momo", {
          onCollect: async () => {
            throw new AuthenticationError("bad mtn auth", {
              referenceId: "r-mtn",
            });
          },
        }),
        makeStubProvider("airtel_money", {
          onCollect: async () => {
            throw new AuthenticationError("bad airtel auth", {
              referenceId: "r-air",
            });
          },
        }),
      ],
    });
    await expect(
      failAllRouter.collect(
        new PaymentRequest({
          amount: "1000",
          currency: "UGX",
          payerMsisdn: "+256772123456",
        }),
        { fallback: true },
      ),
    ).rejects.toMatchObject({
      referenceId: "r-air",
      attemptedReferences: [
        { provider: "mtn_momo", referenceId: "r-mtn" },
        { provider: "airtel_money", referenceId: "r-air" },
      ],
    });

    // Rejects invalid default provider & invalid registration
    expect(() => new PaymentRouter({ defaultProvider: "missing" })).toThrow(
      JsMomoSDKError,
    );
    expect(() => failAllRouter.register({} as unknown as PaymentProvider)).toThrow(
      TypeError,
    );

    // Disbursement fallback with allowAmbiguousWriteFallback=true, all-fail, and non-failover errors
    const disbFailAll = new PaymentRouter({
      providers: [
        makeStubProvider("mtn_momo", {
          onDisburse: async () => {
            throw new JsMomoSDKServerError("503", { statusCode: 503 });
          },
        }),
        makeStubProvider("airtel_money", {
          onDisburse: async () => {
            throw new JsMomoSDKError("bad account");
          },
        }),
      ],
    });
    await expect(
      disbFailAll.disburse(
        new DisbursementRequest({
          amount: "1000",
          currency: "UGX",
          payeeMsisdn: "+256772123456",
        }),
        { fallback: true, allowAmbiguousWriteFallback: true },
      ),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as JsMomoSDKError;
      expect(e.referenceId).toBeTruthy();
      expect(e.attemptedReferences).toHaveLength(2);
      return true;
    });

    // Empty router & unregistered explicit provider
    const emptyRouter = new PaymentRouter();
    await expect(
      emptyRouter.collect(
        new PaymentRequest({
          amount: "1000",
          currency: "UGX",
          payerMsisdn: "+256772123456",
        }),
      ),
    ).rejects.toThrow("No matching payment provider");
    await expect(
      emptyRouter.collect(
        new PaymentRequest({
          amount: "1000",
          currency: "UGX",
          payerMsisdn: "+256772123456",
        }),
        { provider: "mtn_momo" },
      ),
    ).rejects.toThrow("not registered");
  });
});
