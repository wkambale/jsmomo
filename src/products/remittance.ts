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
  validateCountryCode,
  validateCurrency,
  validateHeaderValue,
  validateReferenceId,
} from "../utils.js";
import { BaseProduct } from "./base.js";
import type { DisbursementTransferParams } from "./disbursement.js";

export interface CashTransferParams extends DisbursementTransferParams {
  originatingCountry: string;
  originalAmount?: string;
  originalCurrency?: string;
}

/** MTN MoMo Remittance product client. */
export class Remittance extends BaseProduct {
  protected readonly productName = "remittance";
  protected readonly tokenPath = "/remittance/token/";

  /** Transfer remittance funds to a payee and return the UUID v4 reference ID. */
  public async transfer(params: DisbursementTransferParams): Promise<string> {
    if (params.referenceId !== undefined && params.referenceId !== null) {
      validateReferenceId(params.referenceId);
    }
    const ref = params.referenceId ?? generateReferenceId();
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

    await this.http.request("POST", "/remittance/v1_0/transfer", {
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
        payee: {
          partyIdType: normPartyType,
          partyId,
        },
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

  /** Poll the status of a remittance transfer transaction. */
  public async getTransferStatus(referenceId: string): Promise<TransactionResult> {
    validateReferenceId(referenceId);
    const response = await this.http.request(
      "GET",
      `/remittance/v1_0/transfer/${referenceId}`,
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

  /**
   * Initiate a cross-border Remittance v2 Cash Transfer (`POST /remittance/v2_0/cashtransfer`)
   * and return the UUID v4 reference ID.
   */
  public async cashTransfer(params: CashTransferParams): Promise<string> {
    if (params.referenceId !== undefined && params.referenceId !== null) {
      validateReferenceId(params.referenceId);
    }
    const ref = params.referenceId ?? generateReferenceId();
    const validatedCurrency = validateCurrency(params.currency);
    const validatedAmount = validateAmount(params.amount, {
      currency: validatedCurrency,
    });
    const originatingCountry = validateCountryCode(params.originatingCountry);
    const originalCurrency =
      params.originalCurrency !== undefined
        ? validateCurrency(params.originalCurrency)
        : validatedCurrency;
    const originalAmount =
      params.originalAmount !== undefined
        ? validateAmount(params.originalAmount, { currency: originalCurrency })
        : validatedAmount;
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

    await this.http.request("POST", "/remittance/v2_0/cashtransfer", {
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
        payee: {
          partyIdType: normPartyType,
          partyId,
        },
        payerMessage,
        payeeNote,
        orginatingCountry: originatingCountry,
        originalAmount,
        originalCurrency,
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

  /** Poll the status of a Remittance v2 Cash Transfer (`GET /remittance/v2_0/cashtransfer/{referenceId}`). */
  public async getCashTransferStatus(referenceId: string): Promise<TransactionResult> {
    validateReferenceId(referenceId);
    const response = await this.http.request(
      "GET",
      `/remittance/v2_0/cashtransfer/${referenceId}`,
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
