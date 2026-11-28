import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  AirtelAuth,
  AirtelClient,
  AirtelConfig,
  ApiKeyResult,
  BadRequestError,
  BcAuthorizeResponse,
  CARRIER_PREFIX_MAP,
  DisbursementRequest,
  FlutterwaveClient,
  FlutterwaveConfig,
  JsMomoSDK,
  JsMomoSDKConfig,
  MpesaClient,
  MpesaConfig,
  OAuth2TokenResponse,
  OrangeMoneyClient,
  OrangeMoneyConfig,
  PaymentRequest,
  PaystackClient,
  PaystackConfig,
  ProductConfig,
  ProvisionResult,
  TokenResponse,
  WaveClient,
  WaveConfig,
  detectCarrierFromMsisdn,
  validatePrintableText,
} from "../../src/index.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "../..");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Permanent SDK Cross-Cutting Invariants", () => {
  it("never leaks secret canaries across String(), JSON.stringify(), or util.inspect() on any config, client, token, or error class", () => {
    const usedCanaries: string[] = [];
    const nextCanary = (): string => {
      const val = `CANARY_SECRET_VALUE_${String(usedCanaries.length + 1).padStart(2, "0")}_XYZ987`;
      usedCanaries.push(val);
      return val;
    };

    const mtnCol = new ProductConfig({
      subscriptionKey: nextCanary(),
      apiUser: nextCanary(),
      apiKey: nextCanary(),
    });
    const mtnDisb = new ProductConfig({
      subscriptionKey: nextCanary(),
      apiUser: nextCanary(),
      apiKey: nextCanary(),
    });
    const mtnRem = new ProductConfig({
      subscriptionKey: nextCanary(),
      apiUser: nextCanary(),
      apiKey: nextCanary(),
    });
    const mtnCfg = new JsMomoSDKConfig({
      environment: "sandbox",
      collection: mtnCol,
      disbursement: mtnDisb,
      remittance: mtnRem,
    });
    const mtnSdk = new JsMomoSDK(mtnCfg);
    const provisioner = mtnSdk.createSandboxProvisioner(nextCanary());

    const airtelCfg = new AirtelConfig({
      clientId: "airtel-client-id",
      clientSecret: nextCanary(),
      country: "UG",
      currency: "UGX",
      environment: "sandbox",
      pin: nextCanary(),
      webhookSecret: nextCanary(),
    });
    const airtelAuth = new AirtelAuth(
      "airtel-client-id",
      nextCanary(),
      "https://openapiuat.airtel.africa",
    );
    const airtelClient = new AirtelClient(airtelCfg);

    const waveCfg = new WaveConfig({
      apiKey: nextCanary(),
      webhookSecret: nextCanary(),
      signingSecret: nextCanary(),
      environment: "sandbox",
    });
    const waveClient = new WaveClient(waveCfg);

    const mpesaCfg = new MpesaConfig({
      consumerKey: "mpesa-consumer-key",
      consumerSecret: nextCanary(),
      shortCode: "174379",
      passkey: nextCanary(),
      securityCredential: nextCanary(),
      environment: "sandbox",
    });
    const mpesaClient = new MpesaClient(mpesaCfg);

    const paystackCfg = new PaystackConfig({
      secretKey: nextCanary(),
      environment: "sandbox",
    });
    const paystackClient = new PaystackClient(paystackCfg);

    const flwCfg = new FlutterwaveConfig({
      secretKey: nextCanary(),
      webhookHash: nextCanary(),
      environment: "sandbox",
    });
    const flwClient = new FlutterwaveClient(flwCfg);

    const orangeCfg = new OrangeMoneyConfig({
      clientId: "orange-client-id",
      clientSecret: nextCanary(),
      merchantKey: nextCanary(),
      environment: "sandbox",
    });
    const orangeClient = new OrangeMoneyClient(orangeCfg);

    const tokenResp = new TokenResponse({
      access_token: nextCanary(),
      token_type: "Bearer",
      expires_in: 3600,
    });
    const oauthResp = new OAuth2TokenResponse({
      access_token: nextCanary(),
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: nextCanary(),
    });
    const bcResp = new BcAuthorizeResponse({
      auth_req_id: nextCanary(),
      expires_in: 120,
      interval: 5,
    });
    const apiKeyRes = new ApiKeyResult({ apiKey: nextCanary() });
    const provRes = new ProvisionResult(nextCanary(), nextCanary());

    const upstreamErr = new BadRequestError("Upstream error", {
      access_token: nextCanary(),
      signingSecret: nextCanary(),
      private_key: nextCanary(),
      encryptionKey: nextCanary(),
      "x-key": nextCanary(),
      "x-signature": nextCanary(),
      pay_token: nextCanary(),
      notif_token: nextCanary(),
    });

    expect(usedCanaries.length).toBeGreaterThanOrEqual(30);

    const targets: unknown[] = [
      mtnCol,
      mtnDisb,
      mtnRem,
      mtnCfg,
      mtnSdk,
      provisioner,
      airtelCfg,
      airtelAuth,
      airtelClient,
      waveCfg,
      waveClient,
      mpesaCfg,
      mpesaClient,
      paystackCfg,
      paystackClient,
      flwCfg,
      flwClient,
      orangeCfg,
      orangeClient,
      tokenResp,
      oauthResp,
      bcResp,
      apiKeyRes,
      provRes,
      upstreamErr,
      upstreamErr.responseBody,
    ];

    for (const target of targets) {
      const representations = [
        String(target),
        JSON.stringify(target),
        inspect(target, { depth: 10 }),
      ];
      for (const repr of representations) {
        for (const canary of usedCanaries) {
          expect(repr).not.toContain(canary);
        }
      }
    }

    mtnSdk.close();
    airtelClient.close();
    waveClient.close();
    mpesaClient.close();
    paystackClient.close();
    flwClient.close();
    orangeClient.close();
  });

  it("preserves UTF-8 Francophone & Pan-African text fields while rejecting control characters and banning validateHeaderValue on human text", () => {
    const srcFiles = collectTsFiles(join(REPO_ROOT, "src"));
    const forbiddenFieldNames = [
      "beneficiaryName",
      "payerMessage",
      "payeeNote",
      "customerNote",
      "merchantNote",
      "remarks",
      "occasion",
      "narration",
    ];
    for (const file of srcFiles) {
      const source = readFileSync(file, "utf8");
      for (const field of forbiddenFieldNames) {
        expect(source).not.toMatch(
          new RegExp(`validateHeaderValue\\([^)]*fieldName:\\s*["']${field}["']`),
        );
      }
    }

    // Live UTF-8 acceptance across Francophone & Pan-African labels
    const orangeCfg = new OrangeMoneyConfig({
      clientId: "om-id",
      clientSecret: "om-sec",
      merchantKey: "om-mkey",
      reference: "Boutique Sénégal #42",
    });
    expect(orangeCfg.reference).toBe("Boutique Sénégal #42");

    const payReq = new PaymentRequest({
      amount: "2500",
      currency: "XOF",
      payerMsisdn: "+221771234567",
      payerMessage: "Facture Côte d'Ivoire — Mamadou Koné",
    });
    expect(payReq.payerMessage).toContain("Côte d'Ivoire");

    const disbReq = new DisbursementRequest({
      amount: "5000",
      currency: "XOF",
      payeeMsisdn: "+2250712345678",
      payerMessage: "Règlement février — Lomé",
      payeeNote: "Payé à François Édouard",
    });
    expect(disbReq.payeeNote).toContain("François Édouard");

    expect(
      validatePrintableText("Marché de Yaoundé — N°12", {
        fieldName: "label",
        maxLength: 60,
      }),
    ).toBe("Marché de Yaoundé — N°12");
    expect(() => validatePrintableText("Bad\r\nLine", { fieldName: "label" })).toThrow(
      RangeError,
    );
  });

  it("ensures every prefix in CARRIER_PREFIX_MAP resolves deterministically via detectCarrierFromMsisdn", () => {
    expect(CARRIER_PREFIX_MAP.length).toBeGreaterThanOrEqual(150);
    for (const [prefix, country, provider] of CARRIER_PREFIX_MAP) {
      const msisdn = `+${prefix}${"123456789".slice(0, Math.max(4, 12 - prefix.length))}`;
      const match = detectCarrierFromMsisdn(msisdn);
      expect(match).not.toBeNull();
      expect(match?.country).toBe(country);
      expect(match?.provider).toBe(provider);
    }
  });

  it("typechecks every ```ts code block in README.md and docs/*.md against src/index.ts with strict TypeScript", () => {
    const docPaths = [
      join(REPO_ROOT, "README.md"),
      ...readdirSync(join(REPO_ROOT, "docs"))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => join(REPO_ROOT, "docs", f)),
    ];

    const virtualFiles = new Map<string, string>();
    const snippetDir = join(REPO_ROOT, "__virtual_doc_snippets__");
    const ambientPath = join(snippetDir, "__ambient.d.ts");
    const expressStubPath = join(snippetDir, "__express_stub.d.ts");

    virtualFiles.set(
      expressStubPath,
      `import type {
  ExpressLikeRequest,
  ExpressLikeResponse,
  ExpressNextFunction,
} from "../src/index.js";

export type RequestHandler = (
  req: ExpressLikeRequest,
  res: ExpressLikeResponse & { json(body: unknown): unknown },
  next: ExpressNextFunction,
) => void | Promise<void>;

export interface ExpressApp {
  post(path: string, ...handlers: RequestHandler[]): void;
}

declare function express(): ExpressApp;
declare namespace express {
  function raw(options?: { type?: string }): RequestHandler;
}
export default express;
`,
    );

    virtualFiles.set(
      ambientPath,
      `import type {
  FetchLike,
  JsMomoSDK,
  OrangePaymentContextStore,
} from "../src/index.js";

declare global {
  const client: JsMomoSDK;
  const referenceId: string;
  const originalCollectionRef: string;
  const myRedisContextStore: OrangePaymentContextStore;
  const customFetchImplementation: FetchLike;
  const rawBodyBytes: Uint8Array;
  const signatureHeader: string;
  const secret: string;
  const waveSignatureHeader: string;
  const waveWebhookSecret: string;
  const myReplayStore: { markOnce(header: string): boolean };
  const remoteIp: string;
  const parsedBody: Record<string, unknown>;
  const req: { headers: Record<string, string | string[] | undefined> };
}
`,
    );

    const fenceRe = /```ts\r?\n([\s\S]*?)```/g;
    let totalBlocks = 0;

    for (const docPath of docPaths) {
      const md = readFileSync(docPath, "utf8");
      const baseName = docPath
        .slice(REPO_ROOT.length + 1)
        .replace(/[^a-zA-Z0-9]+/g, "_");
      let match: RegExpExecArray | null;
      let blockIdx = 0;
      while ((match = fenceRe.exec(md)) !== null) {
        blockIdx += 1;
        totalBlocks += 1;
        const rawCode = match[1] ?? "";
        const rewritten = rawCode
          .replace(/from\s+["']js-momo-sdk["']/g, 'from "../src/index.js"')
          .replace(/from\s+["']express["']/g, 'from "./__express_stub.js"');
        const virtualPath = join(snippetDir, `${baseName}_block_${blockIdx}.ts`);
        virtualFiles.set(virtualPath, `${rewritten}\nexport {};\n`);
      }
    }

    expect(totalBlocks).toBeGreaterThanOrEqual(25);

    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
    };

    const baseHost = ts.createCompilerHost(compilerOptions, true);
    const customHost: ts.CompilerHost = {
      ...baseHost,
      directoryExists: (dirName) =>
        resolve(dirName) === snippetDir ||
        (baseHost.directoryExists ? baseHost.directoryExists(dirName) : true),
      realpath: (pathName) =>
        virtualFiles.has(resolve(pathName)) || resolve(pathName) === snippetDir
          ? resolve(pathName)
          : baseHost.realpath
            ? baseHost.realpath(pathName)
            : pathName,
      fileExists: (fileName) =>
        virtualFiles.has(resolve(fileName)) || baseHost.fileExists(fileName),
      readFile: (fileName) => {
        const virtual = virtualFiles.get(resolve(fileName));
        return virtual !== undefined ? virtual : baseHost.readFile(fileName);
      },
      getSourceFile: (
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      ) => {
        const virtual = virtualFiles.get(resolve(fileName));
        if (virtual !== undefined) {
          return ts.createSourceFile(fileName, virtual, languageVersion, true);
        }
        return baseHost.getSourceFile(
          fileName,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
      },
    };

    const rootNames = [...virtualFiles.keys()];
    const program = ts.createProgram(rootNames, compilerOptions, customHost);
    const diagnostics = ts.getPreEmitDiagnostics(program);

    const formattedErrors = diagnostics.map((diag) => {
      const msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
      if (diag.file && diag.start !== undefined) {
        const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
        return `${diag.file.fileName}:${pos.line + 1}:${pos.character + 1} - TS${diag.code}: ${msg}`;
      }
      return `TS${diag.code}: ${msg}`;
    });

    expect(formattedErrors).toEqual([]);
  });
});
