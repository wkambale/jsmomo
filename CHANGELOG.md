# Changelog

All notable changes to **JS MoMo SDK** (`js-momo-sdk`) are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-11-27

### Security
- **Production HTTPS enforcement across Paystack, Flutterwave, and Wave (#31, #63):** Auto-infer `environment: "production"` from live keys (`sk_live_*`, `FLWSECK-*`, `wave_*_prod_*`), reject `sandbox` paired with live keys, and enforce `allowLocalhost: environment === "sandbox"` across configs, `HttpClient`, and per-call callback/redirect URLs.
- **M-Pesa encrypted `SecurityCredential` guard (#36, #67):** Reject plaintext `securityCredential` values in production (requiring valid Base64 RSA ciphertext) and export `encryptMpesaSecurityCredential()`.
- **HTTP retry safety & Paystack transfer protection (#47, #73):** Remove HTTP `500` from `RETRYABLE_STATUS_CODES`, restrict `SAFE_RETRY_METHODS` to `GET`/`HEAD`/`OPTIONS`, and disable auto-retry (`idempotent: false`) on Paystack `POST /transfer` and `POST /transaction/initialize`.
- **SSRF IPv4 blocklist expansion (#44, #57):** Block RFC 3068 `192.88.99.0/24` and RFC 5737 `198.51.100.0/24`, `203.0.113.0/24` in `isDisallowedIpv4()`.
- **Orange Money notification token verification (#35, #68):** Persist `notif_token` in `OrangePaymentContextStore`, add constant-time `OrangeMoneyClient.verifyNotification()`, and map `txnid` to `PaymentResult.providerTransactionId`.
- **Wave outbound signing & 30s webhook skew (#56, #74):** Add redacted `signingSecret` and outbound `Wave-Signature` on `POST /v1/payout`, and align `WaveClient.verifyWebhook()` default `maxFutureSkewSeconds` to `30`s.
- **CI/CD & supply-chain hardening (#49, #75):** Pin all GitHub Actions across `ci.yml`, `docs.yml`, and `publish.yml` to immutable 40-char commit SHAs, add `.github/dependabot.yml`, verify `origin/main` ancestry and `SHA256SUMS.txt` before publishing, and separate OIDC npm publishing from GitHub Release asset uploads.

### Added
- **MTN MoMo consented userinfo (#32, #64):** Add `Collection.getUserInfoWithConsent(oauth2AccessToken)` (`GET /collection/oauth2/v1_0/userinfo`).
- **Airtel Money refunds & webhook HMAC (#33, #65):** Add `AirtelCollection.refund()` (`POST /standard/v1/payments/refund`) and Base64 HMAC-SHA256 `AirtelClient.verifyWebhook()` (`AIRTEL_CAPABILITIES.supportsWebhookHmac = true`).
- **M-Pesa transaction status & callback parsers (#34, #66):** Add `MpesaClient.transactionStatus()` (`POST /mpesa/transactionstatus/v1/query`), `parseMpesaStkCallback()`, and `parseMpesaB2CCallback()`.
- **Paystack transfer recipients (#43, #71):** Add `PaystackClient.createTransferRecipient()` (`POST /transferrecipient`) and mock-server route.
- **Wave checkout & payout lifecycle endpoints (#56, #74):** Add `refundCheckoutSession()`, `expireCheckoutSession()`, `searchCheckoutSessions()`, `reversePayout()`, and `searchPayouts()`.
- **Base64 HMAC webhook encoding (#42, #60):** Add `encoding?: "hex" | "base64"` to `verifyHmacSignature` and framework webhook helpers.

### Fixed
- **MTN MoMo Open API paths (#32, #64):** Align `createOAuth2Token` (`/collection/oauth2/token/`), `getWithdrawStatus` (`/collection/v1_0/requesttowithdraw/{ref}`), `getDepositStatus` (`/disbursement/v1_0/deposit/{ref}`), and `getRefundStatus` (`/disbursement/v1_0/refund/{ref}`).
- **Airtel Money balance & disbursement parity (#33, #65):** Align balance endpoint to `GET /standard/v1/users/balance` with flat `data.{balance, currency, account_status}` parsing (keeping `data.wallet` fallback) and include `country`/`currency` in disbursement `transaction` payloads.
- **M-Pesa STK query pending handling & description cap (#34, #66):** Treat Daraja `500.001.1001` as `PENDING` in `stkQuery()` and enforce/truncate the 13-character `TransactionDesc` limit.
- **Zero-decimal currency validation (#37, #62):** Pass `{ currency }` into `validateAmount()` in `PaymentRequest`, `DisbursementRequest`, `WaveClient`, and `FlutterwaveClient`.
- **Flutterwave mobile money transfer fields (#38, #69):** Support optional `beneficiaryName` (`beneficiary_name`), `debitCurrency` (`debit_currency`), and `meta` on `FlutterwaveClient.createTransfer()`.
- **Wave checkout payer binding & fallback URL (#39, #70):** Send `restrict_payer_mobile` from `WaveProvider.collect()`, fall back `errorUrl` to `request.callbackUrl` when `config.errorUrl` is unset, and include `GMD` in `WAVE_CAPABILITIES`.
- **Carrier-to-capability currency parity (#40, #72):** Add `RWF` and `NGN` to `MTN_CAPABILITIES`, and `CDF`, `GNF`, `LRD`, `MGA`, `SLE`, `BWP`, `USD` to `ORANGE_CAPABILITIES`.
- **Airtel `waitForSettlement` compatibility (#41, #61):** Widen `PollableResult.status` to `unknown` and expose `referenceId`/`reason` getters on `AirtelTransactionResponse`.
- **Webhook telemetry & Fastify preHandler return (#42, #60):** Emit telemetry on pre-check failures without duplicate emission and return `reply.code(...).send(...)` in `createFastifyWebhookPreHandler`.
- **Upfront HTTP method/header validation & CLI stdin guard (#45, #46, #58, #59):** Reject invalid HTTP methods/headers before dispatch without retrying, and reject conflicting `'-'` stdin arguments in CLI commands.

## [1.2.0] - 2026-11-24

### Security
- **Webhook replay protection (#9, #19):** Canonicalize the matched timestamped signature key (`t=<timestamp>,v1=<expectedHex>`) passed to `options.replayCheck`, and reject unknown keys and internal whitespace (including Fetch `Headers` duplicate-header comma-space coalescing) in `verifyTimestampedHmacSignature`.
- **AirtelAuth input validation (#10, #20):** Enforce `validateBaseUrl()`, `validateTimeout()`, positive-integer `maxResponseBytes`, and non-empty credential validation in `AirtelAuth` constructor, forwarding `allowLocalhost: environment === "sandbox"` from `AirtelClient`.
- **JSON secret redaction (#11, #21):** Add `toJSON()` redacting `clientSecret` on `AirtelAuth` (protecting `JSON.stringify(airtelClient)`) and `subscriptionKey` on `SandboxProvisioner`.
- **Orange Money production HTTPS enforcement (#12, #22):** Enforce `allowLocalhost: environment === "sandbox"` for `baseUrl`, `returnUrl`, `cancelUrl`, `notifUrl`, and `HttpClient` in `OrangeMoneyConfig` and `OrangeMoneyClient`.
- **SSRF & loopback blocklist hardening (#13, #23):** Block IPv4-compatible IPv6 (`::/96`), SIIT IPv4-translated (`::ffff:0:0:0/96`), NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 (`2002::/16`), Teredo (`2001::/32`), deprecated site-local (`fec0::/10`), discard-only (`100::/64`), and RFC 6761 `*.localhost` subdomains in `validateBaseUrl`, `validateCallbackUrl`, and `validateCallbackHost`.
- **CLI credential file safety (#14, #24):** Open `sandbox provision --output-file` with `O_NOFOLLOW`, verify regular file descriptor via `fstatSync`, enforce `0o600` via `fchmodSync`, and truncate before writing secrets.
- **Error responseBody redaction (#15, #25):** Normalize keys (camelCase, snake_case, kebab-case) in `redactResponseBody` and redact Orange Money `pay_token` and `notif_token`.
- **Mock server total request deadline (#16, #26):** Configure `server.requestTimeout`/`server.headersTimeout` and enforce a hard per-request deadline timer in `readRequestBody` to prevent slow-drip POST exhaustion of `maxConcurrentRequests`.
- **SandboxProvisioner production-host guard (#17, #27):** Strip trailing DNS root dots before hostname comparisons in `SandboxProvisioner` and `validateMatchingOrigin`.
- **TokenCache namespace framing (#18, #28):** Use unambiguous length-prefixed framing (`${namespace.length}:${namespace}:${product}`) for `TokenCache` keys to eliminate delimiter collisions.

## [1.0.0] - 2026-11-24

### Added
- **Core architecture & security:** Zero-runtime-dependency TypeScript/JavaScript SDK with dual ESM + CommonJS bundles, `.d.ts`/`.d.cts` type declarations, strict HTTPS & SSRF private/loopback/metadata/IPv4-mapped IPv6 validation, canonical UUID v4 & Airtel reference validation, exact BigInt amount validation, single-flight `TokenCache`, bounded streaming response reads, HTTP `3xx` redirect rejection, idempotent retries with `Retry-After` and CSPRNG jitter, and `TelemetryHook`.
- **Structured error diagnostics:** Full 9-class exception hierarchy (`JsMomoSDKError`, `AuthenticationError`, `MissingCredentialsError`, `BadRequestError`, `ResourceNotFoundError`, `ConflictError`, `JsMomoSDKServerError`, `TransactionFailedError`, `WebhookVerificationError`) preserving `referenceId`, `statusCode`, `errorCode`, `reason`, `provider`, recursively redacted `responseBody`, and `attemptedReferences`.
- **MTN MoMo Open API:** `JsMomoSDK` with `Collection` (including CIBA `bcAuthorize` & `createOAuth2Token`), `Disbursement` (`transfer`, `deposit`, `refund`), `Remittance`, and `SandboxProvisioner`.
- **Airtel Money Open API:** `AirtelClient`, `AirtelConfig`, native `node:crypto` RSA PKCS#1 v1.5 `encryptAirtelPin()`, production encrypted-PIN guard, 15-country MSISDN normalization, HTTP 200 business-failure inspection, Collection, Disbursement, and Balance APIs.
- **Pan-African Providers & Unified Routing:** `WaveClient`/`WaveProvider`, `MpesaClient`/`MpesaProvider`, `PaystackClient`/`PaystackProvider`, `FlutterwaveClient`/`FlutterwaveProvider`, `OrangeMoneyClient`/`OrangeMoneyProvider` (with pluggable `OrangePaymentContextStore`), `MtnMomoProvider`, `AirtelMoneyProvider`, 18-market `detectCarrierFromMsisdn()`, and `PaymentRouter` with safe failover defaults (`allowAmbiguousWriteFallback`).
- **Webhooks & Server Framework Adapters:** `WebhookHandler` (HMAC-SHA256/SHA512, timestamped HMAC with replay deduplication, strict IPv4/IPv6 CIDR allowlisting), `verifyRawWebhookRequest`, `verifyStaticTokenWebhookRequest`, `verifyWebWebhookRequest` (Next.js App Router / Edge / Fetch API), `createExpressWebhookMiddleware`, and `createFastifyWebhookPreHandler`.
- **Local Mock Gateway & CLI:** Native `node:http` `startMockServer()` / `createMockServer()` covering all 7 payment rails and executable `js-momo-sdk` CLI (`sandbox`, `collection`, `disbursement`, `remittance`, `airtel`, `webhook verify`, `carrier`, `mock`).
- **Documentation & CI/CD:** MkDocs Material documentation site published to GitHub Pages and automated npm publishing workflow with provenance attestation.
