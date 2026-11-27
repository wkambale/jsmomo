import type { AirtelClient } from "../airtel/client.js";
import type { AirtelTransactionResponse } from "../airtel/models.js";
import type {
  PaymentProvider,
  ProviderBalanceOptions,
  ProviderStatusOptions,
} from "./base.js";
import type { BalanceResult, DisbursementRequest, PaymentRequest } from "./models.js";
import {
  NormalizedStatus,
  PaymentResult,
  ProviderCapabilities,
  validateOperationKind,
} from "./models.js";

const AIRTEL_CAPABILITIES = new ProviderCapabilities({
  providerId: "airtel_money",
  supportsCollection: true,
  supportsDisbursement: true,
  supportsBalance: true,
  supportsWebhookHmac: true,
  currencies: ["UGX", "KES", "TZS", "RWF", "ZMW", "MWK", "NGN", "XAF", "XOF"],
});

function checkAirtelCurrency(
  requestCurrency: string,
  configuredCurrency: string,
): string {
  const expected = configuredCurrency.toUpperCase();
  const actual = requestCurrency.toUpperCase();
  if (actual !== expected) {
    throw new RangeError(
      `Request currency '${actual}' does not match configured Airtel currency '${expected}'`,
    );
  }
  return expected;
}

function mapAirtelResult(
  referenceId: string,
  result: AirtelTransactionResponse,
): PaymentResult {
  const status = result.isSuccessful()
    ? NormalizedStatus.SUCCEEDED
    : result.isFailed()
      ? NormalizedStatus.FAILED
      : NormalizedStatus.PENDING;
  const tx = result.data.transaction;
  return new PaymentResult({
    provider: "airtel_money",
    referenceId,
    status,
    amount: tx.amount,
    currency: tx.currency,
    providerTransactionId: tx.airtelMoneyId ?? tx.id,
    externalId: tx.reference,
    reason: tx.message ?? result.status.message,
    raw: {
      status: result.status,
      transaction: tx,
    },
  });
}

/** Unified provider adapter for Airtel Money. */
export class AirtelMoneyProvider implements PaymentProvider {
  public readonly name = "airtel_money";
  public readonly capabilities = AIRTEL_CAPABILITIES;
  private readonly client: AirtelClient;

  constructor(client: AirtelClient) {
    this.client = client;
  }

  public async collect(request: PaymentRequest): Promise<PaymentResult> {
    const currency = checkAirtelCurrency(request.currency, this.client.config.currency);
    const ref = await this.client.collection.requestToPay({
      amount: request.amount,
      payerMsisdn: request.payerMsisdn,
      referenceId: request.referenceId ?? undefined,
      externalId: request.externalId || undefined,
    });
    return new PaymentResult({
      provider: this.name,
      referenceId: ref,
      status: NormalizedStatus.PENDING,
      amount: request.amount,
      currency,
      externalId: request.externalId || null,
    });
  }

  public async disburse(request: DisbursementRequest): Promise<PaymentResult> {
    const currency = checkAirtelCurrency(request.currency, this.client.config.currency);
    const ref = await this.client.disbursement.transfer({
      amount: request.amount,
      payeeMsisdn: request.payeeMsisdn,
      referenceId: request.referenceId ?? undefined,
      externalId: request.externalId || undefined,
    });
    return new PaymentResult({
      provider: this.name,
      referenceId: ref,
      status: NormalizedStatus.PENDING,
      amount: request.amount,
      currency,
      externalId: request.externalId || null,
    });
  }

  public async getStatus(
    referenceId: string,
    options: ProviderStatusOptions = {},
  ): Promise<PaymentResult> {
    const kind = validateOperationKind(options.kind ?? "collection");
    const result =
      kind === "disbursement"
        ? await this.client.disbursement.getTransferStatus(referenceId)
        : await this.client.collection.getPaymentStatus(referenceId);
    return mapAirtelResult(referenceId, result);
  }

  public async getBalance(
    options: ProviderBalanceOptions = {},
  ): Promise<BalanceResult> {
    validateOperationKind(options.kind ?? "collection");
    if (options.currency !== undefined) {
      checkAirtelCurrency(options.currency, this.client.config.currency);
    }
    const balance = await this.client.disbursement.getBalance();
    const wallet = balance.data.wallet;
    return {
      provider: this.name,
      availableBalance: wallet.balance,
      currency: wallet.currency,
      raw: { wallet, status: balance.status },
    };
  }

  public close(): void {
    this.client.close();
  }
}
