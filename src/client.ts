import { TokenCache } from "./auth.js";
import type { JsMomoSDKConfigOptions } from "./config.js";
import { JsMomoSDKConfig, SANDBOX } from "./config.js";
import { MissingCredentialsError } from "./exceptions.js";
import type { FetchLike } from "./http.js";
import { DEFAULT_MAX_RESPONSE_BYTES, HttpClient } from "./http.js";
import { Collection } from "./products/collection.js";
import { Disbursement } from "./products/disbursement.js";
import { Remittance } from "./products/remittance.js";
import { SandboxProvisioner } from "./sandbox.js";

export interface JsMomoSDKOptions {
  fetch?: FetchLike;
  maxResponseBytes?: number;
  sleepFn?: (seconds: number) => Promise<void>;
}

/** Top-level MTN MoMo Open API client. */
export class JsMomoSDK {
  private readonly config: JsMomoSDKConfig;
  private readonly tokenCache: TokenCache;
  private readonly http: HttpClient;
  private _collection: Collection | null = null;
  private _disbursement: Disbursement | null = null;
  private _remittance: Remittance | null = null;

  constructor(
    config: JsMomoSDKConfig | JsMomoSDKConfigOptions = {},
    options: JsMomoSDKOptions = {},
  ) {
    this.config =
      config instanceof JsMomoSDKConfig ? config : new JsMomoSDKConfig(config);
    this.tokenCache = new TokenCache();
    this.http = new HttpClient({
      baseUrl: this.config.baseUrl,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      retryBackoff: this.config.retryBackoff,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      fetch: options.fetch,
      telemetry: this.config.telemetry,
      providerName: "MTN MoMo",
      allowLocalhost: this.config.environment === SANDBOX,
      sleepFn: options.sleepFn,
    });
  }

  /** Lazily instantiated MTN Collection product client. */
  public get collection(): Collection {
    if (!this.config.collection) {
      throw new MissingCredentialsError(
        "Collection credentials not provided in JsMomoSDKConfig",
      );
    }
    if (!this._collection) {
      this._collection = new Collection(
        this.config,
        this.config.collection,
        this.http,
        this.tokenCache,
      );
    }
    return this._collection;
  }

  /** Lazily instantiated MTN Disbursement product client. */
  public get disbursement(): Disbursement {
    if (!this.config.disbursement) {
      throw new MissingCredentialsError(
        "Disbursement credentials not provided in JsMomoSDKConfig",
      );
    }
    if (!this._disbursement) {
      this._disbursement = new Disbursement(
        this.config,
        this.config.disbursement,
        this.http,
        this.tokenCache,
      );
    }
    return this._disbursement;
  }

  /** Lazily instantiated MTN Remittance product client. */
  public get remittance(): Remittance {
    if (!this.config.remittance) {
      throw new MissingCredentialsError(
        "Remittance credentials not provided in JsMomoSDKConfig",
      );
    }
    if (!this._remittance) {
      this._remittance = new Remittance(
        this.config,
        this.config.remittance,
        this.http,
        this.tokenCache,
      );
    }
    return this._remittance;
  }

  /** Get a SandboxProvisioner using the first configured product subscription key. */
  public get sandbox(): SandboxProvisioner {
    return new SandboxProvisioner({
      config: this.config,
      http: this.http,
    });
  }

  /** Create a SandboxProvisioner with an explicit sandbox subscription key. */
  public createSandboxProvisioner(subscriptionKey: string): SandboxProvisioner {
    return new SandboxProvisioner({
      subscriptionKey,
      config: this.config,
      http: this.http,
    });
  }

  public close(): void {
    this.http.close();
  }
}
