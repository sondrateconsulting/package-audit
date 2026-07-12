import { expect, test, describe, afterAll, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditDb, type RunRecord } from "./db.ts";
import { downgradeToFaithfulV2 } from "./testFixtures.ts";
import { ArgsError } from "./args.ts";
import {
  EXPORT_HELP, EXPORT_REGISTRY, EXPORT_TABLE_NAMES, RAW_EXPORT_WARNING,
  buildNotExportableNotice, exportRun, main, parseExportArgs, runExport,
} from "./export.ts";
import { type Config, DEFAULT_TIMEOUTS } from "./config.ts";
import { parseEvents } from "./testEvents.test.ts";

// Bundle containment roots are caller-provided (unlike AuditDb's hardcoded ./data|./output), so
// exportRun tests run entirely against disposable temp output dirs + :memory: databases.
const TEST_OUT = mkdtempSync(join(tmpdir(), "export-test-"));
// File-backed DBs (needed only where runExport must go through openReadOnly) live under ./data —
// §0 write containment is enforced by AuditDb.open/openReadOnly relative to cwd (db.test.ts idiom).
const DATA_EXISTED_BEFORE = existsSync("./data");
const DB_ROOT = `./data/.exporttest-${process.pid}-${Math.random().toString(36).slice(2)}`;
afterAll(() => {
  rmSync(TEST_OUT, { recursive: true, force: true });
  rmSync(DB_ROOT, { recursive: true, force: true });
  if (!DATA_EXISTED_BEFORE && existsSync("./data") && readdirSync("./data").length === 0) rmSync("./data", { recursive: true });
});
let dirCounter = 0;
const nextOutputDir = (): string => {
  const dir = join(TEST_OUT, `out-${dirCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const mem = (): AuditDb => AuditDb.open({ sqlitePath: ":memory:" });

// Capture BOTH streams while `fn` runs (per-artifact JSONL events go to stdout via logLine; the
// human summary to stderr) — the entrypoints.test.ts idiom, sync- and async-capable.
async function capture<T>(fn: () => T | Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write);
  const se = spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
    err.push(String(c));
    return true;
  }) as typeof process.stderr.write);
  try {
    const result = await fn();
    return { result, out: out.join(""), err: err.join("") };
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
}

const readXray = (outputDir: string, name: string): string => readFileSync(join(outputDir, "xray", name), "utf8");
const jsonlRows = (content: string): Array<Record<string, unknown>> =>
  content.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";
const perma = (sha: string, path: string, line: number): string =>
  `https://github.com/org-a/svc/blob/${sha}/${path}#L${line}`;

// Seed TWO completed runs over the same unit (org-a/svc@main) at DIFFERENT head commits, all via
// the public API. Rows reachable only through the OLD run's head (commit aaa111) must never
// appear in the NEW run's export; an untracked package and a stale surface version prove the
// tracked-package and versionsSeen filters.
function seedTwoRuns(db: AuditDb): { oldRun: RunRecord; newRun: RunRecord } {
  const input = {
    configHash: "h", effectiveOwners: ["org-a"], ownersSource: "configured" as const,
    trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
  };
  const { runId: r1 } = db.startRun(input);
  const oldUnit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "aaa111" };
  db.upsertRunUnitHead({ runId: r1, ...oldUnit, status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
  db.upsertDependencyFinding({
    runId: r1, ...oldUnit, dateFetched: T1, packageName: "expo", dependencyKey: "expo",
    dependencyType: "dependencies", manifestPath: "package.json", manifestLine: 3,
    manifestPermalink: perma("aaa111", "package.json", 3), declaredVersion: "^49.0.0",
    resolvedVersion: "49.0.0", resolvedVersionSource: "lockfile",
  });
  db.upsertUsageFinding({
    runId: r1, ...oldUnit, packageName: "expo", dependencyKey: "expo", usageType: "named-import",
    exportName: "oldExport", context: "", filePath: "src/old.ts", lineNumber: 9,
    permalink: perma("aaa111", "src/old.ts", 9), snippet: "old-run snippet", foundAt: T1,
  });
  db.completeRun(r1);

  // Surfaces for BOTH versions; 49.0.0 is resolved only via the OLD run's rows, so the NEW
  // run's default export must slice it out. writeApiSurface appends the '__complete__' marker.
  db.writeApiSurface({
    packageName: "expo", version: "49.0.0", versionSource: "lockfile",
    rows: [{ exportName: "oldOnly", exportKind: "named", source: "index.d.ts" }],
  });
  db.writeApiSurface({
    packageName: "expo", version: "50.0.7", versionSource: "lockfile",
    rows: [
      { exportName: "registerRootComponent", exportKind: "named", source: "index.d.ts" },
      { exportName: "expo", exportKind: "cli-bin", source: "package.json#bin" },
    ],
  });

  Bun.sleepSync(2); // distinct started_at, so latestReportableRun deterministically picks run 2
  const { runId: r2 } = db.startRun(input);
  const newUnit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "bbb222" };
  db.upsertRunUnitHead({ runId: r2, ...newUnit, status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
  db.upsertDependencyFinding({
    runId: r2, ...newUnit, dateFetched: T2, packageName: "expo", dependencyKey: "expo",
    dependencyType: "dependencies", manifestPath: "package.json", manifestLine: 5,
    manifestPermalink: perma("bbb222", "package.json", 5), declaredVersion: "^50.0.0",
    resolvedVersion: "50.0.7", resolvedVersionSource: "lockfile",
  });
  // UNTRACKED package in the SAME joined unit — the tracked_packages filter must drop it.
  db.upsertDependencyFinding({
    runId: r2, ...newUnit, dateFetched: T2, packageName: "left-pad", dependencyKey: "left-pad",
    dependencyType: "dependencies", manifestPath: "package.json", manifestLine: 6,
    manifestPermalink: perma("bbb222", "package.json", 6), declaredVersion: "^1.0.0",
    resolvedVersion: "1.3.0", resolvedVersionSource: "lockfile",
  });
  db.upsertUsageFinding({
    runId: r2, ...newUnit, packageName: "expo", dependencyKey: "expo", usageType: "named-import",
    exportName: "registerRootComponent", context: "", filePath: "src/app.ts", lineNumber: 2,
    permalink: perma("bbb222", "src/app.ts", 2), snippet: "=cmd|' /C calc'!A0", foundAt: T2,
  });
  db.upsertUsageFinding({
    runId: r2, ...newUnit, packageName: "expo", dependencyKey: "expo", usageType: "require",
    exportName: "", context: "", filePath: "src/b.ts", lineNumber: 7,
    permalink: perma("bbb222", "src/b.ts", 7), snippet: 'const e = require("expo"), x = 1;\nnext', foundAt: T2,
  });
  db.completeRun(r2);
  return { oldRun: db.getRun(r1)!, newRun: db.getRun(r2)! };
}

const config = (sqlitePath: string, outputDir: string): Config => ({
  concurrency: { branches: 1, organizations: 1, repositories: 1 }, timeouts: DEFAULT_TIMEOUTS,
  cutoffDate: "2024-01-01", excludeDirGlobs: [], githubHost: "github.com",
  includeArchived: false, includeForks: false, includePersonalNamespace: false,
  maxBranchesPerRepo: 25, maxReposPerOrg: null, organizations: null, excludeOrganizations: [],
  branches: null, excludeBranches: [], excludeRepositories: [],
  packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
  paths: { sqlitePath, outputDir },
});

describe("parseExportArgs", () => {
  test("defaults: no flags → default run, not raw", () => {
    expect(parseExportArgs([])).toEqual({ configPath: null, runId: null, raw: false, help: false });
  });
  test("parses --config, --run-id (detached and =attached), --raw", () => {
    expect(parseExportArgs(["--config", "c.json", "--run-id", "r-1", "--raw"])).toEqual({ configPath: "c.json", runId: "r-1", raw: true, help: false });
    expect(parseExportArgs(["--run-id=r-2"])).toEqual({ configPath: null, runId: "r-2", raw: false, help: false });
  });
  test("--help/-h wins over everything, even invalid arguments", () => {
    expect(parseExportArgs(["--bogus", "-h"]).help).toBe(true);
    expect(parseExportArgs(["--help"]).help).toBe(true);
  });
  test("unknown arguments are rejected (a typo must not fall through to the default export)", () => {
    expect(() => parseExportArgs(["--rawww"])).toThrow(ArgsError);
    expect(() => parseExportArgs(["extra"])).toThrow(ArgsError);
  });
  test("--run-id requires a value; a detached flag-like value is a missing value", () => {
    expect(() => parseExportArgs(["--run-id"])).toThrow(ArgsError);
    expect(() => parseExportArgs(["--run-id", "--raw"])).toThrow(ArgsError);
  });
  test("--run-id with a path separator or traversal is rejected (shared assertRunId grammar)", () => {
    expect(() => parseExportArgs(["--run-id", "../../xray/manifest"])).toThrow(/invalid run id/);
    expect(() => parseExportArgs(["--run-id", "a/b"])).toThrow(/invalid run id/);
    expect(parseExportArgs(["--run-id", "1f2e3d4c-5b6a-7089-90ab-cdef01234567"]).runId).toBe("1f2e3d4c-5b6a-7089-90ab-cdef01234567");
  });
  test("--raw takes no value", () => {
    expect(() => parseExportArgs(["--raw=1"])).toThrow(ArgsError);
  });
  test("duplicate --config / --run-id are rejected", () => {
    expect(() => parseExportArgs(["--config", "a", "--config", "b"])).toThrow(ArgsError);
    expect(() => parseExportArgs(["--run-id", "a", "--run-id", "b"])).toThrow(ArgsError);
  });
});

describe("EXPORT_REGISTRY ↔ live schema sync (the runtime half of the Equal<> type sync)", () => {
  test("registry keys cover exactly the five export tables", () => {
    expect([...EXPORT_TABLE_NAMES].map(String).sort()).toEqual(Object.keys(EXPORT_REGISTRY).sort());
  });

  test("per table: PRAGMA names ⊇ registry, registry order is a declaration-order subsequence, remainder is exactly the id column", () => {
    const db = mem();
    try {
      for (const table of EXPORT_TABLE_NAMES) {
        // pragma_table_info as a table-valued SELECT passes the read() facade's write guard.
        const declared = (db.read("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(table) as Array<{ name: string }>).map((r) => r.name);
        const { columns, orderBy } = EXPORT_REGISTRY[table];
        const names = columns.map((c) => c.name);
        // every registry column exists, in declaration order (subsequence check)
        let from = 0;
        for (const n of names) {
          const idx = declared.indexOf(n, from);
          expect(`${table}.${n}@${idx}`).not.toBe(`${table}.${n}@-1`);
          from = idx + 1;
        }
        // the ONLY declared columns not exported are the AUTOINCREMENT ids (storage detail). runs and
        // run_unit_head have no surrogate id (composite PKs), so ALL their columns are exported.
        const noId = table === "runs" || table === "run_unit_head";
        expect(declared.filter((n) => !names.includes(n))).toEqual(noId ? [] : ["id"]);
        // ORDER BY keys are registry columns (the chain the contract documents)
        for (const k of orderBy) expect(names).toContain(k);
      }
    } finally {
      db.close();
    }
  });
});

describe("exportRun — run-scoped snapshot (default)", () => {
  test("only the selected run's heads + tracked packages appear; runs export is that one row", async () => {
    const db = mem();
    const { newRun } = seedTwoRuns(db);
    const out = nextOutputDir();
    const { result } = await capture(() => exportRun(db, newRun, out, { raw: false }));

    const deps = jsonlRows(readXray(out, "dependency_findings.jsonl"));
    expect(deps.map((r) => [r["package_name"], r["commit_sha"]])).toEqual([["expo", "bbb222"]]); // no aaa111, no left-pad
    expect(deps[0]!["lockfile_path"]).toBeNull(); // NULLs stay JSON null

    const usage = jsonlRows(readXray(out, "usage_findings.jsonl"));
    expect(usage).toHaveLength(2);
    expect(usage.every((r) => r["commit_sha"] === "bbb222")).toBe(true);

    const runs = jsonlRows(readXray(out, "runs.jsonl"));
    expect(runs.map((r) => r["run_id"])).toEqual([newRun.runId]);
    expect(runs[0]!["tracked_packages"]).toBe('["expo"]'); // TEXT column exported verbatim

    const summary = JSON.parse(result.line) as Record<string, unknown>;
    expect(summary).toEqual({ event: "export-summary", runId: newRun.runId, raw: false, artifacts: 10, swept: [] });
    db.close();
  });

  test("api-surface slice: versionsSeen versions only, marker rows excluded", async () => {
    const db = mem();
    const { newRun } = seedTwoRuns(db);
    const out = nextOutputDir();
    await capture(() => exportRun(db, newRun, out, { raw: false }));
    const surface = jsonlRows(readXray(out, "package_api_surface.jsonl"));
    // 49.0.0 (resolved only via the OLD run) and both '__complete__' markers are sliced out;
    // rows arrive in the (package_name, version, export_kind, export_name) ORDER BY.
    expect(surface.map((r) => [r["version"], r["export_kind"], r["export_name"]])).toEqual([
      ["50.0.7", "cli-bin", "expo"],
      ["50.0.7", "named", "registerRootComponent"],
    ]);
    db.close();
  });

  test("stdout is pure JSONL: one export event per artifact, in table/format order", async () => {
    const db = mem();
    const { newRun } = seedTwoRuns(db);
    const out = nextOutputDir();
    const { out: stdout, err } = await capture(() => exportRun(db, newRun, out, { raw: false }));
    const events = parseEvents(stdout); // T6: asserts + strips the ts each logLine event carries
    expect(events).toHaveLength(10);
    expect(events.every((e) => e["event"] === "export")).toBe(true);
    expect(events.map((e) => `${e["table"]}.${e["format"]}`)).toEqual([
      "dependency_findings.csv", "dependency_findings.jsonl",
      "package_api_surface.csv", "package_api_surface.jsonl",
      "run_unit_head.csv", "run_unit_head.jsonl",
      "runs.csv", "runs.jsonl",
      "usage_findings.csv", "usage_findings.jsonl",
    ]);
    const first = events[0]!;
    expect(first["path"]).toBe(join(out, "xray", "dependency_findings.csv"));
    expect(first["rows"]).toBe(1);
    expect(first["bytes"]).toBe(Buffer.byteLength(readXray(out, "dependency_findings.csv"), "utf8"));
    // human summary went to stderr, not stdout
    expect(err).toContain(`EXPORT COMPLETE — run ${newRun.runId}`);
    expect(err).toContain("usage_findings:");
    db.close();
  });
});

describe("CSV / JSONL goldens (exact bytes)", () => {
  test("usage_findings.csv: pinned bytes — CRLF endings, formula defense, RFC 4180 quoting", async () => {
    const db = mem();
    const { newRun } = seedTwoRuns(db);
    const out = nextOutputDir();
    await capture(() => exportRun(db, newRun, out, { raw: false }));
    const id = newRun.runId;
    const header =
      "run_id,organization,repository,branch,commit_sha,package_name,dependency_key,usage_type,export_name,context,file_path,line_number,permalink,snippet,found_at";
    // hostile snippet "=cmd|..." gets the literal apostrophe INSIDE the field (no RFC chars → unquoted)
    const rowA = `${id},org-a,svc,main,bbb222,expo,expo,named-import,registerRootComponent,,src/app.ts,2,${perma("bbb222", "src/app.ts", 2)},'=cmd|' /C calc'!A0,${T2}`;
    // comma + quote + LF cell: quoted, embedded quotes doubled, LF preserved inside the field
    const rowB = `${id},org-a,svc,main,bbb222,expo,expo,require,,,src/b.ts,7,${perma("bbb222", "src/b.ts", 7)},"const e = require(""expo""), x = 1;\nnext",${T2}`;
    expect(readXray(out, "usage_findings.csv")).toBe([header, rowA, rowB].join("\r\n") + "\r\n");
    db.close();
  });

  test("usage_findings.jsonl: key order = registry order, byte-faithful hostile strings, numbers stay numbers", async () => {
    const db = mem();
    const { newRun } = seedTwoRuns(db);
    const out = nextOutputDir();
    await capture(() => exportRun(db, newRun, out, { raw: false }));
    const content = readXray(out, "usage_findings.jsonl");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    // exact first line: keys inserted in registry order (JSON.stringify preserves insertion order)
    expect(lines[0]).toBe(
      JSON.stringify({
        run_id: newRun.runId, organization: "org-a", repository: "svc", branch: "main",
        commit_sha: "bbb222", package_name: "expo", dependency_key: "expo",
        usage_type: "named-import", export_name: "registerRootComponent", context: "",
        file_path: "src/app.ts", line_number: 2, permalink: perma("bbb222", "src/app.ts", 2),
        snippet: "=cmd|' /C calc'!A0", found_at: T2,
      }),
    );
    // byte-faithful: NO formula-defense apostrophe in JSONL; integer stays a JSON number
    expect(content).toContain('"snippet":"=cmd|\' /C calc\'!A0"');
    expect(content).toContain('"line_number":2');
    for (const line of lines) {
      expect(Object.keys(JSON.parse(line) as object)).toEqual(EXPORT_REGISTRY.usage_findings.columns.map((c) => c.name));
    }
    db.close();
  });

  // Seed ONE completed run whose run_unit_head carries all four dispositions + the nullable policy
  // columns, one deny pattern shaped like a spreadsheet formula. Exercises the new export table's
  // row output, ORDER BY, nullable→empty/JSON-null mapping, typed-number cells, and CSV formula defense.
  function seedPolicyHeads(db: AuditDb): RunRecord {
    const { runId } = db.startRun({
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "configured",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    });
    const D = "2025-06-01T12:00:00Z";
    const base = { runId, organization: "org-a", repository: "svc", scannedCommitDate: D };
    // deny-excluded with a formula-shaped pattern (branch sorts first)
    db.upsertRunUnitHead({ ...base, branch: "=cmd|calc", commitSha: "", status: "policy-excluded", isDefaultBranch: false, policyStatus: "excluded-by-deny", policyMatchedPattern: "=cmd|calc" });
    // scanned default (policy-clean)
    db.upsertRunUnitHead({ ...base, branch: "main", commitSha: "aaa111", status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null });
    // allow-list miss (pattern is NULL → empty CSV / JSON null)
    db.upsertRunUnitHead({ ...base, branch: "stale", commitSha: "", status: "policy-excluded", isDefaultBranch: false, policyStatus: "excluded-by-allow", policyMatchedPattern: null });
    // past the per-repo cap (never carries policy)
    db.upsertRunUnitHead({ ...base, branch: "wip", commitSha: "", status: "past-cap", isDefaultBranch: false, policyStatus: null, policyMatchedPattern: null });
    // A GENUINE cutoff skip — the fourth disposition. Without it the golden proved only three, while its
    // header claimed four: policy exclusions moved to their own status and took the last skipped-cutoff
    // row with them.
    db.upsertRunUnitHead({ ...base, branch: "ancient", commitSha: "", status: "skipped-cutoff", isDefaultBranch: false, policyStatus: null, policyMatchedPattern: null });
    db.completeRun(runId);
    return db.getRun(runId)!;
  }

  test("run_unit_head.csv: every disposition, nullable→empty, typed-number cells, formula defense on the deny pattern", async () => {
    const db = mem();
    const run = seedPolicyHeads(db);
    const out = nextOutputDir();
    await capture(() => exportRun(db, run, out, { raw: false }));
    const id = run.runId;
    const D = "2025-06-01T12:00:00Z";
    const header = "run_id,organization,repository,branch,commit_sha,status,is_default_branch,policy_status,policy_matched_pattern,scanned_commit_date";
    // rows in ORDER BY (run_id, organization, repository, branch); the deny branch is NAMED
    // '=cmd|calc' so its stored pattern (exact-first write-time verification) is the same
    // formula-looking value → BOTH cells get the literal apostrophe prefix (formula defense), and
    // '=' sorts before every letter so the row is FIRST; is_default_branch is a typed number
    // (never prefixed); NULLs are empty.
    const feature = `${id},org-a,svc,'=cmd|calc,,policy-excluded,0,excluded-by-deny,'=cmd|calc,${D}`;
    const ancient = `${id},org-a,svc,ancient,,skipped-cutoff,0,,,${D}`; // the GENUINE cutoff skip
    const main = `${id},org-a,svc,main,aaa111,scanned,1,,,${D}`;
    const stale = `${id},org-a,svc,stale,,policy-excluded,0,excluded-by-allow,,${D}`;
    const wip = `${id},org-a,svc,wip,,past-cap,0,,,${D}`;
    expect(readXray(out, "run_unit_head.csv")).toBe([header, feature, ancient, main, stale, wip].join("\r\n") + "\r\n");
    db.close();
  });

  test("run_unit_head.jsonl: registry key order, byte-faithful pattern (no defense apostrophe), JSON null/number", async () => {
    const db = mem();
    const run = seedPolicyHeads(db);
    const out = nextOutputDir();
    await capture(() => exportRun(db, run, out, { raw: false }));
    const content = readXray(out, "run_unit_head.jsonl");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    // exact deny line (1st by branch order — '=' sorts before letters): keys in registry order,
    // is_default_branch a JSON number, branch AND pattern byte-faithful (no defense apostrophe).
    expect(lines[0]).toBe(
      JSON.stringify({
        run_id: run.runId, organization: "org-a", repository: "svc", branch: "=cmd|calc",
        commit_sha: "", status: "policy-excluded", is_default_branch: 0,
        policy_status: "excluded-by-deny", policy_matched_pattern: "=cmd|calc", scanned_commit_date: "2025-06-01T12:00:00Z",
      }),
    );
    // The GENUINE cutoff skip: same NULL policy columns as a scanned row, distinguished by status alone.
    expect(lines[1]).toBe(
      JSON.stringify({
        run_id: run.runId, organization: "org-a", repository: "svc", branch: "ancient",
        commit_sha: "", status: "skipped-cutoff", is_default_branch: 0,
        policy_status: null, policy_matched_pattern: null, scanned_commit_date: "2025-06-01T12:00:00Z",
      }),
    );
    // no formula-defense apostrophe in JSONL; the scanned default carries JSON null policy columns
    expect(content).toContain('"policy_matched_pattern":"=cmd|calc"');
    expect(content).toContain('"branch":"main","commit_sha":"aaa111","status":"scanned","is_default_branch":1,"policy_status":null,"policy_matched_pattern":null');
    for (const line of lines) {
      expect(Object.keys(JSON.parse(line) as object)).toEqual(EXPORT_REGISTRY.run_unit_head.columns.map((c) => c.name));
    }
    db.close();
  });
});

describe("exportRun --raw (forensic full-table dump)", () => {
  test("every row (markers, stale versions, all runs), raw- names, warning event, RAW stderr banner", async () => {
    const db = mem();
    const { oldRun, newRun } = seedTwoRuns(db);
    const out = nextOutputDir();
    const { result, out: stdout, err } = await capture(() => exportRun(db, newRun, out, { raw: true }));

    const events = parseEvents(stdout); // T6: asserts + strips the ts each logLine event carries
    expect(events[0]).toEqual({ ...RAW_EXPORT_WARNING });
    expect(events.filter((e) => e["event"] === "warning")).toHaveLength(1);

    const names = readdirSync(join(out, "xray")).sort();
    expect(names).toEqual([
      "manifest.json",
      "raw-dependency_findings.csv", "raw-dependency_findings.jsonl",
      "raw-package_api_surface.csv", "raw-package_api_surface.jsonl",
      "raw-run_unit_head.csv", "raw-run_unit_head.jsonl",
      "raw-runs.csv", "raw-runs.jsonl",
      "raw-usage_findings.csv", "raw-usage_findings.jsonl",
    ]);

    const runs = jsonlRows(readXray(out, "raw-runs.jsonl"));
    expect(runs.map((r) => r["run_id"]).sort()).toEqual([oldRun.runId, newRun.runId].sort()); // ALL runs
    const deps = jsonlRows(readXray(out, "raw-dependency_findings.jsonl"));
    expect(deps.map((r) => r["commit_sha"]).sort()).toEqual(["aaa111", "bbb222", "bbb222"]); // other runs + untracked included
    const surface = jsonlRows(readXray(out, "raw-package_api_surface.jsonl"));
    expect(new Set(surface.map((r) => String(r["version"])))).toEqual(new Set(["49.0.0", "50.0.7"]));
    expect(surface.filter((r) => r["export_kind"] === "__complete__")).toHaveLength(2); // markers verbatim

    // --raw still stamps the SELECTED run on the manifest
    const manifest = JSON.parse(readXray(out, "manifest.json")) as { runId: string };
    expect(manifest.runId).toBe(newRun.runId);

    expect(err).toContain("RAW EXPORT");
    expect(JSON.parse(result.line)).toMatchObject({ event: "export-summary", raw: true, artifacts: 10 });
    db.close();
  });
});

describe("bundle integration (xray/ containment, manifest, sweep)", () => {
  test("artifacts land under <outputDir>/xray with an all-export manifest; an operator file in outputDir survives; a stale xray file is swept", async () => {
    const db = mem();
    const { newRun } = seedTwoRuns(db);
    const out = nextOutputDir();
    writeFileSync(join(out, "operator-notes.txt"), "keep me"); // outputDir itself is NEVER swept
    mkdirSync(join(out, "xray"), { recursive: true });
    writeFileSync(join(out, "xray", "stale.txt"), "from a previous generation");

    const { result } = await capture(() => exportRun(db, newRun, out, { raw: false }));

    const manifest = JSON.parse(readXray(out, "manifest.json")) as {
      runId: string; artifacts: Array<{ path: string; kind: string }>;
    };
    expect(manifest.runId).toBe(newRun.runId);
    expect(manifest.artifacts).toHaveLength(10);
    expect(manifest.artifacts.every((a) => a.kind === "export")).toBe(true);
    expect(manifest.artifacts.map((a) => a.path)).toEqual([
      "dependency_findings.csv", "dependency_findings.jsonl",
      "package_api_surface.csv", "package_api_surface.jsonl",
      "run_unit_head.csv", "run_unit_head.jsonl",
      "runs.csv", "runs.jsonl",
      "usage_findings.csv", "usage_findings.jsonl",
    ]);

    expect(readFileSync(join(out, "operator-notes.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(out, "xray", "stale.txt"))).toBe(false); // unmanifested → swept
    expect((JSON.parse(result.line) as { swept: string[] }).swept).toEqual(["stale.txt"]);
    db.close();
  });

  test("determinism: double-run byte-equality over every artifact + manifest (default and raw)", async () => {
    const db = mem();
    const { newRun } = seedTwoRuns(db);
    const snapshotDir = (dir: string): Record<string, string> =>
      Object.fromEntries(readdirSync(join(dir, "xray")).sort().map((n) => [n, readXray(dir, n)]));
    for (const raw of [false, true]) {
      const out = nextOutputDir();
      await capture(() => exportRun(db, newRun, out, { raw }));
      const first = snapshotDir(out);
      await capture(() => exportRun(db, newRun, out, { raw }));
      expect(snapshotDir(out)).toEqual(first);
    }
    db.close();
  });
});

describe("runExport guards (mirroring runReport, notices to stdout only)", () => {
  test("missing database: notExportable notice, zero filesystem effect (short-circuits BEFORE open)", async () => {
    const root = mkdtempSync(join(tmpdir(), "export-nodb-"));
    try {
      const cfg = config(join(root, "data", "audit.db"), join(root, "output"));
      const { result, out, err } = await capture(() => runExport(cfg, { runId: null, raw: false }));
      const notice = JSON.parse(result.line) as Record<string, unknown>;
      expect(notice["notExportable"]).toBe(true);
      expect(String(notice["reason"])).toContain("run `bun run audit` first");
      expect(out).toBe(""); // no events
      expect(err).toBe(""); // no summary
      expect(readdirSync(root)).toEqual([]); // no db created, no output dir, nothing
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(":memory: sqlitePath folds into the missing-db notice; nothing written", async () => {
    const root = mkdtempSync(join(tmpdir(), "export-mem-"));
    try {
      const cfg = config(":memory:", join(root, "output"));
      const { result } = await capture(() => runExport(cfg, { runId: null, raw: false }));
      expect(JSON.parse(result.line)).toEqual(buildNotExportableNotice(null, ":memory:"));
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a too-old (v2) file database is refused through runExport; zero filesystem effect (L6)", () => {
    // export.ts calls the same AuditDb.openReadOnly seam runReport does; a v2-stamped file DB must
    // be refused with the migrate-first error BEFORE any bundle/artifact write. (Mirrors the report
    // too-old guard; the file DB lives under ./data so openReadOnly's §0 containment is satisfied.)
    const dataExistedBefore = existsSync("./data");
    const dbRoot = `./data/.exporttest-v2-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const root = mkdtempSync(join(tmpdir(), "export-v2db-"));
    try {
      const sqlitePath = join(dbRoot, "audit.db");
      AuditDb.open({ sqlitePath }).close(); // create a real current-version db…
      // Faithful v2 file (shared fixture — see testFixtures.ts for why a rebuild, not a column
      // drop): rebuilt to the v2 era + old stamp (ownership precedes the version gate).
      downgradeToFaithfulV2(sqlitePath);
      const cfg = config(sqlitePath, join(root, "output"));
      expect(() => runExport(cfg, { runId: null, raw: false })).toThrow(/run `bun run audit` once to migrate/);
      expect(existsSync(join(root, "output"))).toBe(false); // refused before any artifact write
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dbRoot, { recursive: true, force: true });
      if (!dataExistedBefore && existsSync("./data") && readdirSync("./data").length === 0) rmSync("./data", { recursive: true });
    }
  });

  test("unknown --run-id and no-completed-run: notices, db closed, output untouched", async () => {
    mkdirSync(DB_ROOT, { recursive: true });
    const sqlitePath = join(DB_ROOT, "guards.db");
    AuditDb.open({ sqlitePath }).close(); // a real, empty, cleanly-closed v3 database
    const out = nextOutputDir();
    const cfg = config(sqlitePath, out);

    const unknown = await capture(() => runExport(cfg, { runId: "nope", raw: false }));
    expect(JSON.parse(unknown.result.line)).toEqual({
      notExportable: true,
      reason: "run nope not found or pre-migration (empty tracked_packages)",
    });

    const none = await capture(() => runExport(cfg, { runId: null, raw: false }));
    expect(JSON.parse(none.result.line)).toEqual({ notExportable: true, reason: "no completed reportable run yet" });

    expect(readdirSync(out)).toEqual([]); // unlike report, export never persists a notice file
  });

  test("default run selection through the full runExport path picks the latest reportable run", async () => {
    mkdirSync(DB_ROOT, { recursive: true });
    const sqlitePath = join(DB_ROOT, "select.db");
    const db = AuditDb.open({ sqlitePath });
    const { newRun } = seedTwoRuns(db);
    db.close();
    const out = nextOutputDir();

    const { result } = await capture(() => runExport(config(sqlitePath, out), { runId: null, raw: false }));
    expect(JSON.parse(result.line)).toMatchObject({ event: "export-summary", runId: newRun.runId, raw: false });
    const runs = jsonlRows(readXray(out, "runs.jsonl"));
    expect(runs.map((r) => r["run_id"])).toEqual([newRun.runId]);
    const manifest = JSON.parse(readXray(out, "manifest.json")) as { runId: string };
    expect(manifest.runId).toBe(newRun.runId);
  });
});

describe("main() wiring", () => {
  test("--help prints the help text and does nothing else", async () => {
    const { out, err } = await capture(() => main(["--help"]));
    expect(out).toBe(EXPORT_HELP + "\n");
    expect(err).toBe("");
  });
});

describe("head-join discrimination (dual-review round 1)", () => {
  test("a finding whose run_id MOVED to a later run still exports through the older run's head", () => {
    // The load-bearing invariant: scope through run_unit_head, NEVER findings.run_id. Findings
    // are commit-anchored and their upsert OVERWRITES run_id (db.ts ON CONFLICT ... DO UPDATE
    // SET run_id = excluded.run_id), so a later run re-scanning the SAME commit steals the
    // row's run_id. The older run's export must still contain the row via its immutable head
    // snapshot — a `WHERE run_id = ?` regression drops it and fails here.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const input = {
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "configured" as const,
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    };
    const unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "ccc333" };
    const finding = {
      ...unit, packageName: "expo", dependencyKey: "expo", usageType: "named-import" as const,
      exportName: "sharedExport", context: "", filePath: "src/shared.ts", lineNumber: 4,
      permalink: perma("ccc333", "src/shared.ts", 4), snippet: "import { sharedExport } from 'expo';",
      foundAt: T1,
    };
    const { runId: rA } = db.startRun(input);
    db.upsertRunUnitHead({ runId: rA, ...unit, status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    db.upsertUsageFinding({ runId: rA, ...finding });
    db.completeRun(rA);
    Bun.sleepSync(2);
    const { runId: rB } = db.startRun(input);
    db.upsertRunUnitHead({ runId: rB, ...unit, status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    db.upsertUsageFinding({ runId: rB, ...finding }); // same UNIQUE key → run_id moves to rB
    db.completeRun(rB);

    // Precondition: the row's run_id really did move (otherwise this test discriminates nothing).
    const moved = db.read("SELECT run_id FROM usage_findings WHERE file_path = 'src/shared.ts'").get() as { run_id: string };
    expect(moved.run_id).toBe(rB);

    const out = mkdtempSync(join(tmpdir(), "export-headjoin-"));
    try {
      exportRun(db, db.getRun(rA)!, out, { raw: false });
      const jsonl = readFileSync(join(out, "xray", "usage_findings.jsonl"), "utf8");
      expect(jsonl).toContain("src/shared.ts"); // present via run A's head despite run_id = rB
    } finally {
      rmSync(out, { recursive: true, force: true });
      db.close();
    }
  });
});

// ---- codex re-pass regression (2026-07-11, F5) ---------------------------------------------------
// The run-scoped api-surface slice must require the '__complete__' introspection marker per
// (package, version), mirroring report.ts — a markerless row set (reachable via legacy
// migration, which preserves rows without backfilling markers) must not be exported as if the
// introspection had completed.
describe("api-surface export requires the completion marker (F5)", () => {
  test("markerless version rows are excluded from the run-scoped surface export", () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const rawDb = (db as unknown as { db: import("bun:sqlite").Database }).db;
    const { runId } = db.startRun({
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "configured",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    });
    const unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "aaa111" };
    db.upsertRunUnitHead({ runId, ...unit, status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    for (const version of ["1.0.0", "2.0.0"]) {
      db.upsertDependencyFinding({
        runId, ...unit, dateFetched: "2026-01-01T00:00:00.000Z", packageName: "expo", dependencyKey: version === "1.0.0" ? "expo" : "expo-alias",
        dependencyType: "dependencies", manifestPath: "package.json", manifestLine: 5,
        manifestPermalink: "https://github.com/org-a/svc/blob/aaa111/package.json#L5",
        declaredVersion: `^${version}`, lockfilePath: "bun.lock", lockfileKind: "bun", lockfileLines: [1],
        lockfilePermalink: "https://github.com/org-a/svc/blob/aaa111/bun.lock#L1",
        resolvedVersion: version, resolvedVersionSource: "lockfile",
      });
      db.writeApiSurface({ packageName: "expo", version, versionSource: "lockfile", rows: [
        { exportName: "thing", exportKind: "named", source: "index.d.ts" },
      ] });
    }
    // Strip 2.0.0's completion marker — the legacy-migration shape (rows preserved, no marker).
    rawDb.exec(`DELETE FROM package_api_surface WHERE version = '2.0.0' AND export_kind = '__complete__'`);
    db.completeRun(runId);
    const run = db.getRun(runId)!;

    const out = mkdtempSync(join(tmpdir(), "export-f5-"));
    try {
      exportRun(db, run, out, { raw: false });
      const lines = readFileSync(join(out, "xray", "package_api_surface.jsonl"), "utf8").trim().split("\n").filter((l) => l.length > 0);
      const versions = lines.map((l) => (JSON.parse(l) as { version: string }).version);
      expect(versions).toContain("1.0.0");
      expect(versions).not.toContain("2.0.0"); // markerless — introspection never completed
    } finally {
      rmSync(out, { recursive: true, force: true });
      db.close();
    }
  });
});

describe("export — run_unit_head soundness gate (same whole-row rules as report/compare)", () => {
  test("the DEFAULT export REFUSES a schema-valid malformed row; --raw stays the forensic escape hatch", () => {
    mkdirSync(DB_ROOT, { recursive: true });
    const path = join(DB_ROOT, "guard-gate.db");
    const db = AuditDb.open({ sqlitePath: path });
    const { runId } = db.startRun({ configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" });
    db.completeRun(runId);
    db.close();
    // A DEFAULT branch marked policy-excluded: no SQL CHECK covers defaultness, so NO pragma is
    // needed — the read gate is this row's only defense, and before it existed the default export
    // shipped exactly this row to CSV while buildReport refused the same database.
    const f = new Database(path, { strict: true });
    f.query(`INSERT INTO run_unit_head (run_id, organization, repository, branch, commit_sha, status, is_default_branch, policy_status, policy_matched_pattern, scanned_commit_date) VALUES (?, 'org-a', 'svc', 'main', '', 'policy-excluded', 1, 'excluded-by-deny', 'rel*', '2025-06-01T00:00:00Z')`).run(runId);
    f.close();
    const db2 = AuditDb.open({ sqlitePath: path });
    const run = db2.getRun(runId)!;
    const out = mkdtempSync(join(tmpdir(), "export-gate-"));
    expect(() => exportRun(db2, run, out, { raw: false })).toThrow(/the default branch is always scanned/);
    expect(() => exportRun(db2, run, out, { raw: true })).not.toThrow(); // forensic dump: deliberately ungated
    db2.close();
    rmSync(out, { recursive: true, force: true });
  });
});
