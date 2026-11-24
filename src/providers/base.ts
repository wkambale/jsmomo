import type {
  BalanceResult,
  DisbursementRequest,
  OperationKind,
  PaymentRequest,
  PaymentResult,
  ProviderCapabilities,
} from "./models.js";

export interface ProviderStatusOptions {
  kind?: OperationKind;
  orderId?: string;
  amount?: string;
  currency?: string;
}

export interface ProviderBalanceOptions {
  kind?: OperationKind;
  currency?: string;
}

/** Unified interface implemented by all JS MoMo SDK payment rail adapters. */
export interface PaymentProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  collect(request: PaymentRequest): Promise<PaymentResult>;
  disburse(request: DisbursementRequest): Promise<PaymentResult>;
  getStatus(
    referenceId: string,
    options?: ProviderStatusOptions,
  ): Promise<PaymentResult>;
  getBalance(options?: ProviderBalanceOptions): Promise<BalanceResult>;
  close?(): void | Promise<void>;
}

export function isPaymentProvider(value: unknown): value is PaymentProvider {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["name"] === "string" &&
    obj["name"].length > 0 &&
    obj["capabilities"] !== null &&
    typeof obj["capabilities"] === "object" &&
    typeof obj["collect"] === "function" &&
    typeof obj["disburse"] === "function" &&
    typeof obj["getStatus"] === "function" &&
    typeof obj["getBalance"] === "function"
  );
}
