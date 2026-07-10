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
import { ORCHESTRATE_HELP, REPORT_HELP } from "./args.ts";

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
    process.env.PATH = prevPath;
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
    const tmpBefore = new Set(readdirSync(realpathSync(tmpdir())).filter((n) => n.startsWith("pkg-audit-")));

    const { out, err } = await captureStreams(() =>
      inFixture(fx, () => orchestrateMain(["--plan", "--config", fx.configPath])),
    );

    // stdout is PURE JSONL, and the dispatch stopped at the plan summary — nothing after it
    const events = out.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e["event"])).toEqual(["config", "preflight", "owners", "plan-summary"]);
    const summary = events[3]!;
    expect(summary["owners"]).toEqual(["pkg-audit-test-org-that-cannot-exist"]);
    expect(summary["reposDiscovered"]).toBe(0);
    expect(summary["discoveryErrors"]).toBe(0);
    expect(events[1]!["login"]).toBe("tester"); // preflight really ran against the shims
    expect(err).toContain("PLAN — preview only");

    // §0 zero-write, at the process level: the cwd tree is EXACTLY the two empty roots it
    // started with — no data/audit.db (the DB never opened), no output artifacts, no strays.
    expect(readdirSync(fx.cwdDir).sort()).toEqual(["data", "output"]);
    expect(readdirSync(join(fx.cwdDir, "data"))).toEqual([]);
    expect(readdirSync(join(fx.cwdDir, "output"))).toEqual([]);
    // ... and no pkg-audit-* temp dirs appeared (the git probe runs config-less by design)
    const tmpAfter = readdirSync(realpathSync(tmpdir())).filter((n) => n.startsWith("pkg-audit-"));
    expect(tmpAfter.filter((n) => !tmpBefore.has(n))).toEqual([]);

    rmSync(fx.root, { recursive: true, force: true });
  });
});

describe("report main() wiring (missing DB stays a no-op through the real entrypoint)", () => {
  test("report before any audit prints the notReportable notice and touches NOTHING", async () => {
    const fx = makeFixture();
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
    rmSync(fx.root, { recursive: true, force: true });
  });
});
