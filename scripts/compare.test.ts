import { expect, test, describe, afterAll, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditDb, nowIso, type RunRecord, type UsageType } from "./db.ts";
import {
  COMPARE_DETAIL_CAP, COMPARE_HELP, buildCompare, buildNotComparableNotice, compareSummaryText,
  main, parseCompareArgs, runCompare, type CompareEnvelope,
} from "./compare.ts";
import { ArgsError } from "./args.ts";
import type { Config } from "./config.ts";

const mem = (): AuditDb => AuditDb.open({ sqlitePath: ":memory:" });

// File-backed tests must live under ./data (§0 write containment is enforced by AuditDb.open
// AND openReadOnly). Same idiom as db.test.ts / report.test.ts, including the leave-no-trace
// cleanup for fresh checkouts.
const TEST_ROOT = `./data/.comparetest-${process.pid}-${Math.random().toString(36).slice(2)}`;
const DATA_EXISTED_BEFORE = existsSync("./data");
mkdirSync(TEST_ROOT, { recursive: true });
afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  if (!DATA_EXISTED_BEFORE && existsSync("./data") && readdirSync("./data").length === 0) rmSync("./data", { recursive: true });
});
let fileCounter = 0;
const nextFile = (): string => join(TEST_ROOT, `cmp-${fileCounter++}.db`);

interface Unit { organization: string; repository: string; branch: string; commitSha: string }

// Start + immediately complete a run via the public API (startRun only resumes RUNNING runs, so
// sequential same-hash calls create distinct completed runs — exactly the compare use case).
function startCompleted(db: AuditDb, trackedPackages: string[], configHash = "h"): RunRecord {
  const { runId } = db.startRun({
    configHash, effectiveOwners: ["org-a"], ownersSource: "discovered",
    trackedPackages, cutoffDate: "2024-01-01", githubHost: "github.com",
  });
  db.completeRun(runId);
  return db.getRun(runId)!;
}

function head(db: AuditDb, runId: string, unit: Unit, isDefaultBranch: boolean | null): void {
  db.upsertRunUnitHead({ runId, ...unit, status: "scanned", isDefaultBranch });
}

// One usage site seeded through the public upsert API. Defaults keep tests terse; the permalink
// embeds the commit so "which side did the evidence come from" is assertable.
function site(
  db: AuditDb, runId: string, unit: Unit,
  opts: { pkg?: string; usageType?: UsageType; exportName?: string; context?: string; filePath?: string; lineNumber?: number } = {},
): void {
  const pkg = opts.pkg ?? "expo";
  const filePath = opts.filePath ?? "src/index.ts";
  const lineNumber = opts.lineNumber ?? 1;
  const exportName = opts.exportName ?? "useThing";
  db.upsertUsageFinding({
    runId, ...unit, packageName: pkg, dependencyKey: pkg, usageType: opts.usageType ?? "named-import",
    exportName, context: opts.context ?? "", filePath, lineNumber,
    permalink: `https://github.com/${unit.organization}/${unit.repository}/blob/${unit.commitSha}/${filePath}#L${lineNumber}`,
    snippet: `import { ${exportName} } from '${pkg}';`, foundAt: nowIso(),
  });
}

const config = (sqlitePath: string): Config => ({
  concurrency: { branches: 1, organizations: 1, repositories: 1 },
  cutoffDate: "2024-01-01", excludeDirGlobs: [], githubHost: "github.com",
  includeArchived: false, includeForks: false, includePersonalNamespace: false,
  maxBranchesPerRepo: 25, maxReposPerOrg: null, organizations: null, excludeOrganizations: [],
  branches: null, excludeBranches: [],
  packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
  paths: { sqlitePath, outputDir: "./output" },
});

describe("parseCompareArgs", () => {
  test("accepts exactly two run ids, --config in detached and attached forms", () => {
    expect(parseCompareArgs(["a", "b"])).toEqual({ configPath: null, runIdA: "a", runIdB: "b", help: false });
    expect(parseCompareArgs(["--config", "./c.json", "a", "b"]).configPath).toBe("./c.json");
    expect(parseCompareArgs(["a", "--config=./c.json", "b"]).configPath).toBe("./c.json");
  });
  test("rejects unknown flags, wrong positional counts, and malformed --config with ArgsError", () => {
    expect(() => parseCompareArgs(["a", "b", "--wat"])).toThrow(ArgsError);
    expect(() => parseCompareArgs(["a"])).toThrow(ArgsError);
    expect(() => parseCompareArgs(["a", "b", "c"])).toThrow(ArgsError);
    expect(() => parseCompareArgs([])).toThrow(ArgsError);
    expect(() => parseCompareArgs(["--config", "a", "b"])).toThrow(ArgsError); // "a b" become the path + 1 positional
    expect(() => parseCompareArgs(["a", "b", "--config"])).toThrow(ArgsError); // valueless
    expect(() => parseCompareArgs(["--config", "--fresh", "a", "b"])).toThrow(ArgsError); // flag as value
    expect(() => parseCompareArgs(["--config=x", "--config=y", "a", "b"])).toThrow(ArgsError); // duplicate
  });
  test("--help/-h wins over invalid arguments", () => {
    expect(parseCompareArgs(["--help"]).help).toBe(true);
    expect(parseCompareArgs(["--wat", "-h"]).help).toBe(true);
    expect(parseCompareArgs(["a", "b", "c", "--help"]).help).toBe(true);
  });
  test("a positional run id with a path separator or traversal is rejected (shared assertRunId grammar)", () => {
    expect(() => parseCompareArgs(["../../x", "b"])).toThrow(/invalid run id/);
    expect(() => parseCompareArgs(["a", "x/y"])).toThrow(/invalid run id/);
    expect(parseCompareArgs(["run-a1", "run-b2"])).toEqual({ configPath: null, runIdA: "run-a1", runIdB: "run-b2", help: false });
  });
});

describe("buildCompare — added/removed sites", () => {
  test("detects added/removed; a site that merely moved commits is NEITHER; evidence comes from the right side", () => {
    const db = mem();
    const runA = startCompleted(db, ["expo"]);
    const uA: Unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "shaA" };
    head(db, runA.runId, uA, true);
    site(db, runA.runId, uA, { filePath: "src/keep.ts", lineNumber: 5 });
    site(db, runA.runId, uA, { filePath: "src/gone.ts", lineNumber: 9 });
    const runB = startCompleted(db, ["expo"]);
    const uB: Unit = { ...uA, commitSha: "shaB" }; // head advanced between runs
    head(db, runB.runId, uB, true);
    site(db, runB.runId, uB, { filePath: "src/keep.ts", lineNumber: 5 }); // same site, new commit
    site(db, runB.runId, uB, { filePath: "src/new.ts", lineNumber: 3 });

    const res = buildCompare(db, runA, runB);
    expect(res.compare.formatVersion).toBe(1);
    expect(res.compare.runA).toEqual({ runId: runA.runId, startedAt: runA.startedAt, completedAt: runA.completedAt });
    expect(res.compare.runB).toEqual({ runId: runB.runId, startedAt: runB.startedAt, completedAt: runB.completedAt });

    expect(res.compare.packages.length).toBe(1);
    const pkg = res.compare.packages[0]!;
    expect(pkg.name).toBe("expo");
    // the moved-commit site (src/keep.ts) is in neither direction
    expect(pkg.added.map((e) => e.filePath)).toEqual(["src/new.ts"]);
    expect(pkg.removed.map((e) => e.filePath)).toEqual(["src/gone.ts"]);
    // added evidence from the NEWER side (B), removed from the OLDER side (A)
    expect(pkg.added[0]).toEqual({
      organization: "org-a", repository: "svc", branch: "main", isDefaultBranch: true,
      usageType: "named-import", exportName: "useThing", filePath: "src/new.ts", lineNumber: 3,
      context: "", permalink: "https://github.com/org-a/svc/blob/shaB/src/new.ts#L3",
      snippet: "import { useThing } from 'expo';",
    });
    expect(pkg.removed[0]!.permalink).toContain("shaA");
    expect(pkg.summary).toEqual({
      usageSitesAdded: 1, usageSitesRemoved: 1, reposEntering: 0, reposLeaving: 0,
      addedTotal: 1, removedTotal: 1,
    });
    db.close();
  });

  test("packages are the sorted UNION of both runs' tracked lists, each slice filtered to ITS run's tracked packages", () => {
    const db = mem();
    const runA = startCompleted(db, ["zeta", "unused"]);
    const uA: Unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "a1" };
    head(db, runA.runId, uA, true);
    site(db, runA.runId, uA, { pkg: "alpha", filePath: "f.ts", lineNumber: 1 }); // exists at A's commit but A does not track alpha
    site(db, runA.runId, uA, { pkg: "zeta", filePath: "f.ts", lineNumber: 2 });
    const runB = startCompleted(db, ["alpha", "zeta"]);
    const uB: Unit = { ...uA, commitSha: "b1" };
    head(db, runB.runId, uB, true);
    site(db, runB.runId, uB, { pkg: "alpha", filePath: "f.ts", lineNumber: 1 });
    site(db, runB.runId, uB, { pkg: "zeta", filePath: "f.ts", lineNumber: 2 });

    const res = buildCompare(db, runA, runB);
    expect(res.compare.packages.map((p) => p.name)).toEqual(["alpha", "unused", "zeta"]);
    const [alpha, unused, zeta] = res.compare.packages;
    // alpha's A-side slice is EMPTY (untracked in A) → its identical-key site counts as added
    expect(alpha!.summary.usageSitesAdded).toBe(1);
    expect(alpha!.summary.reposEntering).toBe(1);
    // tracked-but-unused package still appears, all-zero
    expect(unused!.summary).toEqual({ usageSitesAdded: 0, usageSitesRemoved: 0, reposEntering: 0, reposLeaving: 0, addedTotal: 0, removedTotal: 0 });
    expect(unused!.added).toEqual([]);
    // zeta is unchanged
    expect(zeta!.summary.usageSitesAdded).toBe(0);
    expect(zeta!.summary.usageSitesRemoved).toBe(0);
    db.close();
  });
});

describe("buildCompare — default-branch headline (CT5)", () => {
  test("a site added on a feature branch is listed with isDefaultBranch:false but NOT counted in the summary", () => {
    const db = mem();
    const runA = startCompleted(db, ["expo"]);
    const mainA: Unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "a1" };
    head(db, runA.runId, mainA, true);
    site(db, runA.runId, mainA, { filePath: "src/base.ts", lineNumber: 1 });
    const runB = startCompleted(db, ["expo"]);
    const mainB: Unit = { ...mainA, commitSha: "b1" };
    const featB: Unit = { organization: "org-a", repository: "svc", branch: "feat", commitSha: "b2" };
    head(db, runB.runId, mainB, true);
    head(db, runB.runId, featB, false);
    site(db, runB.runId, mainB, { filePath: "src/base.ts", lineNumber: 1 }); // kept
    site(db, runB.runId, mainB, { filePath: "src/more.ts", lineNumber: 2 }); // added, default
    site(db, runB.runId, featB, { filePath: "src/feat.ts", lineNumber: 3 }); // added, non-default

    const pkg = buildCompare(db, runA, runB).compare.packages[0]!;
    expect(pkg.added.length).toBe(2);
    const flags = Object.fromEntries(pkg.added.map((e) => [e.filePath, e.isDefaultBranch]));
    expect(flags).toEqual({ "src/more.ts": true, "src/feat.ts": false });
    expect(pkg.summary.usageSitesAdded).toBe(1); // headline counts default-branch sites only
    expect(pkg.summary.addedTotal).toBe(2); // honest all-branch total
    expect(pkg.summary.defaultBranchDataIncomplete).toBeUndefined();
    expect(pkg.summary.note).toBeUndefined();
    db.close();
  });

  test("a NULL flag in EITHER run triggers the all-branch fallback with the incomplete note (never undercount)", () => {
    const db = mem();
    const runA = startCompleted(db, ["expo"]);
    const mainA: Unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "a1" };
    head(db, runA.runId, mainA, null); // pre-v3-style head
    site(db, runA.runId, mainA, { filePath: "src/base.ts", lineNumber: 1 });
    site(db, runA.runId, mainA, { filePath: "src/gone.ts", lineNumber: 2 });
    const runB = startCompleted(db, ["expo"]);
    const mainB: Unit = { ...mainA, commitSha: "b1" };
    const featB: Unit = { organization: "org-a", repository: "svc", branch: "feat", commitSha: "b2" };
    head(db, runB.runId, mainB, true);
    head(db, runB.runId, featB, false);
    site(db, runB.runId, mainB, { filePath: "src/base.ts", lineNumber: 1 }); // kept
    site(db, runB.runId, featB, { filePath: "src/feat.ts", lineNumber: 3 }); // added on non-default branch

    const pkg = buildCompare(db, runA, runB).compare.packages[0]!;
    expect(pkg.summary.defaultBranchDataIncomplete).toBe(true);
    expect(pkg.summary.note).toBe("default-branch attribution unknown for pre-v3 run(s); headline counts include all branches");
    // fallback: ALL branches count (strict mode would count 0 added / 0 removed here)
    expect(pkg.summary.usageSitesAdded).toBe(1);
    expect(pkg.summary.usageSitesRemoved).toBe(1);
    // detail entries keep the tri-state: A's removed site carries null
    expect(pkg.removed[0]!.isDefaultBranch).toBeNull();
    expect(pkg.added[0]!.isDefaultBranch).toBe(false);
    db.close();
  });
});

describe("buildCompare — repos entering/leaving", () => {
  test("default-branch-scoped: entering/leaving repos are listed and counted; feature-branch-only repos are excluded", () => {
    const db = mem();
    const unit = (repository: string, branch: string, commitSha: string): Unit => ({ organization: "org-a", repository, branch, commitSha });
    const runA = startCompleted(db, ["expo"]);
    for (const [repo, sha] of [["old-repo", "ao"], ["stay", "as"]] as const) {
      head(db, runA.runId, unit(repo, "main", sha), true);
      site(db, runA.runId, unit(repo, "main", sha), { filePath: "f.ts", lineNumber: 1 });
    }
    const runB = startCompleted(db, ["expo"]);
    for (const [repo, sha] of [["stay", "bs"], ["new-repo", "bn"]] as const) {
      head(db, runB.runId, unit(repo, "main", sha), true);
      site(db, runB.runId, unit(repo, "main", sha), { filePath: "f.ts", lineNumber: 1 });
    }
    head(db, runB.runId, unit("feat-only", "dev", "bf"), false);
    site(db, runB.runId, unit("feat-only", "dev", "bf"), { filePath: "f.ts", lineNumber: 1 });

    const pkg = buildCompare(db, runA, runB).compare.packages[0]!;
    expect(pkg.reposEntering).toEqual([{ organization: "org-a", repository: "new-repo" }]);
    expect(pkg.reposLeaving).toEqual([{ organization: "org-a", repository: "old-repo" }]);
    expect(pkg.summary.reposEntering).toBe(1);
    expect(pkg.summary.reposLeaving).toBe(1);
    // the feature-branch-only repo's sites are still visible in the added detail
    expect(pkg.added.some((e) => e.repository === "feat-only" && e.isDefaultBranch === false)).toBe(true);
    db.close();
  });
});

describe("buildCompare — determinism + ordering", () => {
  test("byte-deterministic: same DB, same args → same bytes (double run)", () => {
    const db = mem();
    const runA = startCompleted(db, ["expo"]);
    const uA: Unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "a1" };
    head(db, runA.runId, uA, true);
    site(db, runA.runId, uA, { filePath: "src/gone.ts", lineNumber: 2 });
    const runB = startCompleted(db, ["expo"]);
    const uB: Unit = { ...uA, commitSha: "b1" };
    head(db, runB.runId, uB, true);
    site(db, runB.runId, uB, { filePath: "src/new.ts", lineNumber: 3 });
    const first = JSON.stringify(buildCompare(db, runA, runB));
    const second = JSON.stringify(buildCompare(db, runA, runB));
    expect(first).toBe(second);
    db.close();
  });

  test("detail arrays are sorted by (org, repo, branch, file, line, …) regardless of insertion order", () => {
    const db = mem();
    const runA = startCompleted(db, ["expo"]); // no sites: everything in B is "added"
    const runB = startCompleted(db, ["expo"]);
    const zzz: Unit = { organization: "org-a", repository: "zzz", branch: "main", commitSha: "z1" };
    const aaa: Unit = { organization: "org-a", repository: "aaa", branch: "main", commitSha: "a1" };
    head(db, runB.runId, zzz, true);
    head(db, runB.runId, aaa, true);
    // deliberately shuffled insertion order
    site(db, runB.runId, zzz, { filePath: "f.ts", lineNumber: 1 });
    site(db, runB.runId, aaa, { filePath: "z.ts", lineNumber: 5 });
    site(db, runB.runId, aaa, { filePath: "a.ts", lineNumber: 30 });
    site(db, runB.runId, aaa, { filePath: "a.ts", lineNumber: 10 });

    const pkg = buildCompare(db, runA, runB).compare.packages[0]!;
    expect(pkg.added.map((e) => `${e.repository}/${e.filePath}#L${e.lineNumber}`)).toEqual([
      "aaa/a.ts#L10", "aaa/a.ts#L30", "aaa/z.ts#L5", "zzz/f.ts#L1",
    ]);
    db.close();
  });
});

describe("buildCompare — evidence caps", () => {
  test("caps detail arrays at COMPARE_DETAIL_CAP with honest totals and UNCAPPED counts", () => {
    const db = mem();
    const runA = startCompleted(db, ["expo"]);
    const runB = startCompleted(db, ["expo"]);
    const uB: Unit = { organization: "org-a", repository: "big", branch: "main", commitSha: "b1" };
    head(db, runB.runId, uB, true);
    const total = COMPARE_DETAIL_CAP + 5;
    for (let i = 1; i <= total; i++) site(db, runB.runId, uB, { filePath: "src/big.ts", lineNumber: i });

    const pkg = buildCompare(db, runA, runB).compare.packages[0]!;
    expect(pkg.added.length).toBe(COMPARE_DETAIL_CAP);
    // the cap keeps the SORTED prefix
    expect(pkg.added[0]!.lineNumber).toBe(1);
    expect(pkg.added[COMPARE_DETAIL_CAP - 1]!.lineNumber).toBe(COMPARE_DETAIL_CAP);
    expect(pkg.summary.addedTotal).toBe(total);
    expect(pkg.summary.usageSitesAdded).toBe(total); // counts are never capped
    expect(pkg.summary.detailCapped).toBe(true);
    expect(pkg.summary.removedTotal).toBe(0);
    expect(pkg.removed).toEqual([]);
    db.close();
  });
});

describe("runCompare guard notices (exit-0 stdout JSONL answers)", () => {
  test("missing database file: notice line, zero filesystem effect (short-circuits BEFORE open)", () => {
    const root = mkdtempSync(join(tmpdir(), "compare-nodb-"));
    const sqlitePath = join(root, "data", "audit.db"); // does not exist; outside ./data on purpose
    const { line } = runCompare(config(sqlitePath), "a", "b");
    const notice = JSON.parse(line);
    expect(notice).toEqual({ notComparable: true, reason: `no database at ${sqlitePath} — run \`bun run audit\` first` });
    expect(readdirSync(root)).toEqual([]); // nothing created
    rmSync(root, { recursive: true, force: true });
  });

  test(":memory: sqlitePath folds into the missing-db notice", () => {
    const { line } = runCompare(config(":memory:"), "a", "b");
    const notice = JSON.parse(line);
    expect(notice.notComparable).toBe(true);
    expect(notice.reason).toContain("run `bun run audit` first");
  });

  test("unknown run id (either position): not-found/pre-migration notice carrying the --fresh warning", () => {
    const sqlitePath = nextFile();
    const db = AuditDb.open({ sqlitePath });
    const runA = startCompleted(db, ["expo"]);
    db.close();
    const cfg = config(sqlitePath);
    const first = JSON.parse(runCompare(cfg, runA.runId, "nope").line);
    expect(first.notComparable).toBe(true);
    expect(first.reason).toContain("run nope not found or pre-migration (empty tracked_packages)");
    expect(first.reason).toContain("`--fresh` erases run history");
    const second = JSON.parse(runCompare(cfg, "ghost", runA.runId).line);
    expect(second.reason).toContain("run ghost not found");
  });

  test("non-completed run: notice names the run and its status", () => {
    const sqlitePath = nextFile();
    const db = AuditDb.open({ sqlitePath });
    const runA = startCompleted(db, ["expo"]);
    const { runId: runningId } = db.startRun({
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    }); // left running
    db.close();
    const notice = JSON.parse(runCompare(config(sqlitePath), runA.runId, runningId).line);
    expect(notice.notComparable).toBe(true);
    expect(notice.reason).toContain(runningId);
    expect(notice.reason).toContain("status: running");
  });

  test("success path: ONE JSON line on stdout; the human summary goes to stderr", () => {
    const sqlitePath = nextFile();
    const db = AuditDb.open({ sqlitePath });
    const runA = startCompleted(db, ["expo"]);
    const uA: Unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "a1" };
    head(db, runA.runId, uA, true);
    site(db, runA.runId, uA, { filePath: "src/base.ts", lineNumber: 1 });
    const runB = startCompleted(db, ["expo"]);
    const uB: Unit = { ...uA, commitSha: "b1" };
    head(db, runB.runId, uB, true);
    site(db, runB.runId, uB, { filePath: "src/base.ts", lineNumber: 1 });
    site(db, runB.runId, uB, { filePath: "src/new.ts", lineNumber: 2 });
    db.close();

    const errChunks: string[] = [];
    const se = spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
      errChunks.push(String(c));
      return true;
    }) as typeof process.stderr.write);
    let line: string;
    try {
      line = runCompare(config(sqlitePath), runA.runId, runB.runId).line;
    } finally {
      se.mockRestore();
    }
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n"); // exactly one line
    const parsed = JSON.parse(line) as CompareEnvelope;
    expect(parsed.compare.packages[0]!.summary.usageSitesAdded).toBe(1);
    const err = errChunks.join("");
    expect(err).toContain("COMPARE");
    expect(err).toContain("expo");
    // and the stderr text is exactly the exported renderer's output
    expect(err).toBe(compareSummaryText(parsed));
  });
});

describe("main (stdout purity)", () => {
  async function captureStdout(fn: () => Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const so = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    try {
      await fn();
    } finally {
      so.mockRestore();
    }
    return chunks.join("");
  }

  test("--help prints COMPARE_HELP and nothing else", async () => {
    const out = await captureStdout(() => main(["--help"]));
    expect(out).toBe(COMPARE_HELP + "\n");
  });

  test("writes EXACTLY runCompare's line to stdout (missing-db path through a real --config file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-main-"));
    // paths must pass config.ts's §0 containment relative to the test cwd; the db file itself
    // never exists, so runCompare short-circuits before any open.
    const sqlitePath = `${TEST_ROOT}/no-such-run-yet.db`;
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      githubHost: "github.com", organizations: null, excludeOrganizations: [],
      includePersonalNamespace: false, includeForks: false, includeArchived: false,
      maxReposPerOrg: null, maxBranchesPerRepo: 25, cutoffDate: "2024-01-01",
      concurrency: { organizations: 1, repositories: 1, branches: 1 },
      packages: [{ name: "expo" }], excludeDirGlobs: [],
      paths: { sqlitePath, outputDir: "./output" },
    }));
    const out = await captureStdout(() => main(["--config", configPath, "run-a", "run-b"]));
    expect(out).toBe(`${JSON.stringify(buildNotComparableNotice({ kind: "missing-db", path: sqlitePath }))}\n`);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("buildCompare — review-hardening cases (dual-review round 1)", () => {
  test("head-join fidelity: a shared-commit rescan is NO change even though findings.run_id moved", () => {
    // The load-bearing invariant (never filter by findings.run_id): upsert the finding ONCE
    // under run A, then give run B a scanned head at the SAME commit (the §3 skip-as-current
    // shape — db's upsert would even overwrite run_id on a rescan). The head-join sees the
    // site in BOTH slices → no diff. A `WHERE uf.run_id = ?` regression would report the
    // whole repo as removed (or added) and fail here.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runA = startCompleted(db, ["expo"]);
    const unit: Unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "sha-shared" };
    head(db, runA.runId, unit, true);
    site(db, runA.runId, unit, { filePath: "src/a.ts", lineNumber: 3 });
    const runB = startCompleted(db, ["expo"]);
    head(db, runB.runId, unit, true); // same head, no re-upsert of the finding
    const out = buildCompare(db, runA, runB) as any;
    const pkg = out.compare.packages[0];
    expect(pkg.added).toEqual([]);
    expect(pkg.removed).toEqual([]);
    expect(pkg.summary.usageSitesAdded).toBe(0);
    expect(pkg.summary.usageSitesRemoved).toBe(0);
    db.close();
  });

  test("same file/line with a DIFFERENT export_name IS a change (key discrimination)", () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runA = startCompleted(db, ["expo"]);
    const unitA: Unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "sha-a" };
    head(db, runA.runId, unitA, true);
    site(db, runA.runId, unitA, { filePath: "src/x.ts", lineNumber: 7, exportName: "oldExport" });
    const runB = startCompleted(db, ["expo"]);
    const unitB: Unit = { ...unitA, commitSha: "sha-b" };
    head(db, runB.runId, unitB, true);
    site(db, runB.runId, unitB, { filePath: "src/x.ts", lineNumber: 7, exportName: "newExport" });
    const out = buildCompare(db, runA, runB) as any;
    const pkg = out.compare.packages[0];
    expect(pkg.added.map((s: any) => s.exportName)).toEqual(["newExport"]);
    expect(pkg.removed.map((s: any) => s.exportName)).toEqual(["oldExport"]);
    db.close();
  });

  test("NULL-flag widening extends to reposEntering: a non-default-branch repo counts when incomplete", () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runA = startCompleted(db, ["expo"]);
    const unitA: Unit = { organization: "org-a", repository: "old", branch: "main", commitSha: "sha-a" };
    head(db, runA.runId, unitA, null); // pre-v3-style head → incomplete flag fires
    site(db, runA.runId, unitA, { filePath: "src/a.ts" });
    const runB = startCompleted(db, ["expo"]);
    head(db, runB.runId, unitA, true);
    site(db, runB.runId, unitA, { filePath: "src/a.ts" });
    // the ENTERING repo exists only on a NON-default branch in run B
    const featUnit: Unit = { organization: "org-a", repository: "newcomer", branch: "feat", commitSha: "sha-f" };
    head(db, runB.runId, featUnit, false);
    site(db, runB.runId, featUnit, { filePath: "src/n.ts" });
    const out = buildCompare(db, runA, runB) as any;
    const pkg = out.compare.packages[0];
    expect(pkg.summary.defaultBranchDataIncomplete).toBe(true);
    // widened: the non-default-branch newcomer is COUNTED, never silently dropped
    expect(pkg.summary.reposEntering).toBe(1);
    expect(pkg.reposEntering.map((r: any) => r.repository)).toEqual(["newcomer"]);
    db.close();
  });
});
