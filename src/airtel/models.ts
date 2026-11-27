import {
  BadRequestError,
  JsMomoSDKError,
  TransactionFailedError,
} from "../exceptions.js";
import type { HttpResponse } from "../http.js";
import { parseJsonObject } from "../http.js";
import { normaliseMsisdn } from "../utils.js";

const AIRTEL_COUNTRY_CALLING_CODES: Record<string, string> = {
  CD: "243",
  CG: "242",
  GA: "241",
  GH: "233",
  KE: "254",
  MG: "261",
  MW: "265",
  NE: "227",
  NG: "234",
  RW: "250",
  SC: "248",
  TD: "235",
  TZ: "255",
  UG: "256",
  ZM: "260",
};

const AIRTEL_SUCCESS_STATUSES: ReadonlySet<string> = new Set([
  "TS",
  "SUCCESS",
  "SUCCESSFUL",
]);
const AIRTEL_PENDING_STATUSES: ReadonlySet<string> = new Set([
  "TIP",
  "PENDING",
  "INITIATED",
  "02",
  "AMBIGUOUS",
  "TA",
]);
const AIRTEL_TERMINAL_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  "TF",
  "FAILED",
  "FAIL",
  "REJECTED",
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
]);

/** Normalise an MSISDN to Airtel Africa's local subscriber format matching X-Country. */
export function normaliseAirtelMsisdn(msisdn: string, country: string): string {
  let digits = normaliseMsisdn(msisdn);
  const callingCode = AIRTEL_COUNTRY_CALLING_CODES[country.toUpperCase()];
  if (
    callingCode &&
    digits.startsWith(callingCode) &&
    digits.length - callingCode.length >= 7
  ) {
    digits = digits.slice(callingCode.length);
  }
  if (digits.startsWith("0") && digits.length > 7) {
    digits = digits.replace(/^0+/, "");
  }
  return digits;
}

/** Inspect an Airtel HTTP 200 JSON envelope and raise structured errors on business failures. */
export function checkAirtelResponseStatus(
  data: Record<string, unknown>,
  options: { referenceId?: string | null } = {},
): void {
  const referenceId = options.referenceId ?? null;
  const statusObj = data["status"];
  let statusSuccess: boolean | null = null;
  let statusCodeStr: string | null = null;
  let resultCodeStr: string | null = null;
  let statusMsg: string | null = null;

  if (statusObj && typeof statusObj === "object" && !Array.isArray(statusObj)) {
    const s = statusObj as Record<string, unknown>;
    if (typeof s["success"] === "boolean") statusSuccess = s["success"];
    if (typeof s["code"] === "string" && s["code"].trim())
      statusCodeStr = s["code"].trim();
    if (typeof s["result_code"] === "string" && s["result_code"].trim()) {
      resultCodeStr = s["result_code"].trim();
    }
    if (typeof s["message"] === "string" && s["message"].trim()) {
      statusMsg = s["message"].trim();
    }
  }

  let txStatus: string | null = null;
  let txMsg: string | null = null;
  const dataObj = data["data"];
  if (dataObj && typeof dataObj === "object" && !Array.isArray(dataObj)) {
    const txObj = (dataObj as Record<string, unknown>)["transaction"];
    if (txObj && typeof txObj === "object" && !Array.isArray(txObj)) {
      const tx = txObj as Record<string, unknown>;
      if (typeof tx["status"] === "string" && tx["status"].trim()) {
        txStatus = tx["status"].trim().toUpperCase();
      }
      if (typeof tx["message"] === "string" && tx["message"].trim()) {
        txMsg = tx["message"].trim();
      }
    }
  }

  const errorCode = resultCodeStr ?? statusCodeStr;
  const baseReason = txMsg ?? statusMsg;
  const reason =
    errorCode && baseReason && !baseReason.includes(errorCode)
      ? `${errorCode}: ${baseReason}`
      : (baseReason ?? errorCode ?? "Airtel transaction rejected");

  if (statusSuccess === false) {
    if (
      referenceId !== null &&
      txStatus !== null &&
      AIRTEL_TERMINAL_FAILURE_STATUSES.has(txStatus)
    ) {
      throw new TransactionFailedError(referenceId, reason, {
        statusCode: 200,
        errorCode,
        responseBody: data,
        provider: "Airtel Money",
      });
    }
    if (statusCodeStr === "400") {
      throw new BadRequestError(reason, data, {
        referenceId,
        statusCode: 200,
        errorCode,
        reason,
        provider: "Airtel Money",
      });
    }
    throw new JsMomoSDKError(reason, {
      referenceId,
      statusCode: 200,
      errorCode,
      reason,
      responseBody: data,
      provider: "Airtel Money",
    });
  }

  if (
    referenceId !== null &&
    txStatus !== null &&
    AIRTEL_TERMINAL_FAILURE_STATUSES.has(txStatus)
  ) {
    throw new TransactionFailedError(referenceId, reason, {
      statusCode: 200,
      errorCode,
      responseBody: data,
      provider: "Airtel Money",
    });
  }
}

export interface AirtelStatus {
  readonly code: string;
  readonly message: string;
  readonly resultCode: string | null;
  readonly success: boolean | null;
}

export interface AirtelTransactionDetails {
  readonly airtelMoneyId: string | null;
  readonly id: string | null;
  readonly status: string | null;
  readonly message: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly reference: string | null;
}

export interface AirtelWalletDetails {
  readonly msisdn: string;
  readonly balance: string;
  readonly currency: string;
  readonly status: string;
}

export interface AirtelBalanceResponse {
  readonly data: {
    readonly balance: string;
    readonly currency: string;
    readonly accountStatus: string;
    readonly wallet: AirtelWalletDetails;
  };
  readonly status: AirtelStatus | null;
}

function optStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function parseAirtelStatus(raw: unknown): AirtelStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const s = raw as Record<string, unknown>;
  if (typeof s["code"] !== "string" || typeof s["message"] !== "string") {
    return null;
  }
  return Object.freeze({
    code: s["code"],
    message: s["message"],
    resultCode: optStr(s["result_code"]),
    success: typeof s["success"] === "boolean" ? s["success"] : null,
  });
}

/** Parsed Airtel Money transaction inquiry response with authoritative state helpers. */
export class AirtelTransactionResponse {
  public readonly status: AirtelStatus;
  public readonly data: { readonly transaction: AirtelTransactionDetails };

  constructor(status: AirtelStatus, transaction: AirtelTransactionDetails) {
    this.status = status;
    this.data = Object.freeze({ transaction });
    Object.freeze(this);
  }

  private normalizedTxStatus(): string | null {
    const raw = this.data.transaction.status;
    if (!raw) return null;
    const stripped = raw.trim().toUpperCase();
    return stripped || null;
  }

  public get referenceId(): string | null {
    return this.data.transaction.id ?? this.data.transaction.reference ?? null;
  }

  public get reason(): string | null {
    const txMsg = this.data.transaction.message?.trim();
    if (txMsg) return txMsg;
    const statusMsg = this.status.message.trim();
    return statusMsg || null;
  }

  public isSuccessful(): boolean {
    if (this.status.success === false) return false;
    const txStatus = this.normalizedTxStatus();
    return txStatus !== null && AIRTEL_SUCCESS_STATUSES.has(txStatus);
  }

  public isPending(): boolean {
    if (this.status.success === false) return false;
    const txStatus = this.normalizedTxStatus();
    if (txStatus !== null) {
      return AIRTEL_PENDING_STATUSES.has(txStatus);
    }
    return (
      this.status.resultCode === "00" ||
      this.status.resultCode === "02" ||
      this.status.resultCode === "DP0000000000" ||
      this.status.resultCode === null
    );
  }

  public isFailed(): boolean {
    if (this.status.success === false) return true;
    const txStatus = this.normalizedTxStatus();
    if (txStatus !== null) {
      return (
        !AIRTEL_SUCCESS_STATUSES.has(txStatus) && !AIRTEL_PENDING_STATUSES.has(txStatus)
      );
    }
    return !(
      this.status.resultCode === "00" ||
      this.status.resultCode === "02" ||
      this.status.resultCode === "DP0000000000" ||
      this.status.resultCode === null
    );
  }
}

export function parseAirtelTransactionResponse(
  response: HttpResponse,
  referenceId?: string | null,
): AirtelTransactionResponse {
  const raw = parseJsonObject(response, referenceId);
  const status = parseAirtelStatus(raw["status"]);
  const dataObj = raw["data"];
  const txObj =
    dataObj && typeof dataObj === "object" && !Array.isArray(dataObj)
      ? (dataObj as Record<string, unknown>)["transaction"]
      : null;

  if (!status || !txObj || typeof txObj !== "object" || Array.isArray(txObj)) {
    throw new JsMomoSDKError(
      "API response did not match expected AirtelTransactionResponse schema",
      {
        referenceId: referenceId ?? null,
        statusCode: response.status,
        provider: "Airtel Money",
      },
    );
  }
  const tx = txObj as Record<string, unknown>;
  const details: AirtelTransactionDetails = Object.freeze({
    airtelMoneyId: optStr(tx["airtel_money_id"]),
    id: optStr(tx["id"]),
    status: optStr(tx["status"]),
    message: optStr(tx["message"]),
    amount:
      typeof tx["amount"] === "number" ? String(tx["amount"]) : optStr(tx["amount"]),
    currency: optStr(tx["currency"]),
    reference: optStr(tx["reference"]),
  });
  return new AirtelTransactionResponse(status, details);
}

export function parseAirtelBalanceResponse(
  response: HttpResponse,
  referenceId?: string | null,
): AirtelBalanceResponse {
  const raw = parseJsonObject(response, referenceId);
  const dataObj = raw["data"];
  if (!dataObj || typeof dataObj !== "object" || Array.isArray(dataObj)) {
    throw new JsMomoSDKError(
      "API response did not match expected AirtelBalanceResponse schema",
      {
        referenceId: referenceId ?? null,
        statusCode: response.status,
        provider: "Airtel Money",
      },
    );
  }
  const d = dataObj as Record<string, unknown>;
  const nestedWallet = d["wallet"];
  const source =
    nestedWallet && typeof nestedWallet === "object" && !Array.isArray(nestedWallet)
      ? (nestedWallet as Record<string, unknown>)
      : d;

  const balanceRaw = source["balance"] ?? d["balance"];
  const balance =
    typeof balanceRaw === "number" ? String(balanceRaw) : optStr(balanceRaw);
  const currency = optStr(source["currency"] ?? d["currency"]);
  const msisdn = optStr(source["msisdn"] ?? d["msisdn"] ?? d["account_number"]) ?? "";
  const walletStatus =
    optStr(
      source["status"] ??
        source["account_status"] ??
        d["account_status"] ??
        d["status"],
    ) ?? "ACTIVE";

  if (balance === null || currency === null) {
    throw new JsMomoSDKError(
      "API response did not match expected AirtelBalanceResponse schema",
      {
        referenceId: referenceId ?? null,
        statusCode: response.status,
        provider: "Airtel Money",
      },
    );
  }
  return Object.freeze({
    data: Object.freeze({
      balance,
      currency,
      accountStatus: walletStatus,
      wallet: Object.freeze({
        msisdn,
        balance,
        currency,
        status: walletStatus,
      }),
    }),
    status: parseAirtelStatus(raw["status"]),
  });
}
