import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { WebhookVerificationError } from "../../src/exceptions.js";
import {
  createExpressWebhookMiddleware,
  createFastifyWebhookPreHandler,
  verifyRawWebhookRequest,
  verifyStaticTokenWebhookRequest,
  verifyWebWebhookRequest,
} from "../../src/frameworks.js";
import type { WebhookTelemetryEvent } from "../../src/telemetry.js";

describe("Framework webhook adapters", () => {
  const secret = "whsec_framework";
  const bodyBuf = Buffer.from('{"event":"charge.success"}', "utf8");
  const sig = createHmac("sha256", secret).update(bodyBuf).digest("hex");

  it("verifies raw & static-token webhooks with telemetry, IP allowlist, duplicate-header & size caps", () => {
    const events: WebhookTelemetryEvent[] = [];
    const telemetry = {
      onRequest: () => {},
      onWebhook: (e: WebhookTelemetryEvent) => events.push(e),
    };

    verifyRawWebhookRequest({
      rawBody: bodyBuf,
      headers: { "X-Signature": sig },
      signatureHeaderName: "X-Signature",
      secret,
      remoteIp: "196.43.133.10",
      allowedNetworks: ["196.43.133.0/24"],
      telemetry,
      provider: "mtn_momo",
    });
    expect(events[0]?.verified).toBe(true);

    // Duplicate header rejected
    expect(() =>
      verifyRawWebhookRequest({
        rawBody: bodyBuf,
        headers: { "x-signature": [sig, sig] },
        signatureHeaderName: "X-Signature",
        secret,
        telemetry,
      }),
    ).toThrow("Duplicate");

    // Oversize rejected
    expect(() =>
      verifyRawWebhookRequest({
        rawBody: bodyBuf,
        headers: { "x-signature": sig },
        signatureHeaderName: "X-Signature",
        secret,
        maxBodyBytes: 4,
      }),
    ).toThrow("exceeds maximum");

    // Static token (Flutterwave verif-hash)
    verifyStaticTokenWebhookRequest({
      headers: { "verif-hash": "flw-secret-hash" },
      tokenHeaderName: "verif-hash",
      expectedToken: "flw-secret-hash",
      remoteIp: "10.0.0.1",
      allowedNetworks: ["10.0.0.0/8"],
      telemetry,
      provider: "flutterwave",
    });
    expect(() =>
      verifyStaticTokenWebhookRequest({
        headers: { "verif-hash": "wrong" },
        tokenHeaderName: "verif-hash",
        expectedToken: "flw-secret-hash",
        telemetry,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it("verifies Web Fetch Request (Next.js / Edge / Hono) with streaming size cap", async () => {
    const req = new Request("https://app.example.com/webhooks", {
      method: "POST",
      headers: { "x-signature": sig },
      body: bodyBuf,
    });
    const verifiedBytes = await verifyWebWebhookRequest(req, {
      secret,
      remoteIp: "203.0.113.5",
      allowedNetworks: ["203.0.113.0/24"],
    });
    expect(Buffer.from(verifiedBytes).toString("utf8")).toBe(bodyBuf.toString("utf8"));

    const tooBigReq = new Request("https://app.example.com/webhooks", {
      method: "POST",
      headers: { "x-signature": sig },
      body: "x".repeat(500),
    });
    await expect(
      verifyWebWebhookRequest(tooBigReq, { secret, maxBodyBytes: 64 }),
    ).rejects.toThrow("exceeds maximum");

    // Duplicate Fetch X-Signature headers coalesced with ", " must be rejected (Issue #9)
    const now = 1700000000;
    const tsSig = createHmac("sha256", secret)
      .update(`${now}.`)
      .update(bodyBuf)
      .digest("hex");
    const splitHeaders = new Headers();
    splitHeaders.append("X-Signature", `t=${now}`);
    splitHeaders.append("X-Signature", `v1=${tsSig}`);
    const splitReq = new Request("https://app.example.com/webhooks", {
      method: "POST",
      headers: splitHeaders,
      body: bodyBuf,
    });
    await expect(
      verifyWebWebhookRequest(splitReq, { secret, timestamped: true, now }),
    ).rejects.toThrow(WebhookVerificationError);

    const shadowedHeaders = new Headers();
    shadowedHeaders.append("X-Signature", `t=${now},v1=deadbeef`);
    shadowedHeaders.append("X-Signature", `v1=${tsSig}`);
    const shadowedReq = new Request("https://app.example.com/webhooks", {
      method: "POST",
      headers: shadowedHeaders,
      body: bodyBuf,
    });
    await expect(
      verifyWebWebhookRequest(shadowedReq, { secret, timestamped: true, now }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("supports Express middleware and Fastify preHandler hooks", async () => {
    const mw = createExpressWebhookMiddleware({
      secret,
      httpErrorStatus: 401,
    });

    let nextCalledWith: unknown = "unset";
    let statusSent = 0;
    const res = {
      status: (code: number) => {
        statusSent = code;
        return { json: () => {} };
      },
    };
    mw({ headers: { "x-signature": sig }, rawBody: bodyBuf }, res, (err) => {
      nextCalledWith = err;
    });
    expect(nextCalledWith).toBeUndefined();

    // Invalid signature returns configured HTTP 401
    mw({ headers: { "x-signature": "bad" }, rawBody: bodyBuf }, res, () => {});
    expect(statusSent).toBe(401);

    // Missing rawBody without httpErrorStatus forwards error to next(err)
    const mwThrow = createExpressWebhookMiddleware({ secret });
    mwThrow({ headers: { "x-signature": sig } }, res, (err) => {
      nextCalledWith = err;
    });
    expect(nextCalledWith).toBeInstanceOf(WebhookVerificationError);

    // Fastify preHandler
    const fastifyHook = createFastifyWebhookPreHandler({
      secret,
      httpErrorStatus: 403,
    });
    let replyCode = 0;
    const reply = {
      code: (c: number) => {
        replyCode = c;
        return { send: () => {} };
      },
    };
    await fastifyHook(
      { headers: { "x-signature": sig }, rawBody: bodyBuf.toString("utf8") },
      reply,
    );
    expect(replyCode).toBe(0);
    await fastifyHook({ headers: { "x-signature": "bad" }, rawBody: bodyBuf }, reply);
    expect(replyCode).toBe(403);

    expect(() => createExpressWebhookMiddleware({ secret, maxBodyBytes: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      createExpressWebhookMiddleware({ secret, httpErrorStatus: 200 }),
    ).toThrow(RangeError);
    expect(() =>
      verifyRawWebhookRequest({
        rawBody: bodyBuf,
        headers: { "x-signature": sig },
        signatureHeaderName: "X-Signature",
        secret,
        allowedNetworks: ["10.0.0.0/8"],
      }),
    ).toThrow("source IP address is required");
    expect(() =>
      verifyStaticTokenWebhookRequest({
        headers: { "verif-hash": "x" },
        tokenHeaderName: "verif-hash",
        expectedToken: "x",
        allowedNetworks: ["10.0.0.0/8"],
      }),
    ).toThrow("source IP address is required");

    const now = 1700000000;
    const tsSig = createHmac("sha256", secret)
      .update(`${now}.`)
      .update(bodyBuf)
      .digest("hex");
    verifyRawWebhookRequest({
      rawBody: bodyBuf,
      headers: { "x-signature": `t=${now},v1=${tsSig}` },
      signatureHeaderName: "X-Signature",
      secret,
      timestamped: true,
      now,
    });

    const fastifyThrow = createFastifyWebhookPreHandler({ secret });
    await expect(
      fastifyThrow({ headers: { "x-signature": sig } }, reply),
    ).rejects.toThrow(WebhookVerificationError);
    await expect(
      fastifyThrow(
        {
          headers: { "x-signature": sig, "content-length": "abc" },
          body: bodyBuf,
        },
        reply,
      ),
    ).rejects.toThrow("Content-Length");
    await fastifyThrow({ headers: { "x-signature": sig }, body: bodyBuf }, reply);

    const webMissingIp = new Request("https://app.example.com/webhooks", {
      method: "POST",
      headers: { "x-signature": sig },
      body: bodyBuf,
    });
    await expect(
      verifyWebWebhookRequest(webMissingIp, {
        secret,
        allowedNetworks: ["10.0.0.0/8"],
      }),
    ).rejects.toThrow("source IP address is required");

    // Issue #42: Base64 encoding, pre-check telemetry in Express/Fastify, and Fastify returning reply
    const b64Sig = createHmac("sha256", secret).update(bodyBuf).digest("base64");
    verifyRawWebhookRequest({
      rawBody: bodyBuf,
      headers: { "x-signature": b64Sig },
      signatureHeaderName: "x-signature",
      secret,
      encoding: "base64",
    });

    const preCheckEvents: WebhookTelemetryEvent[] = [];
    const preCheckTelemetry = {
      onRequest: () => {},
      onWebhook: (e: WebhookTelemetryEvent) => preCheckEvents.push(e),
    };
    const expressPre = createExpressWebhookMiddleware({
      secret,
      httpErrorStatus: 400,
      telemetry: preCheckTelemetry,
      provider: "airtel_money",
      encoding: "base64",
    });
    expressPre({ headers: { "x-signature": b64Sig } }, res, () => {});
    expect(preCheckEvents).toHaveLength(1);
    expect(preCheckEvents[0]?.verified).toBe(false);
    expect(preCheckEvents[0]?.provider).toBe("airtel_money");

    // Invalid signature emits failure telemetry exactly once (no double emission)
    expressPre(
      { headers: { "x-signature": "wrong" }, rawBody: bodyBuf },
      res,
      () => {},
    );
    expect(preCheckEvents).toHaveLength(2);

    const fastifyPre = createFastifyWebhookPreHandler({
      secret,
      httpErrorStatus: 401,
      telemetry: preCheckTelemetry,
      provider: "airtel_money",
      encoding: "base64",
    });
    const sentinelReply = { sent: true };
    const fastifyRet = await fastifyPre(
      { headers: { "content-length": "not-a-number" }, rawBody: bodyBuf },
      { code: () => ({ send: () => sentinelReply }) },
    );
    expect(fastifyRet).toBe(sentinelReply);
    expect(preCheckEvents).toHaveLength(3);
    expect(preCheckEvents[2]?.verified).toBe(false);
  });
});
