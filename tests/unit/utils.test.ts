import { describe, expect, it } from "vitest";

import { AirtelTransactionResponse } from "../../src/airtel/models.js";
import { JsMomoSDKError, TransactionFailedError } from "../../src/exceptions.js";
import {
  buildBasicAuthHeader,
  detectCarrierFromMsisdn,
  encodePathSegment,
  generateReferenceId,
  normaliseMsisdn,
  validateAccountHolderIdType,
  validateAirtelReferenceId,
  validateAmount,
  validateBaseUrl,
  validateCallbackHost,
  validateCallbackUrl,
  validateCountryCode,
  validateCurrency,
  validateEmailAddress,
  validateEnvironmentName,
  validateHeaderValue,
  validateMatchingOrigin,
  validateMaxRetries,
  validatePrintableText,
  validateReferenceId,
  validateRequestPath,
  validateRetryBackoff,
  validateTimeout,
  waitForSettlement,
} from "../../src/utils.js";

import { VERSION } from "../../src/version.js";

describe("utils", () => {
  it("exports a semantic VERSION string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("validates base URLs and blocks SSRF, metadata, private, and obfuscated IPs", () => {
    expect(validateBaseUrl("https://sandbox.momodeveloper.mtn.com:443")).toBe(
      "https://sandbox.momodeveloper.mtn.com:443",
    );
    expect(validateBaseUrl("http://localhost:80")).toBe("http://localhost:80");
    expect(validateBaseUrl("http://[::1]:8000")).toBe("http://[::1]:8000");

    expect(() => validateBaseUrl("https://proxy.momoapi.mtn.com?foo=bar")).toThrow(
      JsMomoSDKError,
    );
    expect(validateCallbackUrl("https://proxy.momoapi.mtn.com/cb?token=ok")).toBe(
      "https://proxy.momoapi.mtn.com/cb?token=ok",
    );

    for (const bad of [
      "http://proxy.momoapi.mtn.com",
      "https://user:pass@proxy.momoapi.mtn.com",
      "https://proxy.momoapi.mtn.com#frag",
      "https://169.254.169.254",
      "https://10.0.0.1",
      "https://192.168.1.10",
      "https://172.16.0.1",
      "https://100.64.0.1",
      "https://[fe80::1]",
      "https://[fc00::1]",
      "https://[ff02::1]",
      "https://[::]",
      "https://[2001:db8::1]",
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:169.254.169.254]",
      "https://[::127.0.0.1]",
      "https://[::169.254.169.254]",
      "https://[::ffff:0:127.0.0.1]",
      "https://[64:ff9b::169.254.169.254]",
      "https://[64:ff9b:1::10.0.0.1]",
      "https://[2002:a9fe:a9fe::1]",
      "https://[2001::1]",
      "https://[fec0::1]",
      "https://[100::1]",
      "https://0.0.0.0",
      "https://192.0.2.1",
      "https://192.88.99.1",
      "https://198.18.0.1",
      "https://198.51.100.1",
      "https://203.0.113.1",
      "https://224.0.0.1",
      "https://0x7f000001",
      "https://2130706433",
      "https://127.1",
      "https://sandbox.momodeveloper.mtn.com:",
      "https://sandbox.momodeveloper.mtn.com;a=b",
    ]) {
      expect(() => validateBaseUrl(bad), bad).toThrow(JsMomoSDKError);
      expect(() => validateCallbackUrl(`${bad}/cb`), bad).toThrow(RangeError);
    }

    expect(() =>
      validateBaseUrl("http://127.0.0.1:8080", { allowLocalhost: false }),
    ).toThrow(JsMomoSDKError);
    for (const sub of ["https://api.localhost", "https://127.localhost."]) {
      expect(() => validateBaseUrl(sub, { allowLocalhost: false }), sub).toThrow(
        JsMomoSDKError,
      );
      expect(
        () => validateCallbackUrl(`${sub}/hook`, { allowLocalhost: false }),
        sub,
      ).toThrow(RangeError);
      expect(() => validateCallbackHost(sub, { allowLocalhost: false }), sub).toThrow(
        RangeError,
      );
    }
    expect(validateCallbackHost("merchant.example.com")).toBe("merchant.example.com");
    expect(validateCallbackHost("https://merchant.example.com/hook")).toBe(
      "https://merchant.example.com/hook",
    );
    expect(() => validateCallbackHost("169.254.169.254")).toThrow(RangeError);
    expect(() => validateCallbackHost("10.0.0.1")).toThrow(RangeError);
  });

  it("validates matching origins and blocks path traversal", () => {
    expect(() =>
      validateMatchingOrigin(
        "https://sandbox.momodeveloper.mtn.com",
        "https://sandbox.momodeveloper.mtn.com:443",
      ),
    ).not.toThrow();
    expect(() =>
      validateMatchingOrigin(
        "https://sandbox.momodeveloper.mtn.com",
        "https://evil.example.com",
      ),
    ).toThrow(JsMomoSDKError);

    expect(validateRequestPath("/collection/v1_0/requesttopay")).toBe(
      "/collection/v1_0/requesttopay",
    );
    for (const badPath of [
      "https://evil.example.com/x",
      "//evil.example.com/x",
      "/collection/../disbursement/v1_0/transfer",
      "/collection/%2e%2e/disbursement/v1_0/transfer",
      "/collection/%2E%2E/disbursement/v1_0/transfer",
      "/collection/%252e%252e/token/",
      "/collection/%5c/token/",
      "/collection/v1_0/balance#frag",
    ]) {
      expect(() => validateRequestPath(badPath), badPath).toThrow(JsMomoSDKError);
    }
    expect(() =>
      validateRequestPath("/collection/v1_0/balance?x=1", { allowQuery: false }),
    ).toThrow(JsMomoSDKError);

    expect(encodePathSegment("a b")).toBe("a%20b");
    expect(() => encodePathSegment("..")).toThrow(RangeError);
    expect(() => encodePathSegment("a/b")).toThrow(RangeError);
  });

  it("validates references, MSISDNs, amounts, currencies, emails, and headers", () => {
    const ref = generateReferenceId();
    expect(() => validateReferenceId(ref)).not.toThrow();
    expect(() => validateReferenceId("not-a-uuid")).toThrow(RangeError);
    // v1 UUID rejected
    expect(() => validateReferenceId("550e8400-e29b-11d4-a716-446655440000")).toThrow(
      "version 4",
    );

    expect(validateAirtelReferenceId("ORDER-123_abc.1")).toBe("ORDER-123_abc.1");
    expect(() => validateAirtelReferenceId("../bad")).toThrow(RangeError);

    expect(normaliseMsisdn("+256 771-234-567")).toBe("256771234567");
    expect(normaliseMsisdn("00256771234567")).toBe("256771234567");
    expect(() => normaliseMsisdn("123")).toThrow(RangeError);
    expect(() => normaliseMsisdn("abc")).toThrow(RangeError);

    expect(validateAmount("1000", { currency: "UGX" })).toBe("1000");
    expect(validateAmount("1000.00", { currency: "UGX" })).toBe("1000.00");
    expect(validateAmount("10.50", { currency: "EUR" })).toBe("10.50");
    expect(() => validateAmount("10.50", { currency: "UGX" })).toThrow("zero-decimal");
    expect(() => validateAmount("0")).toThrow("greater than zero");
    expect(() => validateAmount("000100")).toThrow("positive decimal");
    expect(() => validateAmount("10.123")).toThrow("2 decimal places");

    expect(validateCurrency("ugx")).toBe("UGX");
    expect(() => validateCurrency("UG")).toThrow(RangeError);
    expect(validateCountryCode("ug")).toBe("UG");
    expect(() => validateCountryCode("UGA")).toThrow(RangeError);
    expect(validateAccountHolderIdType("MSISDN")).toBe("msisdn");
    expect(() => validateAccountHolderIdType("ssn")).toThrow(RangeError);
    expect(validateEmailAddress(" buyer@example.com ")).toBe("buyer@example.com");
    expect(() => validateEmailAddress("not-an-email")).toThrow(RangeError);
    expect(validateEnvironmentName("mtnuganda")).toBe("mtnuganda");
    expect(() => validateEnvironmentName("bad env")).toThrow(RangeError);
    expect(validateHeaderValue("abc-123", { fieldName: "hdr" })).toBe("abc-123");
    expect(() =>
      validateHeaderValue("a b", { fieldName: "hdr", allowWhitespace: false }),
    ).toThrow("whitespace");
    expect(validateTimeout(5)).toBe(5);
    expect(() => validateTimeout(0)).toThrow(RangeError);
    expect(validateMaxRetries(3)).toBe(3);
    expect(() => validateMaxRetries(-1)).toThrow(RangeError);
    expect(validateRetryBackoff(0.5)).toBe(0.5);
    expect(() => validateRetryBackoff(Number.NaN)).toThrow(RangeError);

    expect(buildBasicAuthHeader("user", "pass")).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`,
    );
    expect(() => buildBasicAuthHeader("u:s", "p")).toThrow("':'");
  });

  it("detects carriers across 18 African markets and supports customPrefixes overrides", () => {
    expect(detectCarrierFromMsisdn("+256771234567")).toEqual({
      country: "UG",
      provider: "mtn_momo",
    });
    expect(detectCarrierFromMsisdn("256752123456")).toEqual({
      country: "UG",
      provider: "airtel_money",
    });
    expect(detectCarrierFromMsisdn("254712345678")).toEqual({
      country: "KE",
      provider: "mpesa",
    });
    expect(detectCarrierFromMsisdn("254752123456")).toEqual({
      country: "KE",
      provider: "airtel_money",
    });
    expect(detectCarrierFromMsisdn("221771234567")).toEqual({
      country: "SN",
      provider: "orange_money",
    });
    expect(detectCarrierFromMsisdn("233241234567")).toEqual({
      country: "GH",
      provider: "mtn_momo",
    });
    expect(detectCarrierFromMsisdn("2348031234567")).toEqual({
      country: "NG",
      provider: "mtn_momo",
    });
    expect(detectCarrierFromMsisdn("12345")).toBeNull();
    expect(
      detectCarrierFromMsisdn("+221771234567", {
        customPrefixes: { "22177": ["SN", "wave"] },
      }),
    ).toEqual({ country: "SN", provider: "wave" });
  });

  it("polls settlement with waitForSettlement and preserves referenceId on failure and timeout", async () => {
    let polls = 0;
    const settled = await waitForSettlement(
      async () => {
        polls += 1;
        return polls < 2 ? { status: "PENDING" } : { status: "SUCCESSFUL" };
      },
      { interval: 0.01, backoff: 1.5, maxInterval: 0.05, sleepFn: async () => {} },
    );
    expect(settled.status).toBe("SUCCESSFUL");
    expect(polls).toBe(2);

    await expect(
      waitForSettlement(
        async () => ({ status: "FAILED", reason: "APPROVAL_REJECTED" }),
        { raiseOnFailed: true, referenceId: "mtn-ref-999" },
      ),
    ).rejects.toMatchObject({
      name: TransactionFailedError.name,
      referenceId: "mtn-ref-999",
      reason: "APPROVAL_REJECTED",
    });

    await expect(
      waitForSettlement(async () => ({ status: "PENDING" }), {
        timeout: 0.05,
        interval: 0.1,
        sleepFn: async () => {},
        referenceId: "mtn-ref-timeout",
      }),
    ).rejects.toMatchObject({
      name: JsMomoSDKError.name,
      referenceId: "mtn-ref-timeout",
    });

    // Supports isPending() / isFailed() object methods and validates polling params
    await expect(
      waitForSettlement(
        async () => ({
          status: "FAILED",
          reason: "EXPIRED",
          isPending: () => false,
          isFailed: () => true,
        }),
        { raiseOnFailed: true, referenceId: "ref-method-1" },
      ),
    ).rejects.toMatchObject({ referenceId: "ref-method-1", reason: "EXPIRED" });

    await expect(
      waitForSettlement(async () => ({ status: "SUCCESSFUL" }), { backoff: 0.5 }),
    ).rejects.toThrow(RangeError);

    // Works natively with AirtelTransactionResponse (Issue #41)
    let airPolls = 0;
    const airSettled = await waitForSettlement(
      async () => {
        airPolls += 1;
        return new AirtelTransactionResponse(
          { code: "200", message: "OK", resultCode: "00", success: true },
          {
            airtelMoneyId: airPolls === 1 ? null : "AM-1",
            id: "airtel-tx-1",
            status: airPolls === 1 ? "TIP" : "TS",
            message: airPolls === 1 ? "Pending" : "Success",
            amount: "1000",
            currency: "UGX",
            reference: "ext-air-1",
          },
        );
      },
      { interval: 0.01, sleepFn: async () => {} },
    );
    expect(airSettled.isSuccessful()).toBe(true);
    expect(airSettled.referenceId).toBe("airtel-tx-1");

    const airFailed = new AirtelTransactionResponse(
      {
        code: "200",
        message: "Transaction Failed",
        resultCode: "DP00800001003",
        success: false,
      },
      {
        airtelMoneyId: null,
        id: "airtel-fail-99",
        status: "TF",
        message: "Insufficient balance",
        amount: "1000",
        currency: "UGX",
        reference: "ext-fail-99",
      },
    );
    await expect(
      waitForSettlement(async () => airFailed, { raiseOnFailed: true }),
    ).rejects.toMatchObject({
      name: TransactionFailedError.name,
      referenceId: "airtel-fail-99",
      reason: "Insufficient balance",
    });
  });

  it("validates printable UTF-8 text fields with control-character and length checks", () => {
    expect(validateCallbackHost("example.com:8443")).toBe("example.com:8443");
    expect(() => validateCallbackHost("example.com:70000")).toThrow(
      "between 1 and 65535",
    );
    expect(() => validateCallbackHost("example.com:abc")).toThrow(RangeError);
    expect(
      validatePrintableText("  Boutique Sénégal  ", { fieldName: "reference" }),
    ).toBe("Boutique Sénégal");
    expect(() => validatePrintableText("   ", { fieldName: "reference" })).toThrow(
      "must not be blank",
    );
    expect(() =>
      validatePrintableText("Shop\r\nInjected", { fieldName: "reference" }),
    ).toThrow("control characters");
    expect(() =>
      validatePrintableText("x".repeat(31), { fieldName: "reference", maxLength: 30 }),
    ).toThrow("must not exceed 30 characters");
  });
});
