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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  buildUnitWorkload, countReplacementChars, parseUnitWorkload, recordSelection, seamSha256, sha256Hex,
  type UnitWorkload, type WorkloadEntry,
} from "./benchWorkload.ts";
import { classifyFile } from "./cliScanner.ts";
import { parseLsTreeZ, type LsTreeEntry } from "./benchFrame.ts";
import { runBenchGit, type BenchSpawnRecord } from "./benchSpawn.ts";
import { makeBuckets, benchGraphqlDispatch, readRateLimit, type BenchGhContext } from "./benchGh.ts";
import { packBatches } from "./benchT1.ts";
import {
  BenchEngine, RunsLog, buildEnvManifest, computeWorstCase, planSegments,
} from "./benchProtocol.ts";
import { acquireStore, type DriverRunContext } from "./benchDrivers.ts";
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

// §4.2 candidates, in preference order — a failing candidate is SWAPPED, never forced.
const SLOT_CANDIDATES: Record<string, Array<{ owner: string; repo: string; branches: string[] }>> = {
  C1: [{ owner: "fastify", repo: "fastify", branches: ["main", "4.x", "3.x", "2.x", "1.x"] }],
  C2: [{ owner: "nodejs", repo: "undici", branches: ["main"] }],
  C3: [
    { owner: "NixOS", repo: "nixpkgs", branches: ["master"] },
    { owner: "home-assistant", repo: "core", branches: ["dev"] },
    { owner: "kubernetes", repo: "kubernetes", branches: ["master"] },
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
const C6_CLONE_CANDIDATES: Array<{ owner: string; repo: string; branch: string }> = [
  { owner: "git", repo: "git", branch: "master" },
  { owner: "PowerShell", repo: "PowerShell", branch: "master" },
  { owner: "fastify", repo: "fastify", branch: "main" },
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

async function pinPerformanceSlot(rt: PinRuntime, slotId: "C1" | "C2" | "C3" | "C4" | "C5"): Promise<PinnedSlotBundle> {
  for (const candidate of SLOT_CANDIDATES[slotId]!) {
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
        const blobs = first.ls.filter((e) => e.type === "blob");
        verdict = verifyC3({
          truncated, entryCount: blobs.length,
          pathByteSum: blobs.reduce((n, e) => n + Buffer.byteLength(e.path, "utf8"), 0),
          oidHexLength: format === "sha1" ? 40 : 64,
          deepEntryCount: blobs.filter((e) => e.path.split("/").length >= 6).length,
        });
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
  // 1) the M9 API-only symlink fixture — verify GitHub still serves the pinned facts
  const meta = (await rt.client.restGetJson(
    `repos/${M9.owner}/${M9.repo}/git/trees/${M9.sha}?recursive=1`,
  ).catch(() => null)) as { truncated?: boolean } | null;
  void meta; // node's tree is truncated; the entry facts are pinned from the ADR's M9 record
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
      if (slot.slot !== "C4" && workload.escapeTripped) {
        results.push({ unit: unit.unitId, skipped: "api-escape unit — clone drivers never acquire here" });
        continue;
      }
      const perForm: Record<string, { walls: number[]; tip: string; tree: string; closureSha256: string; inventorySha256: string }> = {};
      for (const form of ["production", "scaffolding"] as const) {
        for (const checkout of [true, false]) {
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
      const anomalies: string[] = [];
      for (const checkout of ["T2a", "T2c"]) {
        const prod = perForm[`production:${checkout}`]!;
        const scaf = perForm[`scaffolding:${checkout}`]!;
        if (prod.tip !== unit.sha || scaf.tip !== unit.sha) anomalies.push(`${checkout}: tip != pinned SHA`);
        if (prod.tree !== scaf.tree) anomalies.push(`${checkout}: tree oids differ across forms`);
        if (prod.closureSha256 !== scaf.closureSha256) anomalies.push(`${checkout}: reachable closures differ across forms`);
        const med = (w: number[]): number => [...w].sort((a, b) => a - b)[1]!;
        const delta = Math.abs(med(prod.walls) - med(scaf.walls)) / Math.max(1, Math.min(med(prod.walls), med(scaf.walls)));
        if (delta > 0.1) anomalies.push(`${checkout}: median wall delta ${(delta * 100).toFixed(1)}% > 10% — interpret scaffolding-form units with this bound in hand`);
      }
      if (anomalies.some((a) => a.includes("differ") || a.includes("tip"))) throw new Error(`acquisition diagnostics failed for ${unit.unitId}: ${anomalies.join("; ")}`);
      results.push({ unit: unit.unitId, forms: perForm, flags: anomalies });
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
    cfg, corpus, workloads, benchRoot, artifactsDir: ARTIFACTS, runsLog,
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
    const corpus: Corpus = {
      pinnedAtIso: new Date().toISOString(), pinnedByLogin: login,
      performance: bundles.map((b) => b.slot), fidelity,
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
    // §4.4 acquisition diagnostics ride the same pinning session
    const diagnostics = await acquisitionDiagnostics(rt, corpus, workloads);
    writeFileSync(join(ARTIFACTS, "acquisition-diagnostics.json"), `${JSON.stringify({ generatedAtIso: new Date().toISOString(), results: diagnostics }, null, 2)}\n`);
    log("acquisition-diagnostics.json written");
  } finally {
    rmSync(rt.benchRoot, { recursive: true, force: true });
  }
}

async function cmdBudget(): Promise<void> {
  const { cfg, corpus, workloads } = loadPinned();
  let totalCore = 0;
  let totalGraphql = 0;
  for (const slot of corpus.performance) {
    for (const unit of slot.units) {
      const w = workloads.get(unit.unitId)!;
      for (const driver of cfg.drivers) {
        const wc = computeWorstCase(driver, w, cfg, { owner: slot.owner, repo: slot.repo });
        const segments = planSegments(driver, w, cfg, { owner: slot.owner, repo: slot.repo });
        log(`${unit.unitId} ${driver}: WC core ${wc.core}, graphql ${wc.graphql}${segments.length > 1 ? ` (${segments.length} segments)` : ""}`);
        totalCore += wc.core * cfg.reps;
        totalGraphql += wc.graphql * cfg.reps;
      }
    }
  }
  log(`matrix worst-case total (× K=${cfg.reps}): core ${totalCore}, graphql ${totalGraphql} P_max-points`);
  log(`note: WORST-case reservation, not an estimate — actual spend is far lower (§4.8)`);
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

async function cmdMatrix(): Promise<void> {
  const { cfg } = loadPinned();
  if (!existsSync(RATIFICATION_PATH))
    throw new Error(`REFUSING: ${RATIFICATION_PATH} does not exist — §8 ratification (the four sign-off points) must be recorded before any timed matrix run (Step C)`);
  if (cfg.schedule === null) throw new Error("REFUSING: bench-config.json carries no pinned schedule (run pin-corpus first)");
  throw new Error("the timed matrix is Step C — this build stops at ratification (plan §6 row B); the traversal executor runs engine.runOne over cfg.schedule.rows with the R1–R6 taxonomy and is exercised by `pilot` until then");
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
    case "budget": return cmdBudget();
    case "pilot": return cmdPilot();
    case "matrix": return cmdMatrix();
    case "verify-corpus": return cmdVerifyCorpus();
    default:
      log("usage: bun run bench:content <pin-corpus | verify-corpus | budget | pilot | matrix>");
      process.exitCode = 2;
  }
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    log(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    process.exitCode = 1;
  });
}
