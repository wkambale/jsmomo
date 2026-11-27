import type { JsMomoSDK } from "../client.js";
import type { TransactionResult } from "../models.js";
import { TransactionStatus } from "../models.js";
import { generateReferenceId } from "../utils.js";
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

const MTN_STATUS_MAP: Record<TransactionStatus, NormalizedStatus> = {
  [TransactionStatus.PENDING]: NormalizedStatus.PENDING,
  [TransactionStatus.SUCCESSFUL]: NormalizedStatus.SUCCEEDED,
  [TransactionStatus.FAILED]: NormalizedStatus.FAILED,
};

const MTN_CAPABILITIES = new ProviderCapabilities({
  providerId: "mtn_momo",
  supportsCollection: true,
  supportsDisbursement: true,
  supportsBalance: true,
  supportsWebhookHmac: false,
  currencies: [
    "UGX",
    "GHS",
    "ZMW",
    "XAF",
    "XOF",
    "EUR",
    "ZAR",
    "SZL",
    "LRD",
    "GNF",
    "RWF",
    "NGN",
  ],
});

function mapMtnResult(referenceId: string, result: TransactionResult): PaymentResult {
  return new PaymentResult({
    provider: "mtn_momo",
    referenceId,
    status: MTN_STATUS_MAP[result.status],
    amount: result.amount,
    currency: result.currency,
    providerTransactionId: result.financialTransactionId,
    externalId: result.externalId,
    reason: result.reason,
    raw: {
      financialTransactionId: result.financialTransactionId,
      externalId: result.externalId,
      amount: result.amount,
      currency: result.currency,
      status: result.status,
      reason: result.reason,
    },
  });
}

/** Unified provider adapter for MTN Mobile Money. */
export class MtnMomoProvider implements PaymentProvider {
  public readonly name = "mtn_momo";
  public readonly capabilities = MTN_CAPABILITIES;
  private readonly client: JsMomoSDK;

  constructor(client: JsMomoSDK) {
    this.client = client;
  }

  public async collect(request: PaymentRequest): Promise<PaymentResult> {
    const plannedRef = request.referenceId ?? generateReferenceId();
    const extId = request.externalId || plannedRef;
    const ref = await this.client.collection.requestToPay({
      amount: request.amount,
      currency: request.currency,
      payerMsisdn: request.payerMsisdn,
      externalId: extId,
      payerMessage: request.payerMessage,
      payeeNote: request.payeeNote,
      referenceId: plannedRef,
      callbackUrl: request.callbackUrl ?? undefined,
    });
    return new PaymentResult({
      provider: this.name,
      referenceId: ref,
      status: NormalizedStatus.PENDING,
      amount: request.amount,
      currency: request.currency,
      externalId: extId,
    });
  }

  public async disburse(request: DisbursementRequest): Promise<PaymentResult> {
    const plannedRef = request.referenceId ?? generateReferenceId();
    const extId = request.externalId || plannedRef;
    const ref = await this.client.disbursement.transfer({
      amount: request.amount,
      currency: request.currency,
      payeeMsisdn: request.payeeMsisdn,
      externalId: extId,
      payerMessage: request.payerMessage,
      payeeNote: request.payeeNote,
      referenceId: plannedRef,
      callbackUrl: request.callbackUrl ?? undefined,
    });
    return new PaymentResult({
      provider: this.name,
      referenceId: ref,
      status: NormalizedStatus.PENDING,
      amount: request.amount,
      currency: request.currency,
      externalId: extId,
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
    return mapMtnResult(referenceId, result);
  }

  public async getBalance(
    options: ProviderBalanceOptions = {},
  ): Promise<BalanceResult> {
    const kind = validateOperationKind(options.kind ?? "collection");
    const product =
      kind === "disbursement" ? this.client.disbursement : this.client.collection;
    const balance =
      options.currency !== undefined
        ? await product.getBalanceForCurrency(options.currency)
        : await product.getBalance();
    return {
      provider: this.name,
      availableBalance: balance.availableBalance,
      currency: balance.currency,
      raw: {
        availableBalance: balance.availableBalance,
        currency: balance.currency,
      },
    };
  }

  public close(): void {
    this.client.close();
  }
}
