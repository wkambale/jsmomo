# Changelog

All notable changes to **JS MoMo SDK** (`js-momo-sdk`) are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
