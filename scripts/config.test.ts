import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateAndNormalize, computeConfigHash, resolveConfigPath, loadConfig, ConfigError,
  CONFIG_ROOT_KEYS, CONFIG_CONCURRENCY_KEYS, CONFIG_PATHS_KEYS, CONFIG_PACKAGE_KEYS,
  CONFIG_TIMEOUTS_KEYS, DEFAULT_TIMEOUTS,
  type Config, type Timeouts,
} from "./config.ts";

// Compile-only (NEVER called): the `readonly` modifiers on Timeouts' fields and on Config.timeouts
// must reject mutation of a validated, shared config. Each @ts-expect-error below turns into an
// "unused directive" typecheck ERROR the instant its readonly regresses — so `bun run typecheck` is
// the real assertion here. (finding ADVISORY-6d)
function _readonlyTimeoutsCompileGuard(t: Timeouts, c: Config): void {
  // @ts-expect-error — Timeouts.controlApiSeconds is readonly
  t.controlApiSeconds = 0;
  // @ts-expect-error — Timeouts.bulkApiSeconds is readonly
  t.bulkApiSeconds = 0;
  // @ts-expect-error — Timeouts.cloneSeconds is readonly
  t.cloneSeconds = 0;
  // @ts-expect-error — Timeouts.tarSeconds is readonly
  t.tarSeconds = 0;
  // @ts-expect-error — Timeouts.probeSeconds is readonly
  t.probeSeconds = 0;
  // @ts-expect-error — Timeouts.heartbeatSeconds is readonly
  t.heartbeatSeconds = 0;
  // @ts-expect-error — Config.timeouts is readonly (the whole validated object can't be swapped out)
  c.timeouts = t;
}

const baseRaw = (): Record<string, unknown> => ({
  githubHost: "github.com",
  organizations: null,
  excludeOrganizations: [],
  includePersonalNamespace: false,
  includeForks: false,
  includeArchived: false,
  maxReposPerOrg: null,
  maxBranchesPerRepo: 25,
  cutoffDate: "2024-01-01",
  concurrency: { organizations: 3, repositories: 6, branches: 4 },
  packages: [{ name: "expo" }],
  excludeDirGlobs: ["**/node_modules/**"],
  paths: { sqlitePath: "./data/audit.db", outputDir: "./output" },
});

const norm = (raw: Record<string, unknown>, env: Record<string, string | undefined> = {}) =>
  validateAndNormalize(raw, env);
const hashOf = (raw: Record<string, unknown>, env: Record<string, string | undefined> = {}) =>
  computeConfigHash(norm(raw, env));

describe("validateAndNormalize — happy path + defaults", () => {
  test("valid config normalizes with defaults", () => {
    const c = norm({ ...baseRaw(), githubHost: undefined, includeForks: undefined });
    expect(c.githubHost).toBe("github.com");
    expect(c.includeForks).toBe(false);
    expect(c.packages[0]).toEqual({ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null });
    expect(c.organizations).toBeNull();
  });
  test("organizations [] stays configured-empty (distinct from null)", () => {
    expect(norm({ ...baseRaw(), organizations: [] }).organizations).toEqual([]);
    expect(norm({ ...baseRaw(), organizations: null }).organizations).toBeNull();
  });
  test("branches null (default) / [] / [..] normalize distinctly; excludeBranches defaults to []", () => {
    expect(norm(baseRaw()).branches).toBeNull();
    expect(norm(baseRaw()).excludeBranches).toEqual([]);
    expect(norm({ ...baseRaw(), branches: [] }).branches).toEqual([]);
    expect(norm({ ...baseRaw(), branches: ["main", "release/*"] }).branches).toEqual(["main", "release/*"]);
    expect(norm({ ...baseRaw(), excludeBranches: null }).excludeBranches).toEqual([]);
    expect(norm({ ...baseRaw(), excludeBranches: ["dependabot/*"] }).excludeBranches).toEqual(["dependabot/*"]);
  });
  test("excludeRepositories null (default) / [] / [..] normalize; default is [], order preserved as-written", () => {
    expect(norm(baseRaw()).excludeRepositories).toEqual([]);
    // null and omitted both collapse to [] (an absent and an explicit-empty denylist mean the same).
    expect(norm({ ...baseRaw(), excludeRepositories: null }).excludeRepositories).toEqual([]);
    expect(norm({ ...baseRaw(), excludeRepositories: [] }).excludeRepositories).toEqual([]);
    // the normalized value is the raw validated strings in file order (NOT folded/sorted — the ASCII
    // fold + sortedDedup happen only in the hash projection and the compiled policy, not here).
    expect(norm({ ...baseRaw(), excludeRepositories: ["acme/legacy-*", "*/sandbox"] }).excludeRepositories)
      .toEqual(["acme/legacy-*", "*/sandbox"]);
  });
  test("registryUrl trailing slash canonicalized in hash", () => {
    const a = hashOf({ ...baseRaw(), packages: [{ name: "x", registryUrl: "https://r.example.com/" }] });
    const b = hashOf({ ...baseRaw(), packages: [{ name: "x", registryUrl: "https://r.example.com" }] });
    expect(a).toBe(b);
  });
  test("registryAuthEnvVar accepted when env var is set", () => {
    const c = norm({ ...baseRaw(), packages: [{ name: "x", registryAuthEnvVar: "MY_TOKEN" }] }, { MY_TOKEN: "secret" });
    expect(c.packages[0]!.registryAuthEnvVar).toBe("MY_TOKEN");
  });
});

describe("timeouts (T11) — defaults, per-field override, validation, hash exclusion", () => {
  test("omitted timeouts yields all defaults", () => {
    const c = norm({ ...baseRaw() });
    expect(c.timeouts).toEqual(DEFAULT_TIMEOUTS);
  });
  test("an explicit null timeouts also yields all defaults", () => {
    expect(norm({ ...baseRaw(), timeouts: null }).timeouts).toEqual(DEFAULT_TIMEOUTS);
  });
  test("a partial override keeps the other fields at their defaults", () => {
    const c = norm({ ...baseRaw(), timeouts: { bulkApiSeconds: 1800, probeSeconds: 5 } });
    expect(c.timeouts.bulkApiSeconds).toBe(1800);
    expect(c.timeouts.probeSeconds).toBe(5);
    expect(c.timeouts.controlApiSeconds).toBe(DEFAULT_TIMEOUTS.controlApiSeconds);
    expect(c.timeouts.cloneSeconds).toBe(DEFAULT_TIMEOUTS.cloneSeconds);
    expect(c.timeouts.tarSeconds).toBe(DEFAULT_TIMEOUTS.tarSeconds);
    expect(c.timeouts.heartbeatSeconds).toBe(DEFAULT_TIMEOUTS.heartbeatSeconds);
  });
  test("the default magnitudes are pinned (control tighter than the bulk/clone/tar budget)", () => {
    expect(DEFAULT_TIMEOUTS).toEqual({
      controlApiSeconds: 300, bulkApiSeconds: 900, cloneSeconds: 900, tarSeconds: 900, probeSeconds: 10, heartbeatSeconds: 30,
    });
  });
  test("a non-positive or non-integer timeout is rejected (a nonpositive deadline instantly expires every spawn)", () => {
    expect(() => norm({ ...baseRaw(), timeouts: { probeSeconds: 0 } })).toThrow(/timeouts\.probeSeconds must be a positive integer/);
    expect(() => norm({ ...baseRaw(), timeouts: { cloneSeconds: -1 } })).toThrow(/timeouts\.cloneSeconds must be a positive integer/);
    expect(() => norm({ ...baseRaw(), timeouts: { tarSeconds: 1.5 } })).toThrow(/timeouts\.tarSeconds must be a positive integer/);
    expect(() => norm({ ...baseRaw(), timeouts: 5 })).toThrow(/timeouts must be an object/);
  });
  test("the whole timeouts object may be null (= all defaults), but a per-field null is rejected", () => {
    expect(norm({ ...baseRaw(), timeouts: null }).timeouts).toEqual(DEFAULT_TIMEOUTS); // whole-object null OK
    expect(() => norm({ ...baseRaw(), timeouts: { probeSeconds: null } })).toThrow(/timeouts\.probeSeconds must be a positive integer/); // per-field null rejected (schema says integer)
  });
  test("an unknown timeouts key is rejected with a did-you-mean hint", () => {
    expect(() => norm({ ...baseRaw(), timeouts: { probeSecond: 5 } }))
      .toThrow(/unknown config key \$\.timeouts\.probeSecond — did you mean "probeSeconds"\?/);
  });
  test("changing a timeout does NOT change the config hash (tuning deadlines never orphans resumable work)", () => {
    const a = hashOf({ ...baseRaw() });
    const b = hashOf({ ...baseRaw(), timeouts: { bulkApiSeconds: 1, controlApiSeconds: 1, cloneSeconds: 1, tarSeconds: 1, probeSeconds: 1, heartbeatSeconds: 1 } });
    expect(a).toBe(b);
  });
});

describe("validateAndNormalize — validation failures", () => {
  const bad: Array<[string, Record<string, unknown>, Record<string, string | undefined>?]> = [
    ["missing packages", { ...baseRaw(), packages: undefined }],
    ["empty packages", { ...baseRaw(), packages: [] }],
    ["duplicate package names", { ...baseRaw(), packages: [{ name: "a" }, { name: "a" }] }],
    ["http registryUrl", { ...baseRaw(), packages: [{ name: "a", registryUrl: "http://r.com" }] }],
    ["registryUrl with userinfo", { ...baseRaw(), packages: [{ name: "a", registryUrl: "https://u:p@r.com" }] }],
    ["registryAuthEnvVar not set", { ...baseRaw(), packages: [{ name: "a", registryAuthEnvVar: "MISSING" }] }],
    ["bad cutoffDate format", { ...baseRaw(), cutoffDate: "2024/01/01" }],
    ["impossible cutoffDate", { ...baseRaw(), cutoffDate: "2024-13-40" }],
    ["zero maxBranchesPerRepo", { ...baseRaw(), maxBranchesPerRepo: 0 }],
    ["negative maxReposPerOrg", { ...baseRaw(), maxReposPerOrg: -1 }],
    ["non-object concurrency", { ...baseRaw(), concurrency: 5 }],
    ["over-max concurrency value", { ...baseRaw(), concurrency: { organizations: 3, repositories: 6, branches: 65 } }],
    ["missing paths", { ...baseRaw(), paths: undefined }],
    ["githubHost with scheme", { ...baseRaw(), githubHost: "https://gh.com" }],
    ["empty-string branch pattern", { ...baseRaw(), branches: ["main", ""] }],
    ["empty-string excludeBranch pattern", { ...baseRaw(), excludeBranches: [""] }],
    ["leading-! branch pattern (negation unsupported)", { ...baseRaw(), branches: ["!main"] }],
    ["leading-! excludeBranch pattern", { ...baseRaw(), excludeBranches: ["!release/*"] }],
    ["branches not null and not array", { ...baseRaw(), branches: "main" }],
    ["excludeBranches not an array", { ...baseRaw(), excludeBranches: "dependabot/*" }],
    ["empty-string excludeRepositories pattern", { ...baseRaw(), excludeRepositories: [""] }],
    ["leading-! excludeRepositories pattern", { ...baseRaw(), excludeRepositories: ["!acme/legacy"] }],
    ["excludeRepositories not an array", { ...baseRaw(), excludeRepositories: "acme/*" }],
    ["non-string excludeRepositories element", { ...baseRaw(), excludeRepositories: [42] }],
    ["non-string branch element", { ...baseRaw(), branches: [123] }],
    ["empty-string organization", { ...baseRaw(), organizations: ["acme", ""] }],
    ["non-string organization element", { ...baseRaw(), organizations: [42] }],
    ["empty-string excludeOrganization", { ...baseRaw(), excludeOrganizations: [""] }],
    ["empty-string excludeDirGlob", { ...baseRaw(), excludeDirGlobs: ["**/dist/**", ""] }],
    ["non-object root", 42 as unknown as Record<string, unknown>],
  ];
  for (const [name, raw, env] of bad)
    test(name, () => expect(() => norm(raw, env)).toThrow(ConfigError));

  test("empty-string item diagnostics name the key and the index", () => {
    expect(() => norm({ ...baseRaw(), organizations: ["acme", ""] }))
      .toThrow(/organizations\[1\] must be a non-empty string/);
    expect(() => norm({ ...baseRaw(), excludeOrganizations: [""] }))
      .toThrow(/excludeOrganizations\[0\] must be a non-empty string/);
    expect(() => norm({ ...baseRaw(), excludeDirGlobs: ["**/dist/**", ""] }))
      .toThrow(/excludeDirGlobs\[1\] must be a non-empty string/);
    expect(() => norm({ ...baseRaw(), excludeRepositories: ["acme/api", ""] }))
      .toThrow(/excludeRepositories\[1\] must be a non-empty string/);
  });

  test("excludeRepositories leading-! rejected with a repo-specific remediation (NOT the branch text)", () => {
    // Mirrors validateBranchPattern's leading-! rejection but the remediation names excludeRepositories,
    // not branches — a leading '!' is Bun.Glob negation, unsupported as a policy-language restriction.
    expect(() => norm({ ...baseRaw(), excludeRepositories: ["!acme/legacy"] }))
      .toThrow(/excludeRepositories\[0\] must not start with "!"/);
  });

  // `organizations` and `branches` each name a root-level allowlist AND a key under `concurrency`.
  // The hint fires only when the VALUE fits the sibling — a wrong hint is worse than none.
  describe("sibling-key hints for the root/concurrency name collision", () => {
    const conc = (over: Record<string, unknown>) =>
      ({ ...baseRaw(), concurrency: { organizations: 3, repositories: 6, branches: 4, ...over } });

    test("a LIST under concurrency.<k> points at the root-level allowlist of that name", () => {
      expect(() => norm(conc({ branches: ["main", "release/*"] })))
        .toThrow(/concurrency\.branches must be a positive integer — for a list of branch names you likely meant the root-level "branches" allowlist/);
      expect(() => norm(conc({ organizations: ["acme"] })))
        .toThrow(/concurrency\.organizations must be a positive integer — for a list of organization names you likely meant the root-level "organizations" allowlist/);
    });

    // Both numeric twins are real now: maxBranchesPerRepo (the per-repo cap) and concurrency.branches
    // (the per-repo branch fan-out width, §5). The hint offers both and lets the operator pick.
    test("a NUMBER under root branches names BOTH numeric twins — guessing between them would be a coin flip", () => {
      expect(() => norm({ ...baseRaw(), branches: 4 }))
        .toThrow(/branches must be null or an array of strings — for a number you likely meant "maxBranchesPerRepo" \(the per-repo branch cap\) or "concurrency\.branches"/);
    });

    test("a NUMBER under root organizations names its one twin", () => {
      expect(() => norm({ ...baseRaw(), organizations: 3 }))
        .toThrow(/organizations must be null or an array of strings — for a number you likely meant "concurrency\.organizations"/);
    });

    test("SILENT when the value fits no sibling: the base error stands alone", () => {
      expect(() => norm({ ...baseRaw(), branches: { a: 1 } })).toThrow(/^branches must be null or an array of strings$/);
      expect(() => norm({ ...baseRaw(), organizations: "acme" })).toThrow(/^organizations must be null or an array of strings$/);
      // 0 is not a positive integer — it fits neither concurrency.branches nor maxBranchesPerRepo.
      expect(() => norm({ ...baseRaw(), branches: 0 })).toThrow(/^branches must be null or an array of strings$/);
      expect(() => norm(conc({ branches: "4" }))).toThrow(/^concurrency\.branches must be a positive integer$/);
    });

    test("SILENT for a '!'-prefixed list — the root allowlist would reject it too, so the hint would trade one error for another", () => {
      expect(() => norm(conc({ branches: ["!main"] }))).toThrow(/^concurrency\.branches must be a positive integer$/);
    });

    test("concurrency.repositories has no root-level twin and never hints", () => {
      expect(() => norm(conc({ repositories: ["a"] }))).toThrow(/^concurrency\.repositories must be a positive integer$/);
    });
  });
});

describe("concurrency defaults + ceiling (§5 fan-out)", () => {
  test("an omitted concurrency block falls back to ALL defaults (org 3, repos 8, branches 4)", () => {
    const raw = baseRaw();
    delete raw["concurrency"];
    expect(norm(raw).concurrency).toEqual({ organizations: 3, repositories: 8, branches: 4 });
  });
  test("a partial concurrency block defaults ONLY the absent keys", () => {
    expect(norm({ ...baseRaw(), concurrency: { repositories: 12 } }).concurrency)
      .toEqual({ organizations: 3, repositories: 12, branches: 4 });
  });
  test("a null block and null keys fall back to defaults (parity with the schema's ['type','null'] convention)", () => {
    // The runtime treats null like omitted (config.ts normalizeConcurrency), and config.schema.json
    // now types the block and every key ["…","null"] to match — so an explicit null validates the same
    // in both. Pins that parity so the two can never drift.
    expect(norm({ ...baseRaw(), concurrency: null }).concurrency).toEqual({ organizations: 3, repositories: 8, branches: 4 });
    expect(norm({ ...baseRaw(), concurrency: { organizations: null, repositories: 12, branches: null } }).concurrency)
      .toEqual({ organizations: 3, repositories: 12, branches: 4 });
  });
  test("the documented ceiling (64) is inclusive; 65 is rejected on every key", () => {
    expect(norm({ ...baseRaw(), concurrency: { organizations: 64, repositories: 64, branches: 64 } }).concurrency)
      .toEqual({ organizations: 64, repositories: 64, branches: 64 });
    for (const k of ["organizations", "repositories", "branches"] as const)
      expect(() => norm({ ...baseRaw(), concurrency: { [k]: 65 } })).toThrow(/must be <= 64/);
  });
  test("still rejects non-positive / non-integer values (defaults never mask a real mistake)", () => {
    expect(() => norm({ ...baseRaw(), concurrency: { organizations: 0 } })).toThrow(/must be a positive integer/);
    expect(() => norm({ ...baseRaw(), concurrency: { branches: 1.5 } })).toThrow(/must be a positive integer/);
  });
});

describe("computeConfigHash — determinism + scope", () => {
  test("same config → same hash", () => expect(hashOf(baseRaw())).toBe(hashOf(baseRaw())));

  // UPGRADE REGRESSION PIN: the work queue is keyed by config_hash. A config that configures NO branch
  // policy scans exactly what it scanned before the policy feature existed, so its hash MUST NOT change —
  // otherwise every existing user's completed units are orphaned on upgrade and a full rescan is forced.
  // (The pre-v4 RUNNING run itself is failed at the v3→v4 boundary BY DESIGN — see migrateV3toV4's
  // boundary rule — but its completed units skip-as-current in the new run precisely because this
  // hash is stable.) This literal was verified byte-equal against the pre-feature
  // implementation at 81d79a1: the hashed projection omits branches/excludeBranches when neither is set.
  test("a policy-FREE config keeps its PRE-FEATURE hash (legacy work_queue reuse survives the upgrade)", () => {
    expect(hashOf(baseRaw())).toBe("86b8d1c1c68298fbe85dbe5012e9a7110ae3ed260ccf3c468ab920d62d8efe8b");
    // explicitly writing the legacy defaults is still the same policy → still the same hash
    expect(hashOf({ ...baseRaw(), branches: null, excludeBranches: [] })).toBe(hashOf(baseRaw()));
  });

  // excludeRepositories hash projection: ASCII-folded (sortedDedup), folded into the hash ONLY when
  // non-empty via a hasRepoPolicy gate INDEPENDENT of the branch-policy gate (mirrors hasBranchPolicy).
  test("a repo-policy-free config keeps its PRE-FEATURE hash; the repo feature never perturbs existing BRANCH hashes", () => {
    // policy-free baseline — same literal the branch-policy legacy pin verified byte-equal at 81d79a1
    // (the excludeRepositories spread must stay OUT of the projection when empty):
    expect(hashOf(baseRaw())).toBe("86b8d1c1c68298fbe85dbe5012e9a7110ae3ed260ccf3c468ab920d62d8efe8b");
    // CONFIGURED branch-policy hashes must be byte-identical to their pre-repo-feature values — a
    // stray excludeRepositories:[] leaking into a branch-policy projection would silently churn these
    // and orphan every branch-policy user's work_queue on upgrade (verified at d18240b, pre-feature):
    expect(hashOf({ ...baseRaw(), branches: ["main"] })).toBe("caba45c375db20c05bbd8affeb04bc189c750becbc7dfb047c2ffd96c910ff0e");
    expect(hashOf({ ...baseRaw(), excludeBranches: ["dev"] })).toBe("f399b30d59fff91259501202dae039b0e9456a5bbd990a4467197b9641c0093f");
    // an explicit empty / null excludeRepositories is the SAME policy as omitted → same hash
    expect(hashOf({ ...baseRaw(), excludeRepositories: [] })).toBe(hashOf(baseRaw()));
    expect(hashOf({ ...baseRaw(), excludeRepositories: null })).toBe(hashOf(baseRaw()));
  });
  test("a non-empty excludeRepositories changes the hash and composes distinctly with branch policy", () => {
    const free = hashOf(baseRaw());
    const repoOnly = hashOf({ ...baseRaw(), excludeRepositories: ["acme/legacy-*"] });
    const branchOnly = hashOf({ ...baseRaw(), excludeBranches: ["dev"] });
    const both = hashOf({ ...baseRaw(), excludeRepositories: ["acme/legacy-*"], excludeBranches: ["dev"] });
    expect(repoOnly).not.toBe(free);
    expect(new Set([free, repoOnly, branchOnly, both]).size).toBe(4); // four distinct scopes
  });
  test("excludeRepositories reorder/dupe does not change the hash (sortedDedup)", () => {
    const a = hashOf({ ...baseRaw(), excludeRepositories: ["a/x", "b/y"] });
    const b = hashOf({ ...baseRaw(), excludeRepositories: ["b/y", "a/x", "a/x"] });
    expect(a).toBe(b);
  });
  test("excludeRepositories hash is CASE-INSENSITIVE via the ASCII fold: case-only edits hash identically", () => {
    expect(hashOf({ ...baseRaw(), excludeRepositories: ["ACME/Legacy-API"] }))
      .toBe(hashOf({ ...baseRaw(), excludeRepositories: ["acme/legacy-api"] }));
  });
  test("the fold is ASCII-ONLY (NOT Unicode): non-ASCII case variants stay DISTINCT — guards against a toLowerCase() swap", () => {
    // Ä (U+00C4) vs ä (U+00E4): an ASCII-only fold (A-Z only) leaves BOTH untouched, so they stay
    // distinct code-unit sequences → distinct hashes. String.prototype.toLowerCase would collapse Ä→ä
    // and make these collide, so this test fails the moment someone substitutes a Unicode fold.
    expect(hashOf({ ...baseRaw(), excludeRepositories: ["Äcme/repo"] }))
      .not.toBe(hashOf({ ...baseRaw(), excludeRepositories: ["äcme/repo"] }));
  });
  test("any CONFIGURED branch policy changes the hash, and null (unrestricted) stays distinct from [] (default-only)", () => {
    const free = hashOf(baseRaw());
    const emptyAllowlist = hashOf({ ...baseRaw(), branches: [] });
    const denyOnly = hashOf({ ...baseRaw(), excludeBranches: ["dev"] });
    const allowlist = hashOf({ ...baseRaw(), branches: ["main"] });
    expect(new Set([free, emptyAllowlist, denyOnly, allowlist]).size).toBe(4); // all four are distinct scopes
  });
  test("key insertion order does not change the hash", () => {
    const b = baseRaw();
    const reordered = Object.fromEntries(Object.entries(b).reverse());
    expect(hashOf(reordered)).toBe(hashOf(b));
  });
  test("package reorder does not change the hash", () => {
    const a = hashOf({ ...baseRaw(), packages: [{ name: "a" }, { name: "b" }] });
    const b = hashOf({ ...baseRaw(), packages: [{ name: "b" }, { name: "a" }] });
    expect(a).toBe(b);
  });
  test("excludeOrganizations reorder/dupe does not change the hash", () => {
    const a = hashOf({ ...baseRaw(), excludeOrganizations: ["x", "y"] });
    const b = hashOf({ ...baseRaw(), excludeOrganizations: ["y", "x", "x"] });
    expect(a).toBe(b);
  });
  test("concurrency change does NOT change the hash (resumability preserved)", () => {
    const a = hashOf(baseRaw());
    const b = hashOf({ ...baseRaw(), concurrency: { organizations: 1, repositories: 1, branches: 1 } });
    expect(a).toBe(b);
  });
  test("paths change does NOT change the hash", () => {
    const a = hashOf(baseRaw());
    const b = hashOf({ ...baseRaw(), paths: { sqlitePath: "./data/other.db", outputDir: "./output/sub" } });
    expect(a).toBe(b);
  });
  test("cutoffDate change DOES change the hash", () =>
    expect(hashOf(baseRaw())).not.toBe(hashOf({ ...baseRaw(), cutoffDate: "2023-01-01" })));
  test("organizations null vs [] produce DIFFERENT hashes", () =>
    expect(hashOf({ ...baseRaw(), organizations: null })).not.toBe(hashOf({ ...baseRaw(), organizations: [] })));
  test("branches null vs [] produce DIFFERENT hashes", () =>
    expect(hashOf({ ...baseRaw(), branches: null })).not.toBe(hashOf({ ...baseRaw(), branches: [] })));
  test("branches reorder/dupe does not change the hash", () => {
    const a = hashOf({ ...baseRaw(), branches: ["a", "b"] });
    const b = hashOf({ ...baseRaw(), branches: ["b", "a", "a"] });
    expect(a).toBe(b);
  });
  test("excludeBranches reorder/dupe does not change the hash", () => {
    const a = hashOf({ ...baseRaw(), excludeBranches: ["x", "y"] });
    const b = hashOf({ ...baseRaw(), excludeBranches: ["y", "x", "x"] });
    expect(a).toBe(b);
  });
  test("branches change DOES change the hash", () =>
    expect(hashOf({ ...baseRaw(), branches: ["main"] })).not.toBe(hashOf({ ...baseRaw(), branches: ["develop"] })));
  test("excludeBranches change DOES change the hash", () =>
    expect(hashOf(baseRaw())).not.toBe(hashOf({ ...baseRaw(), excludeBranches: ["dependabot/*"] })));
  test("includeForks change DOES change the hash", () =>
    expect(hashOf(baseRaw())).not.toBe(hashOf({ ...baseRaw(), includeForks: true })));
  test("registryAuthEnvVar NAME participates but token VALUE does not", () => {
    const withVar = hashOf({ ...baseRaw(), packages: [{ name: "x", registryAuthEnvVar: "TK" }] }, { TK: "aaa" });
    const diffVal = hashOf({ ...baseRaw(), packages: [{ name: "x", registryAuthEnvVar: "TK" }] }, { TK: "bbb" });
    const noVar = hashOf({ ...baseRaw(), packages: [{ name: "x" }] });
    expect(withVar).toBe(diffVal); // token value not hashed
    expect(withVar).not.toBe(noVar); // env var NAME participates
  });
});

describe("resolveConfigPath — precedence", () => {
  test("--config flag wins", () => expect(resolveConfigPath(["--config", "/a/b.json"], {})).toBe("/a/b.json"));
  test("CONFIG_PATH env next", () => expect(resolveConfigPath([], { CONFIG_PATH: "/env.json" })).toBe("/env.json"));
  test("default ./config.json", () => expect(resolveConfigPath([], {})).toBe("./config.json"));
  test("--config without value throws", () => expect(() => resolveConfigPath(["--config"], {})).toThrow(ConfigError));
});

describe("validateAndNormalize — host + url edge cases", () => {
  test("empty githubHost throws", () => expect(() => norm({ ...baseRaw(), githubHost: "" })).toThrow(ConfigError));
  test("githubHost host:port accepted", () => expect(norm({ ...baseRaw(), githubHost: "ghe.example.com:8443" }).githubHost).toBe("ghe.example.com:8443"));
  test("githubHost out-of-range port throws", () => expect(() => norm({ ...baseRaw(), githubHost: "ghe.example.com:99999" })).toThrow(ConfigError));
  test("registryUrl not a URL throws", () => expect(() => norm({ ...baseRaw(), packages: [{ name: "a", registryUrl: "not a url" }] })).toThrow(ConfigError));
});

describe("computeConfigHash — additional scope coverage", () => {
  test("githubHost change DOES change the hash", () =>
    expect(hashOf(baseRaw())).not.toBe(hashOf({ ...baseRaw(), githubHost: "ghe.example.com" })));
  test("includePersonalNamespace change DOES change the hash", () =>
    expect(hashOf(baseRaw())).not.toBe(hashOf({ ...baseRaw(), includePersonalNamespace: true })));
  test("maxReposPerOrg null vs finite differ", () =>
    expect(hashOf({ ...baseRaw(), maxReposPerOrg: null })).not.toBe(hashOf({ ...baseRaw(), maxReposPerOrg: 10 })));
  test("registryUrl change DOES change the hash", () =>
    expect(hashOf({ ...baseRaw(), packages: [{ name: "x", registryUrl: "https://a.com" }] })).not.toBe(
      hashOf({ ...baseRaw(), packages: [{ name: "x", registryUrl: "https://b.com" }] }),
    ));
  test("excludeDirGlobs reorder does NOT change the hash", () =>
    expect(hashOf({ ...baseRaw(), excludeDirGlobs: ["a", "b"] })).toBe(hashOf({ ...baseRaw(), excludeDirGlobs: ["b", "a"] })));
});

describe("resolveConfigPath — equals form", () => {
  test("--config=/a.json equals form", () => expect(resolveConfigPath(["--config=/a.json"], {})).toBe("/a.json"));
  test("--config= empty throws", () => expect(() => resolveConfigPath(["--config="], {})).toThrow(ConfigError));
});

describe("normalizePaths — containment", () => {
  test("sqlitePath escaping ./data|./output throws", () =>
    expect(() => norm({ ...baseRaw(), paths: { sqlitePath: "/etc/evil.db", outputDir: "./output" } })).toThrow());
  test("outputDir with .. escape throws", () =>
    expect(() => norm({ ...baseRaw(), paths: { sqlitePath: "./data/audit.db", outputDir: "./output/../../etc" } })).toThrow());
});

describe("loadConfig — file I/O", () => {
  const dir = mkdtempSync(join(tmpdir(), "pkg-audit-cfg-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("loads a valid config file", async () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify(baseRaw()));
    const loaded = await loadConfig(["--config", p], {});
    expect(loaded.config.packages[0]!.name).toBe("expo");
    expect(loaded.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.configPath).toBe(p);
  });
  test("loadConfig compiles the branch policy onto LoadedConfig (canonical order)", async () => {
    const p = join(dir, "policy.json");
    writeFileSync(p, JSON.stringify({ ...baseRaw(), branches: ["release/*", "main"], excludeBranches: ["dependabot/*"] }));
    const loaded = await loadConfig(["--config", p], {});
    expect(loaded.branchPolicy.include?.map((c) => c.pattern)).toEqual(["main", "release/*"]);
    expect(loaded.branchPolicy.exclude.map((c) => c.pattern)).toEqual(["dependabot/*"]);
  });
  test("loadConfig leaves branchPolicy.include null when branches is omitted (unrestricted)", async () => {
    const p = join(dir, "nopolicy.json");
    writeFileSync(p, JSON.stringify(baseRaw()));
    const loaded = await loadConfig(["--config", p], {});
    expect(loaded.branchPolicy.include).toBeNull();
    expect(loaded.branchPolicy.exclude).toEqual([]);
  });
  test("loadConfig compiles the repository denylist onto LoadedConfig (ASCII-folded, canonical order)", async () => {
    const p = join(dir, "repopolicy.json");
    writeFileSync(p, JSON.stringify({ ...baseRaw(), excludeRepositories: ["ACME/*", "acme/*", "b/legacy-*"] }));
    const loaded = await loadConfig(["--config", p], {});
    // folded ("ACME/*"→"acme/*") THEN sortedDedup collapses the case-only duplicate; canonical order.
    expect(loaded.repositoryPolicy.map((c) => c.pattern)).toEqual(["acme/*", "b/legacy-*"]);
  });
  test("loadConfig leaves repositoryPolicy empty when excludeRepositories is omitted", async () => {
    const p = join(dir, "norepopolicy.json");
    writeFileSync(p, JSON.stringify(baseRaw()));
    const loaded = await loadConfig(["--config", p], {});
    expect(loaded.repositoryPolicy).toEqual([]);
  });
  test("a repository-glob CONSTRUCTION throw surfaces as ConfigError at load (never mid-run)", async () => {
    // No real pattern throws at construction on the exercised Bun, so force it: swap Bun.Glob for a
    // throwing constructor. The config configures NO branch policy (branches:null, excludeBranches:[]),
    // so compileBranchPolicy constructs no glob — the throw is isolated to the repository compile, whose
    // RepositoryPolicyError loadConfig must re-wrap as ConfigError.
    const p = join(dir, "badrepoglob.json");
    writeFileSync(p, JSON.stringify({ ...baseRaw(), excludeRepositories: ["acme/legacy-*"] }));
    const OriginalGlob = Bun.Glob;
    try {
      (Bun as { Glob: unknown }).Glob = class {
        constructor() { throw new Error("forced construction failure"); }
      };
      await expect(loadConfig(["--config", p], {})).rejects.toThrow(ConfigError);
    } finally {
      (Bun as { Glob: typeof OriginalGlob }).Glob = OriginalGlob;
    }
  });
  test("missing file throws ConfigError", async () => {
    await expect(loadConfig(["--config", join(dir, "nope.json")], {})).rejects.toThrow(ConfigError);
  });
  test("invalid JSON throws ConfigError", async () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    await expect(loadConfig(["--config", p], {})).rejects.toThrow(ConfigError);
  });
});

describe("resolveConfigPath — empty CONFIG_PATH", () => {
  test("CONFIG_PATH set-but-empty throws (not silent fallthrough)", () =>
    expect(() => resolveConfigPath([], { CONFIG_PATH: "" })).toThrow(ConfigError));
  test("CONFIG_PATH unset falls through to default", () =>
    expect(resolveConfigPath([], {})).toBe("./config.json"));
});

describe("resolveConfigPath — --config precedence over CONFIG_PATH", () => {
  test("--config wins over CONFIG_PATH", () =>
    expect(resolveConfigPath(["--config", "/cli.json"], { CONFIG_PATH: "/env.json" })).toBe("/cli.json"));
  test("--config wins even when CONFIG_PATH is set-empty", () =>
    expect(resolveConfigPath(["--config", "/cli.json"], { CONFIG_PATH: "" })).toBe("/cli.json"));
  test("--config= equals form wins over CONFIG_PATH", () =>
    expect(resolveConfigPath(["--config=/cli.json"], { CONFIG_PATH: "/env.json" })).toBe("/cli.json"));
});

describe("normalizePaths — symlinked root escapes the workspace", () => {
  test("a ./data symlink pointing outside cwd is rejected", () => {
    const work = mkdtempSync(join(tmpdir(), "pkg-audit-work-"));
    const outside = mkdtempSync(join(tmpdir(), "pkg-audit-ext-"));
    const { symlinkSync, mkdirSync: mkdir } = require("node:fs");
    mkdir(join(work, "output"), { recursive: true });
    symlinkSync(outside, join(work, "data")); // ./data -> external dir
    const prev = process.cwd();
    try {
      process.chdir(work);
      expect(() => norm(baseRaw())).toThrow(); // assertContained(dataRoot,[cwd]) throws
    } finally {
      process.chdir(prev);
      rmSync(work, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("unknown-key rejection (strict at every level)", () => {
  test("a typo'd root key fails loudly with did-you-mean — never silently widens the scan", () => {
    // "organization" silently ignored would leave organizations=null = DISCOVERY MODE.
    expect(() => norm({ ...baseRaw(), organization: ["client-org"] } as Record<string, unknown>))
      .toThrow(/unknown config key \$\.organization — did you mean "organizations"\?/);
  });
  test("a distant unknown root key lists the valid keys without a bogus suggestion", () => {
    expect(() => norm({ ...baseRaw(), totallyWrong: 1 } as Record<string, unknown>)).toThrow(/\(valid keys: /);
    expect(() => norm({ ...baseRaw(), totallyWrong: 1 } as Record<string, unknown>)).not.toThrow(/did you mean/);
  });
  test("the did-you-mean cutoff is exactly distance <= 2 (a distance-3 typo gets no hint)", () => {
    // "pathxyz" is edit-distance 3 from "paths" and farther from every other root key. (No
    // equidistant-tie test exists because none is constructible: the minimum pairwise distance
    // between known keys at any level is 5, so no typo can sit within distance 2 of two keys.)
    expect(() => norm({ ...baseRaw(), pathxyz: 1 })).toThrow(/\(valid keys: /);
    expect(() => norm({ ...baseRaw(), pathxyz: 1 })).not.toThrow(/did you mean/);
  });
  test("nested unknown keys report the full JSON path", () => {
    expect(() => norm({ ...baseRaw(), concurrency: { organizations: 3, repositories: 6, branches: 4, brnaches: 2 } }))
      .toThrow(/unknown config key \$\.concurrency\.brnaches — did you mean "branches"\?/);
    expect(() => norm({ ...baseRaw(), paths: { sqlitePath: "./data/a.db", outputDir: "./output", outDir: "x" } }))
      .toThrow(/\$\.paths\.outDir/);
    expect(() => norm({ ...baseRaw(), packages: [{ name: "x", regsitryUrl: "https://r.example.com" }] }))
      .toThrow(/\$\.packages\[0\]\.regsitryUrl — did you mean "registryUrl"\?/);
  });
  test("$schema is allowed at the root (string only) and never changes the hash", () => {
    const with$ = { ...baseRaw(), $schema: "./config.schema.json" };
    expect(() => norm(with$)).not.toThrow();
    expect(hashOf(with$)).toBe(hashOf(baseRaw()));
    expect(() => norm({ ...baseRaw(), $schema: 42 } as Record<string, unknown>)).toThrow(ConfigError);
  });
});

describe("normalizePackages — hostile package name is rejected (fail-closed)", () => {
  const BS = String.fromCharCode(92); // a REAL backslash
  test("an injecting backslash name throws ConfigError (never reaches the network layer)", () =>
    expect(() => norm({ ...baseRaw(), packages: [{ name: `@x${BS}..${BS}..${BS}admin?x=1` }] })).toThrow(ConfigError));
  test("a valid name ('expo') does NOT throw for the name reason", () =>
    expect(() => norm({ ...baseRaw(), packages: [{ name: "expo" }] })).not.toThrow());
});

describe("config.schema.json ↔ runtime sync", () => {
  const repoRoot = join(import.meta.dir, "..");
  const schema = JSON.parse(readFileSync(join(repoRoot, "config.schema.json"), "utf8")) as Record<string, any>;
  const committedConfig = JSON.parse(readFileSync(join(repoRoot, "config.json"), "utf8")) as Record<string, unknown>;

  // The ONE keyword allowlist both the value-checker and the schema-only walk trust — a new
  // schema keyword must be added here (and taught to the checker) exactly once.
  const KNOWN_SCHEMA_KEYWORDS = new Set(["$schema", "$id", "title", "description", "type", "properties", "required", "additionalProperties", "items", "minItems", "minimum", "maximum", "minLength", "maxLength", "pattern", "format", "default"]);

  // Minimal JSON-Schema-subset checker covering exactly the features config.schema.json uses:
  // type (string | union incl. "null"), properties/required/additionalProperties:false, items,
  // minItems, minimum, minLength, maxLength, pattern. Fails the test on any schema feature it doesn't know.
  // `format` is recognized but deliberately NOT enforced (annotation-only in JSON Schema; the
  // real-calendar-date check is runtime-enforced in validateAndNormalize).
  function check(value: unknown, node: Record<string, any>, path: string, violations: string[]): void {
    for (const k of Object.keys(node)) if (!KNOWN_SCHEMA_KEYWORDS.has(k)) violations.push(`${path}: unsupported schema keyword '${k}' — extend the test checker`);
    const types: string[] = Array.isArray(node["type"]) ? node["type"] : node["type"] !== undefined ? [node["type"]] : [];
    const jsType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
    if (types.length > 0 && !types.includes(jsType) && !(jsType === "integer" && types.includes("number")))
      violations.push(`${path}: expected ${types.join("|")}, got ${jsType}`);
    if (typeof value === "string") {
      if (node["minLength"] !== undefined && value.length < node["minLength"]) violations.push(`${path}: shorter than minLength`);
      if (node["maxLength"] !== undefined && value.length > node["maxLength"]) violations.push(`${path}: longer than maxLength`);
      if (node["pattern"] !== undefined && !new RegExp(node["pattern"]).test(value)) violations.push(`${path}: does not match ${node["pattern"]}`);
    }
    if (typeof value === "number" && node["minimum"] !== undefined && value < node["minimum"]) violations.push(`${path}: below minimum`);
    if (typeof value === "number" && node["maximum"] !== undefined && value > node["maximum"]) violations.push(`${path}: above maximum`);
    if (Array.isArray(value)) {
      if (node["minItems"] !== undefined && value.length < node["minItems"]) violations.push(`${path}: fewer than minItems`);
      if (node["items"] !== undefined) value.forEach((v, i) => check(v, node["items"], `${path}[${i}]`, violations));
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const props: Record<string, any> = node["properties"] ?? {};
      for (const req of (node["required"] ?? []) as string[])
        if ((value as Record<string, unknown>)[req] === undefined) violations.push(`${path}: missing required '${req}'`);
      for (const [k, v] of Object.entries(value)) {
        if (props[k] !== undefined) check(v, props[k], `${path}.${k}`, violations);
        else if (node["additionalProperties"] === false) violations.push(`${path}: additional property '${k}'`);
      }
    }
  }

  test("the committed config.json validates against the schema AND the runtime", () => {
    const violations: string[] = [];
    check(committedConfig, schema, "$", violations);
    expect(violations).toEqual([]);
    expect(() => validateAndNormalize(committedConfig, {})).not.toThrow();
  });
  test("the checker is not a no-op: it catches unknown keys, wrong types, and pattern misses", () => {
    const bad1: string[] = [];
    check({ ...committedConfig, concurrency: { ...(committedConfig["concurrency"] as object), typo: 1 } }, schema, "$", bad1);
    expect(bad1.some((v) => v.includes("additional property 'typo'"))).toBe(true);
    const bad2: string[] = [];
    check({ ...committedConfig, cutoffDate: 5 }, schema, "$", bad2);
    expect(bad2.some((v) => v.includes("$.cutoffDate"))).toBe(true);
    const bad3: string[] = [];
    check({ ...committedConfig, cutoffDate: "not-a-date" }, schema, "$", bad3);
    expect(bad3.some((v) => v.includes("does not match"))).toBe(true);
  });
  test("every schema node uses only keywords the checker understands (schema-only walk)", () => {
    const unknownKeywords: string[] = [];
    const walk = (node: Record<string, any>, path: string): void => {
      for (const k of Object.keys(node)) if (!KNOWN_SCHEMA_KEYWORDS.has(k)) unknownKeywords.push(`${path}: ${k}`);
      for (const [name, child] of Object.entries((node["properties"] ?? {}) as Record<string, any>)) walk(child, `${path}.${name}`);
      if (node["items"] !== undefined) walk(node["items"], `${path}[]`);
    };
    walk(schema, "$");
    expect(unknownKeywords).toEqual([]);
  });
  test("schema property sets exactly match the runtime's known keys at every strict level", () => {
    expect(Object.keys(schema["properties"]).sort()).toEqual([...CONFIG_ROOT_KEYS].sort());
    expect(Object.keys(schema["properties"]["concurrency"]["properties"]).sort()).toEqual([...CONFIG_CONCURRENCY_KEYS].sort());
    expect(Object.keys(schema["properties"]["timeouts"]["properties"]).sort()).toEqual([...CONFIG_TIMEOUTS_KEYS].sort());
    expect(Object.keys(schema["properties"]["paths"]["properties"]).sort()).toEqual([...CONFIG_PATHS_KEYS].sort());
    expect(Object.keys(schema["properties"]["packages"]["items"]["properties"]).sort()).toEqual([...CONFIG_PACKAGE_KEYS].sort());
  });
  test("additionalProperties:false at every level the runtime rejects unknown keys", () => {
    expect(schema["additionalProperties"]).toBe(false);
    expect(schema["properties"]["concurrency"]["additionalProperties"]).toBe(false);
    expect(schema["properties"]["timeouts"]["additionalProperties"]).toBe(false);
    expect(schema["properties"]["paths"]["additionalProperties"]).toBe(false);
    expect(schema["properties"]["packages"]["items"]["additionalProperties"]).toBe(false);
  });
  test("schema required matches the runtime's required fields (each omission throws; optionals don't)", () => {
    expect((schema["required"] as string[]).sort()).toEqual(["cutoffDate", "maxBranchesPerRepo", "packages", "paths"]);
    for (const req of schema["required"] as string[]) {
      const raw = baseRaw();
      delete raw[req];
      expect(() => norm(raw)).toThrow(ConfigError);
    }
    const optionals = [...CONFIG_ROOT_KEYS].filter((k) => !(schema["required"] as string[]).includes(k));
    const minimal = Object.fromEntries(Object.entries(baseRaw()).filter(([k]) => !optionals.includes(k as (typeof CONFIG_ROOT_KEYS)[number])));
    expect(() => norm(minimal)).not.toThrow();
  });
  test("packages.items requires exactly name", () => {
    expect(schema["properties"]["packages"]["items"]["required"]).toEqual(["name"]);
  });
  test("every items.minLength constraint in the schema is runtime-enforced ([\"\"] and [42] throw)", () => {
    // Derived FROM the schema, then pinned: a new string-array key gaining items.minLength must be
    // added to the expected list (loud), and every listed key must actually reject an empty item
    // AND a non-string item at runtime (the schema declares items.type "string" for all of them,
    // and the keys route through FOUR different validators — optStringArray,
    // normalizeOrganizations, validateBranchPattern, validateRepoPattern — so per-key coverage is what
    // keeps them in lockstep). Schema/code drift on array items fails here instead of shipping.
    const constrained = Object.entries<Record<string, any>>(schema["properties"])
      .filter(([, prop]) => prop["items"]?.["type"] === "string" && prop["items"]?.["minLength"] >= 1)
      .map(([key]) => key)
      .sort();
    expect(constrained).toEqual(["branches", "excludeBranches", "excludeDirGlobs", "excludeOrganizations", "excludeRepositories", "organizations"]);
    for (const key of constrained) {
      expect(() => norm({ ...baseRaw(), [key]: [""] })).toThrow(ConfigError);
      expect(() => norm({ ...baseRaw(), [key]: [42] })).toThrow(ConfigError);
    }
  });
  test("every schema 'default' annotation equals the actual runtime default", () => {
    // required keys only, so every optional field falls back to its runtime default; a schema
    // 'default' that drifts from the code would silently mislead operators editing config.json.
    const minimal: Record<string, unknown> = {
      cutoffDate: "2024-01-01", maxBranchesPerRepo: 25,
      concurrency: { organizations: 1, repositories: 1, branches: 1 },
      packages: [{ name: "expo" }],
      paths: { sqlitePath: "./data/audit.db", outputDir: "./output" },
    };
    const config = norm(minimal);
    const pkg = config.packages[0]!;
    // Typed projections of every defaulted field — a schema default on a key missing here
    // compares against undefined and fails loudly.
    const runtimeDefaults: Record<string, unknown> = {
      githubHost: config.githubHost, organizations: config.organizations,
      excludeOrganizations: config.excludeOrganizations, includePersonalNamespace: config.includePersonalNamespace,
      includeForks: config.includeForks, includeArchived: config.includeArchived,
      maxReposPerOrg: config.maxReposPerOrg, branches: config.branches,
      excludeBranches: config.excludeBranches, excludeDirGlobs: config.excludeDirGlobs,
      excludeRepositories: config.excludeRepositories,
    };
    const pkgRuntimeDefaults: Record<string, unknown> = {
      registryUrl: pkg.registryUrl, registryAuthEnvVar: pkg.registryAuthEnvVar,
    };
    let defaultsChecked = 0;
    for (const [key, prop] of Object.entries<Record<string, unknown>>(schema["properties"])) {
      if (!("default" in prop)) continue;
      defaultsChecked++;
      expect({ key, value: runtimeDefaults[key] }).toEqual({ key, value: prop["default"] });
    }
    for (const [key, prop] of Object.entries<Record<string, unknown>>(schema["properties"]["packages"]["items"]["properties"])) {
      if (!("default" in prop)) continue;
      defaultsChecked++;
      expect({ key, value: pkgRuntimeDefaults[key] }).toEqual({ key, value: prop["default"] });
    }
    expect(defaultsChecked).toBeGreaterThanOrEqual(9); // the walk actually found the annotations
  });
  test("schema concurrency NESTED defaults match the runtime defaults", () => {
    // The default walk above only sweeps ROOT + packages.items, so pin the nested concurrency
    // defaults separately against what the runtime supplies for an omitted block.
    const raw = baseRaw();
    delete raw["concurrency"];
    const rt = norm(raw).concurrency;
    const props = schema["properties"]["concurrency"]["properties"] as Record<string, { default: number }>;
    expect(props["organizations"]!.default).toBe(rt.organizations);
    expect(props["repositories"]!.default).toBe(rt.repositories);
    expect(props["branches"]!.default).toBe(rt.branches);
  });
});
