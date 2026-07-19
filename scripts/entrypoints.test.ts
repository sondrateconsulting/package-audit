// entrypoints.test.ts — the REAL main() dispatch of both entrypoints, driven in-process.
// The one behavior nothing else covers: orchestrate's `--plan` early return is the single line
// standing between plan mode and AuditDb.open (including a destructive --fresh drop), and the
// trust dossier's "writes nothing at all" claim rides on it. These tests run main() end-to-end
// against deterministic offline shims for gh/git/tar (resolved via PATH, exactly as production
// resolves them) with the registry-reachability fetch stubbed, then assert the §0 zero-write
// contract at the PROCESS level: an untouched cwd tree and no new pkg-audit-* temp dirs.
import { expect, test, describe, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { main as orchestrateMain } from "./orchestrate.ts";
import { main as reportMain } from "./report.ts";
import { main as exportMain } from "./export.ts";
import { ORCHESTRATE_HELP, REPORT_HELP } from "./args.ts";
import { activeHeartbeats } from "./heartbeat.ts";
import { AuditDb, nowIso } from "./db.ts";
import { setLogSink, resetLogSink, type LogSink } from "./log.ts";

// Seed a COMPLETED run tracking `expo` with one scanned unit + a usage finding, so report --html
// emits a `dossier` and export emits per-table `export` events. Opened at the cwd-relative path the
// fixture config points at, so it must run INSIDE inFixture (cwd = fixture root).
function seedReportableRun(): void {
  const db = AuditDb.open({ sqlitePath: "./data/audit.db" });
  try {
    const { runId } = db.startRun({ configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" });
    const unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "abc123def" };
    db.upsertRunUnitHead({ runId, ...unit, status: "scanned", isDefaultBranch: null, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    db.upsertUsageFinding({ runId, ...unit, packageName: "expo", dependencyKey: "expo", usageType: "named-import", exportName: "registerRootComponent", context: "", filePath: "src/index.ts", lineNumber: 1, permalink: "https://github.com/org-a/svc/blob/abc123def/src/index.ts#L1", snippet: "import { registerRootComponent } from 'expo';", foundAt: nowIso() });
    db.completeRun(runId);
  } finally {
    db.close();
  }
}

// A stdout sink that backpressures once paused. `hitArtifact` resolves the instant the FIRST artifact
// line (dossier/export) is written under backpressure — i.e. runReport/runExport has started emitting,
// so main() is (synchronously, no await before the finally) about to await flushLogs. That lets a test
// prove main() BLOCKS on its finally-flush: if the finally were removed, main() would write its summary
// and return before we ever resume, so `summaryWritten` would already be true at the checkpoint.
function pausedArtifactSink(markerEvent: string) {
  const received: string[] = [];
  let paused = false;
  let signalled = false;
  let drainCb: (() => void) | null = null;
  let onArtifact: () => void = () => {};
  const hitArtifact = new Promise<void>((r) => { onArtifact = r; });
  const eventOf = (line: string): unknown => { try { return (JSON.parse(line) as { event?: unknown }).event; } catch { return undefined; } };
  const sink: LogSink = {
    write: (line) => {
      received.push(line);
      if (paused) {
        if (!signalled && eventOf(line) === markerEvent) { signalled = true; onArtifact(); }
        return false;
      }
      return true;
    },
    onDrain: (cb) => { drainCb = cb; },
    isClosed: () => false,
    onClose: () => {},
  };
  return { sink, received, hitArtifact, pause: () => { paused = true; }, resume: () => { paused = false; const cb = drainCb; drainCb = null; if (cb) cb(); } };
}

// Capture BOTH streams while `fn` runs (help text and JSONL go to stdout; summaries to stderr).
async function captureStreams(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
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
    await fn();
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
  return { out: out.join(""), err: err.join("") };
}

// Build the offline fixture: bin/ shims, etc/config.json, and a cwd holding only the two
// §0-permitted roots (data/, output/) — both empty, so "still exactly this" IS the zero-write proof.
function makeFixture(): { root: string; binDir: string; cwdDir: string; configPath: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "entry-"));
  const binDir = join(root, "bin");
  const cwdDir = join(root, "cwd");
  mkdirSync(binDir);
  mkdirSync(join(cwdDir, "data"), { recursive: true });
  mkdirSync(join(cwdDir, "output"), { recursive: true });

  // gh shim: canned §2 preflight answers + an empty §5.A repo page (in gh api -i wire format).
  const gh = [
    "#!/bin/sh",
    'case "$1" in',
    '  --version) echo "gh version 2.62.0 (2026-01-01)"; exit 0 ;;',
    "  auth) exit 0 ;;",
    "  api)",
    '    case "$3" in',
    "      user) printf 'HTTP/2.0 200 OK\\r\\n\\r\\n{\"login\":\"tester\"}' ;;",
    "      rate_limit) printf 'HTTP/2.0 200 OK\\r\\n\\r\\n{\"resources\":{\"core\":{\"remaining\":5000},\"graphql\":{\"remaining\":5000}}}' ;;",
    "      orgs/*) printf 'HTTP/2.0 200 OK\\r\\n\\r\\n[]' ;;",
    "      *) printf 'HTTP/2.0 404 Not Found\\r\\n\\r\\n{\"message\":\"Not Found\"}' ;;",
    "    esac",
    "    exit 0 ;;",
    "esac",
    'echo "unexpected gh args: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
  writeFileSync(join(binDir, "gh"), gh);
  writeFileSync(join(binDir, "git"), '#!/bin/sh\necho "git version 2.45.1"\nexit 0\n');
  writeFileSync(join(binDir, "tar"), '#!/bin/sh\necho "tar (GNU tar) 1.35"\nexit 0\n');
  for (const b of ["gh", "git", "tar"]) chmodSync(join(binDir, b), 0o755);

  const configPath = join(root, "etc", "config.json");
  mkdirSync(join(root, "etc"));
  writeFileSync(
    configPath,
    JSON.stringify({
      cutoffDate: "2024-01-01",
      githubHost: "github.com",
      organizations: ["pkg-audit-test-org-that-cannot-exist"],
      excludeOrganizations: [],
      includePersonalNamespace: false,
      includeArchived: false,
      includeForks: false,
      maxReposPerOrg: null,
      maxBranchesPerRepo: 25,
      concurrency: { organizations: 1, repositories: 1, branches: 1 },
      excludeDirGlobs: [],
      packages: [{ name: "expo" }],
      paths: { sqlitePath: "./data/audit.db", outputDir: "./output" },
    }),
  );
  return { root, binDir, cwdDir, configPath };
}

// Run `fn` with cwd/PATH/fetch swapped to the fixture and restored afterward — the same three
// ambient inputs production main() reads (config containment root, bin resolution, registry probe).
async function inFixture(fx: { binDir: string; cwdDir: string }, fn: () => Promise<void>): Promise<void> {
  const prevCwd = process.cwd();
  const prevPath = process.env.PATH;
  const prevFetch = globalThis.fetch;
  process.chdir(fx.cwdDir);
  process.env.PATH = fx.binDir;
  globalThis.fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = prevFetch;
    // restore ABSENCE too: assigning undefined coerces to the string "undefined" on node and
    // leaves a present-but-undefined key on bun — neither is the pre-test state
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    process.chdir(prevCwd);
  }
}

describe("entrypoint --help (both binaries, in-process)", () => {
  test("orchestrate: --help prints the help text and does nothing else", async () => {
    const { out, err } = await captureStreams(() => orchestrateMain(["--help"]));
    expect(out).toBe(ORCHESTRATE_HELP + "\n");
    expect(err).toBe("");
  });
  test("orchestrate: --help wins over other flags (no config read, no preflight)", async () => {
    const { out } = await captureStreams(() => orchestrateMain(["--plan", "-h"]));
    expect(out).toBe(ORCHESTRATE_HELP + "\n"); // nothing before it: main returned at the help gate
  });
  test("report: --help prints the help text and does nothing else", async () => {
    const { out, err } = await captureStreams(() => reportMain(["--help"]));
    expect(out).toBe(REPORT_HELP + "\n");
    expect(err).toBe("");
  });
});

describe("orchestrate main() --plan (offline shims — the zero-write early return)", () => {
  test("plan mode runs preflight + discovery, ends at plan-summary, and touches NOTHING", async () => {
    const fx = makeFixture();
    try {
      const tmpBefore = new Set(readdirSync(realpathSync(tmpdir())).filter((n) => n.startsWith("pkg-audit-")));

      const { out, err } = await captureStreams(() =>
        inFixture(fx, () => orchestrateMain(["--plan", "--config", fx.configPath])),
      );

      // stdout is PURE JSONL, and the dispatch stopped at the plan summary — nothing after it
      const events = out.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(events.map((e) => e["event"])).toEqual(["config", "concurrency", "preflight", "owners", "plan-summary"]);
      const summary = events[4]!;
      expect(summary["owners"]).toEqual(["pkg-audit-test-org-that-cannot-exist"]);
      expect(summary["reposDiscovered"]).toBe(0);
      expect(summary["discoveryErrors"]).toBe(0);
      // T7: plan-summary is plan mode's TERMINAL event, so it carries the reporter counters (M2)
      expect(summary["retryTotal"]).toBe(0);
      expect(summary["suppressed"]).toBe(0);
      // policy diagnostics are present and zero on a no-repos plan
      expect(summary["excludedByDeny"]).toBe(0);
      expect(summary["excludedByAllow"]).toBe(0);
      expect(summary["defaultBranchPolicyOverrides"]).toBe(0);
      expect(events[2]!["login"]).toBe("tester"); // preflight really ran against the shims
      // the concurrency event reports the effective fan-out widths (all three keys present)
      expect(events[1]).toMatchObject({ event: "concurrency" });
      for (const k of ["organizations", "branches", "repositories"]) expect(typeof events[1]![k]).toBe("number");
      expect(err).toContain("PLAN — preview only");

      // §0 zero-write, at the process level: the cwd tree is EXACTLY the two empty roots it
      // started with — no data/audit.db (the DB never opened), no output artifacts, no strays.
      expect(readdirSync(fx.cwdDir).sort()).toEqual(["data", "output"]);
      expect(readdirSync(join(fx.cwdDir, "data"))).toEqual([]);
      expect(readdirSync(join(fx.cwdDir, "output"))).toEqual([]);
      // ... and no pkg-audit-* temp dirs appeared (the git probe runs config-less by design)
      const tmpAfter = readdirSync(realpathSync(tmpdir())).filter((n) => n.startsWith("pkg-audit-"));
      expect(tmpAfter.filter((n) => !tmpBefore.has(n))).toEqual([]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe("orchestrate main() heartbeat lifecycle (T6 — no dangling timer)", () => {
  test("the run-scoped heartbeat is started and cleared on the normal exit path", async () => {
    const fx = makeFixture();
    try {
      const before = activeHeartbeats();
      await captureStreams(() => inFixture(fx, () => orchestrateMain(["--plan", "--config", fx.configPath])));
      // started before preflight, cleared in the ONE outer finally → active-count is balanced
      expect(activeHeartbeats()).toBe(before);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("the heartbeat is cleared even when the run THROWS (error exit path)", async () => {
    const fx = makeFixture();
    try {
      const before = activeHeartbeats();
      await expect(
        captureStreams(() =>
          inFixture(fx, async () => {
            // preflight's registry-reachability probe now fails AFTER the heartbeat has started
            globalThis.fetch = (async () => {
              throw new Error("connect ECONNREFUSED");
            }) as unknown as typeof fetch;
            await orchestrateMain(["--config", fx.configPath]);
          }),
        ),
      ).rejects.toThrow();
      expect(activeHeartbeats()).toBe(before); // the outer finally stopped it despite the throw
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe("report main() wiring (missing DB stays a no-op through the real entrypoint)", () => {
  test("report before any audit prints the notReportable notice and touches NOTHING", async () => {
    const fx = makeFixture();
    try {
      const { out, err } = await captureStreams(() =>
        inFixture(fx, () => reportMain(["--config", fx.configPath])),
      );
      const notice = JSON.parse(out.trim()) as Record<string, unknown>;
      expect(notice["notReportable"]).toBe(true);
      expect(String(notice["reason"])).toContain("run `bun run audit` first");
      expect(err).toBe("");
      expect(readdirSync(fx.cwdDir).sort()).toEqual(["data", "output"]);
      expect(readdirSync(join(fx.cwdDir, "data"))).toEqual([]);
      expect(readdirSync(join(fx.cwdDir, "output"))).toEqual([]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// The finally-flush moved from the (untestable) import.meta.main catch into main()'s own try/finally.
// These drive the REAL main() under a paused sink and prove main() BLOCKS on that finally-flush before
// its summary — deleting the finally would let main() write the summary and return without draining,
// failing the `summaryWritten === false` checkpoint below. (santa round 2 — B/C: tests bypassed main)
describe("report/export main() await their finally-flush before the summary (T7)", () => {
  test("report --html main() blocks on its finally-flush until buffered dossiers drain", async () => {
    const fx = makeFixture();
    const g = pausedArtifactSink("dossier");
    let summaryWritten = false;
    const outSpy = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => { void c; summaryWritten = true; return true; }) as typeof process.stdout.write);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    setLogSink(g.sink);
    try {
      await inFixture(fx, async () => {
        seedReportableRun();
        g.pause();
        const p = reportMain(["--config", fx.configPath, "--html"]);
        await g.hitArtifact; // a `dossier` backpressured the sink → main is (synchronously) at its finally `await flushLogs()`
        await Promise.resolve();
        expect(summaryWritten).toBe(false); // TEETH: main is BLOCKED on the finally-flush; without it the summary is already out
        g.resume(); // drain the buffered dossiers → flush resolves → main writes its summary
        await p;
      });
      expect(summaryWritten).toBe(true);
      expect(g.received.map((l) => JSON.parse(l).event)).toContain("dossier-summary"); // the buffered tail shipped via the flush
    } finally {
      resetLogSink();
      outSpy.mockRestore();
      errSpy.mockRestore();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("export main() blocks on its finally-flush until buffered export events drain", async () => {
    const fx = makeFixture();
    const g = pausedArtifactSink("export");
    let summaryWritten = false;
    const outSpy = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => { void c; summaryWritten = true; return true; }) as typeof process.stdout.write);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    setLogSink(g.sink);
    try {
      await inFixture(fx, async () => {
        seedReportableRun();
        g.pause();
        const p = exportMain(["--config", fx.configPath]);
        await g.hitArtifact; // the first `export` line backpressured the sink → main is at its finally-flush
        await Promise.resolve();
        expect(summaryWritten).toBe(false); // TEETH: main blocked on the finally-flush before the export-summary
        g.resume();
        await p;
      });
      expect(summaryWritten).toBe(true);
      expect(g.received.map((l) => JSON.parse(l).event).filter((e) => e === "export").length).toBeGreaterThan(1); // buffered tail shipped
    } finally {
      resetLogSink();
      outSpy.mockRestore();
      errSpy.mockRestore();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
