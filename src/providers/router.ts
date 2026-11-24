import type { AttemptedReference } from "../exceptions.js";
import {
  AuthenticationError,
  JsMomoSDKError,
  JsMomoSDKServerError,
  MissingCredentialsError,
} from "../exceptions.js";
import { detectCarrierFromMsisdn, generateReferenceId } from "../utils.js";
import type {
  PaymentProvider,
  ProviderBalanceOptions,
  ProviderStatusOptions,
} from "./base.js";
import { isPaymentProvider } from "./base.js";
import type {
  BalanceResult,
  DisbursementRequest,
  OperationKind,
  PaymentRequest,
  PaymentResult,
} from "./models.js";
import { validateOperationKind } from "./models.js";

function supportsOperationAndCurrency(
  provider: PaymentProvider,
  operation: OperationKind,
  currency: string,
): boolean {
  const caps = provider.capabilities;
  if (operation === "collection" && !caps.supportsCollection) {
    return false;
  }
  if (operation === "disbursement" && !caps.supportsDisbursement) {
    return false;
  }
  const normCurrency = currency.toUpperCase();
  return caps.currencies.length === 0 || caps.currencies.includes(normCurrency);
}

function ensureStatusSupported(
  provider: PaymentProvider,
  providerName: string,
  kind: OperationKind,
): void {
  validateOperationKind(kind);
  const caps = provider.capabilities;
  if (kind === "collection" && !caps.supportsCollection) {
    throw new JsMomoSDKError(
      `Provider '${providerName}' does not support collection status queries`,
    );
  }
  if (kind === "disbursement" && !caps.supportsDisbursement) {
    throw new JsMomoSDKError(
      `Provider '${providerName}' does not support disbursement status queries`,
    );
  }
}

function ensureBalanceSupported(
  provider: PaymentProvider,
  providerName: string,
  kind: OperationKind,
): void {
  validateOperationKind(kind);
  if (!provider.capabilities.supportsBalance) {
    throw new JsMomoSDKError(
      `Provider '${providerName}' does not support balance queries`,
    );
  }
}

function isFailoverError(
  err: unknown,
  allowAmbiguousWriteFallback: boolean,
): err is JsMomoSDKError {
  if (err instanceof AuthenticationError || err instanceof MissingCredentialsError) {
    return true;
  }
  if (allowAmbiguousWriteFallback && err instanceof JsMomoSDKServerError) {
    return true;
  }
  return false;
}

export interface PaymentRouterOptions {
  providers?: readonly PaymentProvider[];
  defaultProvider?: string | null;
  customCarrierPrefixes?: Record<string, readonly [string, string]>;
}

export interface RouteWriteOptions {
  provider?: string;
  fallback?: boolean;
  allowAmbiguousWriteFallback?: boolean;
}

export interface RouterStatusOptions extends ProviderStatusOptions {
  provider: string;
}

export interface RouterBalanceOptions extends ProviderBalanceOptions {
  provider: string;
}

/** Unified router for normalized collections, disbursements, status, and balance across rails. */
export class PaymentRouter {
  private readonly providers = new Map<string, PaymentProvider>();
  private readonly order: string[] = [];
  private defaultProvider: string | null;
  private readonly customCarrierPrefixes?: Record<string, readonly [string, string]>;

  constructor(options: PaymentRouterOptions = {}) {
    this.defaultProvider = options.defaultProvider ?? null;
    this.customCarrierPrefixes = options.customCarrierPrefixes
      ? { ...options.customCarrierPrefixes }
      : undefined;
    for (const provider of options.providers ?? []) {
      this.register(provider);
    }
    if (this.defaultProvider !== null && !this.providers.has(this.defaultProvider)) {
      throw new JsMomoSDKError(
        `Default provider is not registered: ${this.defaultProvider}`,
      );
    }
  }

  public register(provider: PaymentProvider): void {
    if (!isPaymentProvider(provider)) {
      throw new TypeError("PaymentRouter requires a valid PaymentProvider adapter");
    }
    const isNew = !this.providers.has(provider.name);
    this.providers.set(provider.name, provider);
    if (isNew) {
      this.order.push(provider.name);
    }
    if (this.defaultProvider === null) {
      this.defaultProvider = provider.name;
    }
  }

  public get(name: string): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new JsMomoSDKError(`Provider is not registered: ${name}`);
    }
    return provider;
  }

  public listProviders(): string[] {
    return [...this.order];
  }

  private resolveCandidates(params: {
    provider?: string;
    msisdn?: string;
    operation: OperationKind;
    currency: string;
    fallback: boolean;
  }): PaymentProvider[] {
    const candidates: PaymentProvider[] = [];
    if (params.provider !== undefined) {
      const explicit = this.providers.get(params.provider);
      if (!explicit) {
        throw new JsMomoSDKError(`Provider is not registered: ${params.provider}`);
      }
      if (!supportsOperationAndCurrency(explicit, params.operation, params.currency)) {
        throw new JsMomoSDKError(
          `Provider '${params.provider}' does not support ${params.operation} for currency '${params.currency}'`,
        );
      }
      candidates.push(explicit);
    } else {
      if (this.defaultProvider !== null && !this.providers.has(this.defaultProvider)) {
        throw new JsMomoSDKError(
          `Default provider is not registered: ${this.defaultProvider}`,
        );
      }
      const inferred = params.msisdn
        ? detectCarrierFromMsisdn(params.msisdn, {
            customPrefixes: this.customCarrierPrefixes,
          })
        : null;
      if (inferred) {
        const cand = this.providers.get(inferred.provider);
        if (
          cand &&
          supportsOperationAndCurrency(cand, params.operation, params.currency)
        ) {
          candidates.push(cand);
        }
      }
      if (candidates.length === 0 && this.defaultProvider !== null) {
        const defCand = this.providers.get(this.defaultProvider);
        if (
          defCand &&
          supportsOperationAndCurrency(defCand, params.operation, params.currency)
        ) {
          candidates.push(defCand);
        }
      }
    }

    if (params.fallback) {
      const seen = new Set(candidates.map((c) => c.name));
      for (const name of this.order) {
        if (seen.has(name)) continue;
        const cand = this.providers.get(name);
        if (
          cand &&
          supportsOperationAndCurrency(cand, params.operation, params.currency)
        ) {
          candidates.push(cand);
          seen.add(name);
        }
      }
    }

    if (candidates.length === 0) {
      throw new JsMomoSDKError("No matching payment provider is registered");
    }
    return candidates;
  }

  public async collect(
    request: PaymentRequest,
    options: RouteWriteOptions = {},
  ): Promise<PaymentResult> {
    const fallback = options.fallback ?? false;
    const allowAmbiguousWriteFallback = options.allowAmbiguousWriteFallback ?? false;
    const candidates = this.resolveCandidates({
      provider: options.provider,
      msisdn: request.payerMsisdn,
      operation: "collection",
      currency: request.currency,
      fallback,
    });
    let effectiveRequest = request;
    if (
      fallback &&
      allowAmbiguousWriteFallback &&
      candidates.length > 1 &&
      effectiveRequest.referenceId === null
    ) {
      effectiveRequest = effectiveRequest.withReferenceId(generateReferenceId());
    }

    const attemptedRefs: AttemptedReference[] = [];
    for (let idx = 0; idx < candidates.length; idx += 1) {
      const candidate = candidates[idx]!;
      try {
        const result = await candidate.collect(effectiveRequest);
        if (attemptedRefs.length > 0 && !("priorFailedAttempts" in result.raw)) {
          result.raw["priorFailedAttempts"] = [...attemptedRefs];
        }
        return result;
      } catch (err) {
        if (isFailoverError(err, allowAmbiguousWriteFallback)) {
          const attemptRef = err.referenceId ?? effectiveRequest.referenceId;
          attemptedRefs.push({
            provider: candidate.name,
            referenceId: attemptRef,
          });
          if (idx + 1 >= candidates.length) {
            if (err.referenceId === null && attemptRef !== null) {
              err.referenceId = attemptRef;
            }
            err.attemptedReferences = [...attemptedRefs];
            throw err;
          }
          continue;
        }
        if (err instanceof JsMomoSDKError) {
          const attemptRef = err.referenceId ?? effectiveRequest.referenceId;
          if (err.referenceId === null && attemptRef !== null) {
            err.referenceId = attemptRef;
          }
          if (attemptedRefs.length > 0) {
            attemptedRefs.push({
              provider: candidate.name,
              referenceId: attemptRef,
            });
            err.attemptedReferences = [...attemptedRefs];
          }
        }
        throw err;
      }
    }
    throw new JsMomoSDKError("All payment providers failed");
  }

  public async disburse(
    request: DisbursementRequest,
    options: RouteWriteOptions = {},
  ): Promise<PaymentResult> {
    const fallback = options.fallback ?? false;
    const allowAmbiguousWriteFallback = options.allowAmbiguousWriteFallback ?? false;
    const candidates = this.resolveCandidates({
      provider: options.provider,
      msisdn: request.payeeMsisdn,
      operation: "disbursement",
      currency: request.currency,
      fallback,
    });
    let effectiveRequest = request;
    if (
      fallback &&
      allowAmbiguousWriteFallback &&
      candidates.length > 1 &&
      effectiveRequest.referenceId === null
    ) {
      effectiveRequest = effectiveRequest.withReferenceId(generateReferenceId());
    }

    const attemptedRefs: AttemptedReference[] = [];
    for (let idx = 0; idx < candidates.length; idx += 1) {
      const candidate = candidates[idx]!;
      try {
        const result = await candidate.disburse(effectiveRequest);
        if (attemptedRefs.length > 0 && !("priorFailedAttempts" in result.raw)) {
          result.raw["priorFailedAttempts"] = [...attemptedRefs];
        }
        return result;
      } catch (err) {
        if (isFailoverError(err, allowAmbiguousWriteFallback)) {
          const attemptRef = err.referenceId ?? effectiveRequest.referenceId;
          attemptedRefs.push({
            provider: candidate.name,
            referenceId: attemptRef,
          });
          if (idx + 1 >= candidates.length) {
            if (err.referenceId === null && attemptRef !== null) {
              err.referenceId = attemptRef;
            }
            err.attemptedReferences = [...attemptedRefs];
            throw err;
          }
          continue;
        }
        if (err instanceof JsMomoSDKError) {
          const attemptRef = err.referenceId ?? effectiveRequest.referenceId;
          if (err.referenceId === null && attemptRef !== null) {
            err.referenceId = attemptRef;
          }
          if (attemptedRefs.length > 0) {
            attemptedRefs.push({
              provider: candidate.name,
              referenceId: attemptRef,
            });
            err.attemptedReferences = [...attemptedRefs];
          }
        }
        throw err;
      }
    }
    throw new JsMomoSDKError("All payment providers failed");
  }

  public async getStatus(
    referenceId: string,
    options: RouterStatusOptions,
  ): Promise<PaymentResult> {
    const kind = validateOperationKind(options.kind ?? "collection");
    const target = this.get(options.provider);
    ensureStatusSupported(target, options.provider, kind);
    return target.getStatus(referenceId, {
      kind,
      orderId: options.orderId,
      amount: options.amount,
      currency: options.currency,
    });
  }

  public async getBalance(options: RouterBalanceOptions): Promise<BalanceResult> {
    const kind = validateOperationKind(options.kind ?? "collection");
    const target = this.get(options.provider);
    ensureBalanceSupported(target, options.provider, kind);
    return target.getBalance({ kind, currency: options.currency });
  }

  public async close(): Promise<void> {
    for (const prov of this.providers.values()) {
      if (typeof prov.close === "function") {
        await prov.close();
      }
    }
  }
}
