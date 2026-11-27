import { createHmac, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import type { RunningMockServer } from "../../src/mock-server.js";
import { startMockServer } from "../../src/mock-server.js";
import { VERSION } from "../../src/version.js";

function captureCli(
  argv: string[],
  options: { env?: Record<string, string>; stdin?: Buffer } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  return runCli(argv, {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    env: options.env ?? {},
    readStdin: () => options.stdin ?? Buffer.alloc(0),
  }).then((code) => ({
    code,
    stdout: out.join("\n"),
    stderr: err.join("\n"),
  }));
}

describe("JS MoMo SDK CLI", () => {
  let mock: RunningMockServer;
  let tmpDir: string;

  beforeAll(async () => {
    mock = await startMockServer();
    tmpDir = mkdtempSync(join(tmpdir(), "jsmomo-cli-"));
  });

  afterAll(async () => {
    await mock.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prints version, help, and detects MSISDN carriers", async () => {
    const v = await captureCli(["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout).toBe(`js-momo-sdk ${VERSION}`);

    const h = await captureCli(["--help"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("Usage:");

    const c = await captureCli(["carrier", "+256772123456"]);
    expect(c.code).toBe(0);
    expect(JSON.parse(c.stdout)).toEqual({
      country: "UG",
      provider: "mtn_momo",
    });

    const unknown = await captureCli(["unknown-cmd"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown command");
  });

  it("verifies HMAC and timestamped webhooks and encrypts Airtel PINs via CLI", async () => {
    const payload = Buffer.from('{"status":"SUCCESSFUL"}', "utf8");
    const sig = createHmac("sha256", "whsec").update(payload).digest("hex");
    const res = await captureCli(
      ["webhook", "verify", "-s", sig, "--secret", "whsec"],
      { stdin: payload },
    );
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ verified: true });

    const now = Math.floor(Date.now() / 1000);
    const tsSig = createHmac("sha256", "whsec")
      .update(`${now}`)
      .update(payload)
      .digest("hex");
    const tsRes = await captureCli(
      [
        "webhook",
        "verify",
        "-s",
        `t=${now},v1=${tsSig}`,
        "--secret",
        "whsec",
        "--timestamped",
        "--timestamp-separator=",
      ],
      { stdin: payload },
    );
    expect(tsRes.code).toBe(0);

    // Reject conflicting stdin usage for both --secret-file and --payload-file (Issue #46)
    let stdinCalls = 0;
    const conflictErr: string[] = [];
    const conflictCode = await runCli(
      ["webhook", "verify", "-s", sig, "--secret-file", "-", "--payload-file", "-"],
      {
        stdout: () => {},
        stderr: (l) => conflictErr.push(l),
        env: {},
        readStdin: () => {
          stdinCalls += 1;
          return Buffer.from("whsec", "utf8");
        },
      },
    );
    expect(conflictCode).toBe(1);
    expect(conflictErr.join("\n")).toContain("stdin");
    expect(stdinCalls).toBe(0);

    const defaultPayloadConflict = await captureCli(
      ["webhook", "verify", "-s", sig, "--secret-file", "-"],
      { stdin: Buffer.from("whsec", "utf8") },
    );
    expect(defaultPayloadConflict.code).toBe(1);
    expect(defaultPayloadConflict.stderr).toContain("stdin");

    const payloadPath = join(tmpDir, "webhook-payload.json");
    writeFileSync(payloadPath, payload);
    const stdinSecretOk = await captureCli(
      [
        "webhook",
        "verify",
        "-s",
        sig,
        "--secret-file",
        "-",
        "--payload-file",
        payloadPath,
      ],
      { stdin: Buffer.from("whsec\n", "utf8") },
    );
    expect(stdinSecretOk.code).toBe(0);
    expect(JSON.parse(stdinSecretOk.stdout)).toEqual({ verified: true });

    const { publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const keyPath = join(tmpDir, "airtel_pub.pem");
    writeFileSync(keyPath, publicKey, "utf8");
    const enc = await captureCli([
      "airtel",
      "encrypt-pin",
      "--public-key-file",
      keyPath,
      "--pin",
      "1234",
    ]);
    expect(enc.code).toBe(0);
    expect(JSON.parse(enc.stdout).encrypted_pin).toBeTruthy();
  });

  it("runs sandbox, collection, disbursement, remittance, and airtel commands against mock server", async () => {
    const env = {
      JS_MOMO_SDK_BASE_URL: mock.url,
      JS_MOMO_SDK_COLLECTION_SUBSCRIPTION_KEY: "sub",
      JS_MOMO_SDK_COLLECTION_API_USER: "user",
      JS_MOMO_SDK_COLLECTION_API_KEY: "key",
      JS_MOMO_SDK_DISBURSEMENT_SUBSCRIPTION_KEY: "sub",
      JS_MOMO_SDK_DISBURSEMENT_API_USER: "user",
      JS_MOMO_SDK_DISBURSEMENT_API_KEY: "key",
      JS_MOMO_SDK_REMITTANCE_SUBSCRIPTION_KEY: "sub",
      JS_MOMO_SDK_REMITTANCE_API_USER: "user",
      JS_MOMO_SDK_REMITTANCE_API_KEY: "key",
      JS_MOMO_SDK_AIRTEL_CLIENT_ID: "cid",
      JS_MOMO_SDK_AIRTEL_CLIENT_SECRET: "csec",
    };

    const credsFile = join(tmpDir, "creds.json");
    const prov = await captureCli(
      ["sandbox", "provision", "--output-file", credsFile],
      { env },
    );
    expect(prov.code).toBe(0);
    const saved = JSON.parse(readFileSync(credsFile, "utf8")) as {
      api_user: string;
      api_key: string;
    };
    expect(saved.api_key).toContain("mock-api-key-");

    // Existing permissive file is tightened to 0o600 and symlinks are refused (Issue #14)
    if (process.platform !== "win32") {
      const existingFile = join(tmpDir, "existing-creds.json");
      writeFileSync(existingFile, "old", { mode: 0o644 });
      chmodSync(existingFile, 0o644);
      const overwrite = await captureCli(
        ["sandbox", "provision", "--output-file", existingFile],
        { env },
      );
      expect(overwrite.code).toBe(0);
      expect(statSync(existingFile).mode & 0o777).toBe(0o600);

      const symTarget = join(tmpDir, "sym-target.json");
      writeFileSync(symTarget, "untouched", "utf8");
      const symLink = join(tmpDir, "creds-link.json");
      symlinkSync(symTarget, symLink);
      const symRes = await captureCli(
        ["sandbox", "provision", "--output-file", symLink],
        { env },
      );
      expect(symRes.code).toBe(1);
      expect(symRes.stderr).toContain("symbolic link");
      expect(readFileSync(symTarget, "utf8")).toBe("untouched");
    }

    const userRes = await captureCli(["sandbox", "get-user", saved.api_user], { env });
    expect(userRes.code).toBe(0);
    expect(JSON.parse(userRes.stdout).targetEnvironment).toBe("sandbox");

    const bal = await captureCli(["collection", "balance"], { env });
    expect(bal.code).toBe(0);
    expect(JSON.parse(bal.stdout).availableBalance).toBe("10000.00");

    const rtp = await captureCli(
      ["collection", "request-to-pay", "256772123456", "500", "UGX", "ext-1"],
      { env },
    );
    expect(rtp.code).toBe(0);
    const refId = JSON.parse(rtp.stdout).reference_id as string;
    const st = await captureCli(["collection", "status", refId], { env });
    expect(st.code).toBe(0);
    expect(JSON.parse(st.stdout).status).toBe("SUCCESSFUL");

    const disb = await captureCli(
      ["disbursement", "transfer", "256772123456", "300", "UGX", "ext-2"],
      { env },
    );
    expect(disb.code).toBe(0);
    const dRef = JSON.parse(disb.stdout).reference_id as string;
    expect((await captureCli(["disbursement", "status", dRef], { env })).code).toBe(0);
    expect((await captureCli(["disbursement", "balance"], { env })).code).toBe(0);

    const rem = await captureCli(
      ["remittance", "transfer", "256772123456", "300", "UGX", "ext-3"],
      { env },
    );
    expect(rem.code).toBe(0);
    const rRef = JSON.parse(rem.stdout).reference_id as string;
    expect((await captureCli(["remittance", "status", rRef], { env })).code).toBe(0);
    expect((await captureCli(["remittance", "balance"], { env })).code).toBe(0);

    const airBal = await captureCli(["airtel", "balance"], { env });
    expect(airBal.code).toBe(0);
    expect(JSON.parse(airBal.stdout).data.wallet.balance).toBe("5000.00");

    // Missing secret returns exit code 1 with clean error
    const fail = await captureCli(["collection", "balance"]);
    expect(fail.code).toBe(1);
    expect(fail.stderr).toContain("Error:");

    // Redact secret mode, secret-file via stdin, --timeout validation, SDK error formatting with referenceId
    const redacted = await captureCli(["sandbox", "provision", "--redact-secret"], {
      env,
    });
    expect(redacted.code).toBe(0);
    expect(JSON.parse(redacted.stdout).api_key).toBe("<redacted>");

    const subKeyFile = join(tmpDir, "sub.key");
    writeFileSync(subKeyFile, "sub-from-file\n", "utf8");
    const fromFile = await captureCli(
      ["sandbox", "provision", "--subscription-key-file", subKeyFile],
      { env: { JS_MOMO_SDK_BASE_URL: mock.url } },
    );
    expect(fromFile.code).toBe(0);

    // Duplicate reference triggers JsMomoSDKError (ConflictError) and formats referenceId cleanly
    const fixedRef = "11111111-1111-4111-8111-111111111111";
    expect(
      (
        await captureCli(
          [
            "collection",
            "request-to-pay",
            "256772123456",
            "500",
            "UGX",
            "ext-dup",
            "--reference-id",
            fixedRef,
          ],
          { env },
        )
      ).code,
    ).toBe(0);
    const dup = await captureCli(
      [
        "collection",
        "request-to-pay",
        "256772123456",
        "500",
        "UGX",
        "ext-dup",
        "--reference-id",
        fixedRef,
      ],
      { env },
    );
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain(fixedRef);

    // Invalid numeric option & unknown carrier
    const badNum = await captureCli(["collection", "balance", "--timeout", "nan"], {
      env,
    });
    expect(badNum.code).toBe(1);
    const unknownCarrier = await captureCli(["carrier", "+19995550000"]);
    expect(unknownCarrier.code).toBe(0);
    expect(JSON.parse(unknownCarrier.stdout)).toEqual({
      country: null,
      provider: null,
    });

    // Currency-specific balances & missing argument checks
    expect(
      (await captureCli(["collection", "balance", "--currency", "UGX"], { env })).code,
    ).toBe(0);
    expect(
      (
        await captureCli(["disbursement", "balance", "--currency", "UGX"], {
          env,
        })
      ).code,
    ).toBe(0);
    expect(
      (await captureCli(["remittance", "balance", "--currency", "UGX"], { env })).code,
    ).toBe(0);
    expect((await captureCli(["carrier"])).code).toBe(1);
    expect((await captureCli(["sandbox", "get-user"])).code).toBe(1);
    expect((await captureCli(["collection", "request-to-pay"], { env })).code).toBe(1);
    expect((await captureCli(["disbursement", "transfer"], { env })).code).toBe(1);
    expect((await captureCli(["remittance", "transfer"], { env })).code).toBe(1);
    expect((await captureCli(["webhook", "verify"])).code).toBe(1);
    expect((await captureCli(["airtel", "encrypt-pin"])).code).toBe(1);
  });
});
