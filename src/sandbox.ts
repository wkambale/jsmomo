import { inspect } from "node:util";

import type { JsMomoSDKConfig } from "./config.js";
import { PRODUCTION_BASE_URL, SANDBOX } from "./config.js";
import { JsMomoSDKError, MissingCredentialsError } from "./exceptions.js";
import type { HttpClient } from "./http.js";
import type { ApiUserInfo } from "./models.js";
import {
  ProvisionResult,
  parseApiKeyResponse,
  parseApiUserInfoResponse,
} from "./models.js";
import {
  generateReferenceId,
  validateCallbackHost,
  validateHeaderValue,
  validateReferenceId,
} from "./utils.js";

const PRODUCTION_HOST = new URL(PRODUCTION_BASE_URL).hostname.toLowerCase();

export interface SandboxProvisionerOptions {
  subscriptionKey?: string;
  config?: JsMomoSDKConfig;
  http: HttpClient;
}

/** Provisions MTN MoMo sandbox API users and API keys. */
export class SandboxProvisioner {
  private readonly http: HttpClient;
  private readonly config: JsMomoSDKConfig | null;
  private readonly subscriptionKey: string;

  constructor(options: SandboxProvisionerOptions) {
    this.http = options.http;
    this.config = options.config ?? null;
    if (this.config && this.config.environment !== SANDBOX) {
      throw new JsMomoSDKError(
        "SandboxProvisioner can only be used with the sandbox environment",
      );
    }
    const baseHost = new URL(this.http.validatedBaseUrl).hostname.toLowerCase();
    if (baseHost === PRODUCTION_HOST) {
      throw new JsMomoSDKError(
        "SandboxProvisioner can only be used with the sandbox environment",
      );
    }

    const subKey =
      options.subscriptionKey ??
      this.config?.collection?.subscriptionKey ??
      this.config?.disbursement?.subscriptionKey ??
      this.config?.remittance?.subscriptionKey ??
      "";
    if (!subKey || !subKey.trim()) {
      throw new MissingCredentialsError(
        "Subscription key is required for sandbox provisioning",
      );
    }
    validateHeaderValue(subKey, { fieldName: "subscriptionKey" });
    this.subscriptionKey = subKey;
  }

  /** Create a sandbox API user and return the UUID v4 `apiUser`. */
  public async createApiUser(
    options: { apiUser?: string; callbackHost?: string } = {},
  ): Promise<string> {
    const callbackHost = options.callbackHost ?? "example.com";
    validateCallbackHost(callbackHost);
    if (options.apiUser !== undefined) {
      validateReferenceId(options.apiUser);
    }
    const ref = options.apiUser ?? generateReferenceId();
    await this.http.request("POST", "/v1_0/apiuser", {
      headers: {
        "X-Reference-Id": ref,
        "Ocp-Apim-Subscription-Key": this.subscriptionKey,
        "Content-Type": "application/json",
      },
      json: { providerCallbackHost: callbackHost },
      referenceId: ref,
    });
    return ref;
  }

  /** Get information about an existing sandbox API user. */
  public async getApiUser(apiUser: string): Promise<ApiUserInfo> {
    validateReferenceId(apiUser);
    const response = await this.http.request("GET", `/v1_0/apiuser/${apiUser}`, {
      headers: {
        "Ocp-Apim-Subscription-Key": this.subscriptionKey,
      },
      referenceId: apiUser,
    });
    return parseApiUserInfoResponse(response, apiUser);
  }

  /** Create an API key for an existing sandbox API user. */
  public async createApiKey(apiUser: string): Promise<string> {
    validateReferenceId(apiUser);
    const response = await this.http.request(
      "POST",
      `/v1_0/apiuser/${apiUser}/apikey`,
      {
        headers: {
          "Ocp-Apim-Subscription-Key": this.subscriptionKey,
        },
        referenceId: apiUser,
      },
    );
    return parseApiKeyResponse(response, apiUser).apiKey;
  }

  /** Create a sandbox API user and API key in a single call. */
  public async provision(
    options: { callbackHost?: string } = {},
  ): Promise<ProvisionResult> {
    const apiUser = await this.createApiUser({ callbackHost: options.callbackHost });
    const apiKey = await this.createApiKey(apiUser);
    return new ProvisionResult(apiUser, apiKey);
  }

  public toString(): string {
    const env = this.config?.environment ?? null;
    return `SandboxProvisioner(subscriptionKey=<redacted>, environment=${JSON.stringify(env)})`;
  }

  public toJSON(): Record<string, unknown> {
    return {
      subscriptionKey: "<redacted>",
      environment: this.config?.environment ?? null,
    };
  }

  public [inspect.custom](): string {
    return this.toString();
  }
}
