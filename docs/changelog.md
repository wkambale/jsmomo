# Changelog

All notable changes to **JS MoMo SDK** (`js-momo-sdk`) are listed below.

## 1.2.1 — 2026-11-27

End-to-end real-rail parity, API completeness, retry safety, and supply-chain hardening release addressing all 19 verified audit issues (#31–#47, #49, #56):

- **Production HTTPS & credential guards (#31, #36, #63, #67):** Enforce `allowLocalhost: environment === "sandbox"` across Paystack, Flutterwave, and Wave (auto-inferring production from live keys); require Base64 RSA ciphertext for `MpesaConfig.securityCredential` in production and export `encryptMpesaSecurityCredential()`.
- **HTTP retry safety & SSRF hardening (#44, #45, #47, #57, #58, #73):** Remove HTTP `500` and `PUT`/`DELETE` from default retries, disable auto-retry on Paystack `POST /transfer` and `POST /transaction/initialize`, validate HTTP methods/headers upfront without retrying, and block RFC 3068/5737 IPv4 ranges.
- **MTN MoMo & Airtel Money rail parity (#32, #33, #41, #61, #64, #65):** Align MTN OAuth2/withdraw/deposit/refund paths and add `getUserInfoWithConsent()`; align Airtel balance (`/standard/v1/users/balance`) and disbursement payloads, add `AirtelCollection.refund()`, add Base64 HMAC-SHA256 `AirtelClient.verifyWebhook()`, and make `AirtelTransactionResponse` compatible with `waitForSettlement()`.
- **M-Pesa, Orange Money, Flutterwave, Paystack & Wave completeness (#34, #35, #38, #39, #43, #56, #66, #68–#71, #74):** Handle Daraja pending `500.001.1001`, add `MpesaClient.transactionStatus()` and STK/B2C callback parsers; persist Orange `notif_token` with constant-time `verifyNotification()` and `txnid` mapping; add Flutterwave `beneficiary_name`/`debit_currency`/`meta`; add `PaystackClient.createTransferRecipient()`; add Wave `restrict_payer_mobile`, `errorUrl` fallback, `GMD` support, outbound `Wave-Signature`, 30s webhook future-skew alignment, and checkout/payout refund, expire, reverse, and search endpoints.
- **Validation, routing, webhooks, CLI & CI hardening (#37, #40, #42, #46, #49, #59, #60, #62, #72, #75):** Enforce zero-decimal currency checks across models/Wave/Flutterwave; align `MTN_CAPABILITIES` and `ORANGE_CAPABILITIES` currencies with carrier routing; add Base64 HMAC support, pre-check telemetry, and Fastify reply return; reject conflicting CLI stdin flags; pin all GitHub Actions to commit SHAs, add Dependabot, and verify tag ancestry & `SHA256SUMS.txt` in `publish.yml`.

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
