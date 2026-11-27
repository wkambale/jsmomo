import type { TransactionResult } from "../models.js";
import {
  parseTransactionResultResponse,
  validateExternalId,
  validateNoteText,
} from "../models.js";
import {
  generateReferenceId,
  normaliseMsisdn,
  validateAmount,
  validateCurrency,
  validateHeaderValue,
  validateReferenceId,
} from "../utils.js";
import { BaseProduct } from "./base.js";

export interface DisbursementTransferParams {
  amount: string;
  currency: string;
  payeeMsisdn: string;
  externalId: string;
  payerMessage?: string;
  payeeNote?: string;
  referenceId?: string | null;
  callbackUrl?: string | null;
  partyIdType?: string;
}

export interface RefundParams {
  amount: string;
  currency: string;
  referenceIdToRefund: string;
  externalId: string;
  payerMessage?: string;
  payeeNote?: string;
  referenceId?: string | null;
  callbackUrl?: string | null;
}

/** MTN MoMo Disbursement product client. */
export class Disbursement extends BaseProduct {
  protected readonly productName = "disbursement";
  protected readonly tokenPath = "/disbursement/token/";

  private buildPayeePayload(
    params: DisbursementTransferParams,
  ): Record<string, unknown> {
    const validatedCurrency = validateCurrency(params.currency);
    const validatedAmount = validateAmount(params.amount, {
      currency: validatedCurrency,
    });
    const validatedExternalId = validateExternalId(params.externalId);
    const payerMessage = validateNoteText(params.payerMessage ?? "", "payerMessage");
    const payeeNote = validateNoteText(params.payeeNote ?? "", "payeeNote");
    const normPartyType = (params.partyIdType ?? "MSISDN").trim().toUpperCase();
    if (!normPartyType) {
      throw new RangeError("partyIdType must be a non-empty string");
    }
    validateHeaderValue(normPartyType, { fieldName: "partyIdType" });
    const partyId =
      normPartyType === "MSISDN"
        ? normaliseMsisdn(params.payeeMsisdn)
        : validateHeaderValue(params.payeeMsisdn.trim(), { fieldName: "payeeMsisdn" });
    if (!partyId) {
      throw new RangeError("partyId must be a non-empty string");
    }
    return {
      amount: validatedAmount,
      currency: validatedCurrency,
      externalId: validatedExternalId,
      payee: {
        partyIdType: normPartyType,
        partyId,
      },
      payerMessage,
      payeeNote,
    };
  }

  /** Transfer funds to a payee and return the UUID v4 reference ID. */
  public async transfer(params: DisbursementTransferParams): Promise<string> {
    if (params.referenceId !== undefined && params.referenceId !== null) {
      validateReferenceId(params.referenceId);
    }
    const ref = params.referenceId ?? generateReferenceId();
    const payload = this.buildPayeePayload(params);

    await this.http.request("POST", "/disbursement/v1_0/transfer", {
      headers: await this.buildHeaders({
        referenceId: ref,
        includeCallback: true,
        callbackUrl: params.callbackUrl,
        includeContentType: true,
      }),
      json: payload,
      productName: this.productName,
      tokenCache: this.tokenCache,
      tokenRefresher: this.getToken,
      tokenNamespace: this.tokenNamespace,
      idempotent: params.referenceId !== undefined && params.referenceId !== null,
      referenceId: ref,
    });
    return ref;
  }

  /** Poll the status of a transfer transaction. */
  public async getTransferStatus(referenceId: string): Promise<TransactionResult> {
    validateReferenceId(referenceId);
    const response = await this.http.request(
      "GET",
      `/disbursement/v1_0/transfer/${referenceId}`,
      {
        headers: await this.buildHeaders(),
        productName: this.productName,
        tokenCache: this.tokenCache,
        tokenRefresher: this.getToken,
        tokenNamespace: this.tokenNamespace,
        referenceId,
      },
    );
    return parseTransactionResultResponse(response, referenceId);
  }

  /** Initiate a Deposit (v2) and return the UUID v4 reference ID. */
  public async deposit(params: DisbursementTransferParams): Promise<string> {
    if (params.referenceId !== undefined && params.referenceId !== null) {
      validateReferenceId(params.referenceId);
    }
    const ref = params.referenceId ?? generateReferenceId();
    const payload = this.buildPayeePayload(params);

    await this.http.request("POST", "/disbursement/v2_0/deposit", {
      headers: await this.buildHeaders({
        referenceId: ref,
        includeCallback: true,
        callbackUrl: params.callbackUrl,
        includeContentType: true,
      }),
      json: payload,
      productName: this.productName,
      tokenCache: this.tokenCache,
      tokenRefresher: this.getToken,
      tokenNamespace: this.tokenNamespace,
      idempotent: params.referenceId !== undefined && params.referenceId !== null,
      referenceId: ref,
    });
    return ref;
  }

  /** Poll the status of a deposit transaction. */
  public async getDepositStatus(referenceId: string): Promise<TransactionResult> {
    validateReferenceId(referenceId);
    const response = await this.http.request(
      "GET",
      `/disbursement/v1_0/deposit/${referenceId}`,
      {
        headers: await this.buildHeaders(),
        productName: this.productName,
        tokenCache: this.tokenCache,
        tokenRefresher: this.getToken,
        tokenNamespace: this.tokenNamespace,
        referenceId,
      },
    );
    return parseTransactionResultResponse(response, referenceId);
  }

  /** Initiate a Refund (v2) and return the UUID v4 reference ID. */
  public async refund(params: RefundParams): Promise<string> {
    if (params.referenceId !== undefined && params.referenceId !== null) {
      validateReferenceId(params.referenceId);
    }
    validateReferenceId(params.referenceIdToRefund);
    const ref = params.referenceId ?? generateReferenceId();
    const validatedCurrency = validateCurrency(params.currency);
    const validatedAmount = validateAmount(params.amount, {
      currency: validatedCurrency,
    });
    const validatedExternalId = validateExternalId(params.externalId);
    const payerMessage = validateNoteText(params.payerMessage ?? "", "payerMessage");
    const payeeNote = validateNoteText(params.payeeNote ?? "", "payeeNote");

    await this.http.request("POST", "/disbursement/v2_0/refund", {
      headers: await this.buildHeaders({
        referenceId: ref,
        includeCallback: true,
        callbackUrl: params.callbackUrl,
        includeContentType: true,
      }),
      json: {
        amount: validatedAmount,
        currency: validatedCurrency,
        externalId: validatedExternalId,
        referenceIdToRefund: params.referenceIdToRefund,
        payerMessage,
        payeeNote,
      },
      productName: this.productName,
      tokenCache: this.tokenCache,
      tokenRefresher: this.getToken,
      tokenNamespace: this.tokenNamespace,
      idempotent: params.referenceId !== undefined && params.referenceId !== null,
      referenceId: ref,
    });
    return ref;
  }

  /** Poll the status of a refund transaction. */
  public async getRefundStatus(referenceId: string): Promise<TransactionResult> {
    validateReferenceId(referenceId);
    const response = await this.http.request(
      "GET",
      `/disbursement/v1_0/refund/${referenceId}`,
      {
        headers: await this.buildHeaders(),
        productName: this.productName,
        tokenCache: this.tokenCache,
        tokenRefresher: this.getToken,
        tokenNamespace: this.tokenNamespace,
        referenceId,
      },
    );
    return parseTransactionResultResponse(response, referenceId);
  }
}
