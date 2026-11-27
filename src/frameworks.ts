import { WebhookVerificationError } from "./exceptions.js";
import { verifyConstantTimeToken } from "./providers/_signatures.js";
import type { TelemetryHook } from "./telemetry.js";
import { DEFAULT_MAX_FUTURE_SKEW_SECONDS, WebhookHandler } from "./webhooks.js";

export { verifyConstantTimeToken };

export const DEFAULT_MAX_WEBHOOK_BYTES = 1_048_576; // 1 MiB
const MAX_CONTENT_LENGTH_DIGITS = 20;

export type HeaderBag =
  Headers | Record<string, string | readonly string[] | undefined>;

function emitWebhookTelemetry(
  telemetry: TelemetryHook | null | undefined,
  provider: string,
  verified: boolean,
  reason: string | null = null,
): void {
  if (!telemetry) return;
  try {
    telemetry.onWebhook({ provider, verified, reason });
  } catch {
    // Telemetry errors must never break webhook verification
  }
}

function validateMaxBodyBytes(maxBodyBytes: number): number {
  if (
    typeof maxBodyBytes !== "number" ||
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes <= 0
  ) {
    throw new RangeError("maxBodyBytes must be a positive integer");
  }
  return maxBodyBytes;
}

function validateHttpErrorStatus(status?: number | null): number | null {
  if (status === undefined || status === null) return null;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 400 ||
    status > 599
  ) {
    throw new RangeError(
      "httpErrorStatus must be an HTTP error status code between 400 and 599",
    );
  }
  return status;
}

function extractSingleHeader(headers: HeaderBag, headerName: string): string | null {
  const target = headerName.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(headerName);
  }
  if (!headers || typeof headers !== "object") {
    throw new WebhookVerificationError("Invalid webhook headers mapping");
  }
  let matched: string | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 1) {
        throw new WebhookVerificationError(
          `Duplicate ${headerName} headers are not allowed`,
        );
      }
      if (value.length === 1) {
        if (typeof value[0] !== "string") {
          throw new WebhookVerificationError("Invalid webhook header value");
        }
        if (matched !== null) {
          throw new WebhookVerificationError(
            `Duplicate ${headerName} headers are not allowed`,
          );
        }
        matched = value[0];
      }
      continue;
    }
    if (typeof value !== "string") {
      throw new WebhookVerificationError("Invalid webhook header value");
    }
    if (matched !== null) {
      throw new WebhookVerificationError(
        `Duplicate ${headerName} headers are not allowed`,
      );
    }
    matched = value;
  }
  return matched;
}

function checkContentLengthHeader(raw: string | null, limit: number): void {
  if (raw === null) return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  if (trimmed.length > MAX_CONTENT_LENGTH_DIGITS || !/^\d+$/.test(trimmed)) {
    throw new WebhookVerificationError("Invalid Content-Length header on webhook");
  }
  if (Number(trimmed) > limit) {
    throw new WebhookVerificationError("Webhook payload exceeds maximum allowed size");
  }
}

export interface VerifyRawWebhookOptions {
  rawBody: Uint8Array | Buffer;
  headers: HeaderBag;
  signatureHeaderName: string;
  secret: string;
  timestamped?: boolean;
  toleranceSeconds?: number;
  maxFutureSkewSeconds?: number;
  timestampSeparator?: string;
  replayCheck?: (
    signatureHeader: string,
    payload: Uint8Array,
    timestamp: number,
  ) => boolean;
  algorithm?: "sha256" | "sha512" | string;
  encoding?: "hex" | "base64" | string;
  remoteIp?: string | null;
  allowedNetworks?: readonly string[] | null;
  maxBodyBytes?: number;
  telemetry?: TelemetryHook | null;
  provider?: string;
  now?: number;
}

/** Verify an inbound HMAC or timestamped HMAC webhook from any server framework. */
export function verifyRawWebhookRequest(options: VerifyRawWebhookOptions): void {
  const limit = validateMaxBodyBytes(options.maxBodyBytes ?? DEFAULT_MAX_WEBHOOK_BYTES);
  const provider = options.provider ?? "unknown";
  try {
    if (options.allowedNetworks !== undefined && options.allowedNetworks !== null) {
      if (!options.remoteIp) {
        throw new WebhookVerificationError("Webhook source IP address is required");
      }
      WebhookHandler.verifySourceIp(options.remoteIp, options.allowedNetworks);
    }
    if (!(options.rawBody instanceof Uint8Array)) {
      throw new WebhookVerificationError("Webhook payload must be bytes");
    }
    if (options.rawBody.byteLength > limit) {
      throw new WebhookVerificationError(
        "Webhook payload exceeds maximum allowed size",
      );
    }
    const sigValue =
      extractSingleHeader(options.headers, options.signatureHeaderName) ?? "";
    if (options.timestamped) {
      WebhookHandler.verifyTimestampedHmacSignature(
        options.rawBody,
        sigValue,
        options.secret,
        {
          toleranceSeconds: options.toleranceSeconds ?? 300,
          maxFutureSkewSeconds:
            options.maxFutureSkewSeconds ?? DEFAULT_MAX_FUTURE_SKEW_SECONDS,
          algorithm: options.algorithm ?? "sha256",
          timestampSeparator: options.timestampSeparator ?? ".",
          replayCheck: options.replayCheck,
          now: options.now,
        },
      );
    } else {
      WebhookHandler.verifyHmacSignature(options.rawBody, sigValue, options.secret, {
        algorithm: options.algorithm ?? "sha256",
        encoding: options.encoding ?? "hex",
      });
    }
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      emitWebhookTelemetry(options.telemetry, provider, false, err.message);
    }
    throw err;
  }
  emitWebhookTelemetry(options.telemetry, provider, true);
}

export interface VerifyStaticTokenWebhookOptions {
  headers: HeaderBag;
  tokenHeaderName: string;
  expectedToken: string;
  remoteIp?: string | null;
  allowedNetworks?: readonly string[] | null;
  telemetry?: TelemetryHook | null;
  provider?: string;
}

/** Verify a static-token webhook (e.g. Flutterwave `verif-hash`) with IP allowlisting & telemetry. */
export function verifyStaticTokenWebhookRequest(
  options: VerifyStaticTokenWebhookOptions,
): void {
  const provider = options.provider ?? "unknown";
  try {
    if (options.allowedNetworks !== undefined && options.allowedNetworks !== null) {
      if (!options.remoteIp) {
        throw new WebhookVerificationError("Webhook source IP address is required");
      }
      WebhookHandler.verifySourceIp(options.remoteIp, options.allowedNetworks);
    }
    const provided =
      extractSingleHeader(options.headers, options.tokenHeaderName) ?? "";
    verifyConstantTimeToken(provided, options.expectedToken);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      emitWebhookTelemetry(options.telemetry, provider, false, err.message);
    }
    throw err;
  }
  emitWebhookTelemetry(options.telemetry, provider, true);
}

export interface FrameworkWebhookVerifierOptions {
  secret: string;
  signatureHeaderName?: string;
  timestamped?: boolean;
  toleranceSeconds?: number;
  maxFutureSkewSeconds?: number;
  timestampSeparator?: string;
  replayCheck?: (
    signatureHeader: string,
    payload: Uint8Array,
    timestamp: number,
  ) => boolean;
  algorithm?: "sha256" | "sha512" | string;
  encoding?: "hex" | "base64" | string;
  allowedNetworks?: readonly string[] | null;
  maxBodyBytes?: number;
  httpErrorStatus?: number | null;
  telemetry?: TelemetryHook | null;
  provider?: string;
  now?: number;
}

async function readBoundedWebBody(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  checkContentLengthHeader(request.headers.get("content-length"), limit);
  if (!request.body) {
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.byteLength > limit) {
      throw new WebhookVerificationError(
        "Webhook payload exceeds maximum allowed size",
      );
    }
    return buf;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => undefined);
          throw new WebhookVerificationError(
            "Webhook payload exceeds maximum allowed size",
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

/** Verify a Fetch API / Next.js App Router / Edge `Request` with streaming body cap. */
export async function verifyWebWebhookRequest(
  request: Request,
  options: FrameworkWebhookVerifierOptions & { remoteIp?: string | null },
): Promise<Uint8Array> {
  const limit = validateMaxBodyBytes(options.maxBodyBytes ?? DEFAULT_MAX_WEBHOOK_BYTES);
  const provider = options.provider ?? "unknown";
  try {
    if (options.allowedNetworks !== undefined && options.allowedNetworks !== null) {
      if (!options.remoteIp) {
        throw new WebhookVerificationError("Webhook source IP address is required");
      }
      WebhookHandler.verifySourceIp(options.remoteIp, options.allowedNetworks);
    }
    const rawBody = await readBoundedWebBody(request, limit);
    verifyRawWebhookRequest({
      rawBody,
      headers: request.headers,
      signatureHeaderName: options.signatureHeaderName ?? "X-Signature",
      secret: options.secret,
      timestamped: options.timestamped,
      toleranceSeconds: options.toleranceSeconds,
      maxFutureSkewSeconds: options.maxFutureSkewSeconds,
      timestampSeparator: options.timestampSeparator,
      replayCheck: options.replayCheck,
      algorithm: options.algorithm,
      encoding: options.encoding,
      maxBodyBytes: limit,
      now: options.now,
    });
    emitWebhookTelemetry(options.telemetry, provider, true);
    return rawBody;
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      emitWebhookTelemetry(options.telemetry, provider, false, err.message);
    }
    throw err;
  }
}

export interface ExpressLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Uint8Array | Buffer;
  body?: unknown;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface ExpressLikeResponse {
  status(code: number): { json(payload: unknown): unknown };
}

export type ExpressNextFunction = (err?: unknown) => void;

/** Build an Express / Connect middleware that verifies raw webhook bytes before routing. */
export function createExpressWebhookMiddleware(
  options: FrameworkWebhookVerifierOptions,
): (
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  next: ExpressNextFunction,
) => void {
  const limit = validateMaxBodyBytes(options.maxBodyBytes ?? DEFAULT_MAX_WEBHOOK_BYTES);
  const errorStatus = validateHttpErrorStatus(options.httpErrorStatus);
  const sigHeader = options.signatureHeaderName ?? "X-Signature";
  const provider = options.provider ?? "unknown";

  return (req, res, next) => {
    let reachedVerify = false;
    try {
      const cl = extractSingleHeader(req.headers, "content-length");
      checkContentLengthHeader(cl, limit);
      const rawBody =
        req.rawBody instanceof Uint8Array
          ? req.rawBody
          : req.body instanceof Uint8Array
            ? req.body
            : null;
      if (!rawBody) {
        throw new WebhookVerificationError(
          "Raw webhook body Buffer is required (configure express.raw() or attach req.rawBody)",
        );
      }
      reachedVerify = true;
      verifyRawWebhookRequest({
        rawBody,
        headers: req.headers,
        signatureHeaderName: sigHeader,
        secret: options.secret,
        timestamped: options.timestamped,
        toleranceSeconds: options.toleranceSeconds,
        maxFutureSkewSeconds: options.maxFutureSkewSeconds,
        timestampSeparator: options.timestampSeparator,
        replayCheck: options.replayCheck,
        algorithm: options.algorithm,
        encoding: options.encoding,
        remoteIp: req.ip ?? req.socket?.remoteAddress ?? null,
        allowedNetworks: options.allowedNetworks,
        maxBodyBytes: limit,
        telemetry: options.telemetry,
        provider: options.provider,
        now: options.now,
      });
      next();
    } catch (err) {
      if (!reachedVerify && err instanceof WebhookVerificationError) {
        emitWebhookTelemetry(options.telemetry, provider, false, err.message);
      }
      if (err instanceof WebhookVerificationError && errorStatus !== null) {
        res.status(errorStatus).json({ error: "Webhook verification failed" });
        return;
      }
      next(err);
    }
  };
}

export interface FastifyLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Uint8Array | Buffer | string;
  body?: unknown;
  ip?: string;
}

export interface FastifyLikeReply {
  code(statusCode: number): { send(payload: unknown): unknown };
}

/** Build a Fastify preHandler hook that verifies raw webhook payloads. */
export function createFastifyWebhookPreHandler(
  options: FrameworkWebhookVerifierOptions,
): (request: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<unknown> {
  const limit = validateMaxBodyBytes(options.maxBodyBytes ?? DEFAULT_MAX_WEBHOOK_BYTES);
  const errorStatus = validateHttpErrorStatus(options.httpErrorStatus);
  const sigHeader = options.signatureHeaderName ?? "X-Signature";
  const provider = options.provider ?? "unknown";

  return async (request, reply) => {
    let reachedVerify = false;
    try {
      const cl = extractSingleHeader(request.headers, "content-length");
      checkContentLengthHeader(cl, limit);
      let rawBody: Uint8Array | null = null;
      if (request.rawBody instanceof Uint8Array) {
        rawBody = request.rawBody;
      } else if (typeof request.rawBody === "string") {
        rawBody = Buffer.from(request.rawBody, "utf8");
      } else if (request.body instanceof Uint8Array) {
        rawBody = request.body;
      }
      if (!rawBody) {
        throw new WebhookVerificationError(
          "Raw webhook body is required on Fastify request (enable rawBody)",
        );
      }
      reachedVerify = true;
      verifyRawWebhookRequest({
        rawBody,
        headers: request.headers,
        signatureHeaderName: sigHeader,
        secret: options.secret,
        timestamped: options.timestamped,
        toleranceSeconds: options.toleranceSeconds,
        maxFutureSkewSeconds: options.maxFutureSkewSeconds,
        timestampSeparator: options.timestampSeparator,
        replayCheck: options.replayCheck,
        algorithm: options.algorithm,
        encoding: options.encoding,
        remoteIp: request.ip ?? null,
        allowedNetworks: options.allowedNetworks,
        maxBodyBytes: limit,
        telemetry: options.telemetry,
        provider: options.provider,
        now: options.now,
      });
    } catch (err) {
      if (!reachedVerify && err instanceof WebhookVerificationError) {
        emitWebhookTelemetry(options.telemetry, provider, false, err.message);
      }
      if (err instanceof WebhookVerificationError && errorStatus !== null) {
        return reply.code(errorStatus).send({ error: "Webhook verification failed" });
      }
      throw err;
    }
  };
}
