import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { WebhookVerificationError } from "../../src/exceptions.js";
import { TransactionStatus } from "../../src/models.js";
import { WebhookHandler } from "../../src/webhooks.js";

describe("WebhookHandler", () => {
  it("verifies HMAC-SHA256/SHA512 and timestamped HMAC signatures with replay protection", () => {
    const payload = Buffer.from('{"status":"SUCCESSFUL"}', "utf8");
    const secret = "whsec_test_secret";
    const sig256 = createHmac("sha256", secret).update(payload).digest("hex");
    const sig512 = createHmac("sha512", secret).update(payload).digest("hex");

    WebhookHandler.verifyHmacSignature(payload, sig256, secret);
    WebhookHandler.verifyHmacSignature(payload, `sha256=${sig256}`, secret);
    WebhookHandler.verifyHmacSignature(payload, sig512, secret, {
      algorithm: "sha512",
    });
    // Base64 HMAC support (e.g. Airtel Money x-signature, Issue #42)
    const sig256B64 = createHmac("sha256", secret).update(payload).digest("base64");
    WebhookHandler.verifyHmacSignature(payload, sig256B64, secret, {
      encoding: "base64",
    });
    expect(() =>
      WebhookHandler.verifyHmacSignature(payload, sig256B64.toLowerCase(), secret, {
        encoding: "base64",
      }),
    ).toThrow(WebhookVerificationError);
    expect(() =>
      WebhookHandler.verifyHmacSignature(payload, sig256, secret, {
        encoding: "base32",
      }),
    ).toThrow("Unsupported webhook signature encoding");
    expect(() =>
      WebhookHandler.verifyHmacSignature(payload, "deadbeef", secret),
    ).toThrow(WebhookVerificationError);

    const now = 1700000000;
    const tsSig = createHmac("sha256", secret)
      .update(`${now}.`)
      .update(payload)
      .digest("hex");
    const seen = new Set<string>();
    const replayCheck = (hdr: string) => {
      if (seen.has(hdr)) return false;
      seen.add(hdr);
      return true;
    };
    WebhookHandler.verifyTimestampedHmacSignature(
      payload,
      `t=${now},v1=${tsSig}`,
      secret,
      { now, replayCheck },
    );
    expect(() =>
      WebhookHandler.verifyTimestampedHmacSignature(
        payload,
        `t=${now},v1=${tsSig}`,
        secret,
        { now, replayCheck },
      ),
    ).toThrow("replay");

    // Mutated header variants must not bypass replayCheck (Issue #9)
    expect(() =>
      WebhookHandler.verifyTimestampedHmacSignature(
        payload,
        `t=${now},v1=${tsSig.toUpperCase()}`,
        secret,
        { now, replayCheck },
      ),
    ).toThrow("replay");
    expect(() =>
      WebhookHandler.verifyTimestampedHmacSignature(
        payload,
        `v1=${tsSig},t=${now}`,
        secret,
        { now, replayCheck },
      ),
    ).toThrow("replay");
    expect(() =>
      WebhookHandler.verifyTimestampedHmacSignature(
        payload,
        `t=${now},v1=deadbeef,v1=${tsSig}`,
        secret,
        { now, replayCheck },
      ),
    ).toThrow("replay");
    expect(() =>
      WebhookHandler.verifyTimestampedHmacSignature(
        payload,
        `t=${now},v1=${tsSig},x=1`,
        secret,
        { now, replayCheck },
      ),
    ).toThrow("Malformed");
    expect(() =>
      WebhookHandler.verifyTimestampedHmacSignature(
        payload,
        `t=${now}, v1=${tsSig}`,
        secret,
        { now, replayCheck },
      ),
    ).toThrow("Malformed");

    // Legitimate multi-v1 key rotation still succeeds on first delivery and blocks replay
    const freshSeen = new Set<string>();
    const freshReplay = (hdr: string) => {
      if (freshSeen.has(hdr)) return false;
      freshSeen.add(hdr);
      return true;
    };
    WebhookHandler.verifyTimestampedHmacSignature(
      payload,
      `t=${now},v1=0000000000000000,v1=${tsSig}`,
      secret,
      { now, replayCheck: freshReplay },
    );
    expect(() =>
      WebhookHandler.verifyTimestampedHmacSignature(
        payload,
        `t=${now},v1=${tsSig}`,
        secret,
        { now, replayCheck: freshReplay },
      ),
    ).toThrow("replay");
  });

  it("enforces IP/CIDR allowlisting with IPv4, IPv6, IPv4-mapped IPv6, and strict host-bit checks", () => {
    WebhookHandler.verifySourceIp("196.43.133.5", ["196.43.133.0/24"]);
    WebhookHandler.verifySourceIp("::ffff:196.43.133.5", ["196.43.133.0/24"]);
    WebhookHandler.verifySourceIp("196.43.133.5", ["::ffff:196.43.133.0/120"]);
    WebhookHandler.verifySourceIp("2001:db8::42", ["2001:db8::/32"]);
    WebhookHandler.verifySourceIp("203.0.113.10", ["203.0.113.10"]);

    expect(() => WebhookHandler.verifySourceIp("1.2.3.4", [])).toThrow("empty");
    expect(() => WebhookHandler.verifySourceIp("fe80::1%eth0", ["fe80::/10"])).toThrow(
      "Invalid webhook source IP",
    );
    expect(() =>
      WebhookHandler.verifySourceIp("not-an-ip", ["196.43.133.0/24"]),
    ).toThrow("Invalid webhook source IP");
    expect(() =>
      WebhookHandler.verifySourceIp("196.43.133.5", ["196.43.133.5/24"]),
    ).toThrow("Invalid CIDR");
    expect(() =>
      WebhookHandler.verifySourceIp("196.43.133.5", ["196.43.133.0/99"]),
    ).toThrow("Invalid CIDR");
    expect(() =>
      WebhookHandler.verifySourceIp("198.51.100.1", ["196.43.133.0/24"]),
    ).toThrow("not in allowed networks");
  });

  it("parses and validates webhook transaction notification payloads", () => {
    const parsed = WebhookHandler.parseTransactionNotification(
      {
        status: "SUCCESSFUL",
        amount: "5000",
        currency: "UGX",
        financialTransactionId: "ft-123",
      },
      { requireIdentifier: true },
    );
    expect(parsed.status).toBe(TransactionStatus.SUCCESSFUL);
    expect(
      WebhookHandler.isSuccessful({
        status: "SUCCESSFUL",
        externalId: "ord-1",
      }),
    ).toBe(true);
    expect(() =>
      WebhookHandler.parseTransactionNotification(
        { status: "SUCCESSFUL" },
        { requireIdentifier: true },
      ),
    ).toThrow("missing a transaction identifier");
    expect(() => WebhookHandler.parseTransactionNotification("bad")).toThrow(
      "JSON object",
    );
    expect(() =>
      WebhookHandler.parseTransactionNotification({ status: "BOGUS" }),
    ).toThrow("Invalid webhook");
  });
});
