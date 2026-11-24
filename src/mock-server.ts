import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { validateTimeout } from "./utils.js";

const VALID_MOCK_STATUSES = new Set(["PENDING", "SUCCESSFUL", "FAILED"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const TOKEN_PATHS = new Set([
  "/collection/token/",
  "/disbursement/token/",
  "/remittance/token/",
  "/collection/v1_0/oauth2/token/",
  "/auth/oauth2/token",
  "/oauth/v3/token",
]);
const MTN_WRITE_PATHS = new Set([
  "/collection/v1_0/requesttopay",
  "/collection/v2_0/requesttowithdraw",
  "/disbursement/v1_0/transfer",
  "/disbursement/v2_0/deposit",
  "/disbursement/v2_0/refund",
  "/remittance/v1_0/transfer",
]);
const MTN_STATUS_PREFIXES = [
  "/collection/v1_0/requesttopay/",
  "/collection/v2_0/requesttowithdraw/",
  "/disbursement/v1_0/transfer/",
  "/disbursement/v2_0/deposit/",
  "/disbursement/v2_0/refund/",
  "/remittance/v1_0/transfer/",
] as const;
const BALANCE_PATHS = new Set([
  "/collection/v1_0/account/balance",
  "/disbursement/v1_0/account/balance",
  "/remittance/v1_0/account/balance",
]);
const BALANCE_CURRENCY_PREFIXES = [
  "/collection/v1_0/account/balance/",
  "/disbursement/v1_0/account/balance/",
  "/remittance/v1_0/account/balance/",
] as const;

export const DEFAULT_MAX_MOCK_BODY_BYTES = 1_048_576;
export const DEFAULT_MAX_MOCK_ENTRIES = 10_000;
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 64;

function extractSingleSuffix(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const suffix = path.slice(prefix.length);
  if (!suffix || suffix.includes("/")) return null;
  try {
    return decodeURIComponent(suffix);
  } catch {
    return suffix;
  }
}

/** Bounded in-memory state store for the local mobile money mock gateway server. */
export class MockGatewayState {
  public defaultStatus: "PENDING" | "SUCCESSFUL" | "FAILED";
  public readonly maxEntries: number;
  public readonly transactions = new Map<string, Record<string, unknown>>();
  public readonly airtelTransactions = new Map<string, Record<string, unknown>>();
  public readonly waveSessions = new Map<string, Record<string, unknown>>();
  public readonly wavePayouts = new Map<string, Record<string, unknown>>();
  public readonly sandboxUsers = new Map<string, Record<string, unknown>>();
  public readonly mpesaTransactions = new Map<string, Record<string, unknown>>();
  public readonly paystackTransactions = new Map<string, Record<string, unknown>>();
  public readonly flutterwaveTransactions = new Map<string, Record<string, unknown>>();
  public readonly orangeTransactions = new Map<string, Record<string, unknown>>();
  private sessionCounter = 0;

  constructor(options: { defaultStatus?: string; maxEntries?: number } = {}) {
    const norm = (options.defaultStatus ?? "SUCCESSFUL").trim().toUpperCase();
    if (!VALID_MOCK_STATUSES.has(norm)) {
      throw new RangeError(
        "defaultStatus must be one of 'PENDING', 'SUCCESSFUL', or 'FAILED'",
      );
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_MOCK_ENTRIES;
    if (
      typeof maxEntries !== "number" ||
      !Number.isInteger(maxEntries) ||
      maxEntries <= 0
    ) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    this.defaultStatus = norm as "PENDING" | "SUCCESSFUL" | "FAILED";
    this.maxEntries = maxEntries;
  }

  public nextId(): number {
    this.sessionCounter += 1;
    return this.sessionCounter;
  }

  public putBounded(
    store: Map<string, Record<string, unknown>>,
    key: string,
    value: Record<string, unknown>,
  ): void {
    if (!store.has(key) && store.size >= this.maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, value);
  }
}

export interface MockServerOptions {
  host?: string;
  port?: number;
  defaultStatus?: "PENDING" | "SUCCESSFUL" | "FAILED" | string;
  maxBodyBytes?: number;
  maxEntries?: number;
  requestTimeout?: number;
  maxConcurrentRequests?: number;
  allowNonLoopback?: boolean;
}

export interface RunningMockServer {
  readonly server: Server;
  readonly state: MockGatewayState;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": String(body.byteLength),
  });
  res.end(body);
}

class MockHttpError extends Error {
  public readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function readRequestBody(
  req: IncomingMessage,
  maxBodyBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  const clHeader = req.headers["content-length"];
  if (Array.isArray(clHeader)) {
    throw new MockHttpError(400, "Duplicate Content-Length header");
  }
  if (typeof clHeader === "string" && clHeader.trim()) {
    const trimmed = clHeader.trim();
    if (!/^\d{1,20}$/.test(trimmed)) {
      throw new MockHttpError(400, "Invalid Content-Length");
    }
    if (Number(trimmed) > maxBodyBytes) {
      throw new MockHttpError(413, "Payload too large");
    }
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const deadline = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new MockHttpError(408, "Request timeout"));
        req.destroy();
      }
    }, timeoutMs);
    if (typeof deadline === "object" && "unref" in deadline) {
      deadline.unref();
    }
    const finish = (cb: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        cb();
      }
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > maxBodyBytes) {
        finish(() => {
          reject(new MockHttpError(413, "Payload too large"));
          req.resume();
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      finish(() => resolve(Buffer.concat(chunks, total)));
    });
    req.on("error", (err) => {
      finish(() => reject(err));
    });
  });
}

async function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes: number,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const raw = await readRequestBody(req, maxBodyBytes, timeoutMs);
  if (raw.byteLength === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new MockHttpError(400, "Invalid JSON payload");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MockHttpError(400, "JSON payload must be an object");
  }
  return parsed as Record<string, unknown>;
}

function headerStr(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v) && typeof v[0] === "string") return v[0].trim();
  return "";
}

/** Create a local HTTP mock gateway server for all 7 supported payment rails. */
export function createMockServer(options: MockServerOptions = {}): {
  server: Server;
  state: MockGatewayState;
  host: string;
  port: number;
} {
  const host = (options.host ?? "127.0.0.1").trim();
  if (!host) throw new RangeError("host must be a non-empty string");
  const port = options.port ?? 0;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_MOCK_BODY_BYTES;
  if (
    typeof maxBodyBytes !== "number" ||
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes <= 0
  ) {
    throw new RangeError("maxBodyBytes must be a positive integer");
  }
  const maxConcurrentRequests =
    options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  if (
    typeof maxConcurrentRequests !== "number" ||
    !Number.isInteger(maxConcurrentRequests) ||
    maxConcurrentRequests <= 0
  ) {
    throw new RangeError("maxConcurrentRequests must be a positive integer");
  }
  const timeoutSec = validateTimeout(options.requestTimeout ?? 10.0);
  const timeoutMs = Math.max(1, Math.ceil(timeoutSec * 1000));
  if (!LOOPBACK_HOSTS.has(host.toLowerCase()) && !options.allowNonLoopback) {
    throw new RangeError(
      "Refusing to bind unauthenticated mock server to non-loopback host without allowNonLoopback: true",
    );
  }

  const state = new MockGatewayState({
    defaultStatus: options.defaultStatus ?? "SUCCESSFUL",
    maxEntries: options.maxEntries ?? DEFAULT_MAX_MOCK_ENTRIES,
  });

  const airtelCode = () =>
    state.defaultStatus === "SUCCESSFUL"
      ? "TS"
      : state.defaultStatus === "FAILED"
        ? "TF"
        : "TIP";
  const waveStatus = () =>
    state.defaultStatus === "SUCCESSFUL"
      ? "succeeded"
      : state.defaultStatus === "FAILED"
        ? "failed"
        : "processing";

  let inFlight = 0;

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const path = parsedUrl.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "POST") {
      if (TOKEN_PATHS.has(path)) {
        await readRequestBody(req, maxBodyBytes, timeoutMs);
        sendJson(res, 200, {
          access_token: "mock-access-token",
          token_type: "access_token",
          expires_in: 3600,
        });
        return;
      }

      if (path === "/v1_0/apiuser") {
        const body = await readJsonBody(req, maxBodyBytes, timeoutMs);
        const ref = headerStr(req, "X-Reference-Id") || "mock-user";
        if (state.sandboxUsers.has(ref)) {
          sendJson(res, 409, { message: "Duplicate X-Reference-Id" });
          return;
        }
        state.putBounded(state.sandboxUsers, ref, {
          providerCallbackHost: body["providerCallbackHost"] ?? "example.com",
          targetEnvironment: "sandbox",
        });
        sendJson(res, 201, { reference_id: ref });
        return;
      }

      if (path.startsWith("/v1_0/apiuser/") && path.endsWith("/apikey")) {
        await readRequestBody(req, maxBodyBytes, timeoutMs);
        const uid = decodeURIComponent(
          path.slice("/v1_0/apiuser/".length, -"/apikey".length),
        );
        if (!state.sandboxUsers.has(uid)) {
          sendJson(res, 404, { message: "Not found" });
          return;
        }
        sendJson(res, 201, { apiKey: `mock-api-key-${uid}` });
        return;
      }

      if (MTN_WRITE_PATHS.has(path)) {
        const body = await readJsonBody(req, maxBodyBytes, timeoutMs);
        const ref = headerStr(req, "X-Reference-Id") || "mock-ref";
        if (state.transactions.has(ref)) {
          sendJson(res, 409, { message: "Duplicate X-Reference-Id" });
          return;
        }
        state.putBounded(state.transactions, ref, {
          financialTransactionId: "mock-fin-001",
          externalId: body["externalId"] ?? "ext-mock",
          amount: body["amount"] ?? "100",
          currency: body["currency"] ?? "UGX",
          status: state.defaultStatus,
        });
        sendJson(res, 202, { reference_id: ref });
        return;
      }

      if (path === "/collection/v1_0/bc-authorize") {
        await readRequestBody(req, maxBodyBytes, timeoutMs);
        sendJson(res, 200, {
          auth_req_id: "mock-auth-req-id",
          interval: 5,
          expires_in: 300,
        });
        return;
      }

      if (path === "/merchant/v1/payments/" || path === "/standard/v1/disbursements/") {
        const body = await readJsonBody(req, maxBodyBytes, timeoutMs);
        const rawTx = body["transaction"];
        const tx =
          rawTx && typeof rawTx === "object" && !Array.isArray(rawTx)
            ? (rawTx as Record<string, unknown>)
            : {};
        const ref = String(tx["id"] ?? body["reference"] ?? "mock-airtel-ref");
        state.putBounded(state.airtelTransactions, ref, {
          status: { code: "200", message: "Accepted", result_code: "DP008" },
          data: {
            transaction: {
              id: ref,
              status: airtelCode(),
              amount: String(tx["amount"] ?? "100"),
              currency: String(tx["currency"] ?? "UGX"),
            },
          },
        });
        sendJson(res, 200, {
          status: { code: "200", message: "Accepted", result_code: "DP008" },
        });
        return;
      }

      if (path === "/v1/checkout/sessions") {
        const body = await readJsonBody(req, maxBodyBytes, timeoutMs);
        const sid = `cos-${state.nextId()}`;
        const session = {
          id: sid,
          amount: String(body["amount"] ?? "100"),
          currency: String(body["currency"] ?? "XOF"),
          checkout_status: "open",
          payment_status: waveStatus(),
          wave_launch_url: `https://pay.wave.com/c/${sid}`,
          client_reference: body["client_reference"] ?? null,
        };
        state.putBounded(state.waveSessions, sid, session);
        sendJson(res, 200, session);
        return;
      }

      if (path === "/v1/payout") {
        const body = await readJsonBody(req, maxBodyBytes, timeoutMs);
        const pid = `pt-${state.nextId()}`;
        const payout = {
          id: pid,
          receive_amount: String(body["receive_amount"] ?? body["amount"] ?? "100"),
          currency: String(body["currency"] ?? "XOF"),
          status: waveStatus(),
          client_reference: body["client_reference"] ?? null,
        };
        state.putBounded(state.wavePayouts, pid, payout);
        sendJson(res, 200, payout);
        return;
      }

      if (path === "/mpesa/stkpush/v1/processrequest") {
        await readJsonBody(req, maxBodyBytes, timeoutMs);
        const cid = `ws_CO_mock_${state.nextId()}`;
        state.putBounded(state.mpesaTransactions, cid, {
          CheckoutRequestID: cid,
          ResultCode:
            state.defaultStatus === "SUCCESSFUL"
              ? "0"
              : state.defaultStatus === "FAILED"
                ? "1032"
                : "",
          ResultDesc: `Mock status ${state.defaultStatus}`,
        });
        sendJson(res, 200, {
          MerchantRequestID: `mr_${cid}`,
          CheckoutRequestID: cid,
          ResponseCode: "0",
          ResponseDescription: "Success. Request accepted",
        });
        return;
      }

      if (path === "/mpesa/stkpushquery/v1/query") {
        const body = await readJsonBody(req, maxBodyBytes, timeoutMs);
        const cid = String(body["CheckoutRequestID"] ?? "");
        const tx = state.mpesaTransactions.get(cid);
        if (!tx) {
          sendJson(res, 404, { message: "Not found" });
          return;
        }
        sendJson(res, 200, tx);
        return;
      }

      if (path === "/mpesa/b2c/v3/paymentrequest") {
        const body = await readJsonBody(req, maxBodyBytes, timeoutMs);
        const ocid = String(body["OriginatorConversationID"] ?? "mock-oc-1");
        sendJson(res, 200, {
          ConversationID: `AG_mock_${ocid}`,
          OriginatorConversationID: ocid,
          ResponseCode: "0",
          ResponseDescription: "Accept the service request successfully.",
        });
        return;
      }

      if (path === "/transaction/initialize" || path === "/transfer") {
        const body = await readJsonBody(req, maxBodyBytes, timeoutMs);
        const ref = String(body["reference"] ?? "ps-mock-ref");
        const psStatus =
          state.defaultStatus === "SUCCESSFUL"
            ? "success"
            : state.defaultStatus === "FAILED"
              ? "failed"
              : "pending";
        const entry = {
          status: true,
          data: {
            reference: ref,
            status: psStatus,
            amount: body["amount"] ?? 10000,
            currency: body["currency"] ?? "NGN",
            authorization_url: `https://checkout.paystack.com/${ref}`,
          },
        };
        state.putBounded(state.paystackTransactions, ref, entry);
        sendJson(res, 200, entry);
        return;
      }

      if (path === "/v3/payments" || path === "/v3/transfers") {
        const body = await readJsonBody(req, maxBodyBytes, timeoutMs);
        const ref = String(body["tx_ref"] ?? body["reference"] ?? "flw-mock-ref");
        const flwStatus =
          state.defaultStatus === "SUCCESSFUL"
            ? "successful"
            : state.defaultStatus === "FAILED"
              ? "failed"
              : "pending";
        const entry = {
          status: "success",
          data: {
            id: ref,
            reference: ref,
            status: flwStatus,
            amount: body["amount"] ?? "100",
            currency: body["currency"] ?? "NGN",
            link: `https://checkout.flutterwave.com/${ref}`,
          },
        };
        state.putBounded(state.flutterwaveTransactions, ref, entry);
        sendJson(res, 200, entry);
        return;
      }

      if (path.startsWith("/orange-money-webpay/") && path.endsWith("/webpayment")) {
        const body = await readJsonBody(req, maxBodyBytes, timeoutMs);
        const pt = `om-pay-${state.nextId()}`;
        const omStatus =
          state.defaultStatus === "SUCCESSFUL"
            ? "SUCCESS"
            : state.defaultStatus === "FAILED"
              ? "FAILED"
              : "PENDING";
        state.putBounded(state.orangeTransactions, pt, {
          status: omStatus,
          order_id: body["order_id"],
        });
        sendJson(res, 201, {
          pay_token: pt,
          payment_url: `https://webpay.orange.com/${pt}`,
        });
        return;
      }

      if (
        path.startsWith("/orange-money-webpay/") &&
        path.endsWith("/transactionstatus")
      ) {
        const body = await readJsonBody(req, maxBodyBytes, timeoutMs);
        const pt = String(body["pay_token"] ?? "");
        const tx = state.orangeTransactions.get(pt);
        if (!tx) {
          sendJson(res, 404, { message: "Not found" });
          return;
        }
        sendJson(res, 200, tx);
        return;
      }

      sendJson(res, 404, { message: "Not found" });
      return;
    }

    if (method === "GET") {
      if (path === "/oauth/v1/generate") {
        sendJson(res, 200, {
          access_token: "mock-mpesa-token",
          expires_in: "3599",
        });
        return;
      }

      if (BALANCE_PATHS.has(path)) {
        sendJson(res, 200, { availableBalance: "10000.00", currency: "EUR" });
        return;
      }
      for (const p of BALANCE_CURRENCY_PREFIXES) {
        const curr = extractSingleSuffix(path, p);
        if (curr !== null) {
          sendJson(res, 200, {
            availableBalance: "10000.00",
            currency: curr.toUpperCase(),
          });
          return;
        }
      }

      if (path.includes("/accountholder/") && path.endsWith("/active")) {
        sendJson(res, 200, { result: true });
        return;
      }
      if (path.includes("/accountholder/") && path.endsWith("/basicuserinfo")) {
        sendJson(res, 200, { given_name: "Mock", family_name: "User" });
        return;
      }

      const sandboxUid = extractSingleSuffix(path, "/v1_0/apiuser/");
      if (sandboxUid !== null) {
        const user = state.sandboxUsers.get(sandboxUid);
        if (!user) {
          sendJson(res, 404, { message: "Not found" });
          return;
        }
        sendJson(res, 200, user);
        return;
      }

      for (const p of MTN_STATUS_PREFIXES) {
        const ref = extractSingleSuffix(path, p);
        if (ref !== null) {
          const tx = state.transactions.get(ref);
          if (!tx) {
            sendJson(res, 404, { message: "Not found" });
            return;
          }
          sendJson(res, 200, tx);
          return;
        }
      }

      if (
        path === "/merchant/v2/wallets/balance/" ||
        path === "/standard/v1/users/balance"
      ) {
        sendJson(res, 200, {
          status: { code: "200", message: "OK", result_code: "00" },
          data: {
            balance: "5000.00",
            currency: "UGX",
            wallet: {
              msisdn: "256750000000",
              balance: "5000.00",
              currency: "UGX",
              status: "ACTIVE",
            },
          },
        });
        return;
      }
      for (const p of ["/standard/v1/payments/", "/standard/v1/disbursements/"]) {
        const ref = extractSingleSuffix(path, p);
        if (ref !== null) {
          const tx = state.airtelTransactions.get(ref);
          if (!tx) {
            sendJson(res, 404, { message: "Not found" });
            return;
          }
          sendJson(res, 200, tx);
          return;
        }
      }

      if (path === "/v1/balance") {
        sendJson(res, 200, { amount: "25000", currency: "XOF" });
        return;
      }
      const waveSid = extractSingleSuffix(path, "/v1/checkout/sessions/");
      if (waveSid !== null) {
        const s = state.waveSessions.get(waveSid);
        if (!s) {
          sendJson(res, 404, { message: "Not found" });
          return;
        }
        sendJson(res, 200, s);
        return;
      }
      const wavePid = extractSingleSuffix(path, "/v1/payout/");
      if (wavePid !== null) {
        const p = state.wavePayouts.get(wavePid);
        if (!p) {
          sendJson(res, 404, { message: "Not found" });
          return;
        }
        sendJson(res, 200, p);
        return;
      }

      if (path === "/balance") {
        sendJson(res, 200, {
          status: true,
          data: [{ balance: 100000, currency: "NGN" }],
        });
        return;
      }
      for (const p of ["/transaction/verify/", "/transfer/verify/"]) {
        const ref = extractSingleSuffix(path, p);
        if (ref !== null) {
          const tx = state.paystackTransactions.get(ref);
          if (!tx) {
            sendJson(res, 404, { message: "Not found" });
            return;
          }
          sendJson(res, 200, tx);
          return;
        }
      }

      if (path === "/v3/transactions/verify_by_reference") {
        const txRef = parsedUrl.searchParams.get("tx_ref") ?? "";
        const tx = state.flutterwaveTransactions.get(txRef);
        if (!tx) {
          sendJson(res, 404, { message: "Not found" });
          return;
        }
        sendJson(res, 200, tx);
        return;
      }
      const flwTr = extractSingleSuffix(path, "/v3/transfers/");
      if (flwTr !== null) {
        const tx = state.flutterwaveTransactions.get(flwTr);
        if (!tx) {
          sendJson(res, 404, { message: "Not found" });
          return;
        }
        sendJson(res, 200, tx);
        return;
      }
      const flwCurr = extractSingleSuffix(path, "/v3/balances/");
      if (flwCurr !== null) {
        sendJson(res, 200, {
          status: "success",
          data: { available_balance: 10000, currency: flwCurr.toUpperCase() },
        });
        return;
      }

      sendJson(res, 404, { message: "Not found" });
      return;
    }

    sendJson(res, 405, { message: "Method not allowed" });
  };

  const server = createServer((req, res) => {
    if (inFlight >= maxConcurrentRequests) {
      sendJson(res, 503, { message: "Server overloaded" });
      return;
    }
    inFlight += 1;
    res.setTimeout(timeoutMs);
    void handleRequest(req, res)
      .catch((err: unknown) => {
        if (res.headersSent) return;
        if (err instanceof MockHttpError) {
          sendJson(res, err.statusCode, { message: err.message });
        } else {
          sendJson(res, 500, { message: "Internal mock server error" });
        }
      })
      .finally(() => {
        inFlight -= 1;
      });
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = timeoutMs;

  return { server, state, host, port };
}

/** Start the local mock gateway server and return its bound URL, state, and async closer. */
export async function startMockServer(
  options: MockServerOptions = {},
): Promise<RunningMockServer> {
  const { server, state, host, port } = createMockServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const displayHost = addr.address.includes(":") ? `[${addr.address}]` : addr.address;
  return {
    server,
    state,
    host: addr.address,
    port: addr.port,
    url: `http://${displayHost}:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
