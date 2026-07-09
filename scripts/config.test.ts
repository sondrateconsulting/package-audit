import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateAndNormalize, computeConfigHash, resolveConfigPath, loadConfig, ConfigError,
  CONFIG_ROOT_KEYS, CONFIG_CONCURRENCY_KEYS, CONFIG_PATHS_KEYS, CONFIG_PACKAGE_KEYS,
} from "./config.ts";

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

describe("config.schema.json ↔ runtime sync", () => {
  const repoRoot = join(import.meta.dir, "..");
  const schema = JSON.parse(readFileSync(join(repoRoot, "config.schema.json"), "utf8")) as Record<string, any>;
  const committedConfig = JSON.parse(readFileSync(join(repoRoot, "config.json"), "utf8")) as Record<string, unknown>;

  // Minimal JSON-Schema-subset checker covering exactly the features config.schema.json uses:
  // type (string | union incl. "null"), properties/required/additionalProperties:false, items,
  // minItems, minimum, minLength, pattern. Fails the test on any schema feature it doesn't know.
  // `format` is recognized but deliberately NOT enforced (annotation-only in JSON Schema; the
  // real-calendar-date check is runtime-enforced in validateAndNormalize).
  function check(value: unknown, node: Record<string, any>, path: string, violations: string[]): void {
    const KNOWN = new Set(["$schema", "$id", "title", "description", "type", "properties", "required", "additionalProperties", "items", "minItems", "minimum", "minLength", "pattern", "format", "default"]);
    for (const k of Object.keys(node)) if (!KNOWN.has(k)) violations.push(`${path}: unsupported schema keyword '${k}' — extend the test checker`);
    const types: string[] = Array.isArray(node["type"]) ? node["type"] : node["type"] !== undefined ? [node["type"]] : [];
    const jsType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
    if (types.length > 0 && !types.includes(jsType) && !(jsType === "integer" && types.includes("number")))
      violations.push(`${path}: expected ${types.join("|")}, got ${jsType}`);
    if (typeof value === "string") {
      if (node["minLength"] !== undefined && value.length < node["minLength"]) violations.push(`${path}: shorter than minLength`);
      if (node["pattern"] !== undefined && !new RegExp(node["pattern"]).test(value)) violations.push(`${path}: does not match ${node["pattern"]}`);
    }
    if (typeof value === "number" && node["minimum"] !== undefined && value < node["minimum"]) violations.push(`${path}: below minimum`);
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
    const KNOWN = new Set(["$schema", "$id", "title", "description", "type", "properties", "required", "additionalProperties", "items", "minItems", "minimum", "minLength", "pattern", "format", "default"]);
    const unknownKeywords: string[] = [];
    const walk = (node: Record<string, any>, path: string): void => {
      for (const k of Object.keys(node)) if (!KNOWN.has(k)) unknownKeywords.push(`${path}: ${k}`);
      for (const [name, child] of Object.entries((node["properties"] ?? {}) as Record<string, any>)) walk(child, `${path}.${name}`);
      if (node["items"] !== undefined) walk(node["items"], `${path}[]`);
    };
    walk(schema, "$");
    expect(unknownKeywords).toEqual([]);
  });
  test("schema property sets exactly match the runtime's known keys at every strict level", () => {
    expect(Object.keys(schema["properties"]).sort()).toEqual([...CONFIG_ROOT_KEYS].sort());
    expect(Object.keys(schema["properties"]["concurrency"]["properties"]).sort()).toEqual([...CONFIG_CONCURRENCY_KEYS].sort());
    expect(Object.keys(schema["properties"]["paths"]["properties"]).sort()).toEqual([...CONFIG_PATHS_KEYS].sort());
    expect(Object.keys(schema["properties"]["packages"]["items"]["properties"]).sort()).toEqual([...CONFIG_PACKAGE_KEYS].sort());
  });
  test("additionalProperties:false at every level the runtime rejects unknown keys", () => {
    expect(schema["additionalProperties"]).toBe(false);
    expect(schema["properties"]["concurrency"]["additionalProperties"]).toBe(false);
    expect(schema["properties"]["paths"]["additionalProperties"]).toBe(false);
    expect(schema["properties"]["packages"]["items"]["additionalProperties"]).toBe(false);
  });
  test("schema required matches the runtime's required fields (each omission throws; optionals don't)", () => {
    expect((schema["required"] as string[]).sort()).toEqual(["concurrency", "cutoffDate", "maxBranchesPerRepo", "packages", "paths"]);
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
      maxReposPerOrg: config.maxReposPerOrg, excludeDirGlobs: config.excludeDirGlobs,
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
});
