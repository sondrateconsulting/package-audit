import { expect, test, describe } from "bun:test";
import { parseVersion, meetsMinimum, detectTarFlavor, hasReadOrgScope, runPreflight } from "./preflight.ts";
import type { GithubClient } from "./github.ts";
import type { Config } from "./config.ts";

describe("parseVersion", () => {
  test("extracts the first dotted tuple", () => {
    expect(parseVersion("git version 2.45.1")).toEqual([2, 45, 1]);
    expect(parseVersion("1.3.14")).toEqual([1, 3, 14]);
    expect(parseVersion("gh version 2.95.0 (2024-01-01)")).toEqual([2, 95, 0]);
    expect(parseVersion("2.45")).toEqual([2, 45, 0]); // missing patch → 0
  });
  test("null when no version present", () => {
    expect(parseVersion("no numbers here")).toBeNull();
  });
  test("null for a bare number without a dotted minor (major.minor are required)", () => {
    expect(parseVersion("just 2")).toBeNull();
    expect(parseVersion("bun 2")).toBeNull();
  });
});

describe("meetsMinimum — FULL tuple compare", () => {
  test("2.45.0 fails the 2.45.1 minimum; 2.45.1 and 2.100.0 pass", () => {
    expect(meetsMinimum([2, 45, 0], [2, 45, 1])).toBe(false);
    expect(meetsMinimum([2, 45, 1], [2, 45, 1])).toBe(true);
    expect(meetsMinimum([2, 100, 0], [2, 45, 1])).toBe(true); // NOT string-compared
    expect(meetsMinimum([3, 0, 0], [2, 45, 1])).toBe(true);
    expect(meetsMinimum([1, 99, 99], [2, 45, 1])).toBe(false);
  });
  test("bun 1.0.99 fails, 1.1.0 passes", () => {
    expect(meetsMinimum([1, 0, 99], [1, 1, 0])).toBe(false);
    expect(meetsMinimum([1, 1, 0], [1, 1, 0])).toBe(true);
  });
});

describe("detectTarFlavor", () => {
  test("recognizes GNU and bsdtar", () => {
    expect(detectTarFlavor("tar (GNU tar) 1.34")).toBe("gnu");
    expect(detectTarFlavor("bsdtar 3.5.3 - libarchive 3.7.4")).toBe("bsd");
    expect(detectTarFlavor("some other tar")).toBe("unknown");
  });
});

describe("hasReadOrgScope", () => {
  test("true when read:org or admin:org present", () => {
    expect(hasReadOrgScope("repo, read:org, gist")).toBe(true);
    expect(hasReadOrgScope("admin:org")).toBe(true);
  });
  test("false for absent header or missing scope (fine-grained token)", () => {
    expect(hasReadOrgScope(undefined)).toBe(false);
    expect(hasReadOrgScope("repo, gist")).toBe(false);
    expect(hasReadOrgScope("")).toBe(false);
  });
});

describe("runPreflight registry probe deadline (§5.E hardening)", () => {
  // every prior test injects deps.fetchImpl, which bypasses the DEFAULT fetch closure — the
  // one carrying the AbortSignal.timeout deadline. This exercises the real closure against a
  // wedged registry (a fetch that never responds, only rejecting when the signal aborts).
  const stubClient = {
    gh: async () => ({ exitCode: 0, stdout: "gh version 2.95.0", stderr: "" }),
    git: async () => ({ exitCode: 0, stdout: "git version 2.45.1", stderr: "" }),
    tar: async () => ({ exitCode: 0, stdout: "bsdtar 3.5.3 - libarchive 3.7.4", stderr: "" }),
    restGet: async () => ({ body: JSON.stringify({ login: "u" }), headers: {} }),
    rateLimit: async () => ({ resources: { core: { remaining: 100 }, graphql: { remaining: 100 } } }),
  } as unknown as GithubClient;
  const config = {
    githubHost: "github.com", organizations: ["org-a"],
    packages: [{ name: "expo", registryUrl: "https://registry.example.com", registryAuthEnvVar: null }],
  } as unknown as Config;

  // the tsconfig lib is ESNext-only, so the platform AbortSignal type is memberless here —
  // a minimal structural shape gives the stub the two members it needs.
  interface AbortSignalLike {
    addEventListener(type: "abort", cb: () => void): void;
    reason?: unknown;
  }

  test("the default fetch closure aborts a hung registry probe at the deadline", async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string, init?: { signal?: AbortSignalLike }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    try {
      await expect(runPreflight(stubClient, config, { registryFetchTimeoutMs: 10 }))
        .rejects.toThrow(/registry .* unreachable/);
    } finally {
      globalThis.fetch = prevFetch;
    }
  }, 2_000);
});
