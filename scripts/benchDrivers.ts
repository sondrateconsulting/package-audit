// benchDrivers.ts — the four transport drivers (resolution plan §4.4), each the minimal
// faithful implementation of its option as evaluated in the ADR. Serial per-run (the matrix is
// a per-scenario serial cost profile, §4.6); every HTTP attempt rides benchGh's recorded layer;
// every git spawn rides benchSpawn's lane-gated single site. The PINNED workload matrix
// constrains every permitted route and its expected bytes; T1 additionally selects
// response-DISCOVERED routes (binary/truncated/validation/timeout/missing) through the frozen
// §4.4 transition table — never a discretionary post-hoc class.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertContained } from "./readOnlyGuard.ts";
import { parseTreeResponse } from "./github.ts";
import { walkClone } from "./orchestrate.ts";
import type { BenchConfig } from "./benchConfig.ts";
import type { CorpusUnit, PerformanceSlot } from "./benchCorpus.ts";
import { BatchChild, runBenchGit, type BatchChildDisposal, type BenchSpawnObserver } from "./benchSpawn.ts";
import { parseLsTreeZ, type LsTreeEntry } from "./benchFrame.ts";
import {
  BenchHttpError, benchRestGet, gitBlobOid, replayRank, type BenchGhContext,
} from "./benchGh.ts";
import {
  analyzeBatchResponse, buildBatchQuery, fivexxSplitConditionMet, packBatches, planRounds,
  splitEntries, type PlannedBatch,
} from "./benchT1.ts";
import { benchGraphqlDispatch } from "./benchGh.ts";
import { seamDecode, type RouteId, type UnitWorkload, type WorkloadEntry } from "./benchWorkload.ts";
import type { DriverId } from "./benchSchedule.ts";

// ---- terminal signals ------------------------------------------------------------------------
// A unit failure with cause (G2 territory) — recorded, never silently absorbed.
// A clean teardown is exit 0 with no protocol fault. `git cat-file --batch` closing normally
// exits 0; anything else — a non-zero code, or a child that never settled inside the bounded
// waits — means the read stream it served cannot be vouched for.
export function disposalIsClean(d: BatchChildDisposal): boolean {
  return d.protocolError === null && d.exitCode === 0;
}

// The batch child's teardown verdict, rendered for an operator: the fatal condition that poisoned
// it plus git's own retained stderr — the diagnosis that was previously captured and discarded.
export function describeDisposal(d: BatchChildDisposal): string {
  const tail = new TextDecoder().decode(d.stderrTail).trim().slice(0, 300);
  const dropped = d.stderrDroppedBytes > 0 ? ` (+${d.stderrDroppedBytes}B dropped)` : "";
  return [
    d.protocolError === null ? null : `protocol fault: ${d.protocolError}`,
    `exit ${d.exitCode === null ? "never settled" : d.exitCode}`,
    tail === "" ? null : `stderr: ${tail}${dropped}`,
  ].filter((s) => s !== null).join("; ");
}

export class UnitFailure extends Error {
  // NOT readonly, but only writable through annotateTeardown below: the engine records `cause2`
  // (not `message`), so evidence discovered during teardown must land HERE or it never reaches
  // runs.jsonl — a mutation of `message` alone is invisible to the record.
  private mutableCause: string;
  get cause2(): string {
    return this.mutableCause;
  }
  // when the terminal condition was HTTP-shaped (e.g. the circuit breaker tripped on repeated
  // no-response dispatches), the typed R1/R2 evidence survives the breaker (codex R2 f.14)
  readonly httpEvidence: { code: string; lastClassification: string | null; requestClass: string | null } | null;
  // when the terminal condition was a SETTLED network-shaped git-transport failure on one of the
  // three network-facing operations, the typed R1 evidence rides here (§4.5, amended 2026-08-02).
  // At most one of httpEvidence/gitEvidence is ever non-null: each throw site supplies its own
  // layer's evidence and no site observes both layers failing on one terminal condition.
  readonly gitEvidence: GitTransportEvidence | null;
  constructor(
    cause: string,
    httpEvidence: { code: string; lastClassification: string | null; requestClass: string | null } | null = null,
    gitEvidence: GitTransportEvidence | null = null,
  ) {
    super(`UNIT FAILURE: ${cause}`);
    this.name = "UnitFailure";
    this.mutableCause = cause;
    this.httpEvidence = httpEvidence;
    this.gitEvidence = gitEvidence;
  }
  /** Append teardown evidence found AFTER this was thrown — the batch child's disposal verdict,
   *  which is only available in the finally that runs on the way out. */
  annotateTeardown(note: string): void {
    this.mutableCause = `${this.mutableCause} — ${note}`;
    this.message = `UNIT FAILURE: ${this.mutableCause}`;
  }
}
// Confirmed upstream drift (R6 branch arm): the live head moved off the pinned SHA. The engine
// discards the unit's collected reps and restarts the whole unit on the scaffolding form.
export class DriftSignal extends Error {
  constructor(readonly liveHead: string) {
    super(`DRIFT: live head ${liveHead} moved off the pinned SHA`);
    this.name = "DriftSignal";
  }
}
// The pinned object itself is no longer served (R6 SHA arm): re-pin = a §8 freeze amendment.
export class RePinRequired extends Error {
  constructor(message: string) {
    super(`RE-PIN REQUIRED: ${message}`);
    this.name = "RePinRequired";
  }
}

export type AcquisitionForm = "production" | "scaffolding";

export interface EntryDelivery {
  path: string;
  route: RouteId;
  delivered: string | null; // null = verified non-acquisition (no-read routes)
  rawVerified: boolean | null; // pre-decode bytes hashed against the tree oid (raw-capable drivers)
}

export interface DriverRunOutcome {
  deliveries: EntryDelivery[];
  fallbackSpend: number;
  // NB no body-byte figure here: the record derives httpBodyBytes from the attempt records
  // (summarizeTraffic), and the drivers' own in-wall UTF-8 re-scans were dead work that taxed
  // API drivers O(body) per response while clone drivers paid nothing
  acquiredPaths: ReadonlySet<string>; // content-acquisition events, for no-read verification
  cloneDir: string | null; // engine measures on-disk object-store bytes + reclaims
  acquisitionForm: AcquisitionForm | null;
}

export interface DriverRunContext {
  cfg: BenchConfig;
  slot: PerformanceSlot;
  unit: CorpusUnit;
  workload: UnitWorkload;
  gh: BenchGhContext;
  benchRoot: string;
  runDir: string;
  gitEnv: Record<string, string>; // sanitized, pinned gitconfig (baseline or the probe's), GIT_NO_REPLACE_OBJECTS=1
  spawnObserver: BenchSpawnObserver;
  acquisitionForm: AcquisitionForm;
  fallbackBudget: number;
  // live progress mirror the ENGINE reads when the driver throws — fallback spend, delivered
  // routes, and the acquired clone dir survive a unit failure instead of flattening to
  // zero/null (codex R3 f.9; the cloneDir addition lets a post-acquisition failure still
  // measure the store it actually cloned)
  liveState?: { fallbackSpend: number; routesDelivered: Record<string, number>; cloneDir?: string | null; t1Conflicts?: number; t1BodyTimeouts?: number };
  // §4.8 segmented mode (per-file REST shapes only): the read loop is chunked into the pinned
  // segment sizes and the engine's gate runs BETWEEN segments (clock paused, bucket re-reserved,
  // per-segment deltas summed). Absent = single-segment run.
  segments?: { sizes: readonly number[]; gate: (nextSegmentIndex: number) => Promise<void> };
}

// ---- shared plumbing -------------------------------------------------------------------------
function contentsEndpoint(ctx: DriverRunContext, path: string): string {
  const enc = path.split("/").map(encodeURIComponent).join("/");
  return `repos/${encodeURIComponent(ctx.slot.owner)}/${encodeURIComponent(ctx.slot.repo)}/contents/${enc}?ref=${encodeURIComponent(ctx.unit.sha)}`;
}

interface RunState {
  deliveries: EntryDelivery[];
  fallbackSpend: number;
  // every path whose CONTENT the run acquired, by any route/transport — §4.3's no-read
  // verification asserts zero events for skip routes (codex R1 finding 20)
  acquiredPaths: Set<string>;
  live?: DriverRunContext["liveState"];
}

function deliver(st: RunState, d: EntryDelivery): void {
  st.deliveries.push(d);
  if (st.live !== undefined) st.live.routesDelivered[d.route] = (st.live.routesDelivered[d.route] ?? 0) + 1;
}

// One REST content read at the pinned SHA. A 404 on a tree-listed path is never benign here:
// the form-aware SHA classifier decides (§4.4) — pinned object gone → re-pin (freeze
// amendment); still served → unexpected-absence unit failure.
async function restRead(ctx: DriverRunContext, st: RunState, entry: WorkloadEntry, route: RouteId, cls: "rest-content" | "rest-fallback"): Promise<void> {
  if (cls === "rest-fallback") {
    st.fallbackSpend++;
    if (st.live !== undefined) st.live.fallbackSpend = st.fallbackSpend;
    if (st.fallbackSpend > ctx.fallbackBudget) throw new UnitFailure(`REST fallback budget (${ctx.fallbackBudget}) exhausted at ${entry.path}`);
  }
  let body: string;
  try {
    const res = await benchRestGet(ctx.gh, {
      endpoint: contentsEndpoint(ctx, entry.path),
      accept: ctx.cfg.rest.rawAccept,
      immutable: true,
      requestClass: cls,
    });
    body = res.body;
  } catch (e) {
    if (e instanceof BenchHttpError && e.status === 404) {
      await classifyPinnedObjectAbsence(ctx, `tree-listed ${entry.path} returned 404`);
      throw new UnitFailure(`unexpected absence: ${entry.path} 404s while the pinned commit is still served`);
    }
    throw e;
  }
  st.acquiredPaths.add(entry.path);
  deliver(st, { path: entry.path, route, delivered: body, rawVerified: null });
}

// The SHA-pinned-context classifier (§4.4): probe the pinned object itself. This is a
// CONSUMING core request the §4.8 worst case reserves explicitly ("one SHA-classifier
// attempt-loop allowance") — its class must count as driver traffic, or its own consumption
// reads as R3 foreign interference (it was previously labeled rest-meta and excluded).
async function classifyPinnedObjectAbsence(ctx: DriverRunContext, what: string): Promise<void> {
  try {
    await benchRestGet(ctx.gh, {
      endpoint: `repos/${encodeURIComponent(ctx.slot.owner)}/${encodeURIComponent(ctx.slot.repo)}/commits/${encodeURIComponent(ctx.unit.sha)}`,
      requestClass: "rest-classifier",
    });
  } catch (e) {
    if (e instanceof BenchHttpError && e.status === 404)
      throw new RePinRequired(`${what}; the pinned commit ${ctx.unit.sha} is no longer served`);
    throw e;
  }
}

function pushNoReads(ctx: DriverRunContext, st: RunState): void {
  for (const entry of ctx.workload.entries) {
    if (entry.read) continue;
    deliver(st, { path: entry.path, route: entry.noReadReason!, delivered: null, rawVerified: null });
  }
}

// ---- §4.5 typed git-transport evidence (amended 2026-08-02) ----------------------------------
// The network-facing subset of a SETTLED git-transport failure, typed so the frozen R1 predicate
// can read it (evidenceIsRerunnable) instead of leaving every git-transport failure a permanent
// {kind:"unit"} driver disqualification. STRICT SCOPE, fail-closed: only the three operations
// below, only a settled child (the harness's synthetic deadline exit 124, or git's fatal exit
// 128), and for 128 only a stderr matching the frozen network patterns. An HTTP-status-bearing
// git failure is EXCLUDED FIRST — a secondary-limit 403 over the git transport prints
// "The requested URL returned error: 403", and §4.5 forbids secondary/budget conditions from
// ever becoming replayable. A child that never settles takes the generic harness-error arm and
// stays outside this variant (the amendment narrows the untyped gap; it does not close it).
export type GitTransportOp = "clone" | "scaffold-fetch" | "ls-remote-probe";
export type GitTransportNetworkClass = "timeout" | "dns" | "tls" | "connect" | "reset";
export interface GitTransportEvidence {
  op: GitTransportOp;
  exitCode: number;
  networkClass: GitTransportNetworkClass;
}

// Frozen pattern sets, matched case-insensitively against the settled child's stderr. Literal
// substrings, no regexes: every entry is auditable against the git/curl message it names.
const GIT_HTTP_STATUS_BEARING: readonly string[] = ["the requested url returned error", "rpc failed; http"];
const GIT_NETWORK_PATTERNS: ReadonlyArray<{ networkClass: GitTransportNetworkClass; needles: readonly string[] }> = [
  { networkClass: "dns", needles: ["could not resolve host", "couldn't resolve host", "name or service not known", "temporary failure in name resolution", "no address associated with hostname"] },
  { networkClass: "tls", needles: ["ssl connect error", "ssl_connect", "ssl_read", "ssl_write", "ssl handshake", "gnutls_handshake", "ssl certificate problem", "server certificate verification failed", "unable to get local issuer certificate"] },
  { networkClass: "connect", needles: ["failed to connect", "couldn't connect to server", "connection refused", "connection timed out", "operation timed out", "network is unreachable", "no route to host"] },
  { networkClass: "reset", needles: ["connection reset", "recv failure", "send failure", "remote end hung up unexpectedly", "early eof", "unexpected disconnect while reading sideband packet", "transfer closed with outstanding read data remaining"] },
];

export function classifyGitTransportFailure(
  op: GitTransportOp,
  res: { exitCode: number; timedOut: boolean; stderr: Uint8Array },
): GitTransportEvidence | null {
  if (res.timedOut && res.exitCode === 124) return { op, exitCode: 124, networkClass: "timeout" };
  if (res.exitCode !== 128) return null;
  const stderr = new TextDecoder("utf-8", { fatal: false }).decode(res.stderr).toLowerCase();
  // status-bearing failures are excluded BEFORE any positive match: a 5xx mid-pack can print a
  // reset-class curl detail beside its status line, and the status is the governing shape
  for (const needle of GIT_HTTP_STATUS_BEARING) if (stderr.includes(needle)) return null;
  for (const group of GIT_NETWORK_PATTERNS) {
    for (const needle of group.needles) {
      if (stderr.includes(needle)) return { op, exitCode: 128, networkClass: group.networkClass };
    }
  }
  return null; // unrecognised stderr fails closed: no evidence, no rerun
}

// ---- acquisition (§4.4: production argv by default, SHA-pinned scaffolding on drift) ---------
// Scaffolding argv is DERIVED inside runBenchGit from the config-pinned tuple + slots (the lane
// carries both) — this module never hand-builds a scaffolding vector, so the pinned tuple is the
// single source. The previous shape had callers substitute the tuple themselves and pass the
// result as BOTH argv and expectArgv, which made the lane's "must equal the pinned tuple" gate a
// self-comparison that could never fail.

export function parseLsRemoteProbe(stdout: Uint8Array, branch: string, oidLength: number): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(stdout);
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length !== 1) throw new UnitFailure(`ls-remote probe returned ${lines.length} lines, expected exactly 1`);
  const [oid, ref] = lines[0]!.split("\t");
  if (ref !== `refs/heads/${branch}`) throw new UnitFailure(`ls-remote probe ref ${JSON.stringify(ref)} is not refs/heads/${branch}`);
  if (oid === undefined || oid.length !== oidLength || !/^[0-9a-f]+$/.test(oid))
    throw new UnitFailure(`ls-remote probe oid is not a full ${oidLength}-hex object id`);
  return oid;
}

// Probe the live head (scaffolding lane; outside any timed window). The engine probes before a
// unit's FIRST clone-involving rep and before each later PRODUCTION-form one; once a unit's form
// is frozen as scaffolding (first probe drifted, or a mid-unit drift restart), later reps are
// SHA-pinned and need no probe. Advisory only: every acquisition still ends with an in-store
// coherence assertion.
export async function probeLiveHead(ctx: Pick<DriverRunContext, "cfg" | "slot" | "unit" | "benchRoot" | "gitEnv" | "spawnObserver">): Promise<string> {
  const url = `https://${ctx.cfg.githubHost}/${encodeURIComponent(ctx.slot.owner)}/${encodeURIComponent(ctx.slot.repo)}.git`;
  const res = await runBenchGit({
    lane: { lane: "scaffolding", tuple: ctx.cfg.scaffolding.tuples.lsRemoteProbe, slots: { url, branch: ctx.unit.branch } },
    env: ctx.gitEnv, benchRoot: ctx.benchRoot,
    limits: { maxStdoutBytes: 1024 * 1024, maxStderrBytes: 1024 * 1024, deadlineMs: ctx.cfg.spawn.timeoutMs },
    onRecord: ctx.spawnObserver,
  });
  if (res.exitCode !== 0)
    throw new UnitFailure(`ls-remote probe failed: ${seamDecode(res.stderr).trim().slice(0, 300)}`, null, classifyGitTransportFailure("ls-remote-probe", res));
  return parseLsRemoteProbe(res.stdout, ctx.unit.branch, ctx.slot.objectFormat === "sha1" ? 40 : 64);
}

async function transportGit(ctx: DriverRunContext, argv: string[], opts: { cwd?: string; cloneShape?: "checkout" | "no-checkout"; maxStdoutBytes?: number }): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array; timedOut: boolean }> {
  return runBenchGit({
    argv,
    lane: { lane: "transport", objectFormat: ctx.slot.objectFormat, ...(opts.cloneShape === undefined ? {} : { cloneShape: opts.cloneShape }) },
    env: ctx.gitEnv, benchRoot: ctx.benchRoot, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    limits: { maxStdoutBytes: opts.maxStdoutBytes ?? 4 * 1024 * 1024, maxStderrBytes: 1024 * 1024, deadlineMs: ctx.cfg.spawn.timeoutMs },
    onRecord: ctx.spawnObserver,
  });
}

async function scaffoldGit(ctx: DriverRunContext, tuple: readonly string[], slots: Record<string, string>, cwd?: string): Promise<void> {
  const res = await runBenchGit({
    lane: { lane: "scaffolding", tuple, slots }, env: ctx.gitEnv, benchRoot: ctx.benchRoot,
    ...(cwd === undefined ? {} : { cwd }),
    limits: { maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 1024 * 1024, deadlineMs: ctx.cfg.spawn.timeoutMs },
    onRecord: ctx.spawnObserver,
  });
  if (res.exitCode !== 0) {
    // a FAILED SHA-pinned fetch runs the pinned-object classifier (§4.4): the frozen SHA no
    // longer served → the R6 SHA arm (re-pin, a freeze amendment), never a generic driver
    // failure (codex R1 finding 19). Only the fetch is network-facing, so only it may carry
    // §4.5's typed git-transport evidence — the local tuples (init/remote-add/checkout) never do.
    if (tuple[0] === "fetch") await classifyPinnedObjectAbsence(ctx, `scaffolding fetch of ${ctx.unit.sha} failed`);
    throw new UnitFailure(
      `scaffolding ${tuple[0]} failed: ${seamDecode(res.stderr).trim().slice(0, 300)}`,
      null,
      tuple[0] === "fetch" ? classifyGitTransportFailure("scaffold-fetch", res) : null,
    );
  }
}

// Acquire the unit's store into runDir/clone. Ends with the coherence assertion; failure
// classification is form-aware (§4.4): production form re-probes the LIVE HEAD (moved → R6
// branch-arm drift; unmoved → driver failure); scaffolding form probes the PINNED OBJECT
// (gone → re-pin; served → a harness bug, since git semantics pin FETCH_HEAD to the fetch).
export async function acquireStore(ctx: DriverRunContext, opts: { checkout: boolean }): Promise<{ dir: string; headRev: "HEAD" | "FETCH_HEAD" }> {
  const dir = join(ctx.runDir, "clone");
  assertContained(dir, [ctx.benchRoot]);
  const url = `https://${ctx.cfg.githubHost}/${encodeURIComponent(ctx.slot.owner)}/${encodeURIComponent(ctx.slot.repo)}.git`;
  if (ctx.acquisitionForm === "production") {
    const argv = [
      "clone", "--depth", "1", "--single-branch", "--branch", ctx.unit.branch,
      "--no-tags", "--no-recurse-submodules", "--template=",
      ...(opts.checkout ? [] : ["--no-checkout"]), url, dir,
    ];
    const res = await transportGit(ctx, argv, { cloneShape: opts.checkout ? "checkout" : "no-checkout" });
    if (res.exitCode !== 0)
      throw new UnitFailure(`clone failed: ${seamDecode(res.stderr).trim().slice(0, 300)}`, null, classifyGitTransportFailure("clone", res));
    // mirrored the moment the store EXISTS: the coherence checks below are fallible, and a
    // post-clone failure must still let the engine measure the store it actually acquired
    if (ctx.liveState !== undefined) ctx.liveState.cloneDir = dir;
    const rev = await transportGit(ctx, ["rev-parse", "HEAD"], { cwd: dir });
    const head = seamDecode(rev.stdout).trim();
    if (rev.exitCode !== 0 || head !== ctx.unit.sha) {
      const live = await probeLiveHead(ctx);
      if (live !== ctx.unit.sha) throw new DriftSignal(live);
      throw new UnitFailure(`coherence failure: clone HEAD ${head.slice(0, 12)} != pinned SHA while the live head is unmoved`);
    }
    return { dir, headRev: "HEAD" };
  }
  // scaffolding form: init --object-format → remote add → fetch <sha> → optional detach checkout
  const t = ctx.cfg.scaffolding.tuples;
  await scaffoldGit(ctx, t.init, { objectFormat: ctx.slot.objectFormat, dest: dir });
  if (ctx.liveState !== undefined) ctx.liveState.cloneDir = dir; // the store exists from init on
  await scaffoldGit(ctx, t.remoteAdd, { url }, dir);
  await scaffoldGit(ctx, t.fetch, { sha: ctx.unit.sha }, dir);
  if (opts.checkout) await scaffoldGit(ctx, t.checkoutDetach, {}, dir);
  const rev = await transportGit(ctx, ["rev-parse", "FETCH_HEAD"], { cwd: dir });
  const head = seamDecode(rev.stdout).trim();
  if (rev.exitCode !== 0 || head !== ctx.unit.sha) {
    await classifyPinnedObjectAbsence(ctx, `scaffolding coherence failure (FETCH_HEAD ${head.slice(0, 12)})`);
    throw new UnitFailure("scaffolding coherence mismatch while the pinned object is still served — a harness bug by git semantics");
  }
  return { dir, headRev: "FETCH_HEAD" };
}

async function enumerateStore(ctx: DriverRunContext, dir: string, headRev: "HEAD" | "FETCH_HEAD"): Promise<Map<string, LsTreeEntry>> {
  // production form addresses HEAD; the SHA-pinned scaffolding form addresses the pinned SHA
  // itself (a bare fetch leaves no HEAD, §4.4).
  const rev = headRev === "HEAD" ? "HEAD" : ctx.unit.sha;
  const res = await transportGit(ctx, ["ls-tree", "-r", "-z", "-l", "--full-tree", rev], {
    cwd: dir, maxStdoutBytes: ctx.cfg.lsTree.maxOutputBytes,
  });
  if (res.exitCode !== 0) throw new UnitFailure(`ls-tree failed: ${seamDecode(res.stderr).trim().slice(0, 300)}`);
  const entries = parseLsTreeZ(res.stdout, ctx.slot.objectFormat, {
    maxEntries: ctx.cfg.lsTree.maxEntries, maxRecordBytes: ctx.cfg.lsTree.maxRecordBytes,
  });
  return new Map(entries.map((e) => [e.path, e]));
}

function readCheckoutDelivery(ctx: DriverRunContext, cloneDir: string, st: RunState, entry: WorkloadEntry, route: RouteId): void {
  const abs = join(cloneDir, entry.path);
  assertContained(abs, [cloneDir]);
  const bytes = readFileSync(abs);
  st.acquiredPaths.add(entry.path);
  deliver(st, { path: entry.path, route, delivered: seamDecode(bytes), rawVerified: null });
}

// ---- the REST tree fetch T0/T1 pay — and an api-escaped T2a, which runs full T0 semantics
// ---- (§4.6: tree acquisition counts toward units) --------------------------------------------
async function fetchRestTree(ctx: DriverRunContext, st: RunState): Promise<{ truncated: boolean }> {
  const endpoint = `repos/${encodeURIComponent(ctx.slot.owner)}/${encodeURIComponent(ctx.slot.repo)}/git/trees/${encodeURIComponent(ctx.unit.treeOid)}?recursive=1`;
  let res: { body: string };
  try {
    res = await benchRestGet(ctx.gh, { endpoint, immutable: true, requestClass: "rest-tree" });
  } catch (e) {
    // the tree endpoint is SHA-pinned like every other pinned read: a 404 runs the §4.4
    // pinned-object classifier — object gone → the R6 SHA arm (re-pin, a freeze amendment),
    // never an ordinary non-rerunnable unit failure
    if (e instanceof BenchHttpError && e.status === 404) {
      await classifyPinnedObjectAbsence(ctx, `pinned tree ${ctx.unit.treeOid} returned 404`);
      throw new UnitFailure(`unexpected absence: the pinned tree 404s while the pinned commit is still served`);
    }
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new UnitFailure(`invalid JSON tree from ${endpoint}`);
  }
  const tree = parseTreeResponse(json, endpoint, ctx.unit.treeOid);
  return { truncated: tree.truncated };
}

// C4's production fallback for T0/T1: checkout clone + read every read-entry from the working
// tree (route truncated-tree-checkout, the declared-caveat route).
async function runTruncatedCheckout(ctx: DriverRunContext, st: RunState): Promise<string> {
  const { dir } = await acquireStore(ctx, { checkout: true });
  // §4.2 defines the C4 comparison as "{REST tree attempt + checkout clone + WALK}": production
  // enumerates the whole checkout recursively (orchestrate's walkClone — lstat over every
  // entry) before any read, and skipping that walk here understated T0/T1's fallback cost by
  // exactly the tree-scale term the truncated slot exists to exercise. The walk's entry list
  // also guards the pinned read set: a pinned path absent from the live checkout is the same
  // coherence condition the untruncated drivers fail on.
  const walked = new Set(walkClone(dir).map((e) => e.path));
  for (const entry of ctx.workload.entries) {
    if (!entry.read) continue;
    if (!walked.has(entry.path)) throw new UnitFailure(`checkout walk omits pinned entry ${entry.path}`);
    readCheckoutDelivery(ctx, dir, st, entry, "truncated-tree-checkout");
  }
  return dir;
}

// ---- T0 --------------------------------------------------------------------------------------
export async function runT0(ctx: DriverRunContext): Promise<DriverRunOutcome> {
  const st: RunState = { deliveries: [], fallbackSpend: 0, acquiredPaths: new Set(), live: ctx.liveState };
  pushNoReads(ctx, st);
  let cloneDir: string | null = null;
  const tree = await fetchRestTree(ctx, st);
  if (tree.truncated !== ctx.workload.truncatedTree)
    throw new UnitFailure(`live tree truncation (${tree.truncated}) disagrees with the pinned workload (${ctx.workload.truncatedTree})`);
  if (tree.truncated) {
    cloneDir = await runTruncatedCheckout(ctx, st);
  } else {
    await segmentedRestReads(ctx, st, "primary", "rest-content");
  }
  return { deliveries: st.deliveries, fallbackSpend: st.fallbackSpend, acquiredPaths: st.acquiredPaths, cloneDir, acquisitionForm: cloneDir === null ? null : ctx.acquisitionForm };
}

// the per-file REST loop, chunked into the pinned segments when the engine supplies them
async function segmentedRestReads(ctx: DriverRunContext, st: RunState, route: RouteId, cls: "rest-content" | "rest-fallback"): Promise<void> {
  const reads = ctx.workload.entries.filter((e) => e.read);
  const sizes = ctx.segments?.sizes ?? [reads.length];
  let at = 0;
  for (let seg = 0; seg < sizes.length; seg++) {
    if (seg > 0) await ctx.segments!.gate(seg);
    const slice = reads.slice(at, at + sizes[seg]!);
    at += sizes[seg]!;
    for (const entry of slice) await restRead(ctx, st, entry, route, cls);
  }
  if (at !== reads.length) throw new UnitFailure(`segment sizes cover ${at} reads, workload has ${reads.length}`);
}

// ---- T1 --------------------------------------------------------------------------------------
export async function runT1(ctx: DriverRunContext): Promise<DriverRunOutcome> {
  const st: RunState = { deliveries: [], fallbackSpend: 0, acquiredPaths: new Set(), live: ctx.liveState };
  pushNoReads(ctx, st);
  let cloneDir: string | null = null;
  const tree = await fetchRestTree(ctx, st);
  if (tree.truncated !== ctx.workload.truncatedTree)
    throw new UnitFailure(`live tree truncation (${tree.truncated}) disagrees with the pinned workload (${ctx.workload.truncatedTree})`);
  if (tree.truncated) {
    cloneDir = await runTruncatedCheckout(ctx, st);
    return { deliveries: st.deliveries, fallbackSpend: st.fallbackSpend, acquiredPaths: st.acquiredPaths, cloneDir, acquisitionForm: ctx.acquisitionForm };
  }
  const plan = planRounds(ctx.workload);
  for (const { entry, route } of plan.preRouted) {
    await restRead(ctx, st, entry, route as RouteId, "rest-fallback");
  }
  let consecutiveFailedDispatches = 0; // the unit-level circuit breaker (§4.4)
  // A breaker verdict must never be MORE replayable than the least replayable dispatch in its
  // streak. The throw previously carried only the LAST dispatch's evidence, so a streak of
  // {RATE_LIMITED, closed default, status 0} surfaced as bare "no-response" and bought an
  // unconditional R1 replay — laundering both a secondary-limit signal (§4.5: "not replayable
  // under any category") and a closed-default condition. A safe/unsafe BOOLEAN was not enough
  // either: R1 and R2 are both admitted but not interchangeable, so {transient, transient,
  // status 0} still escaped the R2 ledger gate. Both are sticky across the streak and cleared
  // only where the counter is (a per-alias result).
  let streakPoisoned = false; // a member §4.5 never replays — the whole verdict carries no evidence
  let streakWeakest: { code: string; lastClassification: string | null } | null = null; // least replayable member so far
  const dispatchChain = async (original: PlannedBatch): Promise<void> => {
    let attempts = 0;
    let descendants = 0;
    let consecutive5xx = 0;
    interface QueueItem { entries: WorkloadEntry[]; depth: number; retriedUnattributed?: boolean }
    const queue: QueueItem[] = [{ entries: original.entries, depth: 0 }];
    const toFallback = async (entries: WorkloadEntry[], route: RouteId): Promise<void> => {
      for (const e of entries) await restRead(ctx, st, e, route, "rest-fallback");
    };
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (attempts >= ctx.cfg.rest.attemptCap) {
        // dispatches exhausted without a terminal unit event → surviving aliases to
        // batch-error-fallback, each counted against the budget (§4.4)
        await toFallback(item.entries, "batch-error-fallback");
        continue;
      }
      const batch = buildBatchQuery(item.entries, {
        owner: ctx.slot.owner, repo: ctx.slot.repo, sha: ctx.unit.sha,
        aliasSelection: ctx.cfg.t1.aliasSelection, rateLimitRider: ctx.cfg.t1.rateLimitRider,
        label: `${original.label}@d${item.depth}`,
      });
      attempts++;
      const d = await benchGraphqlDispatch(ctx.gh, batch.query, batch.fields, batch.label, attempts);
      const analysis = analyzeBatchResponse(d, batch, ctx.slot.objectFormat, ctx.cfg);
      // §4.4 requires a unit failure to carry "the raw condition recorded" — the breaker throw
      // must not discard the last analysis's condition (it previously fired BEFORE the
      // rawCondition-bearing default-failure throw could).
      const failedDispatch = (evidence: { code: string; lastClassification: string | null } | null = null, lastCondition: string | null = null): void => {
        consecutiveFailedDispatches++;
        // keep the WEAKEST member's own evidence, not merely a safe/unsafe verdict: R2 is
        // ledger-gated and R1 is not, so a streak that contained a transient 5xx must surface as
        // transient even when its final dispatch was a no-response
        const rank = replayRank(evidence?.lastClassification);
        if (rank === 0 || evidence === null) streakPoisoned = true;
        else if (streakWeakest === null || rank < replayRank(streakWeakest.lastClassification)) streakWeakest = evidence;
        if (consecutiveFailedDispatches >= ctx.cfg.t1.circuitBreakerConsecutiveFailedDispatches) {
          const carried = streakPoisoned || streakWeakest === null ? null : { ...streakWeakest, requestClass: "graphql-batch" };
          throw new UnitFailure(
            `circuit breaker: ${consecutiveFailedDispatches} consecutive failed dispatches${lastCondition === null ? "" : ` (last: ${lastCondition.slice(0, 200)})`}` +
              (carried === null ? " — the streak contained a condition §4.5 does not replay; no rerunnable evidence is carried" : ""),
            carried,
          );
        }
      };
      const canSplit = (q: QueueItem): boolean =>
        q.entries.length >= 2 && q.depth < ctx.cfg.t1.split.maxDepth &&
        descendants + 2 <= ctx.cfg.t1.split.maxDescendantsPerOriginal;
      const enqueueSplit = (q: QueueItem): void => {
        const [a, b] = splitEntries(q.entries);
        descendants += 2;
        queue.unshift({ entries: b, depth: q.depth + 1 });
        queue.unshift({ entries: a, depth: q.depth + 1 });
      };
      // a backoff sleep is only ever the PREFACE to a retry; once the attempt budget is spent
      // the next loop iteration drains the item to its fallback, and sleeping first would charge
      // driver-correlated idle to the scored wall for a dispatch that can never happen
      const retryRemains = attempts < ctx.cfg.rest.attemptCap;
      if (analysis.kind === "http-failure") {
        // R2's evidence is 5xx-only (plan §4.5): a 200 whose body is not a JSON OBJECT is NOT a
        // rerunnable shape (codex R4). The recorded token stays the terse "non-json" — it is a
        // durable evidence string in committed rows, and evidenceIsRerunnable rejects it by
        // exclusion either way. SECONDARY SHAPE OUTRANKS THE STATUS: analyzeBatchResponse
        // takes its HTTP-level branch before the throttle arms, so a 5xx carrying a RATE_LIMITED
        // body (or classified secondary) arrives here too — deriving the label from the status
        // alone relabelled it "transient" and made it R2-rerunnable, which §4.5 ("secondary-limit
        // signals are not replayable under any category") and evidenceIsRerunnable's own contract
        // both forbid. PRIMARY is deliberately NOT rerouted: an exhausted-window 5xx stays
        // "transient" so a budget condition cannot permanently disqualify the driver.
        failedDispatch({
          code: d.status === 0 ? "no-response" : "http-failure",
          lastClassification: d.status === 0 ? "no-response" : d.secondaryLike ? "secondary" : d.status >= 500 ? "transient" : "non-json",
        }, analysis.rawCondition);
        consecutive5xx = analysis.fivexxSplitCandidate ? consecutive5xx + 1 : 0;
        if (fivexxSplitConditionMet(batch, consecutive5xx, ctx.cfg) && canSplit(item)) enqueueSplit(item);
        else {
          // zero-based like production's backoffWait (github.ts): `attempts` was already
          // incremented for THIS dispatch, so 2**attempts doubled every wait relative to the
          // production design T1 is supposed to reproduce — pure scored-wall inflation
          if (retryRemains) await ctx.gh.sleep(ctx.cfg.rest.transientBaseWaitMs * 2 ** Math.min(attempts - 1, 5));
          queue.unshift(item); // bounded transient retry — never split on first failure
        }
        continue;
      }
      consecutive5xx = 0;
      if (analysis.kind === "throttle-retry") {
        failedDispatch(null, `throttle ${analysis.cause}`);
        // NO explicit sleep for any throttle cause: benchGraphqlDispatch already armed the
        // bucket horizon (Retry-After when given, the secondary base otherwise), and the next
        // dispatch's waitBucket honours exactly that — production's lease discipline. A fixed
        // sleep HERE double-waited on top of the horizon and overrode a short Retry-After
        // (e.g. 1 s) with the full 60 s base, inflating T1's scored wall.
        queue.unshift(item);
        continue;
      }
      if (analysis.kind === "batch-timeout") {
        if (st.live?.t1BodyTimeouts !== undefined) st.live.t1BodyTimeouts += 1;
        failedDispatch(null, "batch-timeout");
        if (item.entries.length === 1) await toFallback(item.entries, "timeout-singleton");
        else if (canSplit(item)) enqueueSplit(item);
        else queue.unshift(item);
        continue;
      }
      if (analysis.kind === "default-failure") {
        failedDispatch(null, analysis.rawCondition);
        if (attempts >= ctx.cfg.rest.attemptCap)
          throw new UnitFailure(`default-clause response persisted through the attempt budget: ${analysis.rawCondition}`);
        queue.unshift(item);
        continue;
      }
      // per-alias
      consecutiveFailedDispatches = 0;
      streakPoisoned = false; // a delivered result ends the streak, so its poison ends with it
      streakWeakest = null;
      // §4.4's "the conflict recorded" and the alias-timeout events were computed by the
      // analyzer and then dropped here — they now land in the run record via the live mirror
      if (st.live !== undefined) {
        st.live.t1Conflicts = (st.live.t1Conflicts ?? 0) + analysis.conflicts.length;
        st.live.t1BodyTimeouts = (st.live.t1BodyTimeouts ?? 0) + analysis.outcomes.filter((o) => o.kind === "timeout").length;
      }
      const timeouts: WorkloadEntry[] = [];
      const unattributed: WorkloadEntry[] = [];
      for (const outcome of analysis.outcomes) {
        const entry = batch.entries[outcome.index]!;
        if (outcome.kind === "resolved") {
          st.acquiredPaths.add(entry.path);
          deliver(st, { path: entry.path, route: "primary", delivered: outcome.text, rawVerified: true });
        } else if (outcome.kind === "binary-fallback" || outcome.kind === "truncated-blob-fallback") {
          // OBSERVED routing states (never pre-routed from pins) → REST, counted
          await restRead(ctx, st, entry, outcome.kind, "rest-fallback");
        } else if (outcome.kind === "validation-fallback") {
          await restRead(ctx, st, entry, "validation-fallback", "rest-fallback");
        } else if (outcome.kind === "timeout") {
          timeouts.push(entry);
        } else if (outcome.kind === "missing") {
          // restRead's 404 path runs the SHA-form classifier (§4.4): re-pin vs unexpected-absence
          await restRead(ctx, st, entry, "missing-alias-fallback", "rest-fallback");
        } else {
          unattributed.push(entry);
        }
      }
      if (timeouts.length === 1) await toFallback(timeouts, "timeout-singleton");
      else if (timeouts.length >= 2) {
        const q: QueueItem = { entries: timeouts, depth: item.depth };
        if (canSplit(q)) enqueueSplit(q);
        else queue.unshift(q);
      }
      if (unattributed.length > 0) {
        if (item.retriedUnattributed !== true) {
          // one batch-level retry PER ITEM, then missing-alias-fallback (§4.4)
          queue.unshift({ entries: unattributed, depth: item.depth, retriedUnattributed: true });
        } else {
          await toFallback(unattributed, "missing-alias-fallback");
        }
      }
    }
  };
  for (const round of [plan.round1, plan.round2]) {
    if (round.length === 0) continue; // either round can legitimately be empty (ADR)
    for (const batch of packBatches(round, ctx.cfg, { owner: ctx.slot.owner, repo: ctx.slot.repo, sha: ctx.unit.sha, roundLabel: round === plan.round1 ? "r1" : "r2" })) {
      await dispatchChain(batch);
    }
  }
  return { deliveries: st.deliveries, fallbackSpend: st.fallbackSpend, acquiredPaths: st.acquiredPaths, cloneDir: null, acquisitionForm: null };
}

// ---- T2a -------------------------------------------------------------------------------------
export async function runT2a(ctx: DriverRunContext): Promise<DriverRunOutcome> {
  const st: RunState = { deliveries: [], fallbackSpend: 0, acquiredPaths: new Set(), live: ctx.liveState };
  pushNoReads(ctx, st);
  if (ctx.workload.escapeTripped && !ctx.workload.truncatedTree) {
    // the size-based api-escape resolves with FULL T0 semantics (§4.4): the REST tree request
    // and its truncation decision are part of the option's cost — omitting them would bias
    // T2a's escape runs (codex R1 finding 12). The pinned workload says untruncated; a live
    // disagreement is the same coherence failure T0 raises.
    const tree = await fetchRestTree(ctx, st);
    if (tree.truncated !== ctx.workload.truncatedTree)
      throw new UnitFailure(`live tree truncation (${tree.truncated}) disagrees with the pinned workload (${ctx.workload.truncatedTree})`);
    await segmentedRestReads(ctx, st, "api-escape", "rest-content");
    return { deliveries: st.deliveries, fallbackSpend: st.fallbackSpend, acquiredPaths: st.acquiredPaths, cloneDir: null, acquisitionForm: null };
  }
  const { dir, headRev } = await acquireStore(ctx, { checkout: true });
  const lsIndex = await enumerateStore(ctx, dir, headRev);
  for (const entry of ctx.workload.entries) {
    if (!entry.read) continue;
    const ls = lsIndex.get(entry.path);
    if (ls === undefined) throw new UnitFailure(`ls-tree omits pinned entry ${entry.path}`);
    if (ls.oid !== entry.blobOid) throw new UnitFailure(`ls-tree oid disagrees with the pinned workload at ${entry.path}`);
    if (ls.mode === "120000") {
      await restRead(ctx, st, entry, "symlink-fallback", "rest-fallback"); // mode-routed, REST-deref parity
    } else {
      readCheckoutDelivery(ctx, dir, st, entry, "primary");
    }
  }
  return { deliveries: st.deliveries, fallbackSpend: st.fallbackSpend, acquiredPaths: st.acquiredPaths, cloneDir: dir, acquisitionForm: ctx.acquisitionForm };
}

// ---- T2c -------------------------------------------------------------------------------------
export async function runT2c(ctx: DriverRunContext, childPool: { acquire(): Promise<() => void> }): Promise<DriverRunOutcome> {
  const st: RunState = { deliveries: [], fallbackSpend: 0, acquiredPaths: new Set(), live: ctx.liveState };
  pushNoReads(ctx, st);
  const { dir, headRev } = await acquireStore(ctx, { checkout: false });
  const lsIndex = await enumerateStore(ctx, dir, headRev);
  const holder: { child: BatchChild | null; release: (() => void) | null } = { child: null, release: null };
  let respawns = 0;
  let firstDisposal: BatchChildDisposal | null = null;
  let finalDisposal: BatchChildDisposal | null = null;
  let thrown: Error | null = null;
  let disposeRejected: string | null = null;
  const ensureChild = async (): Promise<BatchChild> => {
    if (holder.child !== null) return holder.child;
    if (holder.release === null) holder.release = await childPool.acquire(); // lazy spawn at first canonical read (§3.1)
    holder.child = new BatchChild({
      objectFormat: ctx.slot.objectFormat, env: ctx.gitEnv, cwd: dir, benchRoot: ctx.benchRoot,
      limits: {
        maxHeaderBytes: ctx.cfg.frame.maxHeaderBytes, frameCeiling: ctx.cfg.frame.frameCeilingBytes,
        stderrRingBytes: ctx.cfg.frame.stderrRingBytes, readDeadlineMs: ctx.cfg.frame.readDeadlineMs,
        disposeDeadlineMs: ctx.cfg.frame.disposeDeadlineMs,
      },
      onRecord: ctx.spawnObserver,
    });
    return holder.child;
  };
  try {
    for (const entry of ctx.workload.entries) {
      if (!entry.read) continue;
      const ls = lsIndex.get(entry.path);
      if (ls === undefined) throw new UnitFailure(`ls-tree omits pinned entry ${entry.path}`);
      if (ls.oid !== entry.blobOid) throw new UnitFailure(`ls-tree oid disagrees with the pinned workload at ${entry.path}`);
      if (ls.mode === "120000") {
        await restRead(ctx, st, entry, "symlink-fallback", "rest-fallback");
        continue;
      }
      if (ls.size === null) throw new UnitFailure(`ls-tree carries no size for blob ${entry.path}`);
      let frame;
      try {
        frame = await (await ensureChild()).readObject({ oid: ls.oid, size: ls.size });
      } catch (e) {
        // at most one respawn per unit; a second child death fails the unit (§3.1). The FIRST
        // child's disposal carries the actual diagnosis (git's own stderr, the fatal condition
        // that poisoned it) — without it the surviving message is only the second failure's.
        if (respawns >= 1)
          throw new UnitFailure(`batch child died twice: ${e instanceof Error ? e.message : String(e)}${firstDisposal === null ? "" : ` — first child: ${describeDisposal(firstDisposal)}`}`);
        respawns++;
        firstDisposal = (await holder.child?.dispose()) ?? null;
        holder.child = null;
        try {
          frame = await (await ensureChild()).readObject({ oid: ls.oid, size: ls.size });
        } catch (e2) {
          // an immediately-failing REPLACEMENT is the same double death — without this wrap the
          // raw second error escaped the catch block and the FIRST child's retained diagnosis
          // (its poisoned condition + git's own stderr) was discarded on exactly the path it
          // matters most
          throw new UnitFailure(`batch child died twice: ${e2 instanceof Error ? e2.message : String(e2)}${firstDisposal === null ? "" : ` — first child: ${describeDisposal(firstDisposal)}`}`);
        }
      }
      if (frame.kind === "missing")
        throw new UnitFailure(`object-store corruption: ${entry.path}'s enumerated oid is missing from the acquired store`);
      // self-verification BEFORE the seam decode: the frame bytes must hash to the tree oid
      if (gitBlobOid(frame.body, ctx.slot.objectFormat) !== ls.oid)
        throw new UnitFailure(`frame bytes do not hash to the enumerated oid at ${entry.path}`);
      st.acquiredPaths.add(entry.path);
      deliver(st, { path: entry.path, route: "primary", delivered: seamDecode(frame.body), rawVerified: true });
    }
  } catch (e) {
    thrown = e instanceof Error ? e : new Error(String(e));
    throw thrown;
  } finally {
    // ordered teardown BEFORE the engine may delete the clone dir (§3.1); the pool permit is
    // released in its OWN finally so a rejected dispose can never leak it (codex R2 f.32)
    try {
      if (holder.child !== null) finalDisposal = await holder.child.dispose();
    } catch (e) {
      // A REJECTED dispose() previously set finalDisposal = null, which the post-finally check
      // reads as "nothing to complain about" — so a teardown that failed outright returned a
      // clean run. Record it as an unclean verdict instead of erasing it.
      disposeRejected = e instanceof Error ? e.message : String(e);
    } finally {
      // on the EXCEPTION path the post-finally check below never runs, so the verdict would be
      // captured and discarded exactly as before. Attach it to the error instead of losing it —
      // via annotateTeardown, because the engine records UnitFailure.cause2, NOT .message.
      const teardownNote = disposeRejected !== null
        ? `batch child dispose() itself failed: ${disposeRejected}`
        : (finalDisposal !== null && !disposalIsClean(finalDisposal)
            ? `batch child teardown was also unclean: ${describeDisposal(finalDisposal)}`
            : null);
      if (thrown !== null && teardownNote !== null) {
        if (thrown instanceof UnitFailure) thrown.annotateTeardown(teardownNote);
        else thrown.message = `${thrown.message} — ${teardownNote}`;
      }
      holder.release?.();
    }
  }
  // a child that was poisoned mid-unit could previously report a clean run: dispose()'s verdict
  // was captured and dropped on the floor. Checked AFTER the finally so it cannot mask a real
  // in-flight failure, and only on the path that would otherwise have returned success.
  // A non-zero exit, or a child that never settled, is just as disqualifying as an explicit
  // protocol fault — `git cat-file --batch` exits 0 on a clean close and nothing else.
  if (disposeRejected !== null)
    throw new UnitFailure(`batch child dispose() failed, so the bytes it delivered cannot be vouched for: ${disposeRejected}`);
  if (finalDisposal !== null && !disposalIsClean(finalDisposal))
    throw new UnitFailure(`batch child teardown was not clean: ${describeDisposal(finalDisposal)}`);
  return { deliveries: st.deliveries, fallbackSpend: st.fallbackSpend, acquiredPaths: st.acquiredPaths, cloneDir: dir, acquisitionForm: ctx.acquisitionForm };
}

export async function runDriver(driver: DriverId, ctx: DriverRunContext, childPool: { acquire(): Promise<() => void> }): Promise<DriverRunOutcome> {
  switch (driver) {
    case "T0": return runT0(ctx);
    case "T1": return runT1(ctx);
    case "T2a": return runT2a(ctx);
    case "T2c": return runT2c(ctx, childPool);
  }
}
