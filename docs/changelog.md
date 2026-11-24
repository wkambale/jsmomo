# Changelog

All notable changes to **JS MoMo SDK** (`js-momo-sdk`) are listed below.

## 1.2.0 — 2026-11-24

Comprehensive security hardening release addressing all 10 verified audit findings across webhooks, SSRF protection, provider configs, secret redaction, CLI file handling, token caching, and the mock server:

- **Webhook replay canonicalization (#9, #19):** Pass canonical `t=<timestamp>,v1=<expectedHex>` to `replayCheck` and reject unknown keys and internal whitespace (blocking Fetch `Headers` duplicate-header coalescing).
- **AirtelAuth validation (#10, #20):** Validate `baseUrl`, `timeout`, `maxResponseBytes`, and credentials inside `AirtelAuth`.
- **JSON secret redaction (#11, #21):** Redact `clientSecret` and `subscriptionKey` in `AirtelAuth.toJSON()` and `SandboxProvisioner.toJSON()`.
- **Orange Money production HTTPS (#12, #22):** Disallow plaintext `http://localhost`/loopback URLs when `environment === "production"`.
- **SSRF IPv6 & `.localhost` hardening (#13, #23):** Block `::/96`, `::ffff:0:0:0/96`, `64:ff9b::/96`, `64:ff9b:1::/48`, `2002::/16`, `2001::/32`, `fec0::/10`, `100::/64`, and `*.localhost` subdomains.
- **CLI `--output-file` hardening (#14, #24):** Refuse symlinks (`O_NOFOLLOW`) and enforce `0o600` via `fchmodSync` even on existing files.
- **Error `responseBody` redaction (#15, #25):** Normalize camelCase/snake_case/kebab-case keys and redact `pay_token` / `notif_token`.
- **Mock server deadline timeout (#16, #26):** Set `server.requestTimeout`/`headersTimeout` and enforce a hard deadline in `readRequestBody`.
- **SandboxProvisioner trailing-dot guard (#17, #27):** Normalize trailing dots on FQDNs in `SandboxProvisioner` and `validateMatchingOrigin`.
- **TokenCache framing (#18, #28):** Use length-prefixed namespace framing to eliminate delimiter collisions.

## 1.0.0 — 2026-11-24

Initial public release of **JS MoMo SDK** with full feature, security, and documentation parity across all 7 African mobile money and payment rails:

- **Zero-dependency TypeScript / JavaScript core:** Dual ESM (`dist/index.js`) and CommonJS (`dist/index.cjs`) bundles with `.d.ts`/`.d.cts` type declarations targeting Node.js 18+.
- **MTN MoMo Open API:** `JsMomoSDK`, `Collection` (including CIBA `bcAuthorize` and OAuth2 consent/refresh tokens), `Disbursement` (`transfer`, `deposit`, `refund`), `Remittance`, and `SandboxProvisioner`.
- **Airtel Money Open API:** `AirtelClient`, `AirtelConfig`, native `node:crypto` RSA PKCS#1 v1.5 `encryptAirtelPin()`, production encrypted-PIN guard, 15-market MSISDN normalization, and HTTP 200 business-failure inspection.
- **Pan-African Providers & `PaymentRouter`:** `WaveClient`/`WaveProvider`, `MpesaClient`/`MpesaProvider`, `PaystackClient`/`PaystackProvider`, `FlutterwaveClient`/`FlutterwaveProvider`, `OrangeMoneyClient`/`OrangeMoneyProvider` (with pluggable `OrangePaymentContextStore`), 18-market `detectCarrierFromMsisdn()`, and safe failover defaults.
- **Structured Error Diagnostics:** All 9 exception classes preserve `referenceId`, `statusCode`, `errorCode`, `reason`, `provider`, recursively redacted `responseBody`, and `attemptedReferences`.
- **Webhooks & Server Adapters:** `WebhookHandler` (HMAC-SHA256/SHA512, timestamped HMAC + replay protection, IPv4/IPv6 CIDR allowlisting), `createExpressWebhookMiddleware`, `createFastifyWebhookPreHandler`, and `verifyWebWebhookRequest`.
- **Mock Server & CLI:** Native `node:http` `startMockServer()` simulator and executable `js-momo-sdk` CLI.
