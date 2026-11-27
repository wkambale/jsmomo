import {
  encodePathSegment,
  generateReferenceId,
  validateAirtelReferenceId,
  validateAmount,
} from "../../utils.js";
import type { AirtelClient } from "../client.js";
import type { AirtelBalanceResponse, AirtelTransactionResponse } from "../models.js";
import {
  checkAirtelResponseStatus,
  normaliseAirtelMsisdn,
  parseAirtelBalanceResponse,
  parseAirtelTransactionResponse,
} from "../models.js";

export interface AirtelTransferParams {
  amount: string;
  payeeMsisdn: string;
  referenceId?: string | null;
  externalId?: string | null;
  transactionType?: string | null;
  walletType?: string | null;
}

/** Airtel Money Disbursement product client. */
export class AirtelDisbursement {
  private readonly client: AirtelClient;

  constructor(client: AirtelClient) {
    this.client = client;
  }

  /** Initiate an Airtel disbursement payout and return the reference ID. */
  public async transfer(params: AirtelTransferParams): Promise<string> {
    if (!this.client.config.pin) {
      throw new RangeError("pin is required for Airtel disbursements");
    }
    const ref = params.referenceId ?? generateReferenceId();
    validateAirtelReferenceId(ref);
    const validatedAmount = validateAmount(params.amount, {
      currency: this.client.config.currency,
    });
    const merchantRef = params.externalId ?? ref;

    const payee: Record<string, unknown> = {
      msisdn: normaliseAirtelMsisdn(params.payeeMsisdn, this.client.config.country),
    };
    if (params.walletType !== undefined && params.walletType !== null) {
      payee["wallet_type"] = params.walletType;
    }

    const transaction: Record<string, unknown> = {
      amount: validatedAmount,
      country: this.client.config.country,
      currency: this.client.config.currency,
      id: ref,
    };
    if (params.transactionType !== undefined && params.transactionType !== null) {
      transaction["type"] = params.transactionType;
    }

    const response = await this.client.request("POST", "/standard/v1/disbursements/", {
      json: {
        payee,
        reference: merchantRef,
        pin: this.client.config.pin,
        transaction,
      },
      referenceId: ref,
    });
    if (response.body.byteLength > 0) {
      let parsed: unknown;
      try {
        parsed = response.json();
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        checkAirtelResponseStatus(parsed as Record<string, unknown>, {
          referenceId: ref,
        });
      }
    }
    return ref;
  }

  /** Query the status of an Airtel disbursement transaction. */
  public async getTransferStatus(
    referenceId: string,
  ): Promise<AirtelTransactionResponse> {
    validateAirtelReferenceId(referenceId);
    const encoded = encodePathSegment(referenceId, "referenceId");
    const response = await this.client.request(
      "GET",
      `/standard/v1/disbursements/${encoded}`,
      { referenceId },
    );
    return parseAirtelTransactionResponse(response, referenceId);
  }

  /** Query the Airtel merchant wallet balance via Airtel's standard balance endpoint. */
  public async getBalance(): Promise<AirtelBalanceResponse> {
    const response = await this.client.request("GET", "/standard/v1/users/balance");
    if (response.body.byteLength > 0) {
      let parsed: unknown;
      try {
        parsed = response.json();
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        checkAirtelResponseStatus(parsed as Record<string, unknown>);
      }
    }
    return parseAirtelBalanceResponse(response);
  }
}
