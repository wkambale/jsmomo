import {
  encodePathSegment,
  generateReferenceId,
  validateAirtelReferenceId,
  validateAmount,
} from "../../utils.js";
import type { AirtelClient } from "../client.js";
import type { AirtelTransactionResponse } from "../models.js";
import {
  checkAirtelResponseStatus,
  normaliseAirtelMsisdn,
  parseAirtelTransactionResponse,
} from "../models.js";

export interface AirtelRequestToPayParams {
  amount: string;
  payerMsisdn: string;
  referenceId?: string | null;
  externalId?: string | null;
}

/** Airtel Money Collection product client. */
export class AirtelCollection {
  private readonly client: AirtelClient;

  constructor(client: AirtelClient) {
    this.client = client;
  }

  /** Initiate an Airtel USSD Push collection and return the reference ID. */
  public async requestToPay(params: AirtelRequestToPayParams): Promise<string> {
    const ref = params.referenceId ?? generateReferenceId();
    validateAirtelReferenceId(ref);
    const validatedAmount = validateAmount(params.amount, {
      currency: this.client.config.currency,
    });
    const merchantRef = params.externalId ?? ref;

    const payload = {
      reference: merchantRef,
      subscriber: {
        country: this.client.config.country,
        currency: this.client.config.currency,
        msisdn: normaliseAirtelMsisdn(params.payerMsisdn, this.client.config.country),
      },
      transaction: {
        amount: validatedAmount,
        country: this.client.config.country,
        currency: this.client.config.currency,
        id: ref,
      },
    };

    const response = await this.client.request("POST", "/merchant/v1/payments/", {
      json: payload,
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

  /** Query the status of an Airtel collection payment. */
  public async getPaymentStatus(
    referenceId: string,
  ): Promise<AirtelTransactionResponse> {
    validateAirtelReferenceId(referenceId);
    const encoded = encodePathSegment(referenceId, "referenceId");
    const response = await this.client.request(
      "GET",
      `/standard/v1/payments/${encoded}`,
      { referenceId },
    );
    return parseAirtelTransactionResponse(response, referenceId);
  }

  /** Refund a completed Airtel collection payment by its `airtel_money_id`. */
  public async refund(airtelMoneyId: string): Promise<AirtelTransactionResponse> {
    validateAirtelReferenceId(airtelMoneyId);
    const response = await this.client.request("POST", "/standard/v1/payments/refund", {
      json: {
        transaction: {
          airtel_money_id: airtelMoneyId,
        },
      },
      referenceId: airtelMoneyId,
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
          referenceId: airtelMoneyId,
        });
      }
    }
    return parseAirtelTransactionResponse(response, airtelMoneyId);
  }
}
