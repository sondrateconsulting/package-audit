// benchContentTransport.ts — the ADR-0001 content-transport benchmark harness entrypoint
// (resolution plan §4.1), run as `bun run bench:content <subcommand>`. Standalone: it reuses
// production modules where realism demands and NEVER touches the production database, temp
// prefix, or production source files. No CI job runs this — every subcommand that talks to the
// network runs locally under the operator's gh identity.
//
//   pin-corpus     verify §4.2 slot candidates, pin SHAs, record workloads + ground truth,
//                  write corpus.json / selected/*.json / the schedule table into bench-config
//   diagnostics    §4.4 acquisition diagnostics (production vs scaffolding forms, 3× each)
//   budget         print per-(unit × driver) worst-case spend + the schedule's total
//   pilot          §8's pre-ratification diagnostic pilot (K reps of T0 on C2) → noise band
//   matrix         Step C's timed traversal — REFUSES to run before ratification.json exists
//   fidelity       the C6 fidelity battery (untimed, once per applicable driver)
//
// Artifacts land in docs/adrs/0001-benchmark/. The pinning cache lives under ./data (a §0
// write root, git-ignored) so re-runs are cheap; bench run dirs live under a pa-bench-* root.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubClient, buildGitEnv, parseTreeResponse } from "./github.ts";
import { AuditDb } from "./db.ts";
import { walkClone, cloneReader } from "./orchestrate.ts";
import type { TreeEntry } from "./unitPipeline.ts";
import { locateManifests, dirOf } from "./manifest.ts";
import { makeExcluder } from "./unitPipeline.ts";
import { loadBenchConfig, type BenchConfig } from "./benchConfig.ts";
import {
  loadCorpus, scheduleUnitsFrom, verifyC1, verifyC2, verifyC3, verifyC4, verifyC5,
  verifyC6NonUtf8, verifyC6Symlink,
  type Corpus, type PerformanceSlot, type C6Fixture, type CorpusUnit, type SlotVerdict,
} from "./benchCorpus.ts";
import { buildSchedule } from "./benchSchedule.ts";
import {
  buildUnitWorkload, countReplacementChars, parseUnitWorkload, recordSelection, seamDecode, seamSha256, sha256Hex,
  type UnitWorkload, type WorkloadEntry,
} from "./benchWorkload.ts";
import { classifyFile } from "./cliScanner.ts";
import { parseLsTreeZ, type LsTreeEntry } from "./benchFrame.ts";
import { BatchChild, runBenchGit, type BenchSpawnRecord } from "./benchSpawn.ts";
import { benchGraphqlDispatch, benchRestGet, gitBlobOid, makeBuckets, readRateLimit, type BenchGhContext } from "./benchGh.ts";
import { analyzeBatchResponse, buildBatchQuery, packBatches } from "./benchT1.ts";
import {
  BenchEngine, RunsLog, buildEnvManifest, computeWorstCase, planSegments,
} from "./benchProtocol.ts";
import { acquireStore, probeLiveHead, type DriverRunContext } from "./benchDrivers.ts";
import { noiseBandFrom } from "./benchConfig.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const ARTIFACTS = join(REPO_ROOT, "docs", "adrs", "0001-benchmark");
const CONFIG_PATH = join(ARTIFACTS, "bench-config.json");
const CORPUS_PATH = join(ARTIFACTS, "corpus.json");
const SELECTED_DIR = join(ARTIFACTS, "selected");
const RATIFICATION_PATH = join(ARTIFACTS, "ratification.json");

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

// The frozen MEASUREMENT surface's content digest (§8 as amended): every bench module + the
// preregistered artifacts. Binding ratification to THIS (not to HEAD) keeps the gate
// satisfiable — committing ratification.json or appending runs.jsonl changes neither the
// digest nor the frozen surface (codex R2 finding 1).
function frozenSurfaceDigest(): string {
  const files: string[] = [];
  // EVERY non-test script — the bench modules AND the production modules they execute through
  // (github.ts, readOnlyGuard.ts, db.ts, the selection pipeline…) all drive measurement
  // (codex R3 f.1); plus both normative documents and the preregistered artifacts.
  for (const name of readdirSync(join(REPO_ROOT, "scripts"))) {
    if (/\.(ts|tsx)$/.test(name) && !name.includes(".test.")) files.push(join(REPO_ROOT, "scripts", name));
  }
  files.push(join(REPO_ROOT, "docs", "plans", "adr-0001-disagreements-resolution.md"));
  files.push(join(REPO_ROOT, "docs", "adrs", "0001-file-content-acquisition-strategy.md"));
  files.push(CONFIG_PATH, CORPUS_PATH);
  for (const tool of ["package.json", "tsconfig.json", "bun.lock", "bun.lockb"]) {
    const tp = join(REPO_ROOT, tool);
    if (existsSync(tp)) files.push(tp);
  }
  for (const name of readdirSync(SELECTED_DIR)) files.push(join(SELECTED_DIR, name));
  const uniq = [...new Set(files)].sort();
  const h = createHash("sha256");
  for (const f of uniq) {
    h.update(f.slice(REPO_ROOT.length));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

// The §8 freeze gate shared by every gate-relevant executor (matrix, fidelity): ratification
// present with all four answers, the band bound to the pilot, the frozen-surface digest bound,
// and a clean tree EXCLUDING the append-only outputs and ratification.json itself.
async function assertRatifiedAndFrozen(): Promise<{ rat: Record<string, unknown>; digest: string }> {
  // §8 binds ONE network for all timed data; the placeholder default would hash every network
  // identically (codex R4) — gate-relevant runs demand an explicit operator-set description
  if ((process.env["BENCH_NETWORK_DESC"] ?? "") === "")
    throw new Error("REFUSING: BENCH_NETWORK_DESC is unset — §8 requires a concrete network-location description; every timed row binds to it via the environment manifest");
  if (!existsSync(RATIFICATION_PATH))
    throw new Error(`REFUSING: ${RATIFICATION_PATH} does not exist — §8 ratification (the four sign-off points) must be recorded before any gate-relevant run (Step C)`);
  const rat = JSON.parse(readFileSync(RATIFICATION_PATH, "utf8")) as Record<string, unknown>;
  const answers = rat["answers"];
  if (typeof answers !== "object" || answers === null) throw new Error("REFUSING: ratification.json carries no answers object");
  for (const key of ["noiseBandAndDominance", "protocolConstants", "corpusPinning", "symlinkPolicy"]) {
    const a = (answers as Record<string, unknown>)[key];
    if (typeof a !== "string" || a.length === 0) throw new Error(`REFUSING: ratification.json answers.${key} is missing/empty — all four §8 sign-off points must carry explicit answers`);
  }
  const pilot = JSON.parse(readFileSync(join(ARTIFACTS, "pilot.json"), "utf8")) as { noiseBand?: number };
  if (rat["noiseBand"] !== pilot.noiseBand)
    throw new Error(`REFUSING: ratification.json noiseBand (${String(rat["noiseBand"])}) != pilot.json's calibrated band (${String(pilot.noiseBand)})`);
  const digest = frozenSurfaceDigest();
  if (rat["frozenSurfaceDigest"] !== digest)
    throw new Error(`REFUSING: the frozen measurement surface changed since ratification (digest ${digest.slice(0, 12)}… != ratified ${String(rat["frozenSurfaceDigest"]).slice(0, 12)}…) — a §8 amendment + review round is required`);
  const repoRoot = realpathSync(REPO_ROOT);
  const statusOut = await runBenchGit({
    argv: ["status", "--porcelain"], lane: { lane: "pinning" }, env: buildGitEnv(process.env, "/dev/null"),
    benchRoot: repoRoot, cwd: repoRoot, limits: { maxStdoutBytes: 1024 * 1024, maxStderrBytes: 4096, deadlineMs: 60_000 },
  });
  // ratification.json is deliberately NOT here: it must be COMMITTED, so tampering with the
  // signed answers or the digest needs a visible commit (codex R3 f.1)
  const lsFiles = await runBenchGit({
    argv: ["ls-files", "--error-unmatch", "docs/adrs/0001-benchmark/ratification.json"],
    lane: { lane: "pinning" }, env: buildGitEnv(process.env, "/dev/null"),
    benchRoot: repoRoot, cwd: repoRoot, limits: { maxStdoutBytes: 4096, maxStderrBytes: 4096, deadlineMs: 60_000 },
  });
  if (lsFiles.exitCode !== 0)
    throw new Error("REFUSING: ratification.json is not TRACKED — the signed answers must be committed, not a local file (§8)");
  const APPEND_ONLY = ["docs/adrs/0001-benchmark/runs.jsonl", "docs/adrs/0001-benchmark/fidelity.jsonl", "data/"];
  const dirty = text(statusOut.stdout).split("\n").map((l) => l.slice(3).trim()).filter((f) => f !== "" && !APPEND_ONLY.some((a) => f.startsWith(a)));
  if (dirty.length > 0)
    throw new Error(`REFUSING: dirty tracked files outside the append-only outputs: ${dirty.slice(0, 5).join(", ")} — the frozen surface must be committed (§8)`);
  return { rat, digest };
}

// §4.2 candidates, in preference order — a failing candidate is SWAPPED, never forced.
// C1 was swapped off the plan's fastify/fastify at pinning: its major lines share ≤14.2% of
// blob oids (measured), nowhere near the ≥80% the slot requires — repos that keep parallel
// MAINTENANCE branches do satisfy it, so C1 candidates discover main + the top release lines
// live (branch names cannot be pinned offline) and verify the sharing pair as usual.
const C1_CANDIDATES: Array<{ owner: string; repo: string; main: string; releaseRe: RegExp; key: (m: RegExpExecArray) => number }> = [
  { owner: "prometheus", repo: "prometheus", main: "main", releaseRe: /^release-(\d+)\.(\d+)$/, key: (m) => Number(m[1]) * 1000 + Number(m[2]) },
  { owner: "go-gitea", repo: "gitea", main: "main", releaseRe: /^release\/v(\d+)\.(\d+)$/, key: (m) => Number(m[1]) * 1000 + Number(m[2]) },
  { owner: "electron", repo: "electron", main: "main", releaseRe: /^(\d+)-x-y$/, key: (m) => Number(m[1]) },
];
const SLOT_CANDIDATES: Record<string, Array<{ owner: string; repo: string; branches: string[] }>> = {
  // C2's planned candidate nodejs/undici FAILED verification at pinning (791 files < the
  // 1000..3000 window — the repo shrank); the fallbacks are mid-size JS/TS repos with real
  // manifest structure, tried in order (§4.2 swap-not-force).
  C2: [
    { owner: "nodejs", repo: "undici", branches: ["main"] },
    { owner: "nestjs", repo: "nest", branches: ["master"] },
    { owner: "vuejs", repo: "core", branches: ["main"] },
    { owner: "TanStack", repo: "query", branches: ["main"] },
    { owner: "pnpm", repo: "pnpm", branches: ["main"] },
  ],
  // C3 measured at pinning: nixpkgs's REST tree is TRUNCATED (a C4 shape — 53.6k entries) and
  // home-assistant/core's paths are short (mean ~47 B); kubernetes (~31.3k entries, mean ~67 B,
  // deep staging/ nesting) is the path-heavy candidate that verifies, so it leads.
  C3: [
    { owner: "kubernetes", repo: "kubernetes", branches: ["master"] },
    { owner: "NixOS", repo: "nixpkgs", branches: ["master"] },
    { owner: "home-assistant", repo: "core", branches: ["dev"] },
  ],
  C4: [
    { owner: "llvm", repo: "llvm-project", branches: ["main"] },
    { owner: "chromium", repo: "chromium", branches: ["main"] },
  ],
  C5: [
    { owner: "PowerShell", repo: "PowerShell", branches: ["master"] },
    { owner: "dotnet", repo: "runtime", branches: ["main"] },
  ],
};
// Measured at pinning: the plan's git/git has NO selected symlink (its symlinks sit at
// non-classified paths) but DOES carry a selected non-UTF-8 .sh; ansible's
// .azure-pipelines/commands/*.sh are real mode-120000 entries at SELECTED paths (REST-tree mode
// probe, 2026-07-28); kubernetes' root Makefile is a symlink too (and k8s is already C3, so the
// matrix exercises the symlink route there naturally — the fixture isolates byte fidelity).
const C6_CLONE_CANDIDATES: Array<{ owner: string; repo: string; branch: string }> = [
  { owner: "ansible", repo: "ansible", branch: "devel" },
  { owner: "git", repo: "git", branch: "master" },
  { owner: "kubernetes", repo: "kubernetes", branch: "master" },
];
// M9, fully specified in the ADR — the API-only symlink fixture (T0/T1).
const M9 = {
  owner: "nodejs", repo: "node", sha: "b2a024b1ad3373d405ca55af23f59dd4cd696c2f",
  path: "deps/v8/third_party/ittapi/ittapi-rs/CMakeLists.txt",
  mode: "120000", oid: "de0cf227139ff67dd6d0493c03533e48d6ea8634", size: 17,
};

interface PinRuntime {
  cfg: BenchConfig;
  benchRoot: string;
  client: GithubClient; // pin-cache-backed
  gh: BenchGhContext;
  gitEnv: Record<string, string>;
  gitEnvProbe: Record<string, string>;
  spawnObs: (r: BenchSpawnRecord) => void;
}

function makePinRuntime(cfg: BenchConfig): PinRuntime {
  const benchRoot = mkdtempSync(join(realpathSync(tmpdir()), cfg.protocol.tempPrefix));
  mkdirSync(join(REPO_ROOT, "data"), { recursive: true });
  const db = AuditDb.open({ sqlitePath: join(REPO_ROOT, "data", "bench-pin-cache.sqlite"), fresh: false, purgeCache: false });
  const client = new GithubClient({ githubHost: cfg.githubHost, db, tempRoot: benchRoot });
  const buckets = makeBuckets();
  const gh: BenchGhContext = {
    client, db, cfg, core: buckets.core, graphql: buckets.graphql,
    record: () => {}, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const writeGitcfg = (name: string, template: string): string => {
    const ghBin = Bun.which("gh") ?? "gh";
    const quoted = `'${ghBin.replace(/'/g, `'\\''`)}'`;
    const path = join(benchRoot, name);
    writeFileSync(path, template.replace("{ghBin}", quoted), { mode: 0o600 });
    return path;
  };
  const gitEnv = buildGitEnv(process.env, writeGitcfg("gitcfg-baseline", cfg.scaffolding.gitconfigBaseline));
  gitEnv["GIT_NO_REPLACE_OBJECTS"] = "1";
  const gitEnvProbe = buildGitEnv(process.env, writeGitcfg("gitcfg-probe", cfg.scaffolding.gitconfigProbeAutocrlfTrue));
  gitEnvProbe["GIT_NO_REPLACE_OBJECTS"] = "1";
  return { cfg, benchRoot, client, gh, gitEnv, gitEnvProbe, spawnObs: () => {} };
}

// ---- pinning-lane git helpers ----------------------------------------------------------------
async function pinGit(rt: PinRuntime, argv: string[], opts: { cwd?: string; env?: Record<string, string>; maxStdoutBytes?: number } = {}): Promise<Uint8Array> {
  const res = await runBenchGit({
    argv, lane: { lane: "pinning" }, env: opts.env ?? rt.gitEnv, benchRoot: rt.benchRoot,
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    limits: { maxStdoutBytes: opts.maxStdoutBytes ?? 512 * 1024 * 1024, maxStderrBytes: 4 * 1024 * 1024, deadlineMs: rt.cfg.spawn.timeoutMs },
    onRecord: rt.spawnObs,
  });
  if (res.exitCode !== 0)
    throw new Error(`pinning git ${argv[0]} failed: ${new TextDecoder().decode(res.stderr).trim().slice(0, 400)}`);
  return res.stdout;
}
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

async function pinClone(rt: PinRuntime, owner: string, repo: string, branch: string, name: string, env?: Record<string, string>): Promise<{ dir: string; sha: string; treeOid: string; objectFormat: "sha1" | "sha256" }> {
  const dir = join(rt.benchRoot, name);
  const url = `https://${rt.cfg.githubHost}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`;
  await pinGit(rt, ["clone", "--depth", "1", "--single-branch", "--branch", branch, "--no-tags", "--no-recurse-submodules", "--template=", url, dir], { env: env ?? rt.gitEnv });
  const sha = text(await pinGit(rt, ["rev-parse", "HEAD"], { cwd: dir, env })).trim();
  const treeOid = text(await pinGit(rt, ["rev-parse", "HEAD^{tree}"], { cwd: dir, env })).trim();
  const fmt = text(await pinGit(rt, ["rev-parse", "--show-object-format"], { cwd: dir, env })).trim();
  if (fmt !== "sha1" && fmt !== "sha256") throw new Error(`unknown object format ${fmt}`);
  return { dir, sha, treeOid, objectFormat: fmt };
}

async function lsTreeIndex(rt: PinRuntime, dir: string, format: "sha1" | "sha256"): Promise<LsTreeEntry[]> {
  const out = await pinGit(rt, ["ls-tree", "-r", "-z", "-l", "--full-tree", "HEAD"], { cwd: dir, maxStdoutBytes: rt.cfg.lsTree.maxOutputBytes });
  return parseLsTreeZ(out, format, { maxEntries: rt.cfg.lsTree.maxEntries, maxRecordBytes: rt.cfg.lsTree.maxRecordBytes });
}
async function catBlob(rt: PinRuntime, dir: string, oid: string): Promise<Uint8Array> {
  return pinGit(rt, ["cat-file", "blob", oid], { cwd: dir, maxStdoutBytes: rt.cfg.spawn.outputCapBytes });
}

// ---- workload pinning per unit ---------------------------------------------------------------
async function fetchRestTruncation(rt: PinRuntime, owner: string, repo: string, treeOid: string): Promise<boolean> {
  const json = await rt.client.restGetJson(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeOid)}?recursive=1`, { immutable: true });
  const tree = parseTreeResponse(json, "pin-tree", treeOid);
  return tree.truncated;
}

async function probeGqlFacts(rt: PinRuntime, slot: { owner: string; repo: string }, sha: string, entries: WorkloadEntry[]): Promise<Map<string, { isBinary: boolean; isTruncated: boolean; textNull: boolean }>> {
  const facts = new Map<string, { isBinary: boolean; isTruncated: boolean; textNull: boolean }>();
  const probeCfg: BenchConfig = { ...rt.cfg, t1: { ...rt.cfg.t1, aliasCap: 100, batchContentBytesCap: 1024 * 1024 } };
  const candidates = entries.filter((e) => e.read && e.mode !== "120000");
  const batches = packBatches(candidates, probeCfg, { owner: slot.owner, repo: slot.repo, sha, roundLabel: "gqlprobe" });
  for (const batch of batches) {
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      const d = await benchGraphqlDispatch(rt.gh, batch.query, batch.fields, batch.label);
      if (d.status !== 200 || !d.jsonParseable || d.data === null) {
        log(`  gql probe ${batch.label}: HTTP ${d.status}, retrying`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      const repo = d.data["repository"];
      const repoObj = typeof repo === "object" && repo !== null ? (repo as Record<string, unknown>) : {};
      batch.entries.forEach((entry, i) => {
        const alias = repoObj[`a${i}`];
        if (typeof alias !== "object" || alias === null) {
          facts.set(entry.path, { isBinary: true, isTruncated: false, textNull: true }); // absent/opaque: route to fallback
          return;
        }
        const o = alias as Record<string, unknown>;
        facts.set(entry.path, {
          isBinary: o["isBinary"] === true,
          isTruncated: o["isTruncated"] === true,
          textNull: typeof o["text"] !== "string",
        });
      });
      done = true;
    }
    if (!done) throw new Error(`gql probe ${batch.label} failed after 3 attempts`);
  }
  return facts;
}

async function pinUnitWorkload(rt: PinRuntime, slot: PerformanceSlot, unit: CorpusUnit, cloneDir: string, lsIndex: Map<string, LsTreeEntry>, truncated: boolean, probeCheckoutDir: string | null): Promise<UnitWorkload> {
  const format = slot.objectFormat;
  // production TreeEntry list: the REST-tree shape for complete trees; walkClone (lstat sizes,
  // symlinks skipped) for truncated ones — the status-quo selection path exactly (§4.3).
  let entries: TreeEntry[];
  let readFile: (path: string, entry: TreeEntry) => Promise<string | null>;
  if (truncated) {
    entries = walkClone(cloneDir);
    readFile = cloneReader(cloneDir);
  } else {
    entries = [...lsIndex.values()].map((e) => ({ path: e.path, type: e.type, sha: e.oid, size: e.size }));
    readFile = async (path, entry) => {
      if (entry.type !== "blob") return null;
      try {
        return await rt.client.fetchFileRaw(slot.owner, slot.repo, path, unit.sha);
      } catch (e) {
        if (e instanceof Error && "status" in e && (e as { status?: number }).status === 404) return null;
        throw e;
      }
    };
  }
  log(`  selection over ${entries.length} tree entries (${truncated ? "clone-walk (truncated)" : "REST status quo"})…`);
  const rec = await recordSelection({
    loc: { githubHost: rt.cfg.githubHost, organization: slot.owner, repository: slot.repo, branch: unit.branch, commitSha: unit.sha },
    trackedPackages: rt.cfg.selection.trackedPackages,
    excludeDirGlobs: rt.cfg.selection.excludeDirGlobs,
    maxScanBytes: rt.cfg.selection.maxScanBytes,
    entries, readFile,
  });
  log(`  selected ${rec.readPaths.length} read + ${rec.noReads.length} no-read entries`);
  const escapeTripped = slot.repoSizeKb > rt.cfg.t2a.apiEscapeRepoSizeKb;
  const needsCheckoutHashes = truncated || !escapeTripped; // T0/T1 C4 fallback, or T2a's checkout primary
  const workloadEntries: WorkloadEntry[] = [];
  for (const path of rec.readPaths) {
    const ls = lsIndex.get(path);
    if (ls === undefined || ls.size === null) throw new Error(`selected ${path} missing from ls-tree`);
    const canonical = await catBlob(rt, cloneDir, ls.oid);
    const isSymlink = ls.mode === "120000";
    let restDeref: string | null = null;
    if (isSymlink) restDeref = seamSha256(Buffer.from(await rt.client.fetchFileRaw(slot.owner, slot.repo, path, unit.sha), "utf8"));
    let checkout: string | null = null;
    if (needsCheckoutHashes && !isSymlink) checkout = seamSha256(readFileSync(join(cloneDir, path)));
    workloadEntries.push({
      path, mode: ls.mode, blobOid: ls.oid, size: ls.size, class: rec.classes.get(path) ?? "source",
      read: true, noReadReason: null,
      canonicalSeamSha256: seamSha256(canonical), rawSha256: sha256Hex(canonical),
      restDerefSeamSha256: restDeref, checkoutSeamSha256: checkout, gql: null,
    });
  }
  for (const nr of rec.noReads) {
    const ls = lsIndex.get(nr.path);
    workloadEntries.push({
      path: nr.path, mode: ls?.mode ?? "100644", blobOid: ls?.oid ?? "0".repeat(format === "sha1" ? 40 : 64),
      size: ls?.size ?? 0, class: nr.reason === "binary-lockfile-skip" ? "lockfile" : (classifyFile(nr.path) !== "other" ? "cli" : "source"),
      read: false, noReadReason: nr.reason,
      canonicalSeamSha256: null, rawSha256: null, restDerefSeamSha256: null, checkoutSeamSha256: null, gql: null,
    });
  }
  if (!truncated) {
    log(`  probing GitHub's own isBinary/isTruncated/text judgment…`);
    const gqlFacts = await probeGqlFacts(rt, slot, unit.sha, workloadEntries);
    for (const e of workloadEntries) {
      if (!e.read || e.mode === "120000") continue;
      const f = gqlFacts.get(e.path);
      if (f === undefined) throw new Error(`gql probe missed ${e.path}`);
      e.gql = f;
    }
  }
  void probeCheckoutDir;
  return buildUnitWorkload({
    unit: unit.unitId, sha: unit.sha, treeOid: unit.treeOid, objectFormat: format,
    generatedAtIso: new Date().toISOString(), truncatedTree: truncated, escapeTripped,
    batchContentBytesCap: rt.cfg.t1.batchContentBytesCap,
    entries: workloadEntries,
  });
}

// ---- slot verification + pinning -------------------------------------------------------------
async function repoSizeKb(rt: PinRuntime, owner: string, repo: string): Promise<number> {
  const json = (await rt.client.restGetJson(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)) as { size?: number };
  if (typeof json.size !== "number") throw new Error(`repos/${owner}/${repo} carries no size`);
  return json.size;
}

interface PinnedSlotBundle {
  slot: PerformanceSlot;
  workloads: Map<string, UnitWorkload>;
  cloneDirs: Map<string, string>;
}

// live branch discovery for C1 (pinning lane): parse `ls-remote --heads` into branch names.
async function discoverHeads(rt: PinRuntime, owner: string, repo: string): Promise<string[]> {
  const url = `https://${rt.cfg.githubHost}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`;
  const out = text(await pinGit(rt, ["ls-remote", "--heads", url], { maxStdoutBytes: 64 * 1024 * 1024 }));
  return out.split("\n").filter(Boolean).map((l) => l.split("\t")[1] ?? "").filter((r) => r.startsWith("refs/heads/")).map((r) => r.slice("refs/heads/".length));
}

async function c1CandidateBranches(rt: PinRuntime): Promise<Array<{ owner: string; repo: string; branches: string[] }>> {
  const out: Array<{ owner: string; repo: string; branches: string[] }> = [];
  for (const cand of C1_CANDIDATES) {
    try {
      const heads = await discoverHeads(rt, cand.owner, cand.repo);
      const releases = heads
        .map((name) => ({ name, m: cand.releaseRe.exec(name) }))
        .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
        .sort((a, b) => cand.key(b.m) - cand.key(a.m))
        .slice(0, 3)
        .map((x) => x.name);
      if (!heads.includes(cand.main) || releases.length < 3) {
        log(`C1 candidate ${cand.owner}/${cand.repo}: needs main + ≥3 release lines, found ${releases.length}`);
        continue;
      }
      out.push({ owner: cand.owner, repo: cand.repo, branches: [cand.main, ...releases] });
    } catch (e) {
      log(`C1 candidate ${cand.owner}/${cand.repo} discovery failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  }
  return out;
}

async function pinPerformanceSlot(rt: PinRuntime, slotId: "C1" | "C2" | "C3" | "C4" | "C5"): Promise<PinnedSlotBundle> {
  const candidates = slotId === "C1" ? await c1CandidateBranches(rt) : SLOT_CANDIDATES[slotId]!;
  for (const candidate of candidates) {
    log(`${slotId}: candidate ${candidate.owner}/${candidate.repo}`);
    try {
      const sizeKb = await repoSizeKb(rt, candidate.owner, candidate.repo);
      const branches: Array<{ branch: string; dir: string; sha: string; treeOid: string; objectFormat: "sha1" | "sha256"; ls: LsTreeEntry[] }> = [];
      const wanted = slotId === "C1" ? candidate.branches : candidate.branches.slice(0, 1);
      for (const branch of wanted) {
        try {
          const c = await pinClone(rt, candidate.owner, candidate.repo, branch, `${slotId}-${candidate.repo}-${branch.replace(/[^A-Za-z0-9.-]/g, "_")}`);
          const ls = await lsTreeIndex(rt, c.dir, c.objectFormat);
          branches.push({ branch, ...c, ls });
          log(`  ${branch}@${c.sha.slice(0, 12)} — ${ls.length} entries`);
        } catch (e) {
          log(`  branch ${branch} unavailable: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
        }
      }
      if (branches.length === 0) continue;
      if (slotId === "C1" && branches.length > 4) {
        for (const extra of branches.splice(4)) rmSync(extra.dir, { recursive: true, force: true });
      }
      const format = branches[0]!.objectFormat;
      const units: CorpusUnit[] = branches.map((b) => ({
        unitId: `${slotId}:${candidate.owner}/${candidate.repo}@${b.branch}`, branch: b.branch, sha: b.sha, treeOid: b.treeOid,
      }));
      // slot verification (§4.2)
      let verdict: SlotVerdict;
      const first = branches[0]!;
      const truncated = await fetchRestTruncation(rt, candidate.owner, candidate.repo, first.treeOid);
      if (slotId === "C1") {
        verdict = verifyC1(new Map(branches.map((b) => [b.branch, b.ls.filter((e) => e.type === "blob").map((e) => e.oid)])));
      } else if (slotId === "C2") {
        const blobs = first.ls.filter((e) => e.type === "blob");
        const { manifests } = locateManifests(blobs.map((e) => e.path), makeExcluder(rt.cfg.selection.excludeDirGlobs));
        verdict = verifyC2({ fileCount: blobs.length, truncated, manifestCount: manifests.length });
      } else if (slotId === "C3") {
        // the SAME REST recursive-tree computation refresh-evidence uses (codex R2 f.5): all
        // entry kinds, directory depth = path segments − 1
        if (truncated) {
          verdict = { ok: false, reasons: ["REST recursive tree is truncated — this candidate is a C4, not a C3"], evidence: { truncated } };
        } else {
          const restJson = await rt.client.restGetJson(`repos/${encodeURIComponent(candidate.owner)}/${encodeURIComponent(candidate.repo)}/git/trees/${first.treeOid}?recursive=1`, { immutable: true });
          const restTree = parseTreeResponse(restJson, "pin-c3", first.treeOid);
          const entries = restTree.truncated ? [] : restTree.paths;
          verdict = verifyC3({
            truncated: restTree.truncated, entryCount: entries.length,
            pathByteSum: entries.reduce((n, e) => n + Buffer.byteLength(e.path, "utf8"), 0),
            oidHexLength: format === "sha1" ? 40 : 64,
            deepEntryCount: entries.filter((e) => e.path.split("/").length - 1 >= 6).length,
          });
        }
      } else if (slotId === "C4") {
        verdict = verifyC4({ truncated });
      } else {
        // C5: a second checkout under autocrlf=true; compare SELECTED files' checkout bytes
        const probeClone = await pinClone(rt, candidate.owner, candidate.repo, first.branch, `${slotId}-probe`, rt.gitEnvProbe);
        if (probeClone.sha !== first.sha) {
          log(`  C5 probe clone drifted (${probeClone.sha.slice(0, 12)}); retrying candidate`);
          continue;
        }
        const excluder = makeExcluder(rt.cfg.selection.excludeDirGlobs);
        const selectable = first.ls.filter((e) => e.type === "blob" && e.mode !== "120000" && !excluder(e.path) && classifyFile(e.path) !== "other").slice(0, 500);
        const pairs = selectable.map((e) => ({
          path: e.path,
          sha256AutocrlfFalse: sha256Hex(readFileSync(join(first.dir, e.path))),
          sha256AutocrlfTrue: sha256Hex(readFileSync(join(probeClone.dir, e.path))),
        }));
        verdict = verifyC5(pairs);
        rmSync(probeClone.dir, { recursive: true, force: true });
      }
      if (!verdict.ok) {
        log(`  ${slotId} candidate FAILED verification: ${verdict.reasons.join("; ")} — swapping`);
        for (const b of branches) rmSync(b.dir, { recursive: true, force: true });
        continue;
      }
      log(`  ${slotId} verified: ${JSON.stringify(verdict.evidence).slice(0, 200)}`);
      const slot: PerformanceSlot = {
        slot: slotId, owner: candidate.owner, repo: candidate.repo, objectFormat: format,
        repoSizeKb: sizeKb, units, verification: { ...verdict.evidence, truncatedAtPin: truncated },
      };
      const workloads = new Map<string, UnitWorkload>();
      const cloneDirs = new Map<string, string>();
      for (let i = 0; i < branches.length; i++) {
        const b = branches[i]!;
        log(`  workload for ${units[i]!.unitId}`);
        const unitTruncated = i === 0 ? truncated : await fetchRestTruncation(rt, candidate.owner, candidate.repo, b.treeOid);
        const workload = await pinUnitWorkload(rt, slot, units[i]!, b.dir, new Map(b.ls.map((e) => [e.path, e])), unitTruncated, null);
        workloads.set(units[i]!.unitId, workload);
        cloneDirs.set(units[i]!.unitId, b.dir);
      }
      return { slot, workloads, cloneDirs };
    } catch (e) {
      log(`  ${slotId} candidate errored: ${e instanceof Error ? e.message.slice(0, 200) : String(e)} — swapping`);
    }
  }
  throw new Error(`no ${slotId} candidate survives verification — extend the candidate list`);
}

async function pinFidelity(rt: PinRuntime): Promise<C6Fixture[]> {
  const fixtures: C6Fixture[] = [];
  // 1) the M9 API-only symlink fixture — the entry facts are the ADR's pinned M9 record; the
  // live REST dereference is the verification evidence
  const deref = await rt.client.fetchFileRaw(M9.owner, M9.repo, M9.path, M9.sha);
  fixtures.push({
    kind: "api-only-symlink", owner: M9.owner, repo: M9.repo, branch: null, sha: M9.sha,
    objectFormat: "sha1", appliesTo: ["T0", "T1"],
    entries: [{ path: M9.path, mode: M9.mode, oid: M9.oid, size: M9.size }],
    verification: { restDerefBytes: Buffer.byteLength(deref, "utf8"), restDerefSeamSha256: seamSha256(Buffer.from(deref, "utf8")) },
  });
  log(`C6/M9: REST deref ${Buffer.byteLength(deref, "utf8")} bytes (link payload is ${M9.size})`);
  // 2) a small clone-feasible repo with a SELECTED mode-120000 entry, and 3) a selected
  // non-UTF-8-content file — searched over the candidate list, swapped on failure.
  let cloneFixture: C6Fixture | null = null;
  let nonUtf8Fixture: C6Fixture | null = null;
  for (const cand of C6_CLONE_CANDIDATES) {
    if (cloneFixture !== null && nonUtf8Fixture !== null) break;
    log(`C6 candidate ${cand.owner}/${cand.repo}`);
    try {
      const c = await pinClone(rt, cand.owner, cand.repo, cand.branch, `C6-${cand.repo}`);
      const ls = await lsTreeIndex(rt, c.dir, c.objectFormat);
      const excluder = makeExcluder(rt.cfg.selection.excludeDirGlobs);
      const selectedLike = (e: LsTreeEntry): boolean => {
        if (excluder(e.path) || /(^|\/)node_modules\//.test(e.path)) return false;
        const base = e.path.slice(e.path.lastIndexOf("/") + 1);
        return classifyFile(e.path) !== "other" || base === "package.json";
      };
      if (cloneFixture === null) {
        const symlinks = ls.filter((e) => e.mode === "120000" && selectedLike(e));
        const verdict = verifyC6Symlink(ls.filter((e) => e.mode === "120000").map((e) => ({ path: e.path, mode: e.mode, selected: selectedLike(e) })));
        if (verdict.ok) {
          const pick = symlinks[0]!;
          const derefBytes = await rt.client.fetchFileRaw(cand.owner, cand.repo, pick.path, c.sha);
          cloneFixture = {
            kind: "clone-symlink", owner: cand.owner, repo: cand.repo, branch: cand.branch, sha: c.sha,
            objectFormat: c.objectFormat, appliesTo: ["T0", "T1", "T2a", "T2c"],
            entries: [{ path: pick.path, mode: pick.mode, oid: pick.oid, size: pick.size ?? 0 }],
            verification: { ...verdict.evidence, restDerefSeamSha256: seamSha256(Buffer.from(derefBytes, "utf8")) },
          };
          log(`  clone-symlink fixture: ${pick.path}`);
        } else {
          log(`  no selected symlink: ${verdict.reasons.join("; ")}`);
        }
      }
      if (nonUtf8Fixture === null) {
        for (const e of ls) {
          if (e.type !== "blob" || e.size === null || e.size > 512 * 1024 || e.mode === "120000" || !selectedLike(e)) continue;
          const bytes = await catBlob(rt, c.dir, e.oid);
          const replacements = countReplacementChars(bytes);
          if (replacements > 0) {
            const verdict = verifyC6NonUtf8({ path: e.path, replacementCount: replacements });
            nonUtf8Fixture = {
              kind: "non-utf8-content", owner: cand.owner, repo: cand.repo, branch: cand.branch, sha: c.sha,
              objectFormat: c.objectFormat, appliesTo: ["T0", "T1", "T2a", "T2c"],
              entries: [{ path: e.path, mode: e.mode, oid: e.oid, size: e.size }],
              verification: { ...verdict.evidence, canonicalSeamSha256: seamSha256(bytes) },
            };
            log(`  non-utf8 fixture: ${e.path} (${replacements} replacement chars)`);
            break;
          }
        }
      }
      rmSync(c.dir, { recursive: true, force: true });
    } catch (e) {
      log(`  C6 candidate errored: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    }
  }
  if (cloneFixture === null) throw new Error("no C6 clone-symlink candidate has a SELECTED mode-120000 entry — extend the candidate list");
  if (nonUtf8Fixture === null) throw new Error("no C6 non-UTF-8 selected file found — extend the candidate list");
  fixtures.push(cloneFixture, nonUtf8Fixture);
  return fixtures;
}

// ---- acquisition diagnostics (§4.4, non-decision) --------------------------------------------
async function acquisitionDiagnostics(rt: PinRuntime, corpus: Corpus, workloads: Map<string, UnitWorkload>): Promise<unknown> {
  const results: unknown[] = [];
  for (const slot of corpus.performance) {
    for (const unit of slot.units) {
      const workload = workloads.get(unit.unitId)!;
      // the api-escape belongs to T2a ALONE (§4.4): an escape-tripped untruncated unit still
      // gets cloned by T2c in the matrix, so only the checkout (T2a) arms are skipped here.
      const skipCheckoutArms = workload.escapeTripped && !workload.truncatedTree;
      // §4.4: a branch that drifted between pinning and this diagnostic makes the PRODUCTION
      // form unable to acquire the pinned SHA at all (clone --branch takes the live head) —
      // the same condition the matrix answers with the scaffolding form. Probe once here;
      // measure the production arm only while the head still equals the pin, and record the
      // drift verbatim otherwise (the form comparison is then unavailable, not fabricated).
      const live = await probeLiveHead({ cfg: rt.cfg, slot, unit, benchRoot: rt.benchRoot, gitEnv: rt.gitEnv, spawnObserver: rt.spawnObs });
      const drifted = live !== unit.sha;
      if (drifted) log(`diag ${unit.unitId}: live head ${live.slice(0, 12)} drifted off the pin — production form unavailable, measuring scaffolding alone`);
      const perForm: Record<string, { walls: number[]; tip: string; tree: string; closureSha256: string; inventorySha256: string }> = {};
      for (const form of (drifted ? ["scaffolding"] : ["production", "scaffolding"]) as ReadonlyArray<"production" | "scaffolding">) {
        for (const checkout of skipCheckoutArms ? [false] : [true, false]) {
          const key = `${form}:${checkout ? "T2a" : "T2c"}`;
          const walls: number[] = [];
          let evidence: { tip: string; tree: string; closureSha256: string; inventorySha256: string } | null = null;
          for (let i = 0; i < 3; i++) {
            const runDir = join(rt.benchRoot, `diag-${slot.slot}-${form}-${checkout ? "a" : "c"}-${i}`);
            mkdirSync(runDir, { recursive: true });
            const ctx = {
              cfg: rt.cfg, slot, unit, workload, gh: rt.gh, benchRoot: rt.benchRoot, runDir,
              gitEnv: rt.gitEnv, spawnObserver: rt.spawnObs, acquisitionForm: form,
              fallbackBudget: 0,
            } as DriverRunContext;
            const t0 = Date.now();
            const { dir, headRev } = await acquireStore(ctx, { checkout });
            walls.push(Date.now() - t0);
            if (i === 0) {
              const rev = headRev === "HEAD" ? "HEAD" : unit.sha;
              const tip = text(await pinGit(rt, ["rev-parse", rev], { cwd: dir })).trim();
              const tree = text(await pinGit(rt, ["rev-parse", `${rev}^{tree}`], { cwd: dir })).trim();
              const closure = text(await pinGit(rt, ["rev-list", "--objects", unit.sha], { cwd: dir, maxStdoutBytes: 512 * 1024 * 1024 }));
              const closureSha256 = sha256Hex(closure.split("\n").map((l) => l.split(" ")[0] ?? "").filter(Boolean).sort().join("\n"));
              const inventory = text(await pinGit(rt, ["cat-file", "--batch-all-objects", "--batch-check"], { cwd: dir, maxStdoutBytes: 512 * 1024 * 1024 }));
              const inventorySha256 = sha256Hex(inventory.split("\n").filter(Boolean).sort().join("\n"));
              evidence = { tip, tree, closureSha256, inventorySha256 };
            }
            rmSync(runDir, { recursive: true, force: true });
          }
          perForm[key] = { walls, ...(evidence as NonNullable<typeof evidence>) };
          log(`diag ${unit.unitId} ${key}: walls ${walls.join("/")}ms`);
        }
      }
      // assert identical tip/tree oids and identical reachable closure across the forms
      // (form comparison requires the production arm — a drifted unit records scaffolding only)
      const anomalies: string[] = [];
      for (const checkout of skipCheckoutArms ? ["T2c"] : ["T2a", "T2c"]) {
        const scaf = perForm[`scaffolding:${checkout}`]!;
        if (scaf.tip !== unit.sha) anomalies.push(`${checkout}: scaffolding tip != pinned SHA`);
        if (drifted) continue;
        const prod = perForm[`production:${checkout}`]!;
        if (prod.tip !== unit.sha) anomalies.push(`${checkout}: production tip != pinned SHA`);
        if (prod.tree !== scaf.tree) anomalies.push(`${checkout}: tree oids differ across forms`);
        if (prod.closureSha256 !== scaf.closureSha256) anomalies.push(`${checkout}: reachable closures differ across forms`);
        const med = (w: number[]): number => [...w].sort((a, b) => a - b)[1]!;
        const delta = Math.abs(med(prod.walls) - med(scaf.walls)) / Math.max(1, Math.min(med(prod.walls), med(scaf.walls)));
        if (delta > 0.1) anomalies.push(`${checkout}: median wall delta ${(delta * 100).toFixed(1)}% > 10% — interpret scaffolding-form units with this bound in hand`);
      }
      if (anomalies.some((a) => a.includes("differ") || a.includes("tip"))) throw new Error(`acquisition diagnostics failed for ${unit.unitId}: ${anomalies.join("; ")}`);
      results.push({ unit: unit.unitId, driftedAtDiagnostics: drifted, liveHeadAtDiagnostics: live, t2aArmsSkipped: skipCheckoutArms, forms: perForm, flags: anomalies });
    }
  }
  return results;
}

// ---- engine construction ---------------------------------------------------------------------
async function makeEngine(cfg: BenchConfig, corpus: Corpus, workloads: Map<string, UnitWorkload>): Promise<{ engine: BenchEngine; benchRoot: string }> {
  const benchRoot = mkdtempSync(join(realpathSync(tmpdir()), cfg.protocol.tempPrefix));
  const metaClient = new GithubClient({ githubHost: cfg.githubHost, db: null, tempRoot: benchRoot });
  const login = ((await metaClient.restGetJson("user")) as { login?: string }).login ?? "unknown";
  const harnessCommit = text(await runBenchGit({
    argv: ["rev-parse", "HEAD"], lane: { lane: "pinning" }, env: buildGitEnv(process.env, "/dev/null"),
    benchRoot: realpathSync(REPO_ROOT), cwd: REPO_ROOT,
    limits: { maxStdoutBytes: 4096, maxStderrBytes: 4096, deadlineMs: 60_000 },
  }).then((r) => r.stdout)).trim();
  const manifest = await buildEnvManifest(metaClient, {
    login, harnessCommit,
    networkDescription: process.env["BENCH_NETWORK_DESC"] ?? "operator workstation (BENCH_NETWORK_DESC unset)",
    credentialType: "PAT (gh auth)",
  });
  const runsLog = new RunsLog(join(ARTIFACTS, "runs.jsonl"), manifest);
  runsLog.writeManifestOnce();
  const engine = new BenchEngine({
    cfg, corpus, workloads, benchRoot, artifactsDir: ARTIFACTS,
    runCacheDir: join(REPO_ROOT, "data", "bench-run-caches"),
    runsLog,
    client: metaClient,
    makeClient: (db) => new GithubClient({ githubHost: cfg.githubHost, db, tempRoot: benchRoot }),
    log,
  });
  return { engine, benchRoot };
}

function loadPinned(): { cfg: BenchConfig; corpus: Corpus; workloads: Map<string, UnitWorkload> } {
  const cfg = loadBenchConfig(CONFIG_PATH);
  const corpus = loadCorpus(readFileSync(CORPUS_PATH, "utf8"));
  const workloads = new Map<string, UnitWorkload>();
  for (const slot of corpus.performance) {
    for (const unit of slot.units) {
      const file = join(SELECTED_DIR, `${unit.unitId.replace(/[^A-Za-z0-9._@-]/g, "_")}.json`);
      workloads.set(unit.unitId, parseUnitWorkload(readFileSync(file, "utf8")));
    }
  }
  return { cfg, corpus, workloads };
}

const workloadFileName = (unitId: string): string => `${unitId.replace(/[^A-Za-z0-9._@-]/g, "_")}.json`;

// ---- subcommands -----------------------------------------------------------------------------
async function cmdPinCorpus(): Promise<void> {
  const cfg = loadBenchConfig(CONFIG_PATH);
  const rt = makePinRuntime(cfg);
  log(`bench root: ${rt.benchRoot}`);
  const snap = await readRateLimit(rt.gh);
  log(`rate_limit headroom: core ${snap.core.remaining}, graphql ${snap.graphql.remaining}`);
  try {
    const bundles: PinnedSlotBundle[] = [];
    for (const slotId of ["C1", "C2", "C3", "C4", "C5"] as const) {
      bundles.push(await pinPerformanceSlot(rt, slotId));
    }
    const fidelity = await pinFidelity(rt);
    const login = ((await rt.client.restGetJson("user")) as { login?: string }).login ?? "unknown";
    // Option 3's warm-run scenario pair, frozen at Step B (plan §4.4): base = the parent of
    // C1-main's pinned SHA, advanced = the pinned SHA itself.
    const c1 = bundles[0]!.slot;
    const c1main = c1.units[0]!;
    const commitJson = (await rt.client.restGetJson(`repos/${encodeURIComponent(c1.owner)}/${encodeURIComponent(c1.repo)}/commits/${c1main.sha}`)) as { parents?: Array<{ sha?: string }> };
    const parentSha = commitJson.parents?.[0]?.sha;
    if (typeof parentSha !== "string") throw new Error("C1-main's pinned commit has no readable parent for the Option-3 pair");
    const corpus: Corpus = {
      pinnedAtIso: new Date().toISOString(), pinnedByLogin: login,
      performance: bundles.map((b) => b.slot), fidelity,
      option3WarmScenario: { owner: c1.owner, repo: c1.repo, baseSha: parentSha.toLowerCase(), advancedSha: c1main.sha },
    };
    loadCorpus(JSON.stringify(corpus)); // strict self-check before anything is written
    mkdirSync(SELECTED_DIR, { recursive: true });
    writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
    const workloads = new Map<string, UnitWorkload>();
    for (const b of bundles) {
      for (const [unitId, workload] of b.workloads) {
        workloads.set(unitId, workload);
        writeFileSync(join(SELECTED_DIR, workloadFileName(unitId)), `${JSON.stringify(workload, null, 2)}\n`);
      }
    }
    // the literal traversal table (§4.5) lands in bench-config.json
    const schedule = buildSchedule(scheduleUnitsFrom(corpus), cfg.williamsRows, cfg.reps);
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
    raw["schedule"] = schedule;
    writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`);
    loadBenchConfig(CONFIG_PATH); // strict re-validation of the written artifact
    log(`pinned: corpus.json, ${workloads.size} selected/*.json, schedule (${schedule.rows.length} rows)`);
    log(`next: bun run bench:content diagnostics (§4.4 acquisition diagnostics, separately restartable)`);
  } finally {
    rmSync(rt.benchRoot, { recursive: true, force: true });
  }
}

async function cmdBudget(): Promise<void> {
  const { cfg, corpus, workloads } = loadPinned();
  for (const slot of corpus.performance) {
    for (const unit of slot.units) {
      const w = workloads.get(unit.unitId)!;
      for (const driver of cfg.drivers) {
        const wc = computeWorstCase(driver, w, cfg, { owner: slot.owner, repo: slot.repo });
        const segments = planSegments(driver, w, cfg, { owner: slot.owner, repo: slot.repo });
        log(`${unit.unitId} ${driver}: WC core ${wc.core}, graphql ${wc.graphql}${segments.length > 1 ? ` (${segments.length} segments)` : ""}`);
      }
    }
  }
  // the total sums over EVERY scheduled row — probe-epilogue rows included (codex R1 finding 25)
  if (cfg.schedule !== null) {
    let totalCore = 0;
    let totalGraphql = 0;
    for (const row of cfg.schedule.rows) {
      const { slot } = findUnitIn(corpus, row.unit);
      const wc = computeWorstCase(row.driver, workloads.get(row.unit)!, cfg, { owner: slot.owner, repo: slot.repo });
      totalCore += wc.core;
      totalGraphql += wc.graphql;
    }
    log(`schedule worst-case total over ${cfg.schedule.rows.length} rows (probe epilogue included): core ${totalCore}, graphql ${totalGraphql} P_max-points`);
  }
  log(`note: WORST-case reservation, not an estimate — actual spend is far lower (§4.8)`);
}

function findUnitIn(corpus: Corpus, unitId: string): { slot: PerformanceSlot } {
  for (const slot of corpus.performance) {
    for (const unit of slot.units) if (unit.unitId === unitId) return { slot };
  }
  throw new Error(`unknown unit ${unitId}`);
}

async function cmdPilot(): Promise<void> {
  const { cfg, corpus, workloads } = loadPinned();
  const { engine, benchRoot } = await makeEngine(cfg, corpus, workloads);
  try {
    const { walls, spread } = await engine.runPilot(0);
    const band = noiseBandFrom(cfg, spread);
    const pilot = {
      generatedAtIso: new Date().toISOString(), driver: cfg.pilot.driver, slot: cfg.pilot.slot,
      reps: cfg.pilot.reps, wallsMs: walls,
      pilotSpread: Number(spread.toFixed(4)),
      noiseBand: band,
      formula: "max(1.25, spread rounded up to the next 0.05)",
      nonDecision: "declared diagnostic (plan §4.7/§8) — calibrates the band, ranks nothing",
    };
    writeFileSync(join(ARTIFACTS, "pilot.json"), `${JSON.stringify(pilot, null, 2)}\n`);
    log(`pilot: walls ${walls.join("/")}ms, spread ${spread.toFixed(4)} → noise band ${band}`);
  } finally {
    rmSync(benchRoot, { recursive: true, force: true });
  }
}

async function cmdDiagnostics(): Promise<void> {
  const { cfg, corpus, workloads } = loadPinned();
  const rt = makePinRuntime(cfg);
  try {
    const diagnostics = await acquisitionDiagnostics(rt, corpus, workloads);
    writeFileSync(join(ARTIFACTS, "acquisition-diagnostics.json"), `${JSON.stringify({ generatedAtIso: new Date().toISOString(), results: diagnostics }, null, 2)}\n`);
    log("acquisition-diagnostics.json written");
  } finally {
    rmSync(rt.benchRoot, { recursive: true, force: true });
  }
}

// The C6 fidelity battery (§4.2): untimed, once per (fixture, driver), gate-relevant — a
// mismatch is a G1 event for that driver and FAILS this command; a skipped applicable fixture
// is a G2 event. Each driver resolves through its REAL seam (codex R1 finding 6): T0 via the
// recorded REST layer, T1 via a real single-alias GraphQL dispatch + per-alias validation,
// T2a via an acquired checkout read, T2c via an acquired store + BatchChild frame.
async function cmdFidelity(): Promise<void> {
  const { cfg, corpus, workloads } = loadPinned();
  // gate-relevant evidence rides the SAME §8 freeze gate as the matrix (codex R2 f.8)
  const { digest } = await assertRatifiedAndFrozen();
  const { engine, benchRoot } = await makeEngine(cfg, corpus, workloads);
  void engine;
  const rt = makePinRuntime(cfg);
  const results: Array<Record<string, unknown>> = [];
  let failures = 0;
  const seamHash = (bytes: Uint8Array): string => sha256Hex(Buffer.from(seamDecode(bytes), "utf8"));
  try {
    for (const fixture of corpus.fidelity) {
      for (const driver of fixture.appliesTo) {
        for (const entry of fixture.entries) {
          const expectDeref = fixture.verification["restDerefSeamSha256"];
          const expectCanonical = fixture.verification["canonicalSeamSha256"];
          let delivered: string | null = null;
          let rawVerified: boolean | null = null;
          let route = "";
          if (entry.mode === "120000" && driver === "T1") {
            // T1's mode source is the tree it fetched — the fixture pin stands in for it here;
            // the REST dereference is the matrix's route
            const res = await benchRestGet(rt.gh, { endpoint: `repos/${encodeURIComponent(fixture.owner)}/${encodeURIComponent(fixture.repo)}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}?ref=${fixture.sha}`, accept: cfg.rest.rawAccept, immutable: true, requestClass: "rest-fallback" });
            delivered = res.body;
            route = "symlink-fallback";
          } else if (driver === "T0") {
            const res = await benchRestGet(rt.gh, { endpoint: `repos/${encodeURIComponent(fixture.owner)}/${encodeURIComponent(fixture.repo)}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}?ref=${fixture.sha}`, accept: cfg.rest.rawAccept, immutable: true, requestClass: "rest-content" });
            delivered = res.body;
            route = "primary";
          } else if (driver === "T1") {
            // ONE real aliased dispatch through the T1 seam, validated per-alias
            const workloadEntry: WorkloadEntry = {
              path: entry.path, mode: entry.mode, blobOid: entry.oid, size: entry.size, class: "cli",
              read: true, noReadReason: null, canonicalSeamSha256: null, rawSha256: null,
              restDerefSeamSha256: null, checkoutSeamSha256: null, gql: null,
            };
            const batch = buildBatchQuery([workloadEntry], {
              owner: fixture.owner, repo: fixture.repo, sha: fixture.sha,
              aliasSelection: cfg.t1.aliasSelection, rateLimitRider: cfg.t1.rateLimitRider, label: `fid-${fixture.kind}`,
            });
            const d = await benchGraphqlDispatch(rt.gh, batch.query, batch.fields, batch.label);
            const analysis = analyzeBatchResponse(d, batch, fixture.objectFormat, cfg);
            if (analysis.kind === "per-alias" && analysis.outcomes[0]?.kind === "resolved") {
              delivered = analysis.outcomes[0].text;
              rawVerified = true;
              route = "primary";
            } else if (analysis.kind === "per-alias" && (analysis.outcomes[0]?.kind === "binary-fallback" || analysis.outcomes[0]?.kind === "truncated-blob-fallback" || analysis.outcomes[0]?.kind === "validation-fallback")) {
              const res = await benchRestGet(rt.gh, { endpoint: `repos/${encodeURIComponent(fixture.owner)}/${encodeURIComponent(fixture.repo)}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}?ref=${fixture.sha}`, accept: cfg.rest.rawAccept, immutable: true, requestClass: "rest-fallback" });
              delivered = res.body;
              route = analysis.outcomes[0].kind === "validation-fallback" ? "validation-fallback" : analysis.outcomes[0].kind;
            } else {
              route = `unresolved:${analysis.kind}`;
            }
          } else {
            // clone drivers acquire through the REAL acquisition machinery + seams
            const runDir = join(rt.benchRoot, `fid-${fixture.kind}-${driver}`);
            mkdirSync(runDir, { recursive: true });
            const slotLike = { slot: "C5", owner: fixture.owner, repo: fixture.repo, objectFormat: fixture.objectFormat, repoSizeKb: 0, units: [], verification: {} } as unknown as PerformanceSlot;
            const unitLike = { unitId: `fid:${fixture.owner}/${fixture.repo}@${fixture.branch ?? "sha"}`, branch: fixture.branch ?? "", sha: fixture.sha, treeOid: fixture.sha } as CorpusUnit;
            const ctx = {
              cfg, slot: slotLike, unit: unitLike, workload: null as never, gh: rt.gh,
              benchRoot: rt.benchRoot, runDir, gitEnv: rt.gitEnv, spawnObserver: rt.spawnObs,
              acquisitionForm: "scaffolding", fallbackBudget: 20,
            } as unknown as DriverRunContext;
            const { dir, headRev } = await acquireStore(ctx, { checkout: driver === "T2a" });
            // route on the LIVE enumeration's observed mode, never the fixture pin (codex R2 f.9)
            const lsOut = await runBenchGit({
              argv: ["ls-tree", "-r", "-z", "-l", "--full-tree", headRev === "HEAD" ? "HEAD" : fixture.sha],
              lane: { lane: "transport", objectFormat: fixture.objectFormat },
              env: rt.gitEnv, benchRoot: rt.benchRoot, cwd: dir,
              limits: { maxStdoutBytes: cfg.lsTree.maxOutputBytes, maxStderrBytes: 1024 * 1024, deadlineMs: cfg.spawn.timeoutMs },
              onRecord: rt.spawnObs,
            });
            const lsEntries = parseLsTreeZ(lsOut.stdout, fixture.objectFormat, { maxEntries: cfg.lsTree.maxEntries, maxRecordBytes: cfg.lsTree.maxRecordBytes });
            const liveEntry = lsEntries.find((e) => e.path === entry.path);
            if (liveEntry === undefined) {
              route = "missing-from-live-enumeration";
            } else if (liveEntry.mode === "120000") {
              const res = await benchRestGet(rt.gh, { endpoint: `repos/${encodeURIComponent(fixture.owner)}/${encodeURIComponent(fixture.repo)}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}?ref=${fixture.sha}`, accept: cfg.rest.rawAccept, immutable: true, requestClass: "rest-fallback" });
              delivered = res.body;
              route = "symlink-fallback";
            } else if (driver === "T2a") {
              delivered = seamDecode(readFileSync(join(dir, entry.path)));
              route = "primary";
            } else {
              const child = new BatchChild({
                objectFormat: fixture.objectFormat, env: rt.gitEnv, cwd: dir, benchRoot: rt.benchRoot,
                limits: { maxHeaderBytes: cfg.frame.maxHeaderBytes, frameCeiling: cfg.frame.frameCeilingBytes, stderrRingBytes: cfg.frame.stderrRingBytes, readDeadlineMs: cfg.frame.readDeadlineMs, disposeDeadlineMs: cfg.frame.disposeDeadlineMs },
                onRecord: rt.spawnObs,
              });
              try {
                const frame = await child.readObject({ oid: entry.oid, size: entry.size });
                if (frame.kind === "content" && gitBlobOid(frame.body, fixture.objectFormat) === entry.oid) {
                  delivered = seamDecode(frame.body);
                  rawVerified = true;
                  route = "primary";
                } else {
                  route = "missing-or-unverified-frame";
                }
              } finally {
                await child.dispose();
              }
            }
            rmSync(runDir, { recursive: true, force: true });
            void liveEntry;
          }
          const gotHash = delivered === null ? null : sha256Hex(Buffer.from(delivered, "utf8"));
          const expected = route === "symlink-fallback" || entry.mode === "120000" || typeof expectCanonical !== "string" ? expectDeref : expectCanonical;
          const pass = typeof expected === "string" && gotHash === expected;
          if (!pass) failures++;
          const resultRec = { type: "fidelity", generatedAtIso: new Date().toISOString(), frozenSurfaceDigest: digest, fixture: fixture.kind, driver, entry: entry.path, route, pass, rawVerified, gotHash, expected };
          results.push(resultRec);
          // append-only, per entry: an exception later cannot erase earlier evidence, and a
          // re-run APPENDS beside a recorded mismatch instead of overwriting it (codex R3 f.8 —
          // a fidelity mismatch is never rerunnable, §4.2)
          appendFileSync(join(ARTIFACTS, "fidelity.jsonl"), `${JSON.stringify(resultRec)}\n`);
          log(`fidelity ${fixture.kind} ${driver} ${entry.path} [${route}]: ${pass ? "PASS" : "FAIL"}`);
        }
      }
    }
    void seamHash;
    void results;
    appendFileSync(join(ARTIFACTS, "fidelity.jsonl"), `${JSON.stringify({ type: "fidelity-summary", generatedAtIso: new Date().toISOString(), frozenSurfaceDigest: digest, failures })}\n`);
    if (failures > 0) throw new Error(`fidelity battery FAILED: ${failures} mismatch(es) — a G1 event for the affected driver (global eligibility spans the fidelity battery, §4.2)`);
  } finally {
    rmSync(rt.benchRoot, { recursive: true, force: true });
    rmSync(benchRoot, { recursive: true, force: true });
  }
}

async function cmdMatrix(): Promise<void> {
  const { cfg, corpus, workloads } = loadPinned();
  if (cfg.schedule === null) throw new Error("REFUSING: bench-config.json carries no pinned schedule (run pin-corpus first)");
  await assertRatifiedAndFrozen();
  const { engine, benchRoot } = await makeEngine(cfg, corpus, workloads);
  try {
    // ---- resumability (codex R1 f.17): reconstruct terminal state from runs.jsonl ----------
    const runsPath = join(ARTIFACTS, "runs.jsonl");
    const terminalPos = new Set<number>();
    const rerunUsed = new Set<string>();
    const straddled = new Set<string>();
    const successLedger = new Set<string>(); // unit|driver|requestClass with an ok in a COMPLETED rep
    const driftedUnits = new Set<string>();
    const washoutDone = new Set<number>();
    const pendingRows: Array<Record<string, unknown>> = [];
    const completedRows: Array<Record<string, unknown>> = [];
    const resumeForms = new Map<string, "production" | "scaffolding">();
    if (existsSync(runsPath)) {
      const currentCommit = engine.harnessCommit();
      const currentEnvHash = engine.envManifestHashValue();
      for (const line of readFileSync(runsPath, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (rec["type"] === "washout-done" && rec["phase"] === "matrix") {
          washoutDone.add(rec["pos"] as number);
          continue;
        }
        if (rec["type"] !== "run" || rec["phase"] !== "matrix") continue;
        // resume only trusts records from THIS frozen harness revision — rows from another
        // revision/machine must not silently mix into one traversal (codex R2 f.21)
        if (rec["harnessCommit"] !== currentCommit)
          throw new Error(`REFUSING to resume: runs.jsonl carries matrix rows from harness ${String(rec["harnessCommit"]).slice(0, 12)} != current ${currentCommit.slice(0, 12)} — a re-ratified matrix starts a fresh log`);
        // one machine, one network, one credential for ALL timed data (§8) — a foreign
        // environment's rows must never mix into this traversal (codex R3 f.2)
        if (rec["envManifestHash"] !== currentEnvHash)
          throw new Error(`REFUSING to resume: runs.jsonl carries rows from environment ${String(rec["envManifestHash"])} != current ${currentEnvHash}`);
        const pos = rec["pos"] as number;
        const outcome = rec["outcome"] as string;
        if (outcome === "complete" || outcome === "unit-failure") pendingRows.push(rec);
        if (outcome === "invalidated-straddle") straddled.add(rec["unit"] as string);
        if (outcome === "drift-restart") driftedUnits.add(rec["unit"] as string); // pending R6 epilogue survives interruption (f.20)
        if (outcome === "halt-r5-breach" || outcome === "re-pin-required")
          throw new Error(`REFUSING to resume: runs.jsonl carries a terminal ${outcome} row — that is freeze-repair/amendment territory (§4.5 R5/R6), never a silent retry`);
        if (outcome === "complete") completedRows.push(rec);
        const form = rec["acquisitionForm"];
        if (form === "scaffolding") resumeForms.set(rec["unit"] as string, "scaffolding");
        else if (form === "production" && !resumeForms.has(rec["unit"] as string)) resumeForms.set(rec["unit"] as string, "production");
        // only R1/R2 replays charge the driver allowance; R3/R4 in-slot replays do not (f.23)
        if (rec["replayKind"] === "r1r2") rerunUsed.add(`${rec["unit"] as string}|${rec["driver"] as string}`);
      }
      // a row is terminal only once its post-run washout MARKER landed — an interrupted washout
      // (or an interrupted R1/R2 replay decision) re-runs the row (codex R3 f.3). Epilogue rows
      // for drifted units terminalize only as epilogue rows (f.4).
      for (const rec of pendingRows) {
        const pos = rec["pos"] as number;
        if (!washoutDone.has(pos)) continue;
        const unit = rec["unit"] as string;
        if (driftedUnits.has(unit) && rec["epilogue"] !== true) continue; // discarded main reps
        terminalPos.add(pos);
      }
      // the success ledger admits only rows whose washout marker landed — an unfinished
      // repetition must not authorize its own R2 replay (codex R4)
      for (const rec of completedRows) {
        if (!washoutDone.has(rec["pos"] as number)) continue;
        for (const cls of Object.keys((rec["requests"] as Record<string, number> | undefined) ?? {}))
          successLedger.add(`${rec["unit"] as string}|${rec["driver"] as string}|${cls}`);
      }
      // a drifted unit's form is scaffolding regardless of what its pre-drift rows recorded
      for (const unit of driftedUnits) resumeForms.set(unit, "scaffolding");
      if (terminalPos.size > 0) log(`resuming: ${terminalPos.size} scheduled positions already terminal in runs.jsonl`);
      engine.restoreUnitForms(resumeForms);
    }
    // the frozen R1/R2 predicate over TYPED evidence (§4.5; codex R1 f.7): R1 = a network-layer
    // failure outside any HTTP response, rerunnable unconditionally (≤1); R2 = a transient-5xx
    // exhaustion within caps whose request class SUCCEEDED in at least one other completed
    // repetition of this unit × driver. Secondary-shaped failures are NEVER rerunnable.
    const isRerunnable = (record: import("./benchProtocol.ts").RunRecord): boolean => {
      const ev = record.failureEvidence;
      if (ev === null || ev.kind !== "http") return false;
      if (ev.code === "no-response") return true; // R1
      if ((ev.code === "attempts-exhausted" || ev.code === "http-failure") && ev.lastClassification === "transient")
        return successLedger.has(`${record.unit}|${record.driver}|${ev.requestClass ?? ""}`); // R2
      return false;
    };
    const executeRows = async (rows: NonNullable<typeof cfg.schedule>["rows"], phaseNote: string): Promise<void> => {
      for (const row of rows) {
        if (terminalPos.has(row.pos) && phaseNote === "main") continue;
        if (driftedUnits.has(row.unit) && phaseNote === "main") continue; // discarded reps; the epilogue re-runs the whole unit
        for (;;) {
          const handle = await engine.runOne(row, "matrix");
          const key = `${row.unit}|${row.driver}`;
          if (handle.record.outcome === "complete") {
            for (const cls of Object.keys(handle.record.requests)) successLedger.add(`${key}|${cls}`);
            break;
          }
          if (handle.record.outcome === "invalidated-straddle") {
            if (straddled.has(row.unit)) throw new Error(`R4 recurred on ${row.unit} — halt for freeze repair (plan §4.5)`);
            straddled.add(row.unit);
            log(`R4 straddle on ${row.unit} ${row.driver} rep${row.rep} — replaying in its own slot`);
            engine.setReplayOf(row.pos, "r3r4");
            continue;
          }
          if (handle.record.outcome === "invalidated-foreign") {
            // R3: verified external interference — replay in slot, never charged to the driver
            log(`R3 foreign consumption on ${row.unit} ${row.driver} rep${row.rep} — replaying in its own slot`);
            engine.setReplayOf(row.pos, "r3r4");
            continue;
          }
          if (handle.record.outcome === "drift-restart") {
            log(`R6 branch arm: ${row.unit} drifted — unit restarts on the scaffolding form in the epilogue`);
            driftedUnits.add(row.unit);
            break;
          }
          if (handle.record.outcome === "re-pin-required")
            throw new Error(`R6 SHA arm on ${row.unit}: ${handle.record.failureCause ?? ""} — re-pin is a §8 freeze amendment; halting`);
          // unit-failure: the frozen typed predicate decides the ≤1 rerun (never a message regex)
          if (isRerunnable(handle.record) && !rerunUsed.has(key)) {
            rerunUsed.add(key);
            log(`R1/R2 rerun for ${key} rep${row.rep}: ${handle.record.failureCause ?? ""}`);
            engine.setReplayOf(row.pos, "r1r2");
            continue;
          }
          log(`recorded failure (no rerun) for ${key} rep${row.rep}: ${handle.record.failureCause ?? ""}`);
          break;
        }
      }
    };
    await executeRows(cfg.schedule.rows, "main");
    if (driftedUnits.size > 0) {
      log(`epilogue: restarting ${driftedUnits.size} drifted unit(s) on the scaffolding form (R6 branch arm)`);
      const epilogue = cfg.schedule.rows.filter((r) => driftedUnits.has(r.unit) && !terminalPos.has(r.pos));
      engine.setEpilogueMode(true);
      try {
        await executeRows(epilogue, "epilogue");
      } finally {
        engine.setEpilogueMode(false);
      }
    }
    log("matrix complete — runs.jsonl carries every record (scoring/report generation reads it downstream, plan §8's read-only-analysis carve-out)");
  } finally {
    rmSync(benchRoot, { recursive: true, force: true });
  }
}

// refresh-evidence: recompute committed EVIDENCE without moving any pinned SHA — the C3 stats
// from the REST recursive tree it cites (directory depth = path segments − 1), the C6
// single-repo attempt (does the symlink fixture repo also carry a selected non-UTF-8 file?),
// and the Option-3 warm-scenario pair for an already-pinned corpus (codex R1 f.21/23 + f.1).
async function cmdRefreshEvidence(): Promise<void> {
  const { cfg, corpus } = loadPinned();
  const rt = makePinRuntime(cfg);
  try {
    const c3 = corpus.performance.find((s) => s.slot === "C3")!;
    const c3unit = c3.units[0]!;
    const json = await rt.client.restGetJson(`repos/${encodeURIComponent(c3.owner)}/${encodeURIComponent(c3.repo)}/git/trees/${c3unit.treeOid}?recursive=1`, { immutable: true });
    const tree = parseTreeResponse(json, "refresh-c3", c3unit.treeOid);
    if (tree.truncated) throw new Error("C3's REST tree is now truncated?!");
    const entries = tree.paths; // ALL entry kinds — the payload the slot description cites
    const pathByteSum = entries.reduce((n, e) => n + Buffer.byteLength(e.path, "utf8"), 0);
    const deepEntryCount = entries.filter((e) => e.path.split("/").length - 1 >= 6).length; // DIRECTORY depth
    const verdict = verifyC3({ truncated: false, entryCount: entries.length, pathByteSum, oidHexLength: c3.objectFormat === "sha1" ? 40 : 64, deepEntryCount });
    log(`C3 evidence (REST tree, directory depth): ${JSON.stringify(verdict.evidence)} ok=${verdict.ok}`);
    if (!verdict.ok) throw new Error(`C3 re-verification failed on REST-tree evidence: ${verdict.reasons.join("; ")}`);
    c3.verification = { ...verdict.evidence, source: "REST recursive tree at the pinned treeOid; depth = path segments - 1", truncatedAtPin: false };

    // Option-3 pair for the already-pinned corpus
    if (corpus.option3WarmScenario === null) {
      const c1 = corpus.performance.find((s) => s.slot === "C1")!;
      const c1main = c1.units[0]!;
      const commitJson = (await rt.client.restGetJson(`repos/${encodeURIComponent(c1.owner)}/${encodeURIComponent(c1.repo)}/commits/${c1main.sha}`)) as { parents?: Array<{ sha?: string }> };
      const parentSha = commitJson.parents?.[0]?.sha;
      if (typeof parentSha !== "string") throw new Error("no readable parent for the Option-3 pair");
      corpus.option3WarmScenario = { owner: c1.owner, repo: c1.repo, baseSha: parentSha.toLowerCase(), advancedSha: c1main.sha };
      log(`Option-3 warm pair pinned: base ${parentSha.slice(0, 12)} → advanced ${c1main.sha.slice(0, 12)}`);
    }

    // C6 single-repo attempt: does the clone-symlink repo also carry a selected non-UTF-8 file?
    const symFix = corpus.fidelity.find((f) => f.kind === "clone-symlink")!;
    const nonFix = corpus.fidelity.find((f) => f.kind === "non-utf8-content")!;
    if (symFix.owner !== nonFix.owner || symFix.repo !== nonFix.repo) {
      // EXHAUST the candidate set hunting a single repo with BOTH properties, recording
      // per-candidate evidence either way (codex R2 f.6)
      const searchEvidence: Array<Record<string, unknown>> = [];
      let unified = false;
      for (const cand of C6_CLONE_CANDIDATES) {
        if (unified) break;
        try {
          const c = await pinClone(rt, cand.owner, cand.repo, cand.branch, `c6-unify-${cand.repo}`);
          const ls = await lsTreeIndex(rt, c.dir, c.objectFormat);
          const excluder = makeExcluder(cfg.selection.excludeDirGlobs);
          const selectedLike = (e: LsTreeEntry): boolean => {
            if (excluder(e.path) || /(^|\/)node_modules\//.test(e.path)) return false;
            const base = e.path.slice(e.path.lastIndexOf("/") + 1);
            return classifyFile(e.path) !== "other" || base === "package.json";
          };
          const symlinks = ls.filter((e) => e.mode === "120000" && selectedLike(e));
          let nonUtf8: { entry: LsTreeEntry; replacements: number; bytes: Uint8Array } | null = null;
          for (const e of ls) {
            if (e.type !== "blob" || e.size === null || e.size > 512 * 1024 || e.mode === "120000" || !selectedLike(e)) continue;
            const bytes = await catBlob(rt, c.dir, e.oid);
            const replacements = countReplacementChars(bytes);
            if (replacements > 0) {
              nonUtf8 = { entry: e, replacements, bytes };
              break;
            }
          }
          searchEvidence.push({ candidate: `${cand.owner}/${cand.repo}`, sha: c.sha, selectedSymlinks: symlinks.length, selectedNonUtf8: nonUtf8?.entry.path ?? null });
          if (symlinks.length > 0 && nonUtf8 !== null) {
            const pickSym = symlinks[0]!;
            const derefBytes = await rt.client.fetchFileRaw(cand.owner, cand.repo, pickSym.path, c.sha);
            corpus.fidelity = corpus.fidelity.map((f) => {
              if (f.kind === "clone-symlink") return { ...f, owner: cand.owner, repo: cand.repo, branch: cand.branch, sha: c.sha, objectFormat: c.objectFormat, entries: [{ path: pickSym.path, mode: pickSym.mode, oid: pickSym.oid, size: pickSym.size ?? 0 }], verification: { restDerefSeamSha256: seamSha256(Buffer.from(derefBytes, "utf8")), unifiedSearch: searchEvidence } };
              if (f.kind === "non-utf8-content") return { ...f, owner: cand.owner, repo: cand.repo, branch: cand.branch, sha: c.sha, objectFormat: c.objectFormat, entries: [{ path: nonUtf8!.entry.path, mode: nonUtf8!.entry.mode, oid: nonUtf8!.entry.oid, size: nonUtf8!.entry.size ?? 0 }], verification: { ...verifyC6NonUtf8({ path: nonUtf8!.entry.path, replacementCount: nonUtf8!.replacements }).evidence, canonicalSeamSha256: seamSha256(nonUtf8!.bytes), unifiedSearch: searchEvidence } };
              return f;
            });
            log(`C6 UNIFIED on ${cand.owner}/${cand.repo}: symlink ${pickSym.path} + non-utf8 ${nonUtf8.entry.path}`);
            unified = true;
          }
          rmSync(c.dir, { recursive: true, force: true });
        } catch (e) {
          searchEvidence.push({ candidate: `${cand.owner}/${cand.repo}`, error: e instanceof Error ? e.message.slice(0, 160) : String(e) });
        }
      }
      if (!unified) {
        log(`C6 stays split after exhausting ${C6_CLONE_CANDIDATES.length} candidates (evidence recorded; plan §4.2 contingency)`);
        corpus.fidelity = corpus.fidelity.map((f) => f.kind === "clone-symlink" || f.kind === "non-utf8-content" ? { ...f, verification: { ...f.verification, unifiedSearch: searchEvidence } } : f);
      }
    }
    loadCorpus(JSON.stringify(corpus)); // strict self-check before writing
    writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
    log("corpus.json evidence refreshed (no pinned SHA moved)");
  } finally {
    rmSync(rt.benchRoot, { recursive: true, force: true });
  }
}

async function cmdVerifyCorpus(): Promise<void> {
  const { corpus, workloads } = loadPinned();
  log(`corpus pinned ${corpus.pinnedAtIso} by ${corpus.pinnedByLogin}`);
  for (const slot of corpus.performance) {
    log(`${slot.slot}: ${slot.owner}/${slot.repo} (${slot.objectFormat}, ${slot.repoSizeKb} KB) — ${slot.units.length} unit(s)`);
    for (const unit of slot.units) {
      const w = workloads.get(unit.unitId)!;
      const reads = w.entries.filter((e) => e.read).length;
      log(`  ${unit.unitId}: ${reads} reads + ${w.entries.length - reads} no-reads, truncated=${w.truncatedTree}, escape=${w.escapeTripped}`);
    }
  }
  for (const f of corpus.fidelity) log(`C6/${f.kind}: ${f.owner}/${f.repo}@${f.sha.slice(0, 12)} → ${f.entries.map((e) => e.path).join(", ")}`);
}

async function main(): Promise<void> {
  const sub = Bun.argv[2] ?? "";
  switch (sub) {
    case "pin-corpus": return cmdPinCorpus();
    case "diagnostics": return cmdDiagnostics();
    case "budget": return cmdBudget();
    case "pilot": return cmdPilot();
    case "fidelity": return cmdFidelity();
    case "refresh-evidence": return cmdRefreshEvidence();
    case "matrix": return cmdMatrix();
    case "verify-corpus": return cmdVerifyCorpus();
    case "digest": {
      log(frozenSurfaceDigest()); // the §8 freeze binding ratification.json records
      return;
    }
    default:
      log("usage: bun run bench:content <pin-corpus | refresh-evidence | diagnostics | verify-corpus | digest | budget | pilot | fidelity | matrix>");
      process.exitCode = 2;
  }
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    log(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    process.exitCode = 1;
  });
}
