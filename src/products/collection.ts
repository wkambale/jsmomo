import type {
  BasicUserInfo,
  BcAuthorizeResponse,
  OAuth2TokenResponse,
  TransactionResult,
} from "../models.js";
import {
  parseBasicUserInfoResponse,
  parseBcAuthorizeResponse,
  parseOAuth2TokenResponse,
  parseTransactionResultResponse,
  validateExternalId,
  validateNoteText,
} from "../models.js";
import {
  buildBasicAuthHeader,
  generateReferenceId,
  normaliseMsisdn,
  validateAmount,
  validateCurrency,
  validateHeaderValue,
  validateReferenceId,
} from "../utils.js";
import { BaseProduct } from "./base.js";

const VALID_BC_ACCESS_TYPES: ReadonlySet<string> = new Set(["online", "offline"]);
const MSISDN_LIKE_RE = /^[0-9+\-\s().]+$/;

export interface RequestToPayParams {
  amount: string;
  currency: string;
  payerMsisdn: string;
  externalId: string;
  payerMessage?: string;
  payeeNote?: string;
  referenceId?: string | null;
  callbackUrl?: string | null;
  partyIdType?: string;
}

export interface BcAuthorizeParams {
  loginHint: string;
  scope?: string;
  accessType?: "online" | "offline" | string;
  callbackUrl?: string | null;
}

export interface CreateOAuth2TokenParams {
  authReqId?: string | null;
  grantType?: string;
  refreshToken?: string | null;
}

/** MTN MoMo Collection product client. */
export class Collection extends BaseProduct {
  protected readonly productName = "collection";
  protected readonly tokenPath = "/collection/token/";

  private buildPayerPayload(params: RequestToPayParams): Record<string, unknown> {
    const validatedCurrency = validateCurrency(params.currency);
    const validatedAmount = validateAmount(params.amount, {
      currency: validatedCurrency,
    });
    const validatedExternalId = validateExternalId(params.externalId);
    const payerMessage = validateNoteText(params.payerMessage ?? "", "payerMessage");
    const payeeNote = validateNoteText(params.payeeNote ?? "", "payeeNote");
    const normPartyType = (params.partyIdType ?? "MSISDN").trim().toUpperCase();
    if (!normPartyType) {
      throw new RangeError("partyIdType must be a non-empty string");
    }
    validateHeaderValue(normPartyType, { fieldName: "partyIdType" });
    const partyId =
      normPartyType === "MSISDN"
        ? normaliseMsisdn(params.payerMsisdn)
        : validateHeaderValue(params.payerMsisdn.trim(), { fieldName: "payerMsisdn" });
    if (!partyId) {
      throw new RangeError("partyId must be a non-empty string");
    }

    return {
      amount: validatedAmount,
      currency: validatedCurrency,
      externalId: validatedExternalId,
      payer: {
        partyIdType: normPartyType,
        partyId,
      },
      payerMessage,
      payeeNote,
    };
  }

  /** Initiate a Request to Pay and return the UUID v4 reference ID. */
  public async requestToPay(params: RequestToPayParams): Promise<string> {
    if (params.referenceId !== undefined && params.referenceId !== null) {
      validateReferenceId(params.referenceId);
    }
    const ref = params.referenceId ?? generateReferenceId();
    const payload = this.buildPayerPayload(params);

    await this.http.request("POST", "/collection/v1_0/requesttopay", {
      headers: await this.buildHeaders({
        referenceId: ref,
        includeCallback: true,
        callbackUrl: params.callbackUrl,
        includeContentType: true,
      }),
      json: payload,
      productName: this.productName,
      tokenCache: this.tokenCache,
      tokenRefresher: this.getToken,
      tokenNamespace: this.tokenNamespace,
      idempotent: params.referenceId !== undefined && params.referenceId !== null,
      referenceId: ref,
    });
    return ref;
  }

  /** Poll the status of a Request to Pay transaction. */
  public async getPaymentStatus(referenceId: string): Promise<TransactionResult> {
    validateReferenceId(referenceId);
    const response = await this.http.request(
      "GET",
      `/collection/v1_0/requesttopay/${referenceId}`,
      {
        headers: await this.buildHeaders(),
        productName: this.productName,
        tokenCache: this.tokenCache,
        tokenRefresher: this.getToken,
        tokenNamespace: this.tokenNamespace,
        referenceId,
      },
    );
    return parseTransactionResultResponse(response, referenceId);
  }

  /** Initiate a Request to Withdraw (v2) and return the UUID v4 reference ID. */
  public async requestToWithdraw(params: RequestToPayParams): Promise<string> {
    if (params.referenceId !== undefined && params.referenceId !== null) {
      validateReferenceId(params.referenceId);
    }
    const ref = params.referenceId ?? generateReferenceId();
    const payload = this.buildPayerPayload(params);

    await this.http.request("POST", "/collection/v2_0/requesttowithdraw", {
      headers: await this.buildHeaders({
        referenceId: ref,
        includeCallback: true,
        callbackUrl: params.callbackUrl,
        includeContentType: true,
      }),
      json: payload,
      productName: this.productName,
      tokenCache: this.tokenCache,
      tokenRefresher: this.getToken,
      tokenNamespace: this.tokenNamespace,
      idempotent: params.referenceId !== undefined && params.referenceId !== null,
      referenceId: ref,
    });
    return ref;
  }

  /** Poll the status of a Request to Withdraw transaction. */
  public async getWithdrawStatus(referenceId: string): Promise<TransactionResult> {
    validateReferenceId(referenceId);
    const response = await this.http.request(
      "GET",
      `/collection/v1_0/requesttowithdraw/${referenceId}`,
      {
        headers: await this.buildHeaders(),
        productName: this.productName,
        tokenCache: this.tokenCache,
        tokenRefresher: this.getToken,
        tokenNamespace: this.tokenNamespace,
        referenceId,
      },
    );
    return parseTransactionResultResponse(response, referenceId);
  }

  /**
   * Get basic user info using a v2 reference ID.
   * @deprecated Use `getBasicUserInfo()` or `getUserInfoWithConsent()` for official MTN MoMo Open API endpoints.
   */
  public async getBasicUserInfoByReference(
    referenceId: string,
  ): Promise<BasicUserInfo> {
    validateReferenceId(referenceId);
    const response = await this.http.request(
      "GET",
      `/collection/v2_0/user/${referenceId}/basicuserinfo`,
      {
        headers: await this.buildHeaders(),
        productName: this.productName,
        tokenCache: this.tokenCache,
        tokenRefresher: this.getToken,
        tokenNamespace: this.tokenNamespace,
        referenceId,
      },
    );
    return parseBasicUserInfoResponse(response, referenceId);
  }

  /**
   * Fetch consented user profile details using a CIBA user OAuth2 access token
   * obtained via `bcAuthorize()` + `createOAuth2Token()`.
   */
  public async getUserInfoWithConsent(
    oauth2AccessToken: string,
  ): Promise<BasicUserInfo> {
    if (typeof oauth2AccessToken !== "string" || !oauth2AccessToken.trim()) {
      throw new RangeError("oauth2AccessToken must be a non-empty string");
    }
    validateHeaderValue(oauth2AccessToken, {
      fieldName: "oauth2AccessToken",
      allowWhitespace: false,
    });
    const response = await this.http.request(
      "GET",
      "/collection/oauth2/v1_0/userinfo",
      {
        headers: {
          Authorization: `Bearer ${oauth2AccessToken}`,
          "Ocp-Apim-Subscription-Key": this.productConfig.subscriptionKey,
          "X-Target-Environment": this.config.environment,
        },
      },
    );
    return parseBasicUserInfoResponse(response);
  }

  /** Initiate a CIBA backchannel authorization request. */
  public async bcAuthorize(params: BcAuthorizeParams): Promise<BcAuthorizeResponse> {
    const scope = params.scope ?? "profile";
    const accessType = params.accessType ?? "offline";
    if (typeof params.loginHint !== "string" || !params.loginHint.trim()) {
      throw new RangeError("loginHint must be a non-empty string");
    }
    validateHeaderValue(params.loginHint, { fieldName: "loginHint" });
    if (typeof scope !== "string" || !scope.trim()) {
      throw new RangeError("scope must be a non-empty string");
    }
    validateHeaderValue(scope, { fieldName: "scope" });
    if (typeof accessType !== "string" || !accessType.trim()) {
      throw new RangeError("accessType must be a non-empty string");
    }
    validateHeaderValue(accessType, { fieldName: "accessType" });
    const normAccessType = accessType.trim().toLowerCase();
    if (!VALID_BC_ACCESS_TYPES.has(normAccessType)) {
      throw new RangeError("accessType must be 'online' or 'offline'");
    }

    const loginHint = MSISDN_LIKE_RE.test(params.loginHint.trim())
      ? `ID:${normaliseMsisdn(params.loginHint)}/MSISDN`
      : params.loginHint;

    const headers = await this.buildHeaders({
      includeCallback: params.callbackUrl !== undefined && params.callbackUrl !== null,
      callbackUrl: params.callbackUrl,
    });
    headers["Content-Type"] = "application/x-www-form-urlencoded";

    const response = await this.http.request("POST", "/collection/v1_0/bc-authorize", {
      headers,
      form: {
        login_hint: loginHint,
        scope,
        access_type: normAccessType,
      },
      productName: this.productName,
      tokenCache: this.tokenCache,
      tokenRefresher: this.getToken,
      tokenNamespace: this.tokenNamespace,
    });
    return parseBcAuthorizeResponse(response);
  }

  /** Exchange a CIBA authReqId or refreshToken for an OAuth2 user token. */
  public async createOAuth2Token(
    params: CreateOAuth2TokenParams,
  ): Promise<OAuth2TokenResponse> {
    const grantType = params.grantType ?? "urn:openid:params:grant-type:ciba";
    if (typeof grantType !== "string" || !grantType.trim()) {
      throw new RangeError("grantType must be a non-empty string");
    }
    validateHeaderValue(grantType, { fieldName: "grantType" });

    const form: Record<string, string> = { grant_type: grantType };
    if (grantType === "refresh_token") {
      const tokenVal = params.refreshToken ?? params.authReqId;
      if (typeof tokenVal !== "string" || !tokenVal.trim()) {
        throw new RangeError("refreshToken must be a non-empty string");
      }
      validateHeaderValue(tokenVal, {
        fieldName: "refreshToken",
        allowWhitespace: false,
      });
      form["refresh_token"] = tokenVal;
    } else {
      if (typeof params.authReqId !== "string" || !params.authReqId.trim()) {
        throw new RangeError("authReqId must be a non-empty string");
      }
      validateHeaderValue(params.authReqId, { fieldName: "authReqId" });
      form["auth_req_id"] = params.authReqId;
    }

    const authHeader = buildBasicAuthHeader(
      this.productConfig.apiUser,
      this.productConfig.apiKey,
    );
    const response = await this.http.request("POST", "/collection/oauth2/token/", {
      headers: {
        Authorization: authHeader,
        "Ocp-Apim-Subscription-Key": this.productConfig.subscriptionKey,
        "X-Target-Environment": this.config.environment,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      form,
    });
    return parseOAuth2TokenResponse(response);
  }
}
