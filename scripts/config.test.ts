import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAndNormalize, computeConfigHash, resolveConfigPath, loadConfig, ConfigError } from "./config.ts";

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
    ["missing concurrency field", { ...baseRaw(), concurrency: { organizations: 3, repositories: 6 } }],
    ["missing paths", { ...baseRaw(), paths: undefined }],
    ["githubHost with scheme", { ...baseRaw(), githubHost: "https://gh.com" }],
    ["non-object root", 42 as unknown as Record<string, unknown>],
  ];
  for (const [name, raw, env] of bad)
    test(name, () => expect(() => norm(raw, env)).toThrow(ConfigError));
});

describe("computeConfigHash — determinism + scope", () => {
  test("same config → same hash", () => expect(hashOf(baseRaw())).toBe(hashOf(baseRaw())));
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
