import {
  validateAmount,
  validateCallbackUrl,
  validateCurrency,
  validateEmailAddress,
  validateHeaderValue,
} from "../utils.js";

export type OperationKind = "collection" | "disbursement";

/** Validate that a status or balance operation kind is supported. */
export function validateOperationKind(kind: string): OperationKind {
  if (kind !== "collection" && kind !== "disbursement") {
    throw new RangeError("kind must be 'collection' or 'disbursement'");
  }
  return kind;
}

/** Canonical transaction status across all payment providers. */
export enum NormalizedStatus {
  INITIATED = "INITIATED",
  PENDING = "PENDING",
  SUCCEEDED = "SUCCEEDED",
  FAILED = "FAILED",
  EXPIRED = "EXPIRED",
  REVERSED = "REVERSED",
}

export interface ProviderCapabilitiesInit {
  providerId: string;
  supportsCollection?: boolean;
  supportsDisbursement?: boolean;
  supportsBalance?: boolean;
  supportsWebhookHmac?: boolean;
  currencies?: readonly string[];
}

/** Declarative capability metadata for a payment provider adapter. */
export class ProviderCapabilities {
  public readonly providerId: string;
  public readonly supportsCollection: boolean;
  public readonly supportsDisbursement: boolean;
  public readonly supportsBalance: boolean;
  public readonly supportsWebhookHmac: boolean;
  public readonly currencies: readonly string[];

  constructor(init: ProviderCapabilitiesInit) {
    this.providerId = init.providerId;
    this.supportsCollection = init.supportsCollection ?? true;
    this.supportsDisbursement = init.supportsDisbursement ?? true;
    this.supportsBalance = init.supportsBalance ?? true;
    this.supportsWebhookHmac = init.supportsWebhookHmac ?? false;
    const normalized: string[] = [];
    for (const item of init.currencies ?? []) {
      if (typeof item !== "string" || !item.trim()) {
        throw new RangeError("Currency codes in capabilities must be non-empty");
      }
      normalized.push(item.trim().toUpperCase());
    }
    this.currencies = Object.freeze(normalized);
    Object.freeze(this);
  }
}

export interface PaymentRequestInit {
  amount: string;
  currency: string;
  payerMsisdn: string;
  payerEmail?: string | null;
  externalId?: string;
  payerMessage?: string;
  payeeNote?: string;
  referenceId?: string | null;
  callbackUrl?: string | null;
}

/** Normalized collection payment request. */
export class PaymentRequest {
  public readonly amount: string;
  public readonly currency: string;
  public readonly payerMsisdn: string;
  public readonly payerEmail: string | null;
  public readonly externalId: string;
  public readonly payerMessage: string;
  public readonly payeeNote: string;
  public readonly referenceId: string | null;
  public readonly callbackUrl: string | null;

  constructor(init: PaymentRequestInit) {
    this.amount = validateAmount(init.amount);
    this.currency = validateCurrency(init.currency);
    if (typeof init.payerMsisdn !== "string" || !init.payerMsisdn.trim()) {
      throw new RangeError("payerMsisdn must not be blank");
    }
    this.payerMsisdn = validateHeaderValue(init.payerMsisdn.trim(), {
      fieldName: "payerMsisdn",
    });
    this.payerEmail =
      init.payerEmail !== undefined && init.payerEmail !== null
        ? validateEmailAddress(init.payerEmail)
        : null;
    this.externalId = init.externalId ?? "";
    this.payerMessage = init.payerMessage ?? "";
    this.payeeNote = init.payeeNote ?? "";
    this.referenceId = init.referenceId ?? null;
    this.callbackUrl =
      init.callbackUrl !== undefined && init.callbackUrl !== null
        ? validateCallbackUrl(init.callbackUrl)
        : null;
    Object.freeze(this);
  }

  public withReferenceId(referenceId: string): PaymentRequest {
    return new PaymentRequest({
      amount: this.amount,
      currency: this.currency,
      payerMsisdn: this.payerMsisdn,
      payerEmail: this.payerEmail,
      externalId: this.externalId,
      payerMessage: this.payerMessage,
      payeeNote: this.payeeNote,
      referenceId,
      callbackUrl: this.callbackUrl,
    });
  }
}

export interface DisbursementRequestInit {
  amount: string;
  currency: string;
  payeeMsisdn: string;
  payeeBankCode?: string | null;
  externalId?: string;
  payerMessage?: string;
  payeeNote?: string;
  referenceId?: string | null;
  callbackUrl?: string | null;
}

/** Normalized disbursement payout request. */
export class DisbursementRequest {
  public readonly amount: string;
  public readonly currency: string;
  public readonly payeeMsisdn: string;
  public readonly payeeBankCode: string | null;
  public readonly externalId: string;
  public readonly payerMessage: string;
  public readonly payeeNote: string;
  public readonly referenceId: string | null;
  public readonly callbackUrl: string | null;

  constructor(init: DisbursementRequestInit) {
    this.amount = validateAmount(init.amount);
    this.currency = validateCurrency(init.currency);
    if (typeof init.payeeMsisdn !== "string" || !init.payeeMsisdn.trim()) {
      throw new RangeError("payeeMsisdn must not be blank");
    }
    this.payeeMsisdn = validateHeaderValue(init.payeeMsisdn.trim(), {
      fieldName: "payeeMsisdn",
    });
    if (init.payeeBankCode !== undefined && init.payeeBankCode !== null) {
      if (typeof init.payeeBankCode !== "string" || !init.payeeBankCode.trim()) {
        throw new RangeError("payeeBankCode must not be blank");
      }
      this.payeeBankCode = validateHeaderValue(init.payeeBankCode.trim(), {
        fieldName: "payeeBankCode",
      });
    } else {
      this.payeeBankCode = null;
    }
    this.externalId = init.externalId ?? "";
    this.payerMessage = init.payerMessage ?? "";
    this.payeeNote = init.payeeNote ?? "";
    this.referenceId = init.referenceId ?? null;
    this.callbackUrl =
      init.callbackUrl !== undefined && init.callbackUrl !== null
        ? validateCallbackUrl(init.callbackUrl)
        : null;
    Object.freeze(this);
  }

  public withReferenceId(referenceId: string): DisbursementRequest {
    return new DisbursementRequest({
      amount: this.amount,
      currency: this.currency,
      payeeMsisdn: this.payeeMsisdn,
      payeeBankCode: this.payeeBankCode,
      externalId: this.externalId,
      payerMessage: this.payerMessage,
      payeeNote: this.payeeNote,
      referenceId,
      callbackUrl: this.callbackUrl,
    });
  }
}

export interface PaymentResultInit {
  provider: string;
  referenceId: string;
  status: NormalizedStatus;
  amount?: string | null;
  currency?: string | null;
  providerTransactionId?: string | null;
  externalId?: string | null;
  checkoutUrl?: string | null;
  reason?: string | null;
  raw?: Record<string, unknown>;
}

/** Normalized response for collections, disbursements, and status queries. */
export class PaymentResult {
  public readonly provider: string;
  public readonly referenceId: string;
  public readonly status: NormalizedStatus;
  public readonly amount: string | null;
  public readonly currency: string | null;
  public readonly providerTransactionId: string | null;
  public readonly externalId: string | null;
  public readonly checkoutUrl: string | null;
  public readonly reason: string | null;
  public readonly raw: Record<string, unknown>;

  constructor(init: PaymentResultInit) {
    this.provider = init.provider;
    this.referenceId = init.referenceId;
    this.status = init.status;
    this.amount = init.amount ?? null;
    this.currency = init.currency ?? null;
    this.providerTransactionId = init.providerTransactionId ?? null;
    this.externalId = init.externalId ?? null;
    this.checkoutUrl = init.checkoutUrl ?? null;
    this.reason = init.reason ?? null;
    this.raw = init.raw ? { ...init.raw } : {};
  }

  public isSuccessful(): boolean {
    return this.status === NormalizedStatus.SUCCEEDED;
  }

  public isPending(): boolean {
    return (
      this.status === NormalizedStatus.INITIATED ||
      this.status === NormalizedStatus.PENDING
    );
  }

  public isFailed(): boolean {
    return (
      this.status === NormalizedStatus.FAILED ||
      this.status === NormalizedStatus.EXPIRED
    );
  }
}

export interface BalanceResult {
  readonly provider: string;
  readonly availableBalance: string;
  readonly currency: string;
  readonly raw: Record<string, unknown>;
}
