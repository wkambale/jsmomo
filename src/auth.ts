import { inspect } from "node:util";

const MAX_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

/**
 * In-memory OAuth2 token cache with namespace isolation, monotonic expiry,
 * conditional CAS invalidation, and single-flight refresh deduplication.
 */
export class TokenCache {
  private readonly cache = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<string>>();

  private static makeKey(product: string, namespace: string): string {
    return namespace ? `${namespace}:${product}` : product;
  }

  /** Return a valid cached token or `null` if absent or expired. */
  public get(product: string, options: { namespace?: string } = {}): string | null {
    const key = TokenCache.makeKey(product, options.namespace ?? "");
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }
    if (performance.now() >= entry.expiresAtMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.accessToken;
  }

  /**
   * Cache a token with a safety margin before expiry (up to 30 seconds,
   * scaled to 20% of `expiresIn` for short-lived tokens).
   */
  public set(
    product: string,
    accessToken: string,
    expiresIn: number,
    options: { namespace?: string } = {},
  ): void {
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new RangeError("accessToken must be a non-empty string");
    }
    if (
      typeof expiresIn !== "number" ||
      !Number.isInteger(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new RangeError("expiresIn must be a positive integer");
    }
    const boundedTtl = Math.min(expiresIn, MAX_TOKEN_TTL_SECONDS);
    const marginSec = Math.min(30.0, boundedTtl * 0.2);
    const expiresAtMs = performance.now() + (boundedTtl - marginSec) * 1000;
    const key = TokenCache.makeKey(product, options.namespace ?? "");
    this.cache.set(key, { accessToken, expiresAtMs });
  }

  /**
   * Remove a cached token, forcing the next call to re-authenticate.
   * When `expectedToken` is supplied, only evicts if the current entry matches.
   */
  public invalidate(
    product: string,
    options: { expectedToken?: string | null; namespace?: string } = {},
  ): void {
    const key = TokenCache.makeKey(product, options.namespace ?? "");
    if (options.expectedToken !== undefined && options.expectedToken !== null) {
      const entry = this.cache.get(key);
      if (!entry || entry.accessToken !== options.expectedToken) {
        return;
      }
    }
    this.cache.delete(key);
  }

  /**
   * Deduplicate concurrent token fetches for the same `(product, namespace)` key.
   */
  public async getOrRefresh(
    product: string,
    fetcher: () => Promise<string>,
    options: { namespace?: string } = {},
  ): Promise<string> {
    const namespace = options.namespace ?? "";
    const cached = this.get(product, { namespace });
    if (cached !== null) {
      return cached;
    }
    const key = TokenCache.makeKey(product, namespace);
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }
    const promise = (async () => {
      try {
        return await fetcher();
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  public toString(): string {
    const products = [...this.cache.keys()].sort();
    return `TokenCache(products=${JSON.stringify(products)})`;
  }

  public [inspect.custom](): string {
    return this.toString();
  }
}
