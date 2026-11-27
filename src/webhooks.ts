import { isIP } from "node:net";

import { WebhookVerificationError } from "./exceptions.js";
import { TransactionResult } from "./models.js";
import type { TimestampedHmacOptions } from "./providers/_signatures.js";
import {
  DEFAULT_MAX_FUTURE_SKEW_SECONDS,
  verifyHmacSignature,
  verifyTimestampedHmacSignature,
} from "./providers/_signatures.js";

export { DEFAULT_MAX_FUTURE_SKEW_SECONDS, type TimestampedHmacOptions };

function ipv4ToBigInt(ip: string): bigint | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith("0"))) {
      return null;
    }
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    result = (result << 8n) | BigInt(n);
  }
  return result;
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (isIP(ip) !== 6) return null;
  if (ip.includes("%")) return null;
  const lower = ip.toLowerCase();
  const doubleColonParts = lower.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (!segment) return [];
    const tokens = segment.split(":");
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i]!;
      if (tok.includes(".")) {
        if (i !== tokens.length - 1) return null;
        const v4 = ipv4ToBigInt(tok);
        if (v4 === null) return null;
        out.push(Number((v4 >> 16n) & 0xffffn), Number(v4 & 0xffffn));
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        out.push(Number.parseInt(tok, 16));
      }
    }
    return out;
  };

  let groups: number[];
  if (doubleColonParts.length === 2) {
    const left = parseGroups(doubleColonParts[0]!);
    const right = parseGroups(doubleColonParts[1]!);
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    const all = parseGroups(lower);
    if (!all || all.length !== 8) return null;
    groups = all;
  }

  let result = 0n;
  for (const g of groups) {
    result = (result << 16n) | BigInt(g);
  }
  return result;
}

interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

const IPV4_MAPPED_PREFIX = 0xffff00000000n;
const IPV4_MAPPED_MASK = 0xffffffffffffffffffffffff00000000n;

function parseIpNormalized(rawIp: string): ParsedIp {
  if (typeof rawIp !== "string" || !rawIp.trim() || rawIp.includes("%")) {
    throw new WebhookVerificationError("Invalid webhook source IP address");
  }
  const cleaned = rawIp.trim();
  const v4 = ipv4ToBigInt(cleaned);
  if (v4 !== null) {
    return { version: 4, value: v4 };
  }
  const v6 = ipv6ToBigInt(cleaned);
  if (v6 !== null) {
    if ((v6 & IPV4_MAPPED_MASK) === IPV4_MAPPED_PREFIX) {
      return { version: 4, value: v6 & 0xffffffffn };
    }
    return { version: 6, value: v6 };
  }
  throw new WebhookVerificationError("Invalid webhook source IP address");
}

interface ParsedNetwork {
  version: 4 | 6;
  network: bigint;
  mask: bigint;
}

function parseCidrStrict(entry: string): ParsedNetwork {
  if (typeof entry !== "string" || !entry.trim() || entry.includes("%")) {
    throw new WebhookVerificationError(
      "Invalid CIDR entry in allowed webhook networks",
    );
  }
  const trimmed = entry.trim();
  const slashIdx = trimmed.indexOf("/");
  const ipPart = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
  const prefixPart = slashIdx === -1 ? null : trimmed.slice(slashIdx + 1);

  const v4 = ipv4ToBigInt(ipPart);
  if (v4 !== null) {
    const prefix = prefixPart === null ? 32 : Number(prefixPart);
    if (
      prefixPart !== null &&
      (!/^\d{1,2}$/.test(prefixPart) || prefix < 0 || prefix > 32)
    ) {
      throw new WebhookVerificationError(
        "Invalid CIDR entry in allowed webhook networks",
      );
    }
    const mask = prefix === 0 ? 0n : (0xffffffffn << BigInt(32 - prefix)) & 0xffffffffn;
    if ((v4 & ~mask & 0xffffffffn) !== 0n) {
      throw new WebhookVerificationError(
        "Invalid CIDR entry in allowed webhook networks",
      );
    }
    return { version: 4, network: v4, mask };
  }

  const v6 = ipv6ToBigInt(ipPart);
  if (v6 !== null) {
    const prefix = prefixPart === null ? 128 : Number(prefixPart);
    if (
      prefixPart !== null &&
      (!/^\d{1,3}$/.test(prefixPart) || prefix < 0 || prefix > 128)
    ) {
      throw new WebhookVerificationError(
        "Invalid CIDR entry in allowed webhook networks",
      );
    }
    const allOnes128 = (1n << 128n) - 1n;
    const mask = prefix === 0 ? 0n : (allOnes128 << BigInt(128 - prefix)) & allOnes128;
    if ((v6 & (~mask & allOnes128)) !== 0n) {
      throw new WebhookVerificationError(
        "Invalid CIDR entry in allowed webhook networks",
      );
    }
    // Normalize IPv4-mapped IPv6 CIDR (subset of ::ffff:0:0/96) to IPv4
    if (prefix >= 96 && (v6 & IPV4_MAPPED_MASK) === IPV4_MAPPED_PREFIX) {
      const v4Prefix = prefix - 96;
      const v4Mask =
        v4Prefix === 0 ? 0n : (0xffffffffn << BigInt(32 - v4Prefix)) & 0xffffffffn;
      return { version: 4, network: v6 & 0xffffffffn, mask: v4Mask };
    }
    return { version: 6, network: v6, mask };
  }

  throw new WebhookVerificationError("Invalid CIDR entry in allowed webhook networks");
}

/** Utilities for verifying and parsing mobile money webhook callbacks. */
export class WebhookHandler {
  public static verifyHmacSignature(
    payload: Uint8Array | Buffer | string,
    signature: string,
    secret: string,
    options: {
      algorithm?: "sha256" | "sha512" | string;
      encoding?: "hex" | "base64" | string;
    } = {},
  ): void {
    verifyHmacSignature(payload, signature, secret, options);
  }

  public static verifyTimestampedHmacSignature(
    payload: Uint8Array | Buffer | string,
    signatureHeader: string,
    secret: string,
    options: TimestampedHmacOptions = {},
  ): void {
    verifyTimestampedHmacSignature(payload, signatureHeader, secret, options);
  }

  /** Verify that a webhook source IP belongs to an allowed IP or CIDR range (fail-closed). */
  public static verifySourceIp(
    remoteIp: string,
    allowedNetworks: readonly string[],
  ): void {
    if (!Array.isArray(allowedNetworks) || allowedNetworks.length === 0) {
      throw new WebhookVerificationError(
        "Allowed webhook IP networks list must not be empty",
      );
    }
    const addr = parseIpNormalized(remoteIp);
    const parsedNetworks = allowedNetworks.map(parseCidrStrict);
    for (const net of parsedNetworks) {
      if (addr.version === net.version && (addr.value & net.mask) === net.network) {
        return;
      }
    }
    throw new WebhookVerificationError("Webhook source IP is not in allowed networks");
  }

  /** Parse and validate a webhook callback JSON object into a TransactionResult. */
  public static parseTransactionNotification(
    body: unknown,
    options: { requireIdentifier?: boolean } = {},
  ): TransactionResult {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new WebhookVerificationError(
        "Webhook notification body must be a JSON object",
      );
    }
    let result: TransactionResult;
    try {
      result = new TransactionResult(body as Record<string, unknown>);
    } catch {
      throw new WebhookVerificationError(
        "Invalid webhook transaction notification payload",
      );
    }
    if (
      options.requireIdentifier &&
      !(result.financialTransactionId || result.externalId)
    ) {
      throw new WebhookVerificationError(
        "Webhook transaction notification is missing a transaction identifier",
      );
    }
    return result;
  }

  /** Return true if a webhook callback body indicates a settled successful transaction. */
  public static isSuccessful(
    body: unknown,
    options: { requireIdentifier?: boolean } = {},
  ): boolean {
    return WebhookHandler.parseTransactionNotification(body, options).isSuccessful();
  }
}
