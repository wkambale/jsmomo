import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

import { AirtelClient } from "./airtel/client.js";
import { AirtelConfig, encryptAirtelPin } from "./airtel/config.js";
import { JsMomoSDK } from "./client.js";
import { JsMomoSDKConfig, ProductConfig } from "./config.js";
import { JsMomoSDKError } from "./exceptions.js";
import { startMockServer } from "./mock-server.js";
import { detectCarrierFromMsisdn } from "./utils.js";
import { VERSION } from "./version.js";
import { WebhookHandler } from "./webhooks.js";

export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env?: Record<string, string | undefined>;
  readStdin?: () => Buffer;
}

const DEFAULT_IO: CliIO = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

const HELP_TEXT = `js-momo-sdk ${VERSION} — JS MoMo SDK CLI

Usage:
  js-momo-sdk [command] [options]

Commands:
  sandbox provision                Provision a new MTN sandbox API user & key
  sandbox get-user <userId>        Inspect a sandbox API user
  collection balance               Query MTN collection balance
  collection request-to-pay <msisdn> <amount> <currency> <externalId>
  collection status <referenceId>  Query Request to Pay status
  disbursement balance             Query MTN disbursement balance
  disbursement transfer <msisdn> <amount> <currency> <externalId>
  disbursement status <referenceId>
  remittance balance               Query MTN remittance balance
  remittance transfer <msisdn> <amount> <currency> <externalId>
  remittance status <referenceId>
  airtel encrypt-pin               Encrypt an Airtel PIN with an RSA PEM key
  airtel balance                   Query Airtel Money merchant balance
  webhook verify                   Verify HMAC or timestamped HMAC webhook signature
  carrier <msisdn>                 Detect country and provider from an MSISDN
  mock                             Start local HTTP mock gateway server

Options:
  -V, --version                    Show version and exit
  -h, --help                       Show help and exit`;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "h",
  "version",
  "V",
  "redact-secret",
  "timestamped",
  "allow-non-loopback",
]);

const VALUE_FLAGS = new Set([
  "signature",
  "s",
  "secret",
  "secret-file",
  "payload-file",
  "algorithm",
  "encoding",
  "timestamp-separator",
  "tolerance-seconds",
  "subscription-key",
  "k",
  "subscription-key-file",
  "callback-host",
  "c",
  "output-file",
  "api-user",
  "u",
  "api-key",
  "p",
  "api-key-file",
  "environment",
  "e",
  "base-url",
  "timeout",
  "max-retries",
  "retry-backoff",
  "currency",
  "payer-message",
  "payee-note",
  "reference-id",
  "callback-url",
  "public-key-file",
  "pin",
  "pin-file",
  "client-id",
  "client-secret",
  "client-secret-file",
  "country",
  "host",
  "port",
  "status",
]);

const MTN_COMMON_FLAGS = [
  "environment",
  "e",
  "base-url",
  "timeout",
  "max-retries",
  "retry-backoff",
] as const;

const MTN_PRODUCT_FLAGS = [
  ...MTN_COMMON_FLAGS,
  "subscription-key",
  "k",
  "subscription-key-file",
  "api-user",
  "u",
  "api-key",
  "p",
  "api-key-file",
] as const;

const MTN_TX_FLAGS = [
  ...MTN_PRODUCT_FLAGS,
  "payer-message",
  "payee-note",
  "reference-id",
  "callback-url",
] as const;

const COMMAND_ALLOWED_FLAGS: Record<string, ReadonlySet<string>> = {
  carrier: new Set(["help", "h"]),
  "webhook verify": new Set([
    "help",
    "h",
    "signature",
    "s",
    "secret",
    "secret-file",
    "payload-file",
    "algorithm",
    "encoding",
    "timestamped",
    "timestamp-separator",
    "tolerance-seconds",
  ]),
  "sandbox provision": new Set([
    "help",
    "h",
    ...MTN_COMMON_FLAGS,
    "subscription-key",
    "k",
    "subscription-key-file",
    "callback-host",
    "c",
    "output-file",
    "redact-secret",
  ]),
  "sandbox get-user": new Set([
    "help",
    "h",
    ...MTN_COMMON_FLAGS,
    "subscription-key",
    "k",
    "subscription-key-file",
  ]),
  "collection balance": new Set(["help", "h", ...MTN_PRODUCT_FLAGS, "currency"]),
  "collection request-to-pay": new Set(["help", "h", ...MTN_TX_FLAGS]),
  "collection status": new Set(["help", "h", ...MTN_PRODUCT_FLAGS]),
  "disbursement balance": new Set(["help", "h", ...MTN_PRODUCT_FLAGS, "currency"]),
  "disbursement transfer": new Set(["help", "h", ...MTN_TX_FLAGS]),
  "disbursement status": new Set(["help", "h", ...MTN_PRODUCT_FLAGS]),
  "remittance balance": new Set(["help", "h", ...MTN_PRODUCT_FLAGS, "currency"]),
  "remittance transfer": new Set(["help", "h", ...MTN_TX_FLAGS]),
  "remittance status": new Set(["help", "h", ...MTN_PRODUCT_FLAGS]),
  "airtel encrypt-pin": new Set(["help", "h", "public-key-file", "pin", "pin-file"]),
  "airtel balance": new Set([
    "help",
    "h",
    "client-id",
    "client-secret",
    "client-secret-file",
    "country",
    "currency",
    "environment",
    "e",
    "base-url",
  ]),
  mock: new Set(["help", "h", "host", "port", "status", "allow-non-loopback"]),
};

function isFlagLikeToken(tok: string): boolean {
  if (tok.startsWith("--")) return true;
  return tok.startsWith("-") && tok.length > 1 && !/^-\d/.test(tok);
}

function validateCommandFlags(
  commandKey: string,
  flags: Record<string, string | boolean>,
): void {
  const allowed = COMMAND_ALLOWED_FLAGS[commandKey];
  if (!allowed) return;
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      const prefix = key.length === 1 ? "-" : "--";
      throw new RangeError(`Unknown option '${prefix}${key}' for '${commandKey}'`);
    }
  }
}

function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]!;
    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        const name = tok.slice(2, eq);
        const val = tok.slice(eq + 1);
        if (BOOLEAN_FLAGS.has(name)) {
          if (val === "true") {
            flags[name] = true;
          } else if (val === "false") {
            flags[name] = false;
          } else {
            throw new RangeError(
              `Boolean option '--${name}' must be 'true' or 'false'`,
            );
          }
        } else if (VALUE_FLAGS.has(name)) {
          flags[name] = val;
        } else {
          throw new RangeError(`Unknown option '--${name}'`);
        }
      } else {
        const name = tok.slice(2);
        if (BOOLEAN_FLAGS.has(name)) {
          flags[name] = true;
        } else if (VALUE_FLAGS.has(name)) {
          const next = argv[i + 1];
          if (next === undefined || isFlagLikeToken(next)) {
            throw new RangeError(`Option '--${name}' requires a value`);
          }
          i += 1;
          flags[name] = next;
        } else {
          throw new RangeError(`Unknown option '--${name}'`);
        }
      }
    } else if (tok.startsWith("-") && tok.length > 1 && !/^-\d/.test(tok)) {
      if (tok.length !== 2) {
        throw new RangeError(`Unknown option '${tok}'`);
      }
      const short = tok.slice(1);
      if (BOOLEAN_FLAGS.has(short)) {
        flags[short] = true;
      } else if (VALUE_FLAGS.has(short)) {
        const next = argv[i + 1];
        if (next === undefined || isFlagLikeToken(next)) {
          throw new RangeError(`Option '-${short}' requires a value`);
        }
        i += 1;
        flags[short] = next;
      } else {
        throw new RangeError(`Unknown option '-${short}'`);
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

function getOpt(
  flags: Record<string, string | boolean>,
  names: readonly string[],
  envVar?: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const name of names) {
    const v = flags[name];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  if (envVar) {
    const ev = env[envVar];
    if (typeof ev === "string" && ev.trim()) return ev.trim();
  }
  return undefined;
}

function getBool(
  flags: Record<string, string | boolean>,
  names: readonly string[],
): boolean {
  return names.some((n) => flags[n] === true || flags[n] === "true");
}

function getNum(
  flags: Record<string, string | boolean>,
  name: string,
  fallback: number,
): number {
  const v = flags[name];
  if (typeof v === "string" && v.trim()) {
    const parsed = Number(v.trim());
    if (!Number.isFinite(parsed)) {
      throw new RangeError(`--${name} must be a valid number`);
    }
    return parsed;
  }
  return fallback;
}

function resolveSecret(
  direct: string | undefined,
  filePath: string | undefined,
  fieldName: string,
  readStdin: () => Buffer,
): string {
  if (filePath) {
    const raw =
      filePath === "-"
        ? readStdin().toString("utf8").trim()
        : readFileSync(filePath, "utf8").trim();
    if (!raw) throw new RangeError(`${fieldName} file must not be empty`);
    return raw;
  }
  if (direct) return direct;
  throw new RangeError(
    `${fieldName} is required (provide via environment variable, --*-file, or option)`,
  );
}

function buildProductConfig(
  prefix: "COLLECTION" | "DISBURSEMENT" | "REMITTANCE",
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
  readStdin: () => Buffer,
): ProductConfig {
  const subKeyFile = getOpt(flags, ["subscription-key-file"]);
  const apiKeyFile = getOpt(flags, ["api-key-file"]);
  if (subKeyFile === "-" && apiKeyFile === "-") {
    throw new RangeError(
      "Cannot read both --subscription-key-file and --api-key-file from stdin ('-')",
    );
  }
  const subKey = resolveSecret(
    getOpt(
      flags,
      ["subscription-key", "k"],
      `JS_MOMO_SDK_${prefix}_SUBSCRIPTION_KEY`,
      env,
    ),
    subKeyFile,
    "subscriptionKey",
    readStdin,
  );
  const apiUser = getOpt(
    flags,
    ["api-user", "u"],
    `JS_MOMO_SDK_${prefix}_API_USER`,
    env,
  );
  if (!apiUser) {
    throw new RangeError(
      "apiUser is required (provide via --api-user or environment variable)",
    );
  }
  const apiKey = resolveSecret(
    getOpt(flags, ["api-key", "p"], `JS_MOMO_SDK_${prefix}_API_KEY`, env),
    apiKeyFile,
    "apiKey",
    readStdin,
  );
  return new ProductConfig({
    subscriptionKey: subKey,
    apiUser,
    apiKey,
  });
}

function buildMtnConfig(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
  products: {
    collection?: ProductConfig;
    disbursement?: ProductConfig;
    remittance?: ProductConfig;
  } = {},
): JsMomoSDKConfig {
  return new JsMomoSDKConfig({
    environment:
      getOpt(flags, ["environment", "e"], "JS_MOMO_SDK_ENVIRONMENT", env) ?? "sandbox",
    baseUrl: getOpt(flags, ["base-url"], "JS_MOMO_SDK_BASE_URL", env) ?? null,
    timeout: getNum(flags, "timeout", 30.0),
    maxRetries: getNum(flags, "max-retries", 0),
    retryBackoff: getNum(flags, "retry-backoff", 0.5),
    collection: products.collection ?? null,
    disbursement: products.disbursement ?? null,
    remittance: products.remittance ?? null,
  });
}

function echoJson(io: CliIO, payload: unknown): void {
  io.stdout(JSON.stringify(payload, null, 2));
}

function writeSecretFileStrict(filePath: string, content: string): void {
  const openFlags =
    constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(filePath, openFlags, 0o600);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "ELOOP"
    ) {
      throw new RangeError("Refusing to write credentials to a symbolic link", {
        cause: err,
      });
    }
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new RangeError("Output file path must be a regular file");
    }
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Execute the JS MoMo SDK CLI and return a POSIX exit code (0 = ok, 1 = error). */
export async function runCli(
  argv: readonly string[],
  io: CliIO = DEFAULT_IO,
): Promise<number> {
  const env = io.env ?? process.env;
  const readStdin = io.readStdin ?? (() => readFileSync(0));

  try {
    const { positionals, flags } = parseCliArgs(argv);
    if (getBool(flags, ["version", "V"])) {
      io.stdout(`js-momo-sdk ${VERSION}`);
      return 0;
    }
    if (positionals.length === 0 || getBool(flags, ["help", "h"])) {
      io.stdout(HELP_TEXT);
      return 0;
    }

    const [cmd, sub, ...rest] = positionals;

    if (cmd === "carrier") {
      validateCommandFlags("carrier", flags);
      const msisdn = sub;
      if (!msisdn) throw new RangeError("msisdn argument is required");
      const match = detectCarrierFromMsisdn(msisdn);
      echoJson(
        io,
        match
          ? { country: match.country, provider: match.provider }
          : { country: null, provider: null },
      );
      return 0;
    }

    if (cmd === "webhook" && sub === "verify") {
      validateCommandFlags("webhook verify", flags);
      const signature = getOpt(flags, ["signature", "s"]);
      if (!signature) throw new RangeError("--signature is required");
      const secretFile = getOpt(flags, ["secret-file"]);
      const payloadFile = getOpt(flags, ["payload-file"]) ?? "-";
      if (secretFile === "-" && payloadFile === "-") {
        throw new RangeError(
          "Cannot read both --secret-file and --payload-file from stdin ('-')",
        );
      }
      const secret = resolveSecret(
        getOpt(flags, ["secret"], "JS_MOMO_SDK_WEBHOOK_SECRET", env),
        secretFile,
        "secret",
        readStdin,
      );
      const raw = payloadFile === "-" ? readStdin() : readFileSync(payloadFile);
      const algorithm = getOpt(flags, ["algorithm"]) ?? "sha256";
      const encoding = getOpt(flags, ["encoding"]) ?? "hex";
      if (getBool(flags, ["timestamped"])) {
        if (encoding.toLowerCase() !== "hex") {
          throw new RangeError(
            "--encoding must be 'hex' when --timestamped is enabled",
          );
        }
        const sep =
          typeof flags["timestamp-separator"] === "string"
            ? flags["timestamp-separator"]
            : ".";
        WebhookHandler.verifyTimestampedHmacSignature(raw, signature, secret, {
          algorithm,
          timestampSeparator: sep,
          toleranceSeconds: getNum(flags, "tolerance-seconds", 300),
        });
      } else {
        WebhookHandler.verifyHmacSignature(raw, signature, secret, {
          algorithm,
          encoding,
        });
      }
      echoJson(io, { verified: true });
      return 0;
    }

    if (cmd === "sandbox" && sub === "provision") {
      validateCommandFlags("sandbox provision", flags);
      const subKey = resolveSecret(
        getOpt(
          flags,
          ["subscription-key", "k"],
          "JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY",
          env,
        ),
        getOpt(flags, ["subscription-key-file"]),
        "subscriptionKey",
        readStdin,
      );
      const callbackHost = getOpt(flags, ["callback-host", "c"]) ?? "example.com";
      const client = new JsMomoSDK(buildMtnConfig(flags, env));
      try {
        const prov = client.createSandboxProvisioner(subKey);
        const result = await prov.provision({ callbackHost });
        const outPath = getOpt(flags, ["output-file"]);
        if (outPath) {
          writeSecretFileStrict(
            outPath,
            `${JSON.stringify({ api_user: result.apiUser, api_key: result.apiKey }, null, 2)}\n`,
          );
          echoJson(io, {
            api_user: result.apiUser,
            api_key: "<written to file>",
            output_file: outPath,
          });
          return 0;
        }
        if (getBool(flags, ["redact-secret"])) {
          echoJson(io, { api_user: result.apiUser, api_key: "<redacted>" });
          return 0;
        }
        echoJson(io, { api_user: result.apiUser, api_key: result.apiKey });
        return 0;
      } finally {
        client.close();
      }
    }

    if (cmd === "sandbox" && sub === "get-user") {
      validateCommandFlags("sandbox get-user", flags);
      const userId = rest[0];
      if (!userId) throw new RangeError("userId argument is required");
      const subKey = resolveSecret(
        getOpt(
          flags,
          ["subscription-key", "k"],
          "JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY",
          env,
        ),
        getOpt(flags, ["subscription-key-file"]),
        "subscriptionKey",
        readStdin,
      );
      const client = new JsMomoSDK(buildMtnConfig(flags, env));
      try {
        const info = await client.createSandboxProvisioner(subKey).getApiUser(userId);
        echoJson(io, {
          providerCallbackHost: info.providerCallbackHost,
          targetEnvironment: info.targetEnvironment,
        });
        return 0;
      } finally {
        client.close();
      }
    }

    if (
      cmd === "collection" &&
      (sub === "balance" || sub === "request-to-pay" || sub === "status")
    ) {
      validateCommandFlags(`collection ${sub}`, flags);
      const cfg = buildMtnConfig(flags, env, {
        collection: buildProductConfig("COLLECTION", flags, env, readStdin),
      });
      const client = new JsMomoSDK(cfg);
      try {
        if (sub === "balance") {
          const curr = getOpt(flags, ["currency"]);
          const bal = curr
            ? await client.collection.getBalanceForCurrency(curr)
            : await client.collection.getBalance();
          echoJson(io, {
            availableBalance: bal.availableBalance,
            currency: bal.currency,
          });
          return 0;
        }
        if (sub === "request-to-pay") {
          const [msisdn, amount, currency, externalId] = rest;
          if (!msisdn || !amount || !currency || !externalId) {
            throw new RangeError(
              "Usage: collection request-to-pay <msisdn> <amount> <currency> <externalId>",
            );
          }
          const refId = await client.collection.requestToPay({
            amount,
            currency,
            payerMsisdn: msisdn,
            externalId,
            payerMessage: getOpt(flags, ["payer-message"]) ?? "",
            payeeNote: getOpt(flags, ["payee-note"]) ?? "",
            referenceId: getOpt(flags, ["reference-id"]),
            callbackUrl: getOpt(flags, ["callback-url"]),
          });
          echoJson(io, { reference_id: refId });
          return 0;
        }
        if (sub === "status") {
          const refId = rest[0];
          if (!refId) throw new RangeError("referenceId argument is required");
          const res = await client.collection.getPaymentStatus(refId);
          echoJson(io, res);
          return 0;
        }
      } finally {
        client.close();
      }
    }

    if (
      cmd === "disbursement" &&
      (sub === "balance" || sub === "transfer" || sub === "status")
    ) {
      validateCommandFlags(`disbursement ${sub}`, flags);
      const cfg = buildMtnConfig(flags, env, {
        disbursement: buildProductConfig("DISBURSEMENT", flags, env, readStdin),
      });
      const client = new JsMomoSDK(cfg);
      try {
        if (sub === "balance") {
          const curr = getOpt(flags, ["currency"]);
          const bal = curr
            ? await client.disbursement.getBalanceForCurrency(curr)
            : await client.disbursement.getBalance();
          echoJson(io, {
            availableBalance: bal.availableBalance,
            currency: bal.currency,
          });
          return 0;
        }
        if (sub === "transfer") {
          const [msisdn, amount, currency, externalId] = rest;
          if (!msisdn || !amount || !currency || !externalId) {
            throw new RangeError(
              "Usage: disbursement transfer <msisdn> <amount> <currency> <externalId>",
            );
          }
          const refId = await client.disbursement.transfer({
            amount,
            currency,
            payeeMsisdn: msisdn,
            externalId,
            payerMessage: getOpt(flags, ["payer-message"]) ?? "",
            payeeNote: getOpt(flags, ["payee-note"]) ?? "",
            referenceId: getOpt(flags, ["reference-id"]),
            callbackUrl: getOpt(flags, ["callback-url"]),
          });
          echoJson(io, { reference_id: refId });
          return 0;
        }
        if (sub === "status") {
          const refId = rest[0];
          if (!refId) throw new RangeError("referenceId argument is required");
          const res = await client.disbursement.getTransferStatus(refId);
          echoJson(io, res);
          return 0;
        }
      } finally {
        client.close();
      }
    }

    if (
      cmd === "remittance" &&
      (sub === "balance" || sub === "transfer" || sub === "status")
    ) {
      validateCommandFlags(`remittance ${sub}`, flags);
      const cfg = buildMtnConfig(flags, env, {
        remittance: buildProductConfig("REMITTANCE", flags, env, readStdin),
      });
      const client = new JsMomoSDK(cfg);
      try {
        if (sub === "balance") {
          const curr = getOpt(flags, ["currency"]);
          const bal = curr
            ? await client.remittance.getBalanceForCurrency(curr)
            : await client.remittance.getBalance();
          echoJson(io, {
            availableBalance: bal.availableBalance,
            currency: bal.currency,
          });
          return 0;
        }
        if (sub === "transfer") {
          const [msisdn, amount, currency, externalId] = rest;
          if (!msisdn || !amount || !currency || !externalId) {
            throw new RangeError(
              "Usage: remittance transfer <msisdn> <amount> <currency> <externalId>",
            );
          }
          const refId = await client.remittance.transfer({
            amount,
            currency,
            payeeMsisdn: msisdn,
            externalId,
            payerMessage: getOpt(flags, ["payer-message"]) ?? "",
            payeeNote: getOpt(flags, ["payee-note"]) ?? "",
            referenceId: getOpt(flags, ["reference-id"]),
            callbackUrl: getOpt(flags, ["callback-url"]),
          });
          echoJson(io, { reference_id: refId });
          return 0;
        }
        if (sub === "status") {
          const refId = rest[0];
          if (!refId) throw new RangeError("referenceId argument is required");
          const res = await client.remittance.getTransferStatus(refId);
          echoJson(io, res);
          return 0;
        }
      } finally {
        client.close();
      }
    }

    if (cmd === "airtel" && sub === "encrypt-pin") {
      validateCommandFlags("airtel encrypt-pin", flags);
      const keyFile = getOpt(flags, ["public-key-file"]);
      if (!keyFile) throw new RangeError("--public-key-file is required");
      const pin = resolveSecret(
        getOpt(flags, ["pin"]),
        getOpt(flags, ["pin-file"]),
        "pin",
        readStdin,
      );
      const pem = readFileSync(keyFile, "utf8");
      echoJson(io, { encrypted_pin: encryptAirtelPin(pin, pem) });
      return 0;
    }

    if (cmd === "airtel" && sub === "balance") {
      validateCommandFlags("airtel balance", flags);
      const clientId = getOpt(
        flags,
        ["client-id"],
        "JS_MOMO_SDK_AIRTEL_CLIENT_ID",
        env,
      );
      if (!clientId) throw new RangeError("--client-id is required");
      const clientSecret = resolveSecret(
        getOpt(flags, ["client-secret"], "JS_MOMO_SDK_AIRTEL_CLIENT_SECRET", env),
        getOpt(flags, ["client-secret-file"]),
        "clientSecret",
        readStdin,
      );
      const cfg = new AirtelConfig({
        clientId,
        clientSecret,
        country: getOpt(flags, ["country"], "JS_MOMO_SDK_AIRTEL_COUNTRY", env) ?? "UG",
        currency:
          getOpt(flags, ["currency"], "JS_MOMO_SDK_AIRTEL_CURRENCY", env) ?? "UGX",
        environment: (getOpt(
          flags,
          ["environment", "e"],
          "JS_MOMO_SDK_ENVIRONMENT",
          env,
        ) ?? "sandbox") as "sandbox" | "production",
        baseUrl: getOpt(flags, ["base-url"], "JS_MOMO_SDK_BASE_URL", env) ?? null,
      });
      const client = new AirtelClient(cfg);
      try {
        const bal = await client.disbursement.getBalance();
        echoJson(io, bal);
        return 0;
      } finally {
        client.close();
      }
    }

    if (cmd === "mock") {
      validateCommandFlags("mock", flags);
      const running = await startMockServer({
        host: getOpt(flags, ["host"]) ?? "127.0.0.1",
        port: getNum(flags, "port", 8090),
        defaultStatus: getOpt(flags, ["status"]) ?? "SUCCESSFUL",
        allowNonLoopback: getBool(flags, ["allow-non-loopback"]),
      });
      io.stdout(`JS MoMo SDK mock gateway listening on ${running.url}`);
      await new Promise<void>((resolve) => {
        const stop = () => {
          void running.close().finally(resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }

    io.stderr(
      `Error: Unknown command '${positionals.join(" ")}'. Run --help for usage.`,
    );
    return 1;
  } catch (err) {
    if (err instanceof JsMomoSDKError) {
      let msg = err.message || "An unexpected error occurred.";
      msg = msg.charAt(0).toUpperCase() + msg.slice(1);
      if (err.referenceId && !msg.includes(err.referenceId)) {
        msg = `${msg} (referenceId: ${err.referenceId})`;
      }
      io.stderr(`Error: ${msg}`);
      return 1;
    }
    if (err instanceof RangeError || err instanceof TypeError) {
      const msg = err.message || "Invalid input.";
      io.stderr(`Error: ${msg.charAt(0).toUpperCase() + msg.slice(1)}`);
      return 1;
    }
    const errName = err instanceof Error ? err.name : "Error";
    io.stderr(`Error: Unexpected error (${errName}).`);
    return 1;
  }
}

/* v8 ignore next 6 */
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/cli.js") ||
    process.argv[1].endsWith("\\cli.js") ||
    process.argv[1].endsWith("js-momo-sdk"));

if (isDirectRun) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
