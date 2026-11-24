# Changelog

All notable changes to **JS MoMo SDK** (`js-momo-sdk`) are listed below.

## 1.0.0 — 2026-11-24

Initial public release of **JS MoMo SDK** with full feature, security, and documentation parity across all 7 African mobile money and payment rails:

- **Zero-dependency TypeScript / JavaScript core:** Dual ESM (`dist/index.js`) and CommonJS (`dist/index.cjs`) bundles with `.d.ts`/`.d.cts` type declarations targeting Node.js 18+.
- **MTN MoMo Open API:** `JsMomoSDK`, `Collection` (including CIBA `bcAuthorize` and OAuth2 consent/refresh tokens), `Disbursement` (`transfer`, `deposit`, `refund`), `Remittance`, and `SandboxProvisioner`.
- **Airtel Money Open API:** `AirtelClient`, `AirtelConfig`, native `node:crypto` RSA PKCS#1 v1.5 `encryptAirtelPin()`, production encrypted-PIN guard, 15-market MSISDN normalization, and HTTP 200 business-failure inspection.
- **Pan-African Providers & `PaymentRouter`:** `WaveClient`/`WaveProvider`, `MpesaClient`/`MpesaProvider`, `PaystackClient`/`PaystackProvider`, `FlutterwaveClient`/`FlutterwaveProvider`, `OrangeMoneyClient`/`OrangeMoneyProvider` (with pluggable `OrangePaymentContextStore`), 18-market `detectCarrierFromMsisdn()`, and safe failover defaults.
- **Structured Error Diagnostics:** All 9 exception classes preserve `referenceId`, `statusCode`, `errorCode`, `reason`, `provider`, recursively redacted `responseBody`, and `attemptedReferences`.
- **Webhooks & Server Adapters:** `WebhookHandler` (HMAC-SHA256/SHA512, timestamped HMAC + replay protection, IPv4/IPv6 CIDR allowlisting), `createExpressWebhookMiddleware`, `createFastifyWebhookPreHandler`, and `verifyWebWebhookRequest`.
- **Mock Server & CLI:** Native `node:http` `startMockServer()` simulator and executable `js-momo-sdk` CLI.
