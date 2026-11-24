import type { TokenCache } from "../auth.js";
import type { JsMomoSDKConfig, ProductConfig } from "../config.js";
import { SANDBOX } from "../config.js";
import { AuthenticationError, JsMomoSDKError } from "../exceptions.js";
import type { HttpClient } from "../http.js";
import { parseJsonObject } from "../http.js";
import type { AccountHolderIdType, Balance, BasicUserInfo } from "../models.js";
import {
  parseBalanceResponse,
  parseBasicUserInfoResponse,
  parseTokenResponse,
} from "../models.js";
import {
  buildBasicAuthHeader,
  encodePathSegment,
  normaliseMsisdn,
  validateAccountHolderIdType,
  validateCallbackUrl,
  validateCurrency,
} from "../utils.js";

export interface BuildHeadersOptions {
  referenceId?: string | null;
  includeCallback?: boolean;
  callbackUrl?: string | null;
  includeContentType?: boolean;
}

/** Shared behaviour for all MTN MoMo product clients. */
export abstract class BaseProduct {
  protected abstract readonly productName: string;
  protected abstract readonly tokenPath: string;
  protected readonly config: JsMomoSDKConfig;
  protected readonly productConfig: ProductConfig;
  protected readonly http: HttpClient;
  protected readonly tokenCache: TokenCache;
  protected readonly tokenNamespace: string;

  constructor(
    config: JsMomoSDKConfig,
    productConfig: ProductConfig,
    http: HttpClient,
    tokenCache: TokenCache,
  ) {
    this.config = config;
    this.productConfig = productConfig;
    this.http = http;
    this.tokenCache = tokenCache;
    this.tokenNamespace = `${config.environment}:${config.baseUrl}`;
  }

  protected getToken = async (): Promise<string> => {
    return this.tokenCache.getOrRefresh(
      this.productName,
      async () => {
        const authHeader = buildBasicAuthHeader(
          this.productConfig.apiUser,
          this.productConfig.apiKey,
        );
        const response = await this.http.request("POST", this.tokenPath, {
          headers: {
            Authorization: authHeader,
            "Ocp-Apim-Subscription-Key": this.productConfig.subscriptionKey,
            "X-Target-Environment": this.config.environment,
          },
          idempotent: true,
        });
        let token;
        try {
          token = parseTokenResponse(response);
        } catch {
          throw new AuthenticationError("Invalid token response from API", {
            statusCode: response.status,
            provider: "MTN MoMo",
          });
        }
        this.tokenCache.set(this.productName, token.accessToken, token.expiresIn, {
          namespace: this.tokenNamespace,
        });
        return token.accessToken;
      },
      { namespace: this.tokenNamespace },
    );
  };

  protected async buildHeaders(
    options: BuildHeadersOptions = {},
  ): Promise<Record<string, string>> {
    let token: string;
    try {
      token = await this.getToken();
    } catch (err) {
      if (
        err instanceof JsMomoSDKError &&
        err.referenceId === null &&
        options.referenceId
      ) {
        err.referenceId = options.referenceId;
      }
      throw err;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Ocp-Apim-Subscription-Key": this.productConfig.subscriptionKey,
      "X-Target-Environment": this.config.environment,
    };
    if (options.includeContentType) {
      headers["Content-Type"] = "application/json";
    }
    if (options.referenceId) {
      headers["X-Reference-Id"] = options.referenceId;
    }
    if (options.includeCallback) {
      const allowLocalhost = this.config.environment === SANDBOX;
      const resolvedCb =
        options.callbackUrl !== undefined && options.callbackUrl !== null
          ? validateCallbackUrl(options.callbackUrl, { allowLocalhost })
          : this.productConfig.callbackUrl;
      if (resolvedCb) {
        headers["X-Callback-Url"] = resolvedCb;
      }
    }
    return headers;
  }

  /** Get the current account balance for this product. */
  public async getBalance(): Promise<Balance> {
    const response = await this.http.request(
      "GET",
      `/${this.productName}/v1_0/account/balance`,
      {
        headers: await this.buildHeaders(),
        productName: this.productName,
        tokenCache: this.tokenCache,
        tokenRefresher: this.getToken,
        tokenNamespace: this.tokenNamespace,
      },
    );
    return parseBalanceResponse(response);
  }

  /** Get the account balance for a specific ISO 4217 currency. */
  public async getBalanceForCurrency(currency: string): Promise<Balance> {
    const validatedCurrency = validateCurrency(currency);
    const response = await this.http.request(
      "GET",
      `/${this.productName}/v1_0/account/balance/${validatedCurrency}`,
      {
        headers: await this.buildHeaders(),
        productName: this.productName,
        tokenCache: this.tokenCache,
        tokenRefresher: this.getToken,
        tokenNamespace: this.tokenNamespace,
      },
    );
    return parseBalanceResponse(response);
  }

  /** Check whether an account holder is active. */
  public async isAccountHolderActive(
    accountHolderId: string,
    accountHolderIdType: string | AccountHolderIdType = "msisdn",
  ): Promise<boolean> {
    const idType = validateAccountHolderIdType(accountHolderIdType);
    const normalizedId =
      idType === "msisdn" ? normaliseMsisdn(accountHolderId) : accountHolderId;
    const encodedId = encodePathSegment(normalizedId, "accountHolderId");
    const response = await this.http.request(
      "GET",
      `/${this.productName}/v1_0/accountholder/${idType}/${encodedId}/active`,
      {
        headers: await this.buildHeaders(),
        productName: this.productName,
        tokenCache: this.tokenCache,
        tokenRefresher: this.getToken,
        tokenNamespace: this.tokenNamespace,
      },
    );
    const body = parseJsonObject(response);
    const result = body["result"];
    if (typeof result === "boolean") {
      return result;
    }
    if (typeof result === "string") {
      const lower = result.trim().toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
    }
    throw new JsMomoSDKError(
      "Malformed account holder active response: expected boolean 'result'",
      { statusCode: response.status, provider: "MTN MoMo" },
    );
  }

  /** Get basic user info of an account holder. */
  public async getBasicUserInfo(
    accountHolderId: string,
    accountHolderIdType: string | AccountHolderIdType = "msisdn",
  ): Promise<BasicUserInfo> {
    const idType = validateAccountHolderIdType(accountHolderIdType);
    const normalizedId =
      idType === "msisdn" ? normaliseMsisdn(accountHolderId) : accountHolderId;
    const encodedId = encodePathSegment(normalizedId, "accountHolderId");
    const response = await this.http.request(
      "GET",
      `/${this.productName}/v1_0/accountholder/${idType}/${encodedId}/basicuserinfo`,
      {
        headers: await this.buildHeaders(),
        productName: this.productName,
        tokenCache: this.tokenCache,
        tokenRefresher: this.getToken,
        tokenNamespace: this.tokenNamespace,
      },
    );
    return parseBasicUserInfoResponse(response);
  }
}
