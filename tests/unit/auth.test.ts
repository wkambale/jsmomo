import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { TokenCache } from "../../src/auth.js";

describe("TokenCache", () => {
  it("stores, retrieves, isolates namespaces, and redacts tokens from inspect/toString", () => {
    const cache = new TokenCache();
    cache.set("collection", "tok-sandbox", 3600, { namespace: "sandbox" });
    cache.set("collection", "tok-prod", 3600, { namespace: "mtnuganda" });

    expect(cache.get("collection", { namespace: "sandbox" })).toBe("tok-sandbox");
    expect(cache.get("collection", { namespace: "mtnuganda" })).toBe("tok-prod");
    expect(cache.get("disbursement", { namespace: "sandbox" })).toBeNull();

    expect(String(cache)).not.toContain("tok-sandbox");
    expect(inspect(cache)).not.toContain("tok-prod");
    expect(String(cache)).toContain("sandbox:collection");

    // Delimiter ambiguity must not collide across namespaces/products (Issue #18)
    cache.set("b:c", "tok-tenant-a", 3600, { namespace: "a" });
    expect(cache.get("c", { namespace: "a:b" })).toBeNull();
    cache.set("a:b", "tok-default-ns", 3600);
    expect(cache.get("b", { namespace: "a" })).toBeNull();
  });

  it("supports CAS expectedToken invalidation so stale 401 never evicts fresh token", () => {
    const cache = new TokenCache();
    cache.set("collection", "fresh-T2", 3600);
    cache.invalidate("collection", { expectedToken: "stale-T1" });
    expect(cache.get("collection")).toBe("fresh-T2");

    cache.invalidate("collection", { expectedToken: "fresh-T2" });
    expect(cache.get("collection")).toBeNull();
  });

  it("deduplicates concurrent refreshes with getOrRefresh", async () => {
    const cache = new TokenCache();
    let calls = 0;
    const fetcher = async (): Promise<string> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 15));
      cache.set("collection", "shared-token", 3600);
      return "shared-token";
    };

    const results = await Promise.all([
      cache.getOrRefresh("collection", fetcher),
      cache.getOrRefresh("collection", fetcher),
      cache.getOrRefresh("collection", fetcher),
    ]);
    expect(calls).toBe(1);
    expect(results).toEqual(["shared-token", "shared-token", "shared-token"]);
  });

  it("validates non-empty token and positive integer expiresIn", () => {
    const cache = new TokenCache();
    expect(() => cache.set("collection", "  ", 3600)).toThrow(RangeError);
    expect(() => cache.set("collection", "tok", 0)).toThrow(RangeError);
    expect(() => cache.set("collection", "tok", 1.5)).toThrow(RangeError);
    // Short-lived token (e.g. 10s) scales margin to 20% instead of expiring immediately
    cache.set("collection", "short-tok", 10);
    expect(cache.get("collection")).toBe("short-tok");
  });
});
