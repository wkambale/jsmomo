# Changelog

All notable changes to **JS MoMo SDK** (`js-momo-sdk`) are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
