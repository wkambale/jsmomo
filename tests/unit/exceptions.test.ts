import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  JsMomoSDKError,
  JsMomoSDKServerError,
  MissingCredentialsError,
  ResourceNotFoundError,
  TransactionFailedError,
  WebhookVerificationError,
} from "../../src/exceptions.js";

describe("exceptions", () => {
  it("maintains proper instanceof inheritance across all exception classes", () => {
    const errors = [
      new AuthenticationError("auth"),
      new MissingCredentialsError("creds"),
      new BadRequestError("bad"),
      new ResourceNotFoundError("missing"),
      new ConflictError("dup"),
      new JsMomoSDKServerError("500"),
      new TransactionFailedError("tx-1", "insufficient funds"),
      new WebhookVerificationError("sig"),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(JsMomoSDKError);
    }
  });

  it("sanitizes control characters and caps length on server messages", () => {
    const err = new BadRequestError(
      `Line1\r\nFakeLog: admin=true\x00${"A".repeat(1000)}`,
      { secret: "should-not-appear" },
    );
    expect(err.message).not.toContain("\r");
    expect(err.message).not.toContain("\n");
    expect(err.message).not.toContain("\x00");
    expect(err.message.length).toBeLessThanOrEqual(512);
    expect(inspect(err)).not.toContain("should-not-appear");
  });

  it("recursively redacts sensitive keys in responseBody and exposes structured fields", () => {
    const err = new BadRequestError(
      "INVALID_CALLBACK_URL_HOST: Host mismatch",
      {
        code: "INVALID_CALLBACK_URL_HOST",
        access_token: "live-jwt",
        nested: {
          client_secret: "top-secret",
          apiKey: "secret-key",
          safe: "currency=UGX",
        },
        items: [{ pin: "1234", field: "amount" }],
      },
      {
        referenceId: "ref-123",
        statusCode: 422,
        errorCode: "INVALID_CALLBACK_URL_HOST",
        reason: "Host mismatch",
        provider: "MTN MoMo",
      },
    );

    expect(err.referenceId).toBe("ref-123");
    expect(err.statusCode).toBe(422);
    expect(err.errorCode).toBe("INVALID_CALLBACK_URL_HOST");
    expect(err.reason).toBe("Host mismatch");
    expect(err.provider).toBe("MTN MoMo");
    expect(err.responseBody["access_token"]).toBe("<redacted>");
    expect(
      (err.responseBody["nested"] as Record<string, unknown>)["client_secret"],
    ).toBe("<redacted>");
    expect((err.responseBody["nested"] as Record<string, unknown>)["apiKey"]).toBe(
      "<redacted>",
    );
    expect((err.responseBody["nested"] as Record<string, unknown>)["safe"]).toBe(
      "currency=UGX",
    );
    expect(
      ((err.responseBody["items"] as Record<string, unknown>[])[0] ?? {})["pin"],
    ).toBe("<redacted>");

    const rendered = inspect(err);
    expect(rendered).toContain("BadRequestError(");
    expect(rendered).toContain('referenceId="ref-123"');
    expect(rendered).toContain("statusCode=422");
    expect(rendered).toContain('errorCode="INVALID_CALLBACK_URL_HOST"');
    expect(rendered).toContain('provider="MTN MoMo"');
    expect(rendered).not.toContain("live-jwt");
    expect(rendered).not.toContain("currency=UGX");

    const serialized = err.toJSON();
    expect(serialized["referenceId"]).toBe("ref-123");
    expect(serialized["statusCode"]).toBe(422);
    expect(serialized["responseBody"]).toBeUndefined();

    // CamelCase, kebab-case, and Orange Money token keys are redacted (Issue #15)
    const multiErr = new JsMomoSDKError("Upstream failed", {
      responseBody: {
        accessToken: "tok-camel",
        refreshToken: "ref-camel",
        clientSecret: "sec-camel",
        merchantKey: "mkey-camel",
        authReqId: "req-camel",
        "Ocp-Apim-Subscription-Key": "sub-kebab",
        pay_token: "om-pay-tok",
        notif_token: "om-notif-tok",
        signingSecret: "wave-sign-sec",
        private_key: "rsa-priv-key",
        encryptionKey: "flw-enc-key",
        "x-key": "airtel-x-key",
        "x-signature": "airtel-x-sig",
        safeField: "ok",
      },
    });
    for (const k of [
      "accessToken",
      "refreshToken",
      "clientSecret",
      "merchantKey",
      "authReqId",
      "Ocp-Apim-Subscription-Key",
      "pay_token",
      "notif_token",
      "signingSecret",
      "private_key",
      "encryptionKey",
      "x-key",
      "x-signature",
    ]) {
      expect(multiErr.responseBody[k]).toBe("<redacted>");
    }
    expect(multiErr.responseBody["safeField"]).toBe("ok");
  });

  it("caps deep recursion in responseBody redaction", () => {
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i < 10; i += 1) {
      deep = { child: deep };
    }
    const err = new JsMomoSDKError("deep", { responseBody: deep });
    expect(JSON.stringify(err.responseBody)).toContain("<truncated>");
  });

  it("defaults ConflictError statusCode to 409 and formats TransactionFailedError", () => {
    const conflict = new ConflictError("Duplicate reference", {
      referenceId: "dup-1",
      provider: "MTN MoMo",
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.referenceId).toBe("dup-1");

    const txFail = new TransactionFailedError("tx-99", "Insufficient funds", {
      statusCode: 200,
      errorCode: "DP00800001001",
      provider: "Airtel Money",
    });
    expect(txFail.message).toBe("Transaction tx-99 failed: Insufficient funds");
    expect(txFail.referenceId).toBe("tx-99");
    expect(txFail.errorCode).toBe("DP00800001001");

    const txNoReason = new TransactionFailedError("tx-100");
    expect(txNoReason.message).toBe("Transaction tx-100 failed");
    expect(txNoReason.reason).toBeNull();
  });
});
