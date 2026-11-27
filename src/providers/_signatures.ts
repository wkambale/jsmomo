import { createHmac, timingSafeEqual } from "node:crypto";

import { WebhookVerificationError } from "../exceptions.js";

const SUPPORTED_HMAC_ALGORITHMS = new Set(["sha256", "sha512"]);
const SUPPORTED_HMAC_ENCODINGS = new Set(["hex", "base64"]);
const MAX_SIGNATURE_PARTS = 32;
const MAX_V1_SIGNATURES = 16;
const MAX_SIGNATURE_HEADER_LENGTH = 4096;
const MAX_TIMESTAMP_DIGITS = 15;
export const DEFAULT_MAX_FUTURE_SKEW_SECONDS = 60;

function toBytes(payload: Uint8Array | Buffer | string): Buffer {
  if (typeof payload === "string") {
    return Buffer.from(payload, "utf8");
  }
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  throw new WebhookVerificationError("Webhook payload must be bytes or string");
}

function safeEqualUtf8(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Verify a static webhook secret header (e.g. Flutterwave verif-hash) in constant time. */
export function verifyConstantTimeToken(provided: string, expected: string): void {
  if (typeof expected !== "string" || !expected) {
    throw new WebhookVerificationError("Webhook verification token must not be empty");
  }
  if (typeof provided !== "string" || !provided) {
    throw new WebhookVerificationError("Webhook token header must not be empty");
  }
  if (!safeEqualUtf8(provided, expected)) {
    throw new WebhookVerificationError("Webhook token verification failed");
  }
}

/** Verify an HMAC-SHA256 or HMAC-SHA512 signature over raw webhook payload bytes. */
export function verifyHmacSignature(
  payload: Uint8Array | Buffer | string,
  signature: string,
  secret: string,
  options: {
    algorithm?: "sha256" | "sha512" | string;
    encoding?: "hex" | "base64" | string;
  } = {},
): void {
  const algorithm = options.algorithm ?? "sha256";
  if (typeof algorithm !== "string") {
    throw new WebhookVerificationError(
      `Unsupported webhook signature algorithm: ${String(algorithm)}`,
    );
  }
  const algo = algorithm.toLowerCase();
  if (!SUPPORTED_HMAC_ALGORITHMS.has(algo)) {
    throw new WebhookVerificationError(
      `Unsupported webhook signature algorithm: ${algorithm}`,
    );
  }
  const encoding = options.encoding ?? "hex";
  if (
    typeof encoding !== "string" ||
    !SUPPORTED_HMAC_ENCODINGS.has(encoding.toLowerCase())
  ) {
    throw new WebhookVerificationError(
      `Unsupported webhook signature encoding: ${String(encoding)}`,
    );
  }
  const enc = encoding.toLowerCase() as "hex" | "base64";
  const rawBytes = toBytes(payload);
  if (typeof secret !== "string" || !secret) {
    throw new WebhookVerificationError("Webhook verification secret must not be empty");
  }
  if (typeof signature !== "string" || !signature.trim()) {
    throw new WebhookVerificationError("Webhook signature must not be empty");
  }
  let provided = signature.trim();
  const prefix = `${algo}=`;
  if (provided.toLowerCase().startsWith(prefix)) {
    provided = provided.slice(prefix.length);
  }
  const expected = createHmac(algo, Buffer.from(secret, "utf8"))
    .update(rawBytes)
    .digest(enc);
  const candidate = enc === "hex" ? provided.toLowerCase() : provided;

  if (!safeEqualUtf8(expected, candidate)) {
    throw new WebhookVerificationError("Webhook signature verification failed");
  }
}

export interface TimestampedHmacOptions {
  toleranceSeconds?: number;
  maxFutureSkewSeconds?: number;
  algorithm?: "sha256" | "sha512" | string;
  timestampSeparator?: string;
  replayCheck?: (
    signatureHeader: string,
    payload: Uint8Array,
    timestamp: number,
  ) => boolean;
  now?: number;
}

/** Verify a timestamped HMAC header (`t=<unix_ts>,v1=<hex>`) with replay protection. */
export function verifyTimestampedHmacSignature(
  payload: Uint8Array | Buffer | string,
  signatureHeader: string,
  secret: string,
  options: TimestampedHmacOptions = {},
): void {
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const maxFutureSkewSeconds =
    options.maxFutureSkewSeconds ?? DEFAULT_MAX_FUTURE_SKEW_SECONDS;
  const algorithm = options.algorithm ?? "sha256";
  const timestampSeparator = options.timestampSeparator ?? ".";

  if (
    typeof timestampSeparator !== "string" ||
    // eslint-disable-next-line no-control-regex
    !/^[\x00-\x7f]*$/.test(timestampSeparator)
  ) {
    throw new WebhookVerificationError(
      "Webhook timestamp separator must be an ASCII string",
    );
  }
  if (typeof algorithm !== "string") {
    throw new WebhookVerificationError(
      `Unsupported webhook signature algorithm: ${String(algorithm)}`,
    );
  }
  const algo = algorithm.toLowerCase();
  if (!SUPPORTED_HMAC_ALGORITHMS.has(algo)) {
    throw new WebhookVerificationError(
      `Unsupported webhook signature algorithm: ${algorithm}`,
    );
  }
  const rawBytes = toBytes(payload);
  if (typeof secret !== "string" || !secret) {
    throw new WebhookVerificationError("Webhook verification secret must not be empty");
  }
  if (typeof signatureHeader !== "string" || !signatureHeader.trim()) {
    throw new WebhookVerificationError("Webhook signature header must not be empty");
  }
  if (signatureHeader.length > MAX_SIGNATURE_HEADER_LENGTH) {
    throw new WebhookVerificationError(
      "Webhook signature header exceeds maximum allowed length",
    );
  }
  if (
    typeof toleranceSeconds !== "number" ||
    !Number.isFinite(toleranceSeconds) ||
    toleranceSeconds <= 0
  ) {
    throw new WebhookVerificationError("Webhook timestamp tolerance must be positive");
  }
  if (
    typeof maxFutureSkewSeconds !== "number" ||
    !Number.isFinite(maxFutureSkewSeconds) ||
    maxFutureSkewSeconds < 0
  ) {
    throw new WebhookVerificationError(
      "Webhook future skew tolerance must be non-negative",
    );
  }
  if (
    options.now !== undefined &&
    (typeof options.now !== "number" || !Number.isFinite(options.now))
  ) {
    throw new WebhookVerificationError("Invalid reference time for webhook check");
  }

  const trimmedHeader = signatureHeader.trim();
  if (/\s/.test(trimmedHeader)) {
    throw new WebhookVerificationError("Malformed timestamped webhook signature");
  }

  const parts = trimmedHeader.split(",");
  if (parts.length > MAX_SIGNATURE_PARTS) {
    throw new WebhookVerificationError("Malformed timestamped webhook signature");
  }

  let timestampStr: string | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    if (!part) {
      throw new WebhookVerificationError("Malformed timestamped webhook signature");
    }
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) {
      throw new WebhookVerificationError("Malformed timestamped webhook signature");
    }
    const key = part.slice(0, eqIdx);
    const val = part.slice(eqIdx + 1);
    if (!key) {
      throw new WebhookVerificationError("Malformed timestamped webhook signature");
    }
    if (key === "t") {
      if (timestampStr !== null) {
        throw new WebhookVerificationError("Duplicate timestamp in webhook signature");
      }
      timestampStr = val;
    } else if (key === "v1") {
      if (signatures.length >= MAX_V1_SIGNATURES) {
        throw new WebhookVerificationError(
          "Too many signature values in webhook header",
        );
      }
      if (!val) {
        throw new WebhookVerificationError("Malformed timestamped webhook signature");
      }
      signatures.push(val.toLowerCase());
    } else {
      throw new WebhookVerificationError("Malformed timestamped webhook signature");
    }
  }

  if (timestampStr === null || signatures.length === 0) {
    throw new WebhookVerificationError("Malformed timestamped webhook signature");
  }
  if (
    !timestampStr ||
    timestampStr.length > MAX_TIMESTAMP_DIGITS ||
    !/^\d+$/.test(timestampStr) ||
    (timestampStr.length > 1 && timestampStr.startsWith("0"))
  ) {
    throw new WebhookVerificationError("Invalid timestamp in webhook signature");
  }

  const ts = Number(timestampStr);
  const currentTime = options.now ?? Date.now() / 1000;
  const futureLimit = Math.min(toleranceSeconds, maxFutureSkewSeconds);
  if (currentTime - ts > toleranceSeconds) {
    throw new WebhookVerificationError("Webhook signature timestamp expired");
  }
  if (ts - currentTime > futureLimit) {
    throw new WebhookVerificationError("Webhook signature timestamp is in the future");
  }

  const prefixBytes = Buffer.from(`${timestampStr}${timestampSeparator}`, "ascii");
  const expectedHex = createHmac(algo, Buffer.from(secret, "utf8"))
    .update(prefixBytes)
    .update(rawBytes)
    .digest("hex");

  let matched = false;
  for (const sig of signatures) {
    if (safeEqualUtf8(expectedHex, sig)) {
      matched = true;
    }
  }
  if (!matched) {
    throw new WebhookVerificationError("Webhook signature verification failed");
  }
  const canonicalSignature = `t=${timestampStr},v1=${expectedHex}`;
  if (options.replayCheck && !options.replayCheck(canonicalSignature, rawBytes, ts)) {
    throw new WebhookVerificationError("Webhook signature replay detected");
  }
}
