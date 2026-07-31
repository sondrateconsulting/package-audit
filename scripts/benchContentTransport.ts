// benchContentTransport.ts — the ADR-0001 content-transport benchmark harness entrypoint
// (resolution plan §4.1), run as `bun run bench:content <subcommand>`. Standalone: it reuses
// production modules where realism demands and NEVER touches the production database, temp
// prefix, or production source files. No CI job runs this — every subcommand that talks to the
// network runs locally under the operator's gh identity.
//
//   pin-corpus       verify §4.2 slot candidates, pin SHAs, record workloads + ground truth,
//                    write corpus.json / selected/*.json / the schedule table into bench-config
//   refresh-evidence recompute the committed corpus verification evidence in place
//   verify-corpus    re-check the pinned corpus against its recorded evidence
//   diagnostics      §4.4 acquisition diagnostics (production vs scaffolding forms, 3× each)
//   budget           print per-(unit × driver) worst-case spend + the schedule's total
//   digest           print the §8 frozen-surface digest the ratification gate binds
//   pilot            §8's pre-ratification diagnostic pilot (K reps of T0 on C2) → noise band
//   matrix           Step C's timed traversal — REFUSES to run before ratification.json exists
//   fidelity         the C6 fidelity battery (untimed, once per applicable driver)
//
// Artifacts land in docs/adrs/0001-benchmark/. The pinning cache lives under ./data (a §0
// write root, git-ignored) so re-runs are cheap; bench run dirs live under a pa-bench-* root.
// NB a hard interrupt (SIGKILL, power loss) can strand a pa-bench-* root — nothing sweeps
// them (the production sweep deliberately targets pkg-audit-* only); stale ones are safe to
// delete by hand.

import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { BatchChild, BenchSpawnError, runBenchGit, type BenchSpawnRecord } from "./benchSpawn.ts";
import { BenchHttpError, benchGraphqlDispatch, benchRestGet, gitBlobOid, makeBuckets, readRateLimit, type BenchGhContext } from "./benchGh.ts";
import { analyzeBatchResponse, buildBatchQuery, packBatches } from "./benchT1.ts";
import {
  BenchEngine, RunsLog, buildEnvManifest, computeWorstCase, planSegments,
} from "./benchProtocol.ts";
import { UnitFailure, acquireStore, describeDisposal, disposalIsClean, probeLiveHead, type DriverRunContext } from "./benchDrivers.ts";
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
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

// A HARNESS failure, as opposed to an observation about a transport. The distinction is
// load-bearing: §4.7 disqualifies a driver globally on an observed divergence and a fidelity
// mismatch is never rerunnable, so a local git/tooling failure must never be recorded through
// that channel — it is the operator's problem, and re-running it is legitimate.
export class BenchOperationalError extends Error {
  readonly rerunnable = true as const;
  constructor(message: string) {
    super(message);
    this.name = "BenchOperationalError";
  }
}

// §8 binds every timed row to the credential identity that produced it. An unvalidated cast let
// a malformed /user payload silently become the literal "unknown", which hashes into the
// environment manifest as if it were a real identity.
export function loginFromUserPayload(json: unknown): string {
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new Error("REFUSING: GET /user returned no object — §8 needs the credential identity behind every timed row");
  const login = (json as Record<string, unknown>)["login"];
  if (typeof login !== "string" || login.trim() === "")
    throw new Error("REFUSING: GET /user carries no usable login — §8 needs the credential identity behind every timed row");
  return login;
}

const gitFailure = (what: string, res: { exitCode: number; stderr: Uint8Array }): string =>
  `${what} failed (exit ${res.exitCode}): ${text(res.stderr).trim().slice(0, 400)}`;

// The frozen MEASUREMENT surface's content digest (§8 as amended): every bench module + the
// preregistered artifacts. Binding ratification to THIS (not to HEAD) keeps the gate
// satisfiable — committing ratification.json or appending runs.jsonl changes neither the
// digest nor the frozen surface (codex R2 finding 1).
function frozenSurfaceDigest(): string {
  const files: string[] = [];
  // EVERY non-test script — the bench modules AND the production modules they execute through
  // (github.ts, readOnlyGuard.ts, db.ts, the selection pipeline…) all drive measurement
  // (codex R3 f.1); plus both normative documents and the preregistered artifacts.
  // RECURSIVE: the original readdirSync was flat and silently omitted every nested module
  // (scripts/tui/*), so the digest bound less than the comment above claimed. A freeze that
  // does not cover what it says it covers is worse than no freeze — it reads as assurance.
  for (const name of readdirSync(join(REPO_ROOT, "scripts"), { recursive: true }) as string[]) {
    if (/\.(ts|tsx)$/.test(name) && !name.includes(".test.")) files.push(join(REPO_ROOT, "scripts", name));
  }
  files.push(join(REPO_ROOT, "docs", "plans", "adr-0001-disagreements-resolution.md"));
  files.push(join(REPO_ROOT, "docs", "adrs", "0001-file-content-acquisition-strategy.md"));
  // pilot.json belongs here: the gate READS it (the ratified band must equal the pilot's
  // calibrated band), so leaving it out let its walls, spread, reps, driver, or slot be edited
  // freely as long as noiseBand still matched. ratification.json is still deliberately excluded —
  // it must be COMMITTED, and binding a file to a digest recorded inside it is unsatisfiable.
  files.push(CONFIG_PATH, CORPUS_PATH, join(ARTIFACTS, "pilot.json"));
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
  // the band must POSITIVELY be a usable ratio before equality means anything — strict equality
  // alone let two nulls (or two matching non-numeric values) pass as a "bound" band
  if (typeof rat["noiseBand"] !== "number" || !Number.isFinite(rat["noiseBand"]) || rat["noiseBand"] < 1)
    throw new Error(`REFUSING: ratification.json noiseBand (${String(rat["noiseBand"])}) is not a finite ratio >= 1 — no calibrated band is bound`);
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
  assertFreezeGitState(statusOut, lsFiles, APPEND_ONLY);
  // Verify the append-only CLAIM for each tracked evidence log: committed bytes must be a
  // byte-exact prefix of the working copy. Presence-in-HEAD is probed with `ls-tree HEAD --`,
  // whose contract is exit 0 with empty output for an absent path — so a NON-ZERO exit from
  // either probe or show is a git failure and REFUSES (an earlier draft skipped on any show
  // failure, which failed OPEN for exactly the rewritten-log case this check exists to catch).
  // KNOWN LIMIT, stated plainly: this proves no COMMITTED evidence was edited or truncated;
  // rows appended since the last commit have no committed baseline and are protected only by
  // committing them — commit the evidence logs early and often during Step C.
  for (const rel of APPEND_ONLY) {
    if (rel.endsWith("/")) continue; // directory exemptions are untracked scratch space
    const gitLimits = { maxStdoutBytes: 512 * 1024 * 1024, maxStderrBytes: 4096, deadlineMs: 60_000 };
    const probe = await runBenchGit({
      argv: ["ls-tree", "HEAD", "--", rel], lane: { lane: "pinning" }, env: buildGitEnv(process.env, "/dev/null"),
      benchRoot: repoRoot, cwd: repoRoot, limits: gitLimits,
    });
    if (probe.exitCode !== 0)
      throw new Error(`REFUSING: ${gitFailure(`git ls-tree HEAD -- ${rel}`, probe)} — the append-only verification cannot run, so it fails closed (§8)`);
    if (text(probe.stdout).trim() === "") continue; // not in HEAD yet (first run of a log) — nothing to prefix-check
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs))
      throw new Error(`REFUSING: ${rel} is committed in HEAD but ABSENT from the working tree — deleting an evidence log is not appending (§8)`);
    const show = await runBenchGit({
      argv: ["show", `HEAD:${rel}`], lane: { lane: "pinning" }, env: buildGitEnv(process.env, "/dev/null"),
      benchRoot: repoRoot, cwd: repoRoot, limits: gitLimits,
    });
    if (show.exitCode !== 0)
      throw new Error(`REFUSING: ${gitFailure(`git show HEAD:${rel}`, show)} — the committed evidence baseline is unreadable, so the append-only claim cannot be verified (§8)`);
    const working = readFileSync(abs);
    assertAppendOnlyPrefix(rel, show.stdout, working);
    // the INDEX is a third copy a later plain `git commit` would persist: a staged REWRITE
    // beside an appended working file passed the HEAD↔working check alone. The staged copy
    // must itself extend HEAD and be a prefix of the working bytes (the chain HEAD ⊑ index ⊑
    // working is exactly "only appends, everywhere").
    const staged = await runBenchGit({
      argv: ["show", `:${rel}`], lane: { lane: "pinning" }, env: buildGitEnv(process.env, "/dev/null"),
      benchRoot: repoRoot, cwd: repoRoot, limits: gitLimits,
    });
    if (staged.exitCode !== 0)
      throw new Error(`REFUSING: ${gitFailure(`git show :${rel}`, staged)} — the staged copy of an evidence log is unreadable, so the append-only claim cannot be verified (§8)`);
    assertAppendOnlyPrefix(`${rel} (staged)`, show.stdout, staged.stdout);
    assertAppendOnlyPrefix(`${rel} (staged vs working)`, staged.stdout, working);
  }
  return { rat, digest };
}

const APPEND_ONLY = ["docs/adrs/0001-benchmark/runs.jsonl", "docs/adrs/0001-benchmark/fidelity.jsonl", "data/"];

// The traversal is SERIAL by §4.5 and the evidence logs are append-only files with no internal
// framing protection — two concurrent matrix/fidelity invocations would interleave rows and
// markers (which the resume invariant then rightly refuses) and perturb each other's walls.
// One exclusive on-disk lock per repo enforces the single writer; a stale lock (crashed
// process) is the operator's to remove, deliberately — silently stealing a lock a LIVE process
// holds is the worse failure.
function acquireSingleWriterLock(what: string): () => void {
  mkdirSync(join(REPO_ROOT, "data"), { recursive: true });
  const lockPath = join(REPO_ROOT, "data", "bench-single-writer.lock");
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    const holder = ((): string => {
      try {
        return readFileSync(lockPath, "utf8").trim();
      } catch {
        return "unreadable";
      }
    })();
    throw new Error(`REFUSING: ${lockPath} exists (held by: ${holder}) — another ${what} invocation may be live; the traversal is single-writer (§4.5). If that process is dead, remove the lock file and re-run`);
  }
  writeFileSync(lockPath, `pid ${process.pid}, ${what}, started ${new Date().toISOString()}\n`);
  closeSync(fd);
  return () => {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      log(`WARNING: could not remove ${lockPath} — remove it by hand before the next run`);
    }
  };
}

// The §8 gate's git-state leg, pure over the two command results so it is testable in CI.
// BOTH exit codes are checked. `git status` was previously trusted unconditionally: a
// status-only failure yields empty stdout, which parses as "no dirty files" and lets the
// tamper-detection leg pass. (A GLOBAL git failure was already caught, since `ls-files` runs
// under the same pinned env and its exit IS checked — the hole was only ever status-specific.)
export function assertFreezeGitState(
  statusOut: { exitCode: number; stdout: Uint8Array; stderr: Uint8Array },
  lsFiles: { exitCode: number },
  appendOnly: readonly string[],
): void {
  if (statusOut.exitCode !== 0)
    throw new Error(`REFUSING: ${gitFailure("git status --porcelain", statusOut)} — the freeze gate cannot verify a clean tree, so it fails closed (§8)`);
  if (lsFiles.exitCode !== 0)
    throw new Error("REFUSING: ratification.json is not TRACKED — the signed answers must be committed, not a local file (§8)");
  // Exemptions match EXACTLY for files and as prefixes only for "/"-terminated directories. A
  // raw startsWith let `runs.jsonl.bak` (a stray sibling) and — worse — a staged RENAME line
  // (`R  runs.jsonl -> README.md`, whose payload starts with the exempt path) pass the
  // tamper-detection leg. A rename/copy record is never append-only behavior, so any ` -> `
  // line refuses regardless of which paths it names (paths containing a literal " -> " are
  // ambiguous in porcelain v1 — ambiguity resolves to refusal, the gate's posture).
  const isExempt = (f: string): boolean => {
    if (f.includes(" -> ")) return false;
    return appendOnly.some((a) => (a.endsWith("/") ? f.startsWith(a) : f === a));
  };
  const dirty = text(statusOut.stdout).split("\n").map((l) => l.slice(3).trim()).filter((f) => f !== "" && !isExempt(f));
  if (dirty.length > 0)
    throw new Error(`REFUSING: dirty tracked files outside the append-only outputs: ${dirty.slice(0, 5).join(", ")} — the frozen surface must be committed (§8)`);
}

// The append-only exemption above is a BEHAVIORAL claim the digest cannot check (these files
// are outside it by design), so the gate verifies the behavior: the committed bytes must be a
// byte-exact PREFIX of the working copy. Editing or truncating prior evidence refuses; only
// appending passes.
export function assertAppendOnlyPrefix(name: string, committed: Uint8Array, working: Uint8Array): void {
  if (committed.byteLength > working.byteLength)
    throw new Error(`REFUSING: ${name} is shorter than its committed version — the append-only evidence log has been truncated or rewritten (§8)`);
  for (let i = 0; i < committed.byteLength; i++) {
    if (committed[i] !== working[i])
      throw new Error(`REFUSING: ${name} diverges from its committed version at byte ${i} — the append-only evidence log has been edited, not appended (§8)`);
  }
}

// Provenance acquisition, fail-closed. An unchecked rev-parse that returned "" made every row
// claim harnessCommit:"" and turned the resume guard's revision comparison into "" !== "",
// which silently merged rows from different harness revisions into one traversal (§8).
export function harnessCommitFromGitResult(res: { exitCode: number; stdout: Uint8Array; stderr: Uint8Array }): string {
  if (res.exitCode !== 0)
    throw new Error(`REFUSING: ${gitFailure("git rev-parse HEAD", res)} — §8 binds every timed row to a harness revision, which must never be empty`);
  const oid = text(res.stdout).trim();
  if (!/^[0-9a-f]{40}$/.test(oid) && !/^[0-9a-f]{64}$/.test(oid))
    throw new Error(`REFUSING: git rev-parse HEAD returned ${oid === "" ? "an empty string" : `"${oid.slice(0, 24)}"`}, not a full object id — §8 provenance must be a complete sha1/sha256 oid`);
  return oid;
}

// The fidelity battery's live enumeration. A non-zero git exit is a HARNESS failure, never an
// observation: parseLsTreeZ over the deadline path's empty stdout returns [] without throwing,
// which previously read as "the entry is absent from the live tree" — a pass:false row appended
// to the append-only fidelity log, disqualifying the driver globally and irreversibly (§4.7).
export function classifyFidelityEnumeration(
  res: { exitCode: number; stdout: Uint8Array; stderr: Uint8Array },
  format: "sha1" | "sha256",
  limits: { maxEntries: number; maxRecordBytes: number },
): LsTreeEntry[] {
  if (res.exitCode !== 0)
    throw new BenchOperationalError(`${gitFailure("fidelity ls-tree", res)} — a local enumeration failure is a harness fault, not a transport divergence; re-run the battery`);
  return parseLsTreeZ(res.stdout, format, limits);
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
  // home-assistant/core's paths are short (mean ~47 B); kubernetes (37,393 entries, mean 64.2 B,
  // deep staging/ nesting — the figures corpus.json records) is the path-heavy candidate that
  // verifies, so it leads.
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
  try {
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
  } catch (e) {
    // construction failed before any caller could own benchRoot — reclaim it here or the
    // pa-bench-* root (which nothing sweeps) leaks on every failed startup
    rmSync(benchRoot, { recursive: true, force: true });
    throw e;
  }
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

export interface GqlFact { isBinary: boolean; isTruncated: boolean; textNull: boolean }
export type ProbeBatchResult =
  | { ok: true; facts: Map<string, GqlFact> }
  | { ok: false; reason: string };

// Pinned GraphQL facts are ground truth for the WHOLE matrix, so they commit per batch and only
// when every alias in that batch resolved cleanly. Previously an absent/opaque alias — including
// one whose expression carried an alias-attributed error inside an otherwise-200 response — was
// coerced to the POSITIVE fact {isBinary:true}. deriveRoutes freezes that as primary
// "binary-fallback" with no permitted alternative, so at matrix time a normal delivery becomes a
// G2 completeness failure and disqualifies T1 globally, on an artifact of one flaky alias.
// Absence is not a measurement: reject the batch and let the caller retry, then fail the pin.
export function parseProbeBatch(
  data: Record<string, unknown>,
  entries: readonly WorkloadEntry[],
  errors: readonly unknown[] | undefined,
  malformedErrorEntries = 0,
): ProbeBatchResult {
  if (errors !== undefined && errors.length > 0)
    return { ok: false, reason: `response carried ${errors.length} error entr${errors.length === 1 ? "y" : "ies"} — an alias-attributed error is not a fact` };
  // an unreadable errors[] member is an error we cannot attribute, which is strictly worse than
  // one we can — it must not read as "no errors" (the closed default T1's analyzer already uses)
  if (malformedErrorEntries > 0)
    return { ok: false, reason: `response carried ${malformedErrorEntries} malformed error entr${malformedErrorEntries === 1 ? "y" : "ies"} — unattributable errors cannot be read as success` };
  const repo = data["repository"];
  if (typeof repo !== "object" || repo === null)
    return { ok: false, reason: "response carried no repository object" };
  const repoObj = repo as Record<string, unknown>;
  const facts = new Map<string, GqlFact>();
  for (const [i, entry] of entries.entries()) {
    const alias = repoObj[`a${i}`];
    // `typeof x === "object"` alone admits arrays and any wrong-typed node, and the field reads
    // below coerce anything missing into a definite-looking fact. The alias must POSITIVELY be a
    // Blob with correctly-typed fields before it becomes ground truth for the whole matrix.
    if (typeof alias !== "object" || alias === null || Array.isArray(alias))
      return { ok: false, reason: `alias a${i} (${entry.path}) is absent or opaque — refusing to fabricate a binary fact` };
    const o = alias as Record<string, unknown>;
    if (o["__typename"] !== "Blob")
      return { ok: false, reason: `alias a${i} (${entry.path}) resolved to ${typeof o["__typename"] === "string" ? String(o["__typename"]) : "an untyped node"}, not a Blob` };
    // the selection requests oid and byteSize precisely so identity is checkable: a Blob-shaped
    // node for a DIFFERENT object (wrong oid or size) must never pin this entry's route
    if (o["oid"] !== entry.blobOid)
      return { ok: false, reason: `alias a${i} (${entry.path}) resolved to a different object (oid ${typeof o["oid"] === "string" ? `${(o["oid"] as string).slice(0, 12)}…` : "absent"} != pinned ${entry.blobOid.slice(0, 12)}…)` };
    if (o["byteSize"] !== entry.size)
      return { ok: false, reason: `alias a${i} (${entry.path}) carries byteSize ${String(o["byteSize"])} != the pinned canonical size ${entry.size}` };
    if (typeof o["isBinary"] !== "boolean" || typeof o["isTruncated"] !== "boolean")
      return { ok: false, reason: `alias a${i} (${entry.path}) is missing a boolean isBinary/isTruncated — an absent field is not a false one` };
    if (o["text"] !== null && typeof o["text"] !== "string")
      return { ok: false, reason: `alias a${i} (${entry.path}) carries a text field that is neither string nor null` };
    facts.set(entry.path, {
      isBinary: o["isBinary"],
      isTruncated: o["isTruncated"],
      textNull: typeof o["text"] !== "string",
    });
  }
  return { ok: true, facts };
}

async function probeGqlFacts(rt: PinRuntime, slot: { owner: string; repo: string }, sha: string, entries: WorkloadEntry[]): Promise<Map<string, GqlFact>> {
  const facts = new Map<string, GqlFact>();
  // The probe narrows the ALIAS cap (small batches) but keeps the matrix content cap: a
  // tighter probe cap made packBatches THROW at pinning for any entry between the two caps
  // ("alone violates a T1 cap" — a latent pinning crash). Over-MATRIX-cap entries are excluded
  // outright: planRounds pre-routes them by size alone, so GitHub's isBinary/isTruncated
  // judgment is never observed for them at matrix time and pinning one would be dead weight.
  const probeCfg: BenchConfig = { ...rt.cfg, t1: { ...rt.cfg.t1, aliasCap: 100 } };
  const candidates = entries.filter((e) => e.read && e.mode !== "120000" && e.size <= rt.cfg.t1.batchContentBytesCap);
  const batches = packBatches(candidates, probeCfg, { owner: slot.owner, repo: slot.repo, sha, roundLabel: "gqlprobe" });
  for (const batch of batches) {
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      const d = await benchGraphqlDispatch(rt.gh, batch.query, batch.fields, batch.label);
      // gh's exit code matters here exactly as the matrix analyzer treats it: a nonzero exit
      // under an otherwise success-shaped envelope means the transfer cannot be vouched for,
      // and this probe COMMITS ground truth — retry, never pin from it. (Errored envelopes are
      // already rejected downstream by parseProbeBatch.)
      if (d.status !== 200 || !d.jsonParseable || d.data === null || (d.exitCode !== 0 && d.errors.length === 0 && d.malformedErrorEntries === 0)) {
        log(`  gql probe ${batch.label}: HTTP ${d.status} (gh exit ${d.exitCode}), retrying`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      const parsed = parseProbeBatch(d.data, batch.entries, d.errors, d.malformedErrorEntries);
      if (!parsed.ok) {
        log(`  gql probe ${batch.label}: ${parsed.reason}, retrying`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      for (const [path, fact] of parsed.facts) facts.set(path, fact); // batch-atomic commit
      done = true;
    }
    if (!done) throw new Error(`gql probe ${batch.label} failed after 3 attempts — pinning refuses to record fabricated facts`);
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
      // over-cap entries are deliberately unprobed (see probeGqlFacts) — their route derives
      // from size alone and their gql member stays null
      if (!e.read || e.mode === "120000" || e.size > rt.cfg.t1.batchContentBytesCap) continue;
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
async function makeEngine(cfg: BenchConfig, corpus: Corpus, workloads: Map<string, UnitWorkload>, frozenSurfaceDigest: string | null): Promise<{ engine: BenchEngine; benchRoot: string }> {
  const benchRoot = mkdtempSync(join(realpathSync(tmpdir()), cfg.protocol.tempPrefix));
  try {
  const metaClient = new GithubClient({ githubHost: cfg.githubHost, db: null, tempRoot: benchRoot });
  const login = loginFromUserPayload(await metaClient.restGetJson("user"));
  const harnessCommit = harnessCommitFromGitResult(await runBenchGit({
    argv: ["rev-parse", "HEAD"], lane: { lane: "pinning" }, env: buildGitEnv(process.env, "/dev/null"),
    benchRoot: realpathSync(REPO_ROOT), cwd: REPO_ROOT,
    limits: { maxStdoutBytes: 4096, maxStderrBytes: 4096, deadlineMs: 60_000 },
  }));
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
    frozenSurfaceDigest,
    client: metaClient,
    makeClient: (db) => new GithubClient({ githubHost: cfg.githubHost, db, tempRoot: benchRoot }),
    log,
  });
  return { engine, benchRoot };
  } catch (e) {
    // construction failed before the caller could own benchRoot — reclaim it here or the
    // temp root (pa-bench-*, which nothing sweeps) leaks on every failed startup
    rmSync(benchRoot, { recursive: true, force: true });
    throw e;
  }
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
  try {
    log(`bench root: ${rt.benchRoot}`);
    const snap = await readRateLimit(rt.gh);
    log(`rate_limit headroom: core ${snap.core.remaining}, graphql ${snap.graphql.remaining}`);
    const bundles: PinnedSlotBundle[] = [];
    for (const slotId of ["C1", "C2", "C3", "C4", "C5"] as const) {
      bundles.push(await pinPerformanceSlot(rt, slotId));
    }
    const fidelity = await pinFidelity(rt);
    const login = loginFromUserPayload(await rt.client.restGetJson("user"));
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
  // the pilot runs BEFORE ratification exists, so its rows carry no frozen-surface digest
  const { engine, benchRoot } = await makeEngine(cfg, corpus, workloads, null);
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

// The fidelity battery's resume discipline over its own append-only log (§4.2: "§4.5's
// objective-external rerun predicate applies once per (fixture, driver); a fidelity mismatch is
// never rerunnable"). Only rows at the CURRENT frozen surface count: another surface's rows
// neither skip nor block (a digest change restarts the battery like any §8 amendment).
export interface FidelityLogState {
  passed: Set<string>; // "kind|driver|path" recorded pass:true — skipped on re-run (idempotence)
  failed: Set<string>; // any recorded pass:false — the battery REFUSES to re-run (G1 stands)
  // "kind|driver" driver failures (store corruption, coherence, fatal HTTP): durable and NEVER
  // rerunnable (§4.5 "everything else is a driver failure, no rerun") — re-running until a pass
  // would launder them
  driverFailures: Set<string>;
  operationalAborts: Map<string, number>; // "kind|driver" → recorded operational-abort count
}
export function classifyFidelityLog(lines: readonly string[], digest: string): FidelityLogState {
  const passed = new Set<string>();
  const failed = new Set<string>();
  const driverFailures = new Set<string>();
  const operationalAborts = new Map<string, number>();
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`REFUSING: fidelity.jsonl line ${i + 1} is not valid JSON — the append-only evidence log is corrupted; §8 freeze-repair territory, never a silent skip`);
    }
    if (rec["frozenSurfaceDigest"] !== digest) continue;
    if (rec["type"] === "fidelity") {
      const key = `${String(rec["fixture"])}|${String(rec["driver"])}|${String(rec["entry"])}`;
      if (rec["pass"] === true) passed.add(key);
      else failed.add(key);
    } else if (rec["type"] === "fidelity-operational-abort") {
      const key = `${String(rec["fixture"])}|${String(rec["driver"])}`;
      operationalAborts.set(key, (operationalAborts.get(key) ?? 0) + 1);
    } else if (rec["type"] === "fidelity-driver-failure") {
      driverFailures.add(`${String(rec["fixture"])}|${String(rec["driver"])}`);
    }
  }
  return { passed, failed, driverFailures, operationalAborts };
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
  const releaseLock = acquireSingleWriterLock("fidelity");
  const rt = makePinRuntime(cfg);
  // Gate-relevant fidelity evidence must come off the WIRE, never from the persistent pinning
  // cache: an immutable cache hit would let a stale or corrupted local bench-pin-cache row
  // become a permanent pass/fail verdict in the append-only log with no transport happening.
  // The battery is untimed and tiny (K = 1 per applicable driver), so the extra requests are
  // immaterial.
  const fidelityGh: BenchGhContext = { ...rt.gh, db: null };
  const results: Array<Record<string, unknown>> = [];
  let failures = 0;
  const seamHash = (bytes: Uint8Array): string => sha256Hex(Buffer.from(seamDecode(bytes), "utf8"));
  // resume discipline over the battery's own append-only log (§4.2): a recorded pass at THIS
  // surface is skipped (idempotence — re-running it would append duplicate evidence and spend
  // live requests for nothing); a recorded FAIL refuses outright (a fidelity mismatch is never
  // rerunnable — re-running until it passed would launder a permanent G1 verdict); a second
  // operational abort on one (fixture, driver) refuses (the ≤1 objective-external rerun is
  // spent — the operator investigates the harness fault rather than retrying forever).
  const fidelityLogPath = join(ARTIFACTS, "fidelity.jsonl");
  const logState: FidelityLogState = existsSync(fidelityLogPath)
    ? classifyFidelityLog(readFileSync(fidelityLogPath, "utf8").split("\n"), digest)
    : { passed: new Set<string>(), failed: new Set<string>(), driverFailures: new Set<string>(), operationalAborts: new Map<string, number>() };
  if (logState.failed.size > 0)
    throw new Error(`REFUSING: fidelity.jsonl records ${logState.failed.size} pass:false row(s) at the current frozen surface — a fidelity mismatch is never rerunnable (§4.2); the G1 verdict stands`);
  if (logState.driverFailures.size > 0)
    throw new Error(`REFUSING: fidelity.jsonl records driver failure(s) at the current frozen surface (${[...logState.driverFailures].join(", ")}) — §4.5 makes driver failures non-rerunnable; re-running until a pass would launder them`);
  let inFlight: { fixture: string; driver: string } | null = null;
  try {
    for (const fixture of corpus.fidelity) {
      for (const driver of fixture.appliesTo) {
        const abortKey = `${fixture.kind}|${driver}`;
        if ((logState.operationalAborts.get(abortKey) ?? 0) >= 2)
          throw new Error(`REFUSING: fidelity.jsonl records ${logState.operationalAborts.get(abortKey)} operational aborts for ${abortKey} at the current surface — the ≤1 rerun allowance (§4.2/§4.5) is spent; investigate the harness fault`);
        for (const entry of fixture.entries) {
          if (logState.passed.has(`${fixture.kind}|${driver}|${entry.path}`)) {
            log(`fidelity ${fixture.kind} ${driver} ${entry.path}: already recorded PASS at this surface — skipping`);
            continue;
          }
          inFlight = { fixture: fixture.kind, driver };
          const expectDeref = fixture.verification["restDerefSeamSha256"];
          const expectCanonical = fixture.verification["canonicalSeamSha256"];
          let delivered: string | null = null;
          let rawVerified: boolean | null = null;
          let route = "";
          if (entry.mode === "120000" && driver === "T1") {
            // T1's mode source is the tree it fetched — the fixture pin stands in for it here;
            // the REST dereference is the matrix's route
            const res = await benchRestGet(fidelityGh, { endpoint: `repos/${encodeURIComponent(fixture.owner)}/${encodeURIComponent(fixture.repo)}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}?ref=${fixture.sha}`, accept: cfg.rest.rawAccept, immutable: true, requestClass: "rest-fallback" });
            delivered = res.body;
            route = "symlink-fallback";
          } else if (driver === "T0") {
            const res = await benchRestGet(fidelityGh, { endpoint: `repos/${encodeURIComponent(fixture.owner)}/${encodeURIComponent(fixture.repo)}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}?ref=${fixture.sha}`, accept: cfg.rest.rawAccept, immutable: true, requestClass: "rest-content" });
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
            const d = await benchGraphqlDispatch(fidelityGh, batch.query, batch.fields, batch.label);
            const analysis = analyzeBatchResponse(d, batch, fixture.objectFormat, cfg);
            if (analysis.kind === "per-alias" && analysis.outcomes[0]?.kind === "resolved") {
              delivered = analysis.outcomes[0].text;
              rawVerified = true;
              route = "primary";
            } else if (analysis.kind === "per-alias" && (analysis.outcomes[0]?.kind === "binary-fallback" || analysis.outcomes[0]?.kind === "truncated-blob-fallback" || analysis.outcomes[0]?.kind === "validation-fallback")) {
              const res = await benchRestGet(fidelityGh, { endpoint: `repos/${encodeURIComponent(fixture.owner)}/${encodeURIComponent(fixture.repo)}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}?ref=${fixture.sha}`, accept: cfg.rest.rawAccept, immutable: true, requestClass: "rest-fallback" });
              delivered = res.body;
              route = analysis.outcomes[0].kind === "validation-fallback" ? "validation-fallback" : analysis.outcomes[0].kind;
            } else {
              // FAIL-CLOSED BY DEFAULT. Everything that is not one of the delivering cases above
              // is a transport-level condition — http-failure, throttle-retry, batch/alias
              // timeout, the closed default — and none of them is an observation about T1's
              // FIDELITY. Recording any of them as a route appends a pass:false row to the
              // append-only log and disqualifies the driver globally and irreversibly (§4.7).
              // Written as an else rather than a list so a NEW analysis kind fails closed too.
              // This defect class — a transient failure recorded as a PERMANENT verdict — has now
              // been found five times in this harness; ratification.json enumerates them.
              const detail = analysis.kind === "per-alias"
                ? `alias outcome ${analysis.outcomes[0]?.kind ?? "none"}`
                : analysis.kind;
              throw new BenchOperationalError(`fidelity T1 could not deliver ${entry.path} (${detail}) — a transport-level failure is a harness fault, not a transport divergence; re-run the battery`);
            }
          } else {
            // clone drivers acquire through the REAL acquisition machinery + seams
            const runDir = join(rt.benchRoot, `fid-${fixture.kind}-${driver}`);
            mkdirSync(runDir, { recursive: true });
            const slotLike = { slot: "C5", owner: fixture.owner, repo: fixture.repo, objectFormat: fixture.objectFormat, repoSizeKb: 0, units: [], verification: {} } as unknown as PerformanceSlot;
            const unitLike = { unitId: `fid:${fixture.owner}/${fixture.repo}@${fixture.branch ?? "sha"}`, branch: fixture.branch ?? "", sha: fixture.sha, treeOid: fixture.sha } as CorpusUnit;
            const ctx = {
              cfg, slot: slotLike, unit: unitLike, workload: null as never, gh: fidelityGh,
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
            const lsEntries = classifyFidelityEnumeration(lsOut, fixture.objectFormat, { maxEntries: cfg.lsTree.maxEntries, maxRecordBytes: cfg.lsTree.maxRecordBytes });
            const liveEntry = lsEntries.find((e) => e.path === entry.path);
            if (liveEntry === undefined) {
              // the store is coherence-asserted at the PINNED sha, so a pinned path absent from
              // its own enumeration is a stale corpus pin — an artifact defect, never a byte-
              // fidelity observation (the same channel rule as the oid/size staleness check)
              throw new BenchOperationalError(`fixture ${fixture.kind} pins ${entry.path}, which is absent from the pinned tree's own enumeration — repair corpus.json, never record a verdict from it`);
            } else if (liveEntry.mode === "120000") {
              const res = await benchRestGet(fidelityGh, { endpoint: `repos/${encodeURIComponent(fixture.owner)}/${encodeURIComponent(fixture.repo)}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}?ref=${fixture.sha}`, accept: cfg.rest.rawAccept, immutable: true, requestClass: "rest-fallback" });
              delivered = res.body;
              route = "symlink-fallback";
            } else if (driver === "T2a") {
              delivered = seamDecode(readFileSync(join(dir, entry.path)));
              route = "primary";
            } else {
              // a stale fixture pin is a CORPUS-ARTIFACT defect, and a store that cannot serve
              // (or mis-serves) an oid its own enumeration listed is the acquisition condition
              // runT2c classifies as a UnitFailure — neither is a BYTE-fidelity observation, so
              // neither may append a permanent pass:false row (the wrong §4.7 channel)
              if (liveEntry.oid !== entry.oid || (liveEntry.size ?? 0) !== entry.size)
                throw new BenchOperationalError(`fixture ${fixture.kind} pin is stale for ${entry.path} (live ${liveEntry.oid.slice(0, 12)}…/${String(liveEntry.size)} != pinned ${entry.oid.slice(0, 12)}…/${entry.size}) — repair corpus.json, never record a verdict from it`);
              const child = new BatchChild({
                objectFormat: fixture.objectFormat, env: rt.gitEnv, cwd: dir, benchRoot: rt.benchRoot,
                limits: { maxHeaderBytes: cfg.frame.maxHeaderBytes, frameCeiling: cfg.frame.frameCeilingBytes, stderrRingBytes: cfg.frame.stderrRingBytes, readDeadlineMs: cfg.frame.readDeadlineMs, disposeDeadlineMs: cfg.frame.disposeDeadlineMs },
                onRecord: rt.spawnObs,
              });
              let fidelityThrown: Error | null = null;
              try {
                const frame = await child.readObject({ oid: liveEntry.oid, size: liveEntry.size ?? 0 });
                if (frame.kind === "missing")
                  throw new UnitFailure(`object-store corruption: ${entry.path}'s enumerated oid is missing from the acquired store`);
                if (gitBlobOid(frame.body, fixture.objectFormat) !== liveEntry.oid)
                  throw new UnitFailure(`frame bytes do not hash to the enumerated oid at ${entry.path}`);
                delivered = seamDecode(frame.body);
                rawVerified = true;
                route = "primary";
              } catch (e) {
                fidelityThrown = e instanceof Error ? e : new Error(String(e));
                throw fidelityThrown;
              } finally {
                // the fidelity battery reads bytes through this child, so an unclean teardown
                // means the bytes it just delivered cannot be vouched for. Raised as a HARNESS
                // fault, never as a transport divergence — §4.7 disqualification is permanent.
                // When a readObject error is ALREADY propagating, a throw here would REPLACE it
                // (the same evidence-masking runT2c's teardown annotation prevents), so the
                // disposal verdict is appended to the in-flight error instead.
                const d = await child.dispose();
                if (!disposalIsClean(d)) {
                  if (fidelityThrown !== null) fidelityThrown.message = `${fidelityThrown.message} — batch child teardown was also unclean: ${describeDisposal(d)}`;
                  else throw new BenchOperationalError(`fidelity batch child teardown was not clean: ${describeDisposal(d)}`);
                }
              }
            }
            rmSync(runDir, { recursive: true, force: true });
            void liveEntry;
          }
          const gotHash = delivered === null ? null : sha256Hex(Buffer.from(delivered, "utf8"));
          const expected = route === "symlink-fallback" || entry.mode === "120000" || typeof expectCanonical !== "string" ? expectDeref : expectCanonical;
          // a fixture whose verification carries NO usable hash is a corpus-artifact defect —
          // recording pass:false from it would permanently disqualify every applicable driver
          // over a malformed ARTIFACT, not an observed divergence. Refuse instead.
          if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))
            throw new BenchOperationalError(`fixture ${fixture.kind} carries no usable sha256 verification hash for ${entry.path} (route ${route}) — a corpus artifact defect; repair corpus.json, never record a verdict from it`);
          const pass = gotHash === expected;
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
  } catch (e) {
    // a HARNESS fault (never a divergence) aborts the battery: record which (fixture, driver)
    // was in flight so the ≤1 rerun allowance is countable across invocations. Best-effort —
    // the abort itself must still propagate even if the marker append fails.
    // Two DISTINCT durable outcomes, matching §4.5's split exactly:
    //   • operational/R1-R2-shaped aborts (harness faults; network-layer no-response; transient
    //     5xx exhaustion) — an abort marker, and the ≤1 objective-external rerun applies;
    //   • DRIVER failures (store corruption, coherence, fatal HTTP, spawn faults) — a durable
    //     driver-failure row, never rerunnable: re-running until a pass would launder a §4.5
    //     "driver failure, no rerun" through the battery.
    if (inFlight !== null) {
      const rerunnableAbort =
        e instanceof BenchOperationalError ||
        (e instanceof BenchHttpError && evidenceIsRerunnable(
          { kind: "http", code: e.code, lastClassification: e.lastClassification, requestClass: e.requestClass },
          `${inFlight.fixture}|${inFlight.driver}`,
          // the battery has no repetition ledger; R2's prior-success stands on the pinning-time
          // success of the same read class, recorded in corpus.json's verification evidence
          new Set([`${inFlight.fixture}|${inFlight.driver}|${e.requestClass ?? ""}`]),
        ));
      const driverFailure = !rerunnableAbort && (e instanceof UnitFailure || e instanceof BenchSpawnError || e instanceof BenchHttpError);
      const marker = rerunnableAbort
        ? { type: "fidelity-operational-abort", generatedAtIso: new Date().toISOString(), frozenSurfaceDigest: digest, fixture: inFlight.fixture, driver: inFlight.driver, reason: (e instanceof Error ? e.message : String(e)).slice(0, 300) }
        : driverFailure
          ? { type: "fidelity-driver-failure", generatedAtIso: new Date().toISOString(), frozenSurfaceDigest: digest, fixture: inFlight.fixture, driver: inFlight.driver, reason: (e instanceof Error ? e.message : String(e)).slice(0, 300) }
          : null;
      if (marker !== null) {
        try {
          appendFileSync(fidelityLogPath, `${JSON.stringify(marker)}\n`);
        } catch {
          log(`WARNING: could not append the ${String(marker.type)} marker to fidelity.jsonl`);
        }
      }
    }
    throw e;
  } finally {
    rmSync(rt.benchRoot, { recursive: true, force: true });
    releaseLock();
  }
}

// ---- matrix resumability (codex R1 f.17), extracted PURE so CI can drive it ------------------
// The frozen R1/R2 predicate over TYPED evidence (§4.5; codex R1 f.7): R1 = a network-layer
// failure outside any HTTP response, rerunnable unconditionally (≤1); R2 = a transient-5xx
// exhaustion within caps whose request class SUCCEEDED in at least one other completed
// repetition of this unit × driver. Secondary-shaped failures are NEVER rerunnable.
export function evidenceIsRerunnable(ev: unknown, unitDriverKey: string, ledger: ReadonlySet<string>): boolean {
  if (typeof ev !== "object" || ev === null) return false;
  const e = ev as Record<string, unknown>;
  if (e["kind"] !== "http") return false;
  if (e["code"] === "no-response") return true; // R1
  if ((e["code"] === "attempts-exhausted" || e["code"] === "http-failure") && e["lastClassification"] === "transient")
    return ledger.has(`${unitDriverKey}|${typeof e["requestClass"] === "string" ? e["requestClass"] : ""}`); // R2
  return false;
}

export interface ResumeState {
  terminalPos: Set<number>;
  rerunUsed: Set<string>; // unit|driver keys whose ≤1 R1/R2 allowance is spent
  straddled: Set<string>; // units with a recorded R4 straddle (a second one halts)
  successLedger: Set<string>; // unit|driver|requestClass with an ok in a completed rep
  driftedUnits: Set<string>;
  resumeForms: Map<string, "production" | "scaffolding">;
  // pos → unit|driver: a rerunnable unit-failure whose MANDATED in-slot R1/R2 replay (§4.5)
  // never landed a row — the traversal owes it, it is not terminal
  owedReplays: Map<number, string>;
  // pos set whose LAST row is an R3/R4 invalidation: the in-slot replay §4.5 mandates is still
  // owed, and the caller must dispatch it AS an r3r4 replay so its record carries the
  // physical-predecessor bookkeeping ("a replay's physical predecessor is the failed attempt
  // itself — recorded as such") — a resumed re-execution previously ran unmarked
  owedInSlotReplays: Set<number>;
  // non-null when the log's FINAL event is a run row whose washout marker never landed: the
  // washout was interrupted, and the caller COMPLETES it (sleep, then append the marker)
  // before executing anything — §4.5's separation is satisfied without re-running a transport
  // attempt that already measured (an earlier design re-ran the row, which duplicated
  // measurements and consumed budget for an owed IDLE period)
  owedWashout: { pos: number; ms: number } | null;
}

// the identity a resume row must match — the frozen schedule's own row at that position
export interface ScheduleRowIdentity {
  unit: string;
  driver: string;
  rep: number;
  probe: boolean;
}

const RESUME_OUTCOMES = new Set([
  "complete", "unit-failure", "invalidated-straddle", "invalidated-foreign",
  "invalidated-finalisation", "halt-r5-breach", "drift-restart", "re-pin-required",
]);

// Reconstruct the traversal state from runs.jsonl. The properties that matter beyond
// bookkeeping:
//   • every run row is validated against the FROZEN schedule's identity at its position —
//     a parseable-but-wrong row (garbage unit/driver, an unknown outcome) must refuse, never
//     silently terminalize a position it does not describe;
//   • washout markers pair with run rows by LOG ORDER (a marker certifies the row it follows;
//     the live engine appends row-then-marker before anything else runs, so at most the FINAL
//     event may be an unmarked row). An interrupted washout is returned as owedWashout for the
//     caller to COMPLETE (sleep + append the marker) — never a reason to re-run a transport
//     attempt that already measured, which duplicated measurements and consumed budget for an
//     owed idle period;
//   • a unit-failure whose live traversal had decided an R1/R2 replay — and was then
//     interrupted anywhere in the replay run — must NOT terminalize: the frozen §4.5 discipline
//     mandated that replay. It is re-decided here with the SAME predicate over the ledger AS OF
//     the failure's position (a completion recorded after it must not retroactively authorize —
//     §4.5's "evaluated at failure time" is order-stable), so a live "no rerun" decision
//     reconstructs identically and is never granted a replay resume-side;
//   • two recorded R4 straddles on one unit mean the live traversal already halted for freeze
//     repair — resume REFUSES rather than quietly executing a third attempt past that halt.
export function reconstructResumeState(
  lines: readonly string[],
  currentDigest: string,
  currentEnvHash: string,
  schedule: ReadonlyMap<number, ScheduleRowIdentity>,
): ResumeState {
  const rowsAtPos = new Map<number, Array<Record<string, unknown>>>();
  const straddleRows = new Map<string, number>();
  const driftedUnits = new Set<string>();
  const rerunUsed = new Set<string>();
  const resumeForms = new Map<string, "production" | "scaffolding">();
  const ledgerEntries: Array<{ pos: number; key: string; unit: string; epilogue: boolean }> = [];
  let pendingUnmarked: { pos: number; rec: Record<string, unknown>; line: number } | null = null;
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // an unreadable line in the evidence log is freeze-repair territory: skipping it could
      // silently drop a terminal halt-r5/re-pin row and resume straight past a frozen-
      // assumption breach
      throw new Error(`REFUSING to resume: runs.jsonl line ${i + 1} is not valid JSON — the append-only evidence log is corrupted; that is §8 freeze-repair territory, never a silent skip`);
    }
    if (rec["type"] === "washout-done" && rec["phase"] === "matrix") {
      // a marker certifies the row it follows — one with no unmarked row, or the wrong pos,
      // describes a log the live engine cannot have written
      if (pendingUnmarked === null || rec["pos"] !== pendingUnmarked.pos)
        throw new Error(`REFUSING to resume: runs.jsonl line ${i + 1} carries a washout marker with no matching preceding run row — the evidence log violates the row/marker invariant`);
      pendingUnmarked = null;
      continue;
    }
    if (rec["type"] !== "run" || rec["phase"] !== "matrix") continue;
    // resume only trusts records from THIS frozen measurement surface — rows from another
    // surface/machine must not silently mix into one traversal (codex R2 f.21). The binding is
    // the §8 CONTENT digest, not the commit: an evidence-only or test-only commit moves HEAD
    // without changing the frozen surface, and must not orphan every prior row (the commit
    // stays stamped per row as provenance).
    if (rec["frozenSurfaceDigest"] !== currentDigest)
      throw new Error(`REFUSING to resume: runs.jsonl carries matrix rows from frozen surface ${String(rec["frozenSurfaceDigest"]).slice(0, 12)} != current ${currentDigest.slice(0, 12)} — a changed measurement surface restarts the matrix (§8)`);
    // one machine, one network, one credential for ALL timed data (§8) — a foreign
    // environment's rows must never mix into this traversal (codex R3 f.2)
    if (rec["envManifestHash"] !== currentEnvHash)
      throw new Error(`REFUSING to resume: runs.jsonl carries rows from environment ${String(rec["envManifestHash"])} != current ${currentEnvHash}`);
    const outcome = rec["outcome"];
    if (outcome === "halt-r5-breach" || outcome === "re-pin-required")
      throw new Error(`REFUSING to resume: runs.jsonl carries a terminal ${outcome} row — that is freeze-repair/amendment territory (§4.5 R5/R6), never a silent retry`);
    if (typeof outcome !== "string" || !RESUME_OUTCOMES.has(outcome))
      throw new Error(`REFUSING to resume: runs.jsonl line ${i + 1} carries unknown outcome ${JSON.stringify(outcome)} — a row this scan cannot classify must not be skimmed past`);
    const pos = rec["pos"];
    if (typeof pos !== "number")
      throw new Error(`REFUSING to resume: runs.jsonl line ${i + 1} is a matrix run row with no numeric pos`);
    // the row must describe the FROZEN schedule's own identity at its position — a garbage
    // unit/driver would otherwise terminalize a position it does not describe
    const expected = schedule.get(pos);
    if (expected === undefined)
      throw new Error(`REFUSING to resume: runs.jsonl line ${i + 1} names pos ${pos}, which the frozen schedule does not contain`);
    if (rec["unit"] !== expected.unit || rec["driver"] !== expected.driver || rec["rep"] !== expected.rep || rec["probe"] !== expected.probe)
      throw new Error(`REFUSING to resume: runs.jsonl line ${i + 1} at pos ${pos} does not match the frozen schedule row (${expected.unit} ${expected.driver} rep${expected.rep}${expected.probe ? " probe" : ""})`);
    if (pendingUnmarked !== null)
      throw new Error(`REFUSING to resume: runs.jsonl line ${i + 1} appends a run row while line ${pendingUnmarked.line} is still awaiting its washout marker — the evidence log violates the row/marker invariant`);
    pendingUnmarked = { pos, rec, line: i + 1 };
    const list = rowsAtPos.get(pos) ?? [];
    list.push(rec);
    rowsAtPos.set(pos, list);
    const unit = expected.unit;
    if (outcome === "invalidated-straddle") straddleRows.set(unit, (straddleRows.get(unit) ?? 0) + 1);
    if (outcome === "drift-restart") driftedUnits.add(unit); // pending R6 epilogue survives interruption (f.20)
    const form = rec["acquisitionForm"];
    if (form === "scaffolding") resumeForms.set(unit, "scaffolding");
    else if (form === "production" && !resumeForms.has(unit)) resumeForms.set(unit, "production");
    // only R1/R2 replays charge the driver allowance; R3/R4 in-slot replays do not (f.23)
    if (rec["replayKind"] === "r1r2") rerunUsed.add(`${unit}|${expected.driver}`);
    if (outcome === "complete") {
      for (const cls of Object.keys((rec["requests"] as Record<string, number> | undefined) ?? {}))
        ledgerEntries.push({ pos, key: `${unit}|${expected.driver}|${cls}`, unit, epilogue: rec["epilogue"] === true });
      // every completed run READ rate_limit successfully before and after (its accounting
      // depends on it), but rest-meta is control-plane and excluded from `requests` — without
      // this implied entry a pre-run rate_limit exhaustion could never satisfy R2's
      // prior-success predicate and became a permanent G3 failure
      ledgerEntries.push({ pos, key: `${unit}|${expected.driver}|rest-meta`, unit, epilogue: rec["epilogue"] === true });
    }
  }
  // §4.5 R4: the SECOND straddle on a unit halts the matrix for freeze repair — a log carrying
  // two straddle rows records a traversal that already halted; resume must not run a third
  for (const [unit, n] of straddleRows) {
    if (n >= 2)
      throw new Error(`REFUSING to resume: runs.jsonl records ${n} R4 straddles on ${unit} — the second one halted the matrix for freeze repair (§4.5); never a silent third attempt`);
  }
  const straddled = new Set(straddleRows.keys());
  // a drifted unit's form is scaffolding regardless of what its pre-drift rows recorded
  for (const unit of driftedUnits) resumeForms.set(unit, "scaffolding");
  // drift may have landed AFTER a completion entered the ledger above — a drifted unit's
  // non-epilogue reps are discarded and their evidence with them
  const filteredLedger = ledgerEntries.filter((e) => !driftedUnits.has(e.unit) || e.epilogue);
  const successLedger = new Set(filteredLedger.map((e) => e.key));
  const ledgerBefore = (pos: number): Set<string> => new Set(filteredLedger.filter((e) => e.pos < pos).map((e) => e.key));

  // the final event may legitimately be an unmarked row: its washout was interrupted and is
  // OWED — the caller completes it before executing anything
  const washoutMsOf = (rec: Record<string, unknown>): number => {
    const v = rec["washoutAppliedMs"];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  };
  const owedWashout = pendingUnmarked === null ? null : { pos: pendingUnmarked.pos, ms: washoutMsOf(pendingUnmarked.rec) };

  const terminalPos = new Set<number>();
  const owedReplays = new Map<number, string>();
  const owedInSlotReplays = new Set<number>();
  for (const [pos, rows] of rowsAtPos) {
    // a SECOND invalidated-finalisation at one position means the post-run accounting read is
    // failing persistently — an unbounded silent retry class; the operator investigates
    const finalisationFailures = rows.filter((r) => r["outcome"] === "invalidated-finalisation").length;
    if (finalisationFailures >= 2)
      throw new Error(`REFUSING to resume: pos ${pos} carries ${finalisationFailures} invalidated-finalisation rows — the post-run accounting is failing persistently; investigate before re-running`);
    const last = rows[rows.length - 1]!;
    const outcome = last["outcome"] as string;
    if (outcome === "invalidated-straddle" || outcome === "invalidated-foreign") {
      // the §4.5 in-slot replay is owed AND must carry its replay bookkeeping when dispatched
      owedInSlotReplays.add(pos);
      continue;
    }
    if (outcome !== "complete" && outcome !== "unit-failure") continue; // finalisation/drift rows never terminalize
    const unit = last["unit"] as string;
    if (driftedUnits.has(unit) && last["epilogue"] !== true) continue; // discarded main reps; the epilogue re-runs them (f.4)
    // the owed-replay reconstruction applies to EPILOGUE failures of drifted units too — an
    // interrupt during an epilogue R1/R2 replay must not forfeit it (the ledger already keeps
    // only the drifted unit's epilogue evidence)
    if (outcome === "unit-failure" && (!driftedUnits.has(unit) || last["epilogue"] === true)) {
      const key = `${unit}|${last["driver"] as string}`;
      if (!rerunUsed.has(key) && evidenceIsRerunnable(last["failureEvidence"], key, ledgerBefore(pos))) {
        owedReplays.set(pos, key);
        continue;
      }
    }
    terminalPos.add(pos);
  }
  return { terminalPos, rerunUsed, straddled, successLedger, driftedUnits, resumeForms, owedReplays, owedInSlotReplays, owedWashout };
}

async function cmdMatrix(): Promise<void> {
  const { cfg, corpus, workloads } = loadPinned();
  if (cfg.schedule === null) throw new Error("REFUSING: bench-config.json carries no pinned schedule (run pin-corpus first)");
  const releaseLock = acquireSingleWriterLock("matrix");
  try {
  const { digest } = await assertRatifiedAndFrozen();
  const { engine, benchRoot } = await makeEngine(cfg, corpus, workloads, digest);
  try {
    const runsPath = join(ARTIFACTS, "runs.jsonl");
    let terminalPos = new Set<number>();
    let rerunUsed = new Set<string>();
    let straddled = new Set<string>();
    let successLedger = new Set<string>();
    let driftedUnits = new Set<string>();
    let owedReplays = new Map<number, string>();
    let owedInSlotReplays = new Set<number>();
    if (existsSync(runsPath)) {
      const scheduleByPos = new Map(cfg.schedule.rows.map((r) => [r.pos, { unit: r.unit, driver: r.driver, rep: r.rep, probe: r.probe }]));
      const state = reconstructResumeState(
        readFileSync(runsPath, "utf8").split("\n"),
        digest,
        engine.envManifestHashValue(),
        scheduleByPos,
      );
      ({ terminalPos, rerunUsed, straddled, successLedger, driftedUnits, owedReplays, owedInSlotReplays } = state);
      if (terminalPos.size > 0) log(`resuming: ${terminalPos.size} scheduled positions already terminal in runs.jsonl`);
      if (owedReplays.size > 0) log(`resuming: ${owedReplays.size} owed R1/R2 replay(s) reconstructed from the log`);
      engine.restoreUnitForms(state.resumeForms);
      if (state.owedWashout !== null) {
        // the last recorded run's washout was interrupted: complete the owed IDLE period and
        // append its marker — never re-run a transport attempt that already measured (§4.5's
        // separation is about idle time, not repetition)
        const sched = scheduleByPos.get(state.owedWashout.pos)!;
        const ms = Math.max(cfg.protocol.washoutFloorMs, state.owedWashout.ms);
        log(`completing the interrupted washout for pos ${state.owedWashout.pos} (${Math.ceil(ms / 1000)}s) before resuming (§4.5)`);
        await new Promise((r) => setTimeout(r, ms));
        engine.appendLogMarker({ type: "washout-done", pos: state.owedWashout.pos, rep: sched.rep, probe: sched.probe, phase: "matrix", unit: sched.unit, driver: sched.driver });
      }
    }
    const isRerunnable = (record: import("./benchProtocol.ts").RunRecord): boolean =>
      evidenceIsRerunnable(record.failureEvidence, `${record.unit}|${record.driver}`, successLedger);
    const executeRows = async (rows: NonNullable<typeof cfg.schedule>["rows"], phaseNote: string): Promise<void> => {
      for (const row of rows) {
        if (terminalPos.has(row.pos) && phaseNote === "main") continue;
        if (driftedUnits.has(row.unit) && phaseNote === "main") continue; // discarded reps; the epilogue re-runs the whole unit
        if (owedInSlotReplays.has(row.pos)) {
          // the pre-interrupt traversal's R3/R4 in-slot replay: dispatch it WITH its replay
          // bookkeeping so the record names its physical predecessor (§4.5)
          owedInSlotReplays.delete(row.pos);
          engine.setReplayOf(row.pos, "r3r4");
          log(`resuming the owed in-slot (R3/R4) replay at pos ${row.pos}`);
        }
        const owedKey = owedReplays.get(row.pos);
        if (owedKey !== undefined) {
          // the pre-interrupt traversal decided this R1/R2 replay (§4.5's evaluated-at-failure-
          // time predicate, reconstructed identically by reconstructResumeState) — execute it
          // with the same bookkeeping the live decision would have used
          owedReplays.delete(row.pos);
          rerunUsed.add(owedKey);
          engine.setReplayOf(row.pos, "r1r2");
          log(`resuming the owed R1/R2 replay for ${owedKey} at pos ${row.pos}`);
        }
        for (;;) {
          const handle = await engine.runOne(row, "matrix");
          const key = `${row.unit}|${row.driver}`;
          if (handle.record.outcome === "complete") {
            for (const cls of Object.keys(handle.record.requests)) successLedger.add(`${key}|${cls}`);
            successLedger.add(`${key}|rest-meta`); // implied: a completed run's accounting read rate_limit successfully
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
            // §4.4 discards the unit's collected reps — including their SUCCESS-LEDGER evidence:
            // a later epilogue R2 decision must not cite a discarded rep (resume filters these
            // out; the live set must agree or live and resumed traversals diverge)
            for (const k of [...successLedger]) if (k.startsWith(`${row.unit}|`)) successLedger.delete(k);
            // drift discovered at RUNTIME — possibly after resume restored earlier reps of this
            // unit as terminal. §4.4 discards the unit's collected reps and restarts the WHOLE
            // unit (medians never mix acquisition forms), so those restored positions must not
            // shield a suffix-only epilogue.
            for (const r of cfg.schedule!.rows) if (r.unit === row.unit) terminalPos.delete(r.pos);
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
  } finally {
    releaseLock();
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
      const searchErrors = searchEvidence.filter((s) => s["error"] !== undefined).length;
      if (!unified && searchErrors > 0)
        throw new Error(`C6 unification search did NOT complete: ${searchErrors} candidate(s) errored — an incomplete search must not be committed as the §4.2 exhausted-search contingency; re-run refresh-evidence`);
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
