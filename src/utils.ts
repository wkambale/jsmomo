import { randomInt, randomUUID } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

import { JsMomoSDKError, TransactionFailedError } from "./exceptions.js";

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;
const LOCALHOST_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);
const ENCODED_TRAVERSAL_RE = /%(?:2e|2f|5c|25(?:2e|2f|5c))/i;
const CURRENCY_RE = /^[A-Za-z]{3}$/;
const COUNTRY_RE = /^[A-Za-z]{2}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]+)?$/;
const MSISDN_ALLOWED_CHARS_RE = /^[0-9+\-\s().]+$/;
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "RWF",
  "UGX",
  "XAF",
  "XOF",
]);
const HEADER_TOKEN_RE = /^[A-Za-z0-9._-]+$/;
const BARE_HOST_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const CANONICAL_UUID_V4_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const CANONICAL_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const FORBIDDEN_SEGMENT_CHARS = new Set(["/", "\\", "?", "#"]);
const VALID_ACCOUNT_HOLDER_ID_TYPES: ReadonlySet<string> = new Set([
  "msisdn",
  "email",
  "party_code",
]);
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) {
      return false;
    }
  }
  return true;
}

function hasWhitespace(value: string): boolean {
  return /\s/.test(value);
}

function normalizePort(scheme: string, port: string): string {
  if (scheme === "https:" && port === "443") {
    return "";
  }
  if (scheme === "http:" && port === "80") {
    return "";
  }
  return port;
}

function hasMalformedAuthority(rawUrl: string): boolean {
  const schemeIdx = rawUrl.indexOf("://");
  if (schemeIdx === -1) {
    return true;
  }
  const afterScheme = rawUrl.slice(schemeIdx + 3);
  const pathStart = afterScheme.search(/[/?#]/);
  const netloc = pathStart === -1 ? afterScheme : afterScheme.slice(0, pathStart);
  if (!netloc || netloc.includes(";")) {
    return true;
  }
  const atIdx = netloc.lastIndexOf("@");
  const hostPort = atIdx === -1 ? netloc : netloc.slice(atIdx + 1);
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    if (end === -1) {
      return true;
    }
    const remainder = hostPort.slice(end + 1);
    if (
      remainder &&
      (!remainder.startsWith(":") || !/^\d+$/.test(remainder.slice(1)))
    ) {
      return true;
    }
    return false;
  }
  const colonIdx = hostPort.lastIndexOf(":");
  if (colonIdx !== -1) {
    const portPart = hostPort.slice(colonIdx + 1);
    if (!portPart || !/^\d+$/.test(portPart)) {
      return true;
    }
  }
  return false;
}

function isNumericObfuscatedIp(host: string): boolean {
  if (!host || host.includes(":")) {
    return false;
  }
  const labels = host.split(".");
  if (labels.length > 4) {
    return false;
  }
  for (const label of labels) {
    if (!label) {
      return true;
    }
    if (label.startsWith("0x") || label.startsWith("0X")) {
      if (label.length <= 2 || !/^[0-9a-fA-F]+$/.test(label.slice(2))) {
        return false;
      }
    } else if (/^\d+$/.test(label)) {
      continue;
    } else {
      return false;
    }
  }
  return true;
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isDisallowedIpv4(ip: string, allowLocalhost: boolean): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) {
    return true;
  }
  const [a, b] = octets;
  if (a === 127) {
    return !allowLocalhost; // 127.0.0.0/8 loopback
  }
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 10) return true; // 10.0.0.0/8 RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC 1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC 1918
  if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 192 && b === 88 && octets[2] === 99) return true; // 192.88.99.0/24 RFC 3068 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100.0/24 RFC 5737 TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113.0/24 RFC 5737 TEST-NET-3
  if (a >= 224) return true; // multicast & reserved (224.0.0.0/4+)
  return false;
}

function expandIpv6ToWords(rawIp: string): number[] | null {
  const ip = rawIp.split("%")[0]!.toLowerCase();
  // Handle IPv4-embedded IPv6 suffix (e.g. ::ffff:127.0.0.1)
  let normalized = ip;
  const lastColon = ip.lastIndexOf(":");
  if (lastColon !== -1 && ip.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4Octets(ip.slice(lastColon + 1));
    if (!v4) {
      return null;
    }
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    normalized = `${ip.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) {
    return null;
  }
  const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
  const right =
    doubleColonParts.length === 2 && doubleColonParts[1]
      ? doubleColonParts[1].split(":")
      : [];
  if (doubleColonParts.length === 1 && left.length !== 8) {
    return null;
  }
  const missing = 8 - (left.length + right.length);
  if (missing < 0) {
    return null;
  }
  const full = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (full.length !== 8) {
    return null;
  }
  const words: number[] = [];
  for (const seg of full) {
    if (!/^[0-9a-f]{1,4}$/.test(seg)) {
      return null;
    }
    words.push(parseInt(seg, 16));
  }
  return words;
}

function isDisallowedIpv6(ip: string, allowLocalhost: boolean): boolean {
  const words = expandIpv6ToWords(ip);
  if (!words) {
    return true;
  }
  // Unspecified ::
  if (words.every((w) => w === 0)) {
    return true;
  }
  // Loopback ::1
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) {
    return !allowLocalhost;
  }
  // Deprecated IPv4-compatible ::/96 (e.g. ::127.0.0.1, ::169.254.169.254)
  if (words.slice(0, 6).every((w) => w === 0)) {
    return true;
  }
  // IPv4-mapped ::ffff:a.b.c.d (never permitted even when allowLocalhost=true)
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const a = (words[6]! >> 8) & 0xff;
    const b = words[6]! & 0xff;
    const c = (words[7]! >> 8) & 0xff;
    const d = words[7]! & 0xff;
    return isDisallowedIpv4(`${a}.${b}.${c}.${d}`, false);
  }
  // RFC 2765 SIIT IPv4-translated ::ffff:0:0:0/96
  if (
    words.slice(0, 4).every((w) => w === 0) &&
    words[4] === 0xffff &&
    words[5] === 0
  ) {
    return true;
  }
  const first = words[0]!;
  // RFC 6052 / RFC 8215 NAT64 prefixes (64:ff9b::/96 and 64:ff9b:1::/48)
  if (first === 0x0064 && words[1] === 0xff9b) {
    if (words[2] === 0x0001 || words.slice(2, 6).every((w) => w === 0)) {
      return true;
    }
  }
  // RFC 6666 discard-only 100::/64
  if (first === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) {
    return true;
  }
  if (first === 0x2002) return true; // RFC 3056 / 7526 6to4 IPv4-embedding
  if (first === 0x2001 && words[1] === 0x0000) return true; // RFC 4380 Teredo
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && words[1] === 0x0db8) return true; // documentation
  return false;
}

export function isDisallowedIpHost(host: string, allowLocalhost: boolean): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.+$/, "");
  if (!normalized) {
    return true;
  }
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return !allowLocalhost;
  }
  const bare =
    normalized.startsWith("[") && normalized.endsWith("]")
      ? normalized.slice(1, -1)
      : normalized;
  if (isIPv4(bare)) {
    return isDisallowedIpv4(bare, allowLocalhost);
  }
  if (isIPv6(bare)) {
    return isDisallowedIpv6(bare, allowLocalhost);
  }
  return isNumericObfuscatedIp(bare);
}

/**
 * Validate that a base URL uses HTTPS (or localhost/127.0.0.1/::1 when permitted).
 */
export function validateBaseUrl(
  baseUrl: string,
  options: { allowLocalhost?: boolean } = {},
): string {
  const allowLocalhost = options.allowLocalhost ?? true;
  if (
    typeof baseUrl !== "string" ||
    !baseUrl ||
    baseUrl !== baseUrl.trim() ||
    hasWhitespace(baseUrl) ||
    CONTROL_CHAR_RE.test(baseUrl) ||
    !isAscii(baseUrl) ||
    baseUrl.includes("\\")
  ) {
    throw new JsMomoSDKError("Base URL must use HTTPS");
  }
  if (baseUrl.includes("?") || baseUrl.includes("#")) {
    throw new JsMomoSDKError("Base URL must not contain a query string or fragment");
  }
  if (hasMalformedAuthority(baseUrl)) {
    throw new JsMomoSDKError("Base URL must use HTTPS");
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new JsMomoSDKError("Base URL must use HTTPS");
  }

  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const bareHost =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (!bareHost) {
    throw new JsMomoSDKError("Base URL must use HTTPS");
  }

  // Reject parser-normalized obfuscated hosts (e.g. http://0x7f000001 -> 127.0.0.1)
  const rawAuthority = baseUrl.slice(baseUrl.indexOf("://") + 3).split("/")[0] ?? "";
  const rawHostPort = rawAuthority.includes("@")
    ? rawAuthority.slice(rawAuthority.lastIndexOf("@") + 1)
    : rawAuthority;
  const rawHost = rawHostPort.startsWith("[")
    ? rawHostPort.slice(1, rawHostPort.indexOf("]")).toLowerCase()
    : rawHostPort.split(":")[0]!.toLowerCase();

  if (isNumericObfuscatedIp(rawHost) && !isIPv4(rawHost)) {
    throw new JsMomoSDKError("Base URL host is not allowed");
  }

  const isAllowedScheme =
    scheme === "https:" ||
    (allowLocalhost && scheme === "http:" && LOCALHOST_HOSTS.has(bareHost));
  if (!isAllowedScheme) {
    throw new JsMomoSDKError("Base URL must use HTTPS");
  }

  if (isDisallowedIpHost(bareHost, allowLocalhost)) {
    throw new JsMomoSDKError("Base URL host is not allowed");
  }

  if (parsed.username || parsed.password || rawAuthority.includes("@")) {
    throw new JsMomoSDKError("Base URL must not contain embedded credentials");
  }

  return baseUrl;
}

/** Verify that two URLs share the exact same scheme, host, and normalized port. */
export function validateMatchingOrigin(
  configuredUrl: string,
  injectedUrl: string,
): void {
  let cfg: URL;
  let inj: URL;
  try {
    cfg = new URL(configuredUrl);
    inj = new URL(injectedUrl);
  } catch {
    throw new JsMomoSDKError(
      "Injected HTTP client baseUrl must match configured baseUrl",
    );
  }
  const same =
    cfg.protocol.toLowerCase() === inj.protocol.toLowerCase() &&
    cfg.hostname.toLowerCase().replace(/\.+$/, "") ===
      inj.hostname.toLowerCase().replace(/\.+$/, "") &&
    normalizePort(cfg.protocol.toLowerCase(), cfg.port) ===
      normalizePort(inj.protocol.toLowerCase(), inj.port);
  if (!same) {
    throw new JsMomoSDKError(
      "Injected HTTP client baseUrl must match configured baseUrl",
    );
  }
}

/** Validate that a request path is strictly relative to the client base URL. */
export function validateRequestPath(
  path: string,
  options: { allowQuery?: boolean } = {},
): string {
  const allowQuery = options.allowQuery ?? true;
  if (typeof path !== "string") {
    throw new JsMomoSDKError("Request path must be a relative path starting with '/'");
  }
  if (!allowQuery && path.includes("?")) {
    throw new JsMomoSDKError("Request path must not contain a query string");
  }
  const rawPath = path.split("?", 1)[0] ?? "";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    throw new JsMomoSDKError("Request path must be a relative path starting with '/'");
  }
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    decodedPath.includes("\\") ||
    path.includes("#") ||
    !isAscii(path) ||
    hasWhitespace(path) ||
    CONTROL_CHAR_RE.test(path) ||
    ENCODED_TRAVERSAL_RE.test(rawPath) ||
    rawPath.split("/").some((seg) => seg === "." || seg === "..") ||
    decodedPath.split("/").some((seg) => seg === "." || seg === "..")
  ) {
    throw new JsMomoSDKError("Request path must be a relative path starting with '/'");
  }
  return path;
}

/** Return a cryptographically random UUID v4 string suitable for X-Reference-Id. */
export function generateReferenceId(): string {
  return randomUUID();
}

/** Validate and normalise a phone number into a clean ASCII E.164 digit string. */
export function normaliseMsisdn(msisdn: string): string {
  if (typeof msisdn !== "string") {
    throw new TypeError("MSISDN must be a string");
  }
  if (!msisdn.trim() || !MSISDN_ALLOWED_CHARS_RE.test(msisdn)) {
    throw new RangeError(
      "MSISDN must contain only digits and standard phone formatting",
    );
  }
  let digits = msisdn.replace(/[^0-9]/g, "");
  if (digits.startsWith("00") && digits.length > 9) {
    digits = digits.slice(2);
  }
  if (digits.length < 7 || digits.length > 15) {
    throw new RangeError("MSISDN must contain between 7 and 15 digits");
  }
  return digits;
}

/** Validate an ISO 4217 three-letter currency code and return it uppercased. */
export function validateCurrency(currency: string): string {
  if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) {
    throw new RangeError("Currency must be a valid three-letter ISO 4217 code");
  }
  return currency.toUpperCase();
}

/** Validate and normalize an account holder ID type (msisdn, email, or party_code). */
export function validateAccountHolderIdType(accountHolderIdType: string): string {
  if (typeof accountHolderIdType !== "string") {
    throw new TypeError("Account holder ID type must be a string");
  }
  const normalized = accountHolderIdType.toLowerCase();
  if (!VALID_ACCOUNT_HOLDER_ID_TYPES.has(normalized)) {
    throw new RangeError(
      "Account holder ID type must be one of 'msisdn', 'email', or 'party_code'",
    );
  }
  return normalized;
}

/**
 * Validate that a transaction amount is a canonical positive decimal string.
 * Enforces <= 18 integer digits, <= 2 decimal places, > 0, and zero-decimal currency rules.
 */
export function validateAmount(
  amount: string,
  options: { currency?: string | null } = {},
): string {
  if (typeof amount !== "string" || !AMOUNT_RE.test(amount)) {
    throw new RangeError("Amount must be a positive decimal string");
  }
  const dotIdx = amount.indexOf(".");
  const intPart = dotIdx === -1 ? amount : amount.slice(0, dotIdx);
  const fracPart = dotIdx === -1 ? "" : amount.slice(dotIdx + 1);
  if (fracPart.length > 2) {
    throw new RangeError("Amount must not have more than 2 decimal places");
  }
  const minorUnits = BigInt(intPart) * 100n + BigInt(fracPart.padEnd(2, "0"));
  if (minorUnits <= 0n) {
    throw new RangeError("Amount must be greater than zero");
  }
  if (options.currency !== undefined && options.currency !== null) {
    const normCcy = validateCurrency(options.currency);
    if (ZERO_DECIMAL_CURRENCIES.has(normCcy) && minorUnits % 100n !== 0n) {
      throw new RangeError(
        `Amount for zero-decimal currency ${normCcy} must not have fractional minor units`,
      );
    }
  }
  return amount;
}

/** Validate that a network timeout (seconds) is a finite positive number. */
export function validateTimeout(timeout: number): number {
  if (typeof timeout !== "number") {
    throw new TypeError("Timeout must be a positive finite number");
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError("Timeout must be a positive finite number");
  }
  return timeout;
}

/** Validate an ISO 3166-1 alpha-2 country code and return it uppercased. */
export function validateCountryCode(country: string): string {
  if (typeof country !== "string" || !COUNTRY_RE.test(country)) {
    throw new RangeError("Country must be a valid two-letter ISO 3166-1 code");
  }
  return country.toUpperCase();
}

/** Validate that an HTTP header value contains only safe printable ASCII. */
export function validateHeaderValue(
  value: string,
  options: { fieldName: string; allowWhitespace?: boolean },
): string {
  const allowWhitespace = options.allowWhitespace ?? true;
  if (typeof value !== "string" || CONTROL_CHAR_RE.test(value)) {
    throw new RangeError(`${options.fieldName} must not contain control characters`);
  }
  if (!isAscii(value)) {
    throw new RangeError(
      `${options.fieldName} must contain only printable ASCII characters`,
    );
  }
  if (!allowWhitespace && hasWhitespace(value)) {
    throw new RangeError(`${options.fieldName} must not contain whitespace`);
  }
  return value;
}

/** Validate a target environment header identifier. */
export function validateEnvironmentName(environment: string): string {
  if (typeof environment !== "string" || !HEADER_TOKEN_RE.test(environment)) {
    throw new RangeError("Environment must be a non-empty valid identifier");
  }
  return environment;
}

/** Validate that maxRetries is a non-negative integer. */
export function validateMaxRetries(maxRetries: number): number {
  if (typeof maxRetries !== "number") {
    throw new TypeError("maxRetries must be a non-negative integer");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError("maxRetries must be a non-negative integer");
  }
  return maxRetries;
}

/** Validate that retryBackoff is a positive finite number. */
export function validateRetryBackoff(retryBackoff: number): number {
  if (typeof retryBackoff !== "number") {
    throw new TypeError("retryBackoff must be a positive finite number");
  }
  if (!Number.isFinite(retryBackoff) || retryBackoff <= 0) {
    throw new RangeError("retryBackoff must be a positive finite number");
  }
  return retryBackoff;
}

/** Validate a basic email address for payment rails that require customer email. */
export function validateEmailAddress(email: string): string {
  if (typeof email !== "string") {
    throw new RangeError("Email address must be a valid email string");
  }
  const trimmed = email.trim();
  if (
    !trimmed ||
    trimmed.length > 254 ||
    CONTROL_CHAR_RE.test(trimmed) ||
    !EMAIL_RE.test(trimmed)
  ) {
    throw new RangeError("Email address must be a valid email string");
  }
  return trimmed;
}

/** Validate that a callback URL uses HTTPS (or localhost when permitted). */
export function validateCallbackUrl(
  callbackUrl: string,
  options: { allowLocalhost?: boolean } = {},
): string {
  const allowLocalhost = options.allowLocalhost ?? true;
  if (
    typeof callbackUrl !== "string" ||
    !callbackUrl ||
    callbackUrl !== callbackUrl.trim() ||
    hasWhitespace(callbackUrl) ||
    CONTROL_CHAR_RE.test(callbackUrl) ||
    !isAscii(callbackUrl) ||
    callbackUrl.includes("\\")
  ) {
    throw new RangeError("Callback URL must use HTTPS");
  }
  if (callbackUrl.includes("#")) {
    throw new RangeError("Callback URL must not contain a fragment");
  }
  if (hasMalformedAuthority(callbackUrl)) {
    throw new RangeError("Callback URL must use HTTPS");
  }
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new RangeError("Callback URL must use HTTPS");
  }
  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const bareHost =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!bareHost) {
    throw new RangeError("Callback URL must use HTTPS");
  }
  const rawAuthority =
    callbackUrl.slice(callbackUrl.indexOf("://") + 3).split(/[/?#]/)[0] ?? "";
  const rawHostPort = rawAuthority.includes("@")
    ? rawAuthority.slice(rawAuthority.lastIndexOf("@") + 1)
    : rawAuthority;
  const rawHost = rawHostPort.startsWith("[")
    ? rawHostPort.slice(1, rawHostPort.indexOf("]")).toLowerCase()
    : rawHostPort.split(":")[0]!.toLowerCase();
  if (isNumericObfuscatedIp(rawHost) && !isIPv4(rawHost)) {
    throw new RangeError("Callback URL host is not allowed");
  }
  const isAllowedScheme =
    scheme === "https:" ||
    (allowLocalhost && scheme === "http:" && LOCALHOST_HOSTS.has(bareHost));
  if (!isAllowedScheme) {
    throw new RangeError("Callback URL must use HTTPS");
  }
  if (isDisallowedIpHost(bareHost, allowLocalhost)) {
    throw new RangeError("Callback URL host is not allowed");
  }
  if (parsed.username || parsed.password || rawAuthority.includes("@")) {
    throw new RangeError("Callback URL must not contain embedded credentials");
  }
  return callbackUrl;
}

/** Validate a sandbox provider callback host (bare hostname or HTTPS URL). */
export function validateCallbackHost(
  callbackHost: string,
  options: { allowLocalhost?: boolean } = {},
): string {
  const allowLocalhost = options.allowLocalhost ?? true;
  if (
    typeof callbackHost !== "string" ||
    !callbackHost ||
    callbackHost !== callbackHost.trim() ||
    CONTROL_CHAR_RE.test(callbackHost) ||
    !isAscii(callbackHost)
  ) {
    throw new RangeError("Callback host must be a valid hostname or HTTPS URL");
  }
  if (callbackHost.includes("://")) {
    return validateCallbackUrl(callbackHost, { allowLocalhost });
  }
  if (callbackHost.length > 253 || !BARE_HOST_RE.test(callbackHost)) {
    throw new RangeError("Callback host must be a valid hostname or HTTPS URL");
  }
  if (isDisallowedIpHost(callbackHost, allowLocalhost)) {
    throw new RangeError("Callback host is not allowed");
  }
  return callbackHost;
}

/** Validate and percent-encode a single URL path segment. */
export function encodePathSegment(value: string, fieldName = "value"): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value === "." ||
    value === ".." ||
    CONTROL_CHAR_RE.test(value) ||
    [...value].some((ch) => FORBIDDEN_SEGMENT_CHARS.has(ch))
  ) {
    throw new RangeError(`Invalid path segment for ${fieldName}`);
  }
  return encodeURIComponent(value);
}

/** Return a Base64-encoded Basic authorization header value. */
export function buildBasicAuthHeader(apiUser: string, apiKey: string): string {
  validateHeaderValue(apiUser, { fieldName: "apiUser" });
  validateHeaderValue(apiKey, { fieldName: "apiKey" });
  if (apiUser.includes(":")) {
    throw new RangeError("API user must not contain ':'");
  }
  const encoded = Buffer.from(`${apiUser}:${apiKey}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/** Validate that the given string is a canonical hyphenated UUID v4. */
export function validateReferenceId(referenceId: string): void {
  if (typeof referenceId !== "string" || !CANONICAL_UUID_RE.test(referenceId)) {
    throw new RangeError("The reference ID must be a valid UUID v4");
  }
  if (!CANONICAL_UUID_V4_RE.test(referenceId)) {
    throw new RangeError("The reference ID must be a version 4 UUID");
  }
}

/** Validate an Airtel transaction reference identifier (UUID or 1-64 safe chars). */
export function validateAirtelReferenceId(referenceId: string): string {
  if (
    typeof referenceId !== "string" ||
    referenceId.length < 1 ||
    referenceId.length > 64 ||
    referenceId === "." ||
    referenceId === ".." ||
    !HEADER_TOKEN_RE.test(referenceId)
  ) {
    throw new RangeError("Invalid Airtel reference ID");
  }
  return referenceId;
}

export interface CarrierMatch {
  readonly country: string;
  readonly provider: string;
}

const CARRIER_PREFIX_MAP: readonly (readonly [string, string, string])[] = [
  // Uganda (256)
  ["25677", "UG", "mtn_momo"],
  ["25678", "UG", "mtn_momo"],
  ["25676", "UG", "mtn_momo"],
  ["25679", "UG", "mtn_momo"],
  ["25639", "UG", "mtn_momo"],
  ["25675", "UG", "airtel_money"],
  ["25670", "UG", "airtel_money"],
  ["25674", "UG", "airtel_money"],
  // Ghana (233)
  ["23324", "GH", "mtn_momo"],
  ["23325", "GH", "mtn_momo"],
  ["23353", "GH", "mtn_momo"],
  ["23354", "GH", "mtn_momo"],
  ["23355", "GH", "mtn_momo"],
  ["23359", "GH", "mtn_momo"],
  ["23326", "GH", "airtel_money"],
  ["23327", "GH", "airtel_money"],
  ["23356", "GH", "airtel_money"],
  ["23357", "GH", "airtel_money"],
  // Kenya (254)
  ["254740", "KE", "mpesa"],
  ["254741", "KE", "mpesa"],
  ["254742", "KE", "mpesa"],
  ["254743", "KE", "mpesa"],
  ["254745", "KE", "mpesa"],
  ["254746", "KE", "mpesa"],
  ["254748", "KE", "mpesa"],
  ["254757", "KE", "mpesa"],
  ["254758", "KE", "mpesa"],
  ["254759", "KE", "mpesa"],
  ["254768", "KE", "mpesa"],
  ["254769", "KE", "mpesa"],
  ["254750", "KE", "airtel_money"],
  ["254751", "KE", "airtel_money"],
  ["254752", "KE", "airtel_money"],
  ["254753", "KE", "airtel_money"],
  ["254754", "KE", "airtel_money"],
  ["254755", "KE", "airtel_money"],
  ["254756", "KE", "airtel_money"],
  ["254762", "KE", "airtel_money"],
  ["25470", "KE", "mpesa"],
  ["25471", "KE", "mpesa"],
  ["25472", "KE", "mpesa"],
  ["25479", "KE", "mpesa"],
  ["25411", "KE", "mpesa"],
  ["25410", "KE", "airtel_money"],
  ["25473", "KE", "airtel_money"],
  ["25478", "KE", "airtel_money"],
  // Tanzania (255)
  ["25574", "TZ", "mpesa"],
  ["25575", "TZ", "mpesa"],
  ["25576", "TZ", "mpesa"],
  ["25568", "TZ", "airtel_money"],
  ["25569", "TZ", "airtel_money"],
  ["25578", "TZ", "airtel_money"],
  ["25579", "TZ", "airtel_money"],
  // Rwanda (250)
  ["25078", "RW", "mtn_momo"],
  ["25079", "RW", "mtn_momo"],
  ["25072", "RW", "airtel_money"],
  ["25073", "RW", "airtel_money"],
  // Zambia (260)
  ["26076", "ZM", "mtn_momo"],
  ["26096", "ZM", "mtn_momo"],
  ["26077", "ZM", "airtel_money"],
  ["26097", "ZM", "airtel_money"],
  // Malawi (265)
  ["26598", "MW", "airtel_money"],
  ["26599", "MW", "airtel_money"],
  // DRC (243)
  ["24381", "CD", "mpesa"],
  ["24382", "CD", "mpesa"],
  ["24383", "CD", "mpesa"],
  ["24397", "CD", "airtel_money"],
  ["24398", "CD", "airtel_money"],
  ["24399", "CD", "airtel_money"],
  ["24384", "CD", "orange_money"],
  ["24385", "CD", "orange_money"],
  ["24389", "CD", "orange_money"],
  // Ethiopia (251)
  ["2517", "ET", "mpesa"],
  // Cameroon (237)
  ["237650", "CM", "mtn_momo"],
  ["237651", "CM", "mtn_momo"],
  ["237652", "CM", "mtn_momo"],
  ["237653", "CM", "mtn_momo"],
  ["237654", "CM", "mtn_momo"],
  ["237655", "CM", "orange_money"],
  ["237656", "CM", "orange_money"],
  ["237657", "CM", "orange_money"],
  ["237658", "CM", "orange_money"],
  ["237659", "CM", "orange_money"],
  ["23767", "CM", "mtn_momo"],
  ["23768", "CM", "mtn_momo"],
  ["23769", "CM", "orange_money"],
  // Nigeria (234)
  ["234703", "NG", "mtn_momo"],
  ["234706", "NG", "mtn_momo"],
  ["234803", "NG", "mtn_momo"],
  ["234806", "NG", "mtn_momo"],
  ["234810", "NG", "mtn_momo"],
  ["234813", "NG", "mtn_momo"],
  ["234814", "NG", "mtn_momo"],
  ["234816", "NG", "mtn_momo"],
  ["234903", "NG", "mtn_momo"],
  ["234906", "NG", "mtn_momo"],
  ["234913", "NG", "mtn_momo"],
  ["234916", "NG", "mtn_momo"],
  ["234701", "NG", "airtel_money"],
  ["234708", "NG", "airtel_money"],
  ["234802", "NG", "airtel_money"],
  ["234808", "NG", "airtel_money"],
  ["234812", "NG", "airtel_money"],
  ["234901", "NG", "airtel_money"],
  ["234902", "NG", "airtel_money"],
  ["234904", "NG", "airtel_money"],
  ["234907", "NG", "airtel_money"],
  ["234912", "NG", "airtel_money"],
  // South Africa (27)
  ["27710", "ZA", "mtn_momo"],
  ["27717", "ZA", "mtn_momo"],
  ["27718", "ZA", "mtn_momo"],
  ["27719", "ZA", "mtn_momo"],
  ["2763", "ZA", "mtn_momo"],
  ["2768", "ZA", "mtn_momo"],
  ["2773", "ZA", "mtn_momo"],
  ["2778", "ZA", "mtn_momo"],
  ["2783", "ZA", "mtn_momo"],
  // Ivory Coast (225)
  ["22505", "CI", "mtn_momo"],
  ["22507", "CI", "orange_money"],
  ["22501", "CI", "moov_money"],
  // Senegal (221)
  ["22177", "SN", "orange_money"],
  ["22178", "SN", "orange_money"],
  // Benin (229)
  ["229015", "BJ", "mtn_momo"],
  ["229016", "BJ", "mtn_momo"],
  ["229019", "BJ", "mtn_momo"],
  ["22950", "BJ", "mtn_momo"],
  ["22951", "BJ", "mtn_momo"],
  ["22952", "BJ", "mtn_momo"],
  ["22953", "BJ", "mtn_momo"],
  ["22954", "BJ", "mtn_momo"],
  ["22956", "BJ", "mtn_momo"],
  ["22957", "BJ", "mtn_momo"],
  ["22959", "BJ", "mtn_momo"],
  ["22961", "BJ", "mtn_momo"],
  ["22962", "BJ", "mtn_momo"],
  ["22966", "BJ", "mtn_momo"],
  ["22967", "BJ", "mtn_momo"],
  ["22969", "BJ", "mtn_momo"],
  ["22990", "BJ", "mtn_momo"],
  ["22991", "BJ", "mtn_momo"],
  ["22996", "BJ", "mtn_momo"],
  ["22997", "BJ", "mtn_momo"],
  // Congo-Brazzaville (242)
  ["24206", "CG", "mtn_momo"],
  ["24205", "CG", "airtel_money"],
  // Liberia (231)
  ["23155", "LR", "mtn_momo"],
  ["23188", "LR", "mtn_momo"],
  ["23177", "LR", "orange_money"],
  // Guinea (224)
  ["22466", "GN", "mtn_momo"],
  ["22462", "GN", "orange_money"],
  // Eswatini (268)
  ["26876", "SZ", "mtn_momo"],
  ["26878", "SZ", "mtn_momo"],
];

const SORTED_CARRIER_PREFIX_MAP = [...CARRIER_PREFIX_MAP].sort(
  (a, b) => b[0].length - a[0].length,
);

/**
 * Infer `{ country, provider }` from an international MSISDN prefix across 18 African markets.
 * Returns `null` if the prefix is not in the routing table.
 */
export function detectCarrierFromMsisdn(
  msisdn: string,
  options: { customPrefixes?: Record<string, readonly [string, string]> } = {},
): CarrierMatch | null {
  if (typeof msisdn !== "string") {
    throw new TypeError("MSISDN must be a string");
  }
  const digits = msisdn.replace(/[^0-9]/g, "").replace(/^00/, "");
  if (digits.length < 10 || digits.length > 15) {
    return null;
  }
  if (options.customPrefixes) {
    const entries = Object.entries(options.customPrefixes).sort(
      (a, b) => b[0].length - a[0].length,
    );
    for (const [prefix, target] of entries) {
      const cleanPrefix = prefix.replace(/[^0-9]/g, "").replace(/^00/, "");
      if (cleanPrefix && digits.startsWith(cleanPrefix)) {
        return { country: String(target[0]), provider: String(target[1]) };
      }
    }
  }
  for (const [prefix, country, provider] of SORTED_CARRIER_PREFIX_MAP) {
    if (digits.startsWith(prefix)) {
      return { country, provider };
    }
  }
  return null;
}

export interface WaitForSettlementOptions {
  timeout?: number;
  interval?: number;
  backoff?: number;
  maxInterval?: number;
  sleepFn?: (seconds: number) => Promise<void>;
  raiseOnFailed?: boolean;
  referenceId?: string | null;
}

interface PollableResult {
  status?: unknown;
  reason?: string | null;
  referenceId?: string | null;
  externalId?: string | null;
  isPending?: () => boolean;
  isFailed?: () => boolean;
}

function validatePollingParams(
  interval: number,
  backoff: number,
  maxInterval: number,
): [number, number, number] {
  for (const val of [interval, backoff, maxInterval]) {
    if (typeof val !== "number") {
      throw new TypeError("Polling interval, backoff, and maxInterval must be valid");
    }
  }
  if (
    !Number.isFinite(interval) ||
    !Number.isFinite(backoff) ||
    !Number.isFinite(maxInterval) ||
    interval <= 0 ||
    backoff < 1.0 ||
    maxInterval <= 0
  ) {
    throw new RangeError("Polling interval, backoff, and maxInterval must be valid");
  }
  return [interval, backoff, maxInterval];
}

function isResultPending(result: PollableResult): boolean {
  if (typeof result.isPending === "function") {
    return Boolean(result.isPending());
  }
  return (
    typeof result.status === "string" &&
    result.status.trim().toUpperCase() === "PENDING"
  );
}

function raiseIfResultFailed(
  result: PollableResult,
  referenceId?: string | null,
): void {
  const isFailed =
    typeof result.isFailed === "function"
      ? Boolean(result.isFailed())
      : typeof result.status === "string" &&
        result.status.trim().toUpperCase() === "FAILED";
  if (isFailed) {
    const resolvedRef =
      referenceId ?? result.referenceId ?? result.externalId ?? "unknown";
    throw new TransactionFailedError(String(resolvedRef), result.reason ?? null);
  }
}

function jitteredPollDelay(delay: number, maxInterval: number): number {
  const maxJitterMs = Math.floor(Math.min(250, delay * 100));
  const jitter = maxJitterMs > 0 ? randomInt(0, maxJitterMs) / 1000 : 0;
  return Math.min(delay + jitter, maxInterval);
}

function defaultSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)));
}

/**
 * Poll `pollFn` with exponential backoff and cryptographic jitter until a transaction settles.
 */
export async function waitForSettlement<T extends PollableResult>(
  pollFn: () => Promise<T> | T,
  options: WaitForSettlementOptions = {},
): Promise<T> {
  const timeoutSec = validateTimeout(options.timeout ?? 60.0);
  const [intervalSec, backoff, maxIntervalSec] = validatePollingParams(
    options.interval ?? 2.0,
    options.backoff ?? 1.5,
    options.maxInterval ?? 10.0,
  );
  const sleep = options.sleepFn ?? defaultSleep;
  const raiseOnFailed = options.raiseOnFailed ?? false;
  const referenceId = options.referenceId ?? null;

  const deadlineMs = performance.now() + timeoutSec * 1000;
  let delaySec = Math.min(intervalSec, maxIntervalSec);

  while (true) {
    const result = await pollFn();
    if (!isResultPending(result)) {
      if (raiseOnFailed) {
        raiseIfResultFailed(result, referenceId);
      }
      return result;
    }
    const remainingSec = (deadlineMs - performance.now()) / 1000;
    const sleepForSec = jitteredPollDelay(delaySec, maxIntervalSec);
    if (remainingSec <= 0 || sleepForSec >= remainingSec) {
      throw new JsMomoSDKError("Transaction settlement polling timed out", {
        referenceId,
      });
    }
    await sleep(sleepForSec);
    delaySec = Math.min(delaySec * backoff, maxIntervalSec);
  }
}
