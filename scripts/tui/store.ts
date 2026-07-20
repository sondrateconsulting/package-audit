// store.ts — the TUI store (§U4 of PROMPT-TUI.md): ONE mutable store folding ProgressEvents into
// a renderable snapshot. React-free; the clock is constructor-injected (events are timeless — the
// store stamps arrival time), so instrumented modules gain no clock plumbing and tests stay
// deterministic. Everything here is BOUNDED: nothing grows with estate size (active maps shrink
// as spans end; the problems ring is capped; counters are integers).
//
// Ownership boundary: this file and everything React lives in scripts/tui/ (display layer); the
// hub lives in scripts/progress.ts (core). Core modules never import from scripts/tui/.
import { assertNever } from "../assertNever.ts";
import type { ProgressEvent } from "../progress.ts";

export const PROBLEM_RING_CAP = 50;

export type SpawnTool = "gh" | "git" | "tar";
export type FetchKind = "packument" | "tarball" | "registry-probe";
export type LimitResource = "core" | "graphql";
// The closed set of pipeline phases (mirrors ProgressEvent's "phase" member) — narrower than a bare
// string, so a future phase-keyed lookup gets exhaustiveness instead of a silent fall-through.
export type Phase = Extract<ProgressEvent, { type: "phase" }>["phase"];

export interface RateSnapshot {
  readonly remaining: number | null;
  readonly limit: number | null;
  readonly resetEpochSec: number | null;
  readonly asOfMs: number;
}

export interface ThrottleSnapshot {
  readonly horizonMs: number; // PAUSED is DERIVED at render: horizonMs > nowMs() — time, not events, clears it
  readonly budgetSpentMs: number;
}

// There is deliberately NO "cleared" event (§U2): with concurrent callers the pause horizon can
// be extended while another caller wakes, so "cleared" cannot be emitted race-free. Time clears it.
export function isPaused(t: ThrottleSnapshot | null, nowMs: number): boolean {
  return t !== null && t.horizonMs > nowMs;
}

export interface Problem {
  readonly atMs: number;
  readonly kind: "error" | "warning";
  readonly scope: string;
  readonly target: string;
  readonly message: string;
}

export interface SessionCounters {
  scanned: number;
  skipCurrent: number;
  skipCutoff: number;
  skipPolicy: number;
  pastCap: number;
  errored: number;
  requeued: number;
}

export interface TuiSnapshot {
  readonly phase: Phase | null;
  readonly runId: string | null; // header shows run <id8> (resumed)/(fresh) — NOTHING from counts
  readonly resumed: boolean | null;
  readonly logPath: string | null; // the ACTUAL divert path, once known
  readonly spawns: ReadonlyArray<{ id: number; tool: SpawnTool; label: string; sinceMs: number }>;
  readonly fetches: ReadonlyArray<{ id: number; kind: FetchKind; label: string; sinceMs: number }>;
  readonly introspections: ReadonlyArray<{ id: number; packageName: string; version: string; sinceMs: number }>;
  readonly spawnWaiting: number;
  readonly spawnCap: number | null; // tapped `concurrency` event's `repositories`
  readonly owners: readonly string[]; // active owners, insertion order
  readonly repoCount: number; // active repos
  readonly unitWorkers: ReadonlyArray<{ key: string; sinceMs: number }>; // dispatch→settle occupancy
  readonly scanning: ReadonlyArray<{ key: string; sinceMs: number }>; // start→settle real scans
  readonly ownerCap: number | null;
  readonly branchCap: number | null; // PER-REPO — render "≤B/repo", never a global fraction
  readonly limits: Readonly<Record<LimitResource, RateSnapshot | null>>;
  readonly throttle: Readonly<Record<LimitResource, ThrottleSnapshot | null>>;
  readonly budgetExhausted: boolean; // sticky — it cannot un-happen within a run
  readonly retryExhaustions: number; // transient per-call exhaustions, surfaced as a count
  readonly counters: Readonly<SessionCounters>; // THIS-SESSION activity, never report totals
  readonly findings: Readonly<{ deps: number; usage: number; cli: number }>;
  readonly problems: readonly Problem[]; // newest LAST; render slices the tail
}

export interface TuiStore {
  readonly version: number; // incremented per MUTATION (§U4) — only a dispatch that WROTE
  //                             store state advances it, so the render-skip check truly skips
  //                             no-op dispatches (unknown tapped events, unknown span ids,
  //                             occupied-slot seeds, unchanged gauge values)
  snapshot(): TuiSnapshot;
  dispatch(e: ProgressEvent): void;
}

// ---- defensive readers for the tapped JSONL projection ---------------------------------------
// The tapped fold must never throw on ANY event shape — unknown events fold to nothing by design
// (the vocabulary can grow without touching the TUI).
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// snapshot() deep-copies these bounded value objects so a returned snapshot is fully independent of
// live state. The store already REPLACES them by reference (never mutates in place), so this guards
// the OTHER direction: a consumer mutating a returned snapshot must not reach back into the store.
// Fields are readonly (compile-time); these clones make it hold at runtime too. Cost is trivial and
// bounded — 2 rate + 2 throttle + at most PROBLEM_RING_CAP problems, each a flat object.
const copyRate = (r: RateSnapshot | null): RateSnapshot | null => (r === null ? null : { ...r });
const copyThrottle = (t: ThrottleSnapshot | null): ThrottleSnapshot | null => (t === null ? null : { ...t });

// Active-map keys: repos by owner/repo, branch units by owner/repo@branch. One place so the
// dispatch cases that correlate start↔end (repo) and dispatch↔settle (unit, §U2) never drift on
// the key grammar.
const repoKey = (owner: string, repo: string): string => `${owner}/${repo}`;
const unitKey = (owner: string, repo: string, branch: string): string => `${owner}/${repo}@${branch}`;

export function createTuiStore(nowMs: () => number): TuiStore {
  let version = 0;
  let phase: Phase | null = null;
  let runId: string | null = null;
  let resumed: boolean | null = null;
  let logPath: string | null = null;
  const spawns = new Map<number, { tool: SpawnTool; label: string; sinceMs: number }>();
  const fetches = new Map<number, { kind: FetchKind; label: string; sinceMs: number }>();
  const introspections = new Map<number, { packageName: string; version: string; sinceMs: number }>();
  let spawnWaiting = 0;
  let spawnCap: number | null = null;
  const activeOwners = new Set<string>();
  const activeRepos = new Set<string>();
  const unitWorkers = new Map<string, { sinceMs: number }>();
  const scanningUnits = new Map<string, { sinceMs: number }>();
  let ownerCap: number | null = null;
  let branchCap: number | null = null;
  const limits: Record<LimitResource, RateSnapshot | null> = { core: null, graphql: null };
  const throttle: Record<LimitResource, ThrottleSnapshot | null> = { core: null, graphql: null };
  let budgetExhausted = false;
  let retryExhaustions = 0;
  const counters: SessionCounters = { scanned: 0, skipCurrent: 0, skipCutoff: 0, skipPolicy: 0, pastCap: 0, errored: 0, requeued: 0 };
  const findings = { deps: 0, usage: 0, cli: 0 };
  const problems: Problem[] = [];

  const pushProblem = (kind: "error" | "warning", scope: string, target: string, message: string): void => {
    problems.push({ atMs: nowMs(), kind, scope, target, message });
    if (problems.length > PROBLEM_RING_CAP) problems.splice(0, problems.length - PROBLEM_RING_CAP);
  };

  // The tapped-JSONL projection (§U4): folds counters, header identity, caps, and problems from
  // the durable stream. Total over ANY shape; plan events are deliberately NOT projected (plan
  // mode never mounts). Returns whether anything was WRITTEN — §U4's per-mutation version
  // contract rides on it: an event that folds to nothing must not wake the renderer.
  const foldJsonl = (ev: Readonly<Record<string, unknown>>): boolean => {
    const event = str(ev["event"]);
    if (event === null) return false;
    switch (event) {
      case "run": {
        runId = str(ev["runId"]);
        resumed = bool(ev["resumed"]);
        return true; // counts are whole-database row totals — deliberately unread (§U4)
      }
      case "concurrency": {
        ownerCap = num(ev["organizations"]);
        branchCap = num(ev["branches"]);
        spawnCap = num(ev["repositories"]);
        return true;
      }
      case "unit": {
        const action = str(ev["action"]);
        // Identity-field tolerance (the fold is TOTAL, §U4): an absent or mistyped
        // org/repo/branch renders as a "?" placeholder — "?/?@?" is the honest unknown — rather
        // than throwing or dropping the problem row over its label.
        const target = `${str(ev["org"]) ?? "?"}/${str(ev["repo"]) ?? "?"}@${str(ev["branch"]) ?? "?"}`;
        if (action === "scanned") {
          counters.scanned++;
          findings.deps += num(ev["deps"]) ?? 0;
          findings.usage += num(ev["usage"]) ?? 0;
          findings.cli += num(ev["cli"]) ?? 0;
          return true;
        }
        if (action === "skip-current") {
          counters.skipCurrent++;
          return true;
        }
        if (action === "skip-cutoff") {
          counters.skipCutoff++;
          return true;
        }
        if (action === "skip-policy") {
          counters.skipPolicy++;
          return true;
        }
        if (action === "past-cap") {
          counters.pastCap++;
          return true;
        }
        if (action === "requeue-throttle") {
          counters.requeued++;
          return true;
        }
        if (action === "error") {
          counters.errored++;
          pushProblem("error", "scan", target, str(ev["message"]) ?? "scan error");
          return true;
        }
        return false; // an unrecognized action wrote nothing
      }
      case "discovery": {
        const error = str(ev["error"]);
        if (error !== null) {
          const repo = str(ev["repo"]);
          pushProblem("error", "discovery", repo === null ? (str(ev["org"]) ?? "?") : `${str(ev["org"]) ?? "?"}/${repo}`, error);
          return true;
        }
        return false; // a successful discovery line projects nothing
      }
      case "introspection": {
        const error = str(ev["error"]);
        if (error !== null) {
          const v = str(ev["version"]);
          pushProblem("error", "introspection", `${str(ev["packageName"]) ?? "?"}${v === null ? "" : `@${v}`}`, error);
          return true;
        }
        return false; // a successful introspection line projects nothing
      }
      case "warning": {
        pushProblem("warning", str(ev["reason"]) ?? "warning", str(ev["target"]) ?? "", str(ev["message"]) ?? "");
        return true;
      }
      case "policy-warning": {
        const kind = str(ev["kind"]) ?? "policy-warning";
        const pattern = str(ev["pattern"]);
        pushProblem("warning", "policy", pattern === null ? kind : `${kind} ${pattern}`, "");
        return true;
      }
      default:
        return false; // unknown events fold to nothing by design
    }
  };

  const dispatch = (e: ProgressEvent): void => {
    // §U4: version advances PER MUTATION — only a dispatch that WROTE store state. The no-op
    // shapes (an unknown tapped event, an unknown span id, a seed into an occupied slot, an
    // unchanged gauge value) leave it untouched, so the tick's render-skip check truly skips.
    // Writes that only refresh a timestamp (re-stamped sinceMs/asOfMs) count as mutations —
    // the stamp IS state; the contract excludes writes that never happened, not cheap ones.
    let changed = true;
    switch (e.type) {
      case "phase":
        phase = e.phase;
        break;
      case "spawn-start":
        spawns.set(e.id, { tool: e.tool, label: e.label, sinceMs: nowMs() });
        break;
      case "spawn-end":
        changed = spawns.delete(e.id);
        break;
      case "spawn-queue":
        changed = spawnWaiting !== e.waiting;
        spawnWaiting = e.waiting;
        break;
      case "fetch-start":
        fetches.set(e.id, { kind: e.kind, label: e.label, sinceMs: nowMs() });
        break;
      case "fetch-end":
        changed = fetches.delete(e.id);
        break;
      case "rate-limit":
        // Quota number slots are VALIDATED AT THE FOLD (the same num() the tapped JSONL folds
        // use), never trusted from the event type: the seed's values originate in an
        // unvalidated external JSON body (preflight reads the rate_limit response through a
        // bare type assertion — pre-existing code this branch must not edit), so a hostile or
        // malformed API payload can put ANY runtime value in a number-typed field — including
        // a string whose toLocaleString would render its bytes VERBATIM. §U0's sanitized-
        // rendering pillar means the display validates everything at its own boundary: a
        // non-finite-number value folds to null and renders as the honest "?".
        limits[e.resource] = { remaining: num(e.remaining), limit: num(e.limit), resetEpochSec: num(e.resetEpochSec), asOfMs: nowMs() };
        break;
      case "rate-limit-seed":
        // fold-if-absent ONLY: a live snapshot always wins — the seed must not clobber it with
        // nulls. Same finite validation as the live fold above (the seed IS the external one).
        if (limits[e.resource] === null) limits[e.resource] = { remaining: num(e.remaining), limit: null, resetEpochSec: null, asOfMs: nowMs() };
        else changed = false; // occupied slot — the seed wrote nothing
        break;
      case "throttle": {
        if (e.state === "exhausted") {
          // Exhaustive over the reason union: a future reason added to ProgressEvent that is not
          // mapped here is a BUILD error (assertNever), never a silent miscount. Were one to slip
          // through at runtime, the throw unwinds the fold into the guarded progress-sink path — the
          // lifecycle sink closure degrades the dashboard (emitProgress's own catch is the backstop),
          // never the audit.
          switch (e.reason) {
            case "budget": budgetExhausted = true; break; // sticky — cannot un-happen this run
            case "retries": retryExhaustions++; break; // transient per-call exhaustion, a count
            default: assertNever(e, "throttle exhausted reason"); // a new reason → build error here
          }
        }
        const prev = throttle[e.bucket];
        const horizonMs = Math.max(prev?.horizonMs ?? 0, e.untilMs ?? 0);
        throttle[e.bucket] = { horizonMs, budgetSpentMs: e.budgetSpentMs };
        break;
      }
      case "owner-start":
        changed = !activeOwners.has(e.owner);
        activeOwners.add(e.owner);
        break;
      case "owner-end":
        changed = activeOwners.delete(e.owner);
        break;
      case "repo-start": {
        const key = repoKey(e.owner, e.repo);
        changed = !activeRepos.has(key);
        activeRepos.add(key);
        break;
      }
      case "repo-end":
        changed = activeRepos.delete(repoKey(e.owner, e.repo));
        break;
      case "unit-dispatch":
        unitWorkers.set(unitKey(e.owner, e.repo, e.branch), { sinceMs: nowMs() });
        break;
      case "unit-settle": {
        // settle is the ONLY reliable end (§U2): it clears BOTH the worker slot and any active
        // scan — tapped JSONL events never clear active state (the `scanned` line fires before
        // cleanup finishes, and fatal escapes emit no terminal unit line at all).
        const key = unitKey(e.owner, e.repo, e.branch);
        const workerGone = unitWorkers.delete(key);
        const scanGone = scanningUnits.delete(key);
        changed = workerGone || scanGone;
        break;
      }
      case "unit-start":
        scanningUnits.set(unitKey(e.owner, e.repo, e.branch), { sinceMs: nowMs() });
        break;
      case "introspect-start":
        introspections.set(e.id, { packageName: e.packageName, version: e.version, sinceMs: nowMs() });
        break;
      case "introspect-end":
        changed = introspections.delete(e.id);
        break;
      case "divert":
        logPath = e.path;
        break;
      case "jsonl":
        changed = foldJsonl(e.event);
        break;
      default:
        assertNever(e, "ProgressEvent");
    }
    if (changed) version++;
  };

  return {
    get version() {
      return version;
    },
    dispatch,
    snapshot(): TuiSnapshot {
      return {
        phase,
        runId,
        resumed,
        logPath,
        spawns: [...spawns.entries()].map(([id, s]) => ({ id, ...s })),
        fetches: [...fetches.entries()].map(([id, f]) => ({ id, ...f })),
        introspections: [...introspections.entries()].map(([id, i]) => ({ id, ...i })),
        spawnWaiting,
        spawnCap,
        owners: [...activeOwners],
        repoCount: activeRepos.size,
        unitWorkers: [...unitWorkers.entries()].map(([key, u]) => ({ key, ...u })),
        scanning: [...scanningUnits.entries()].map(([key, u]) => ({ key, ...u })),
        ownerCap,
        branchCap,
        limits: { core: copyRate(limits.core), graphql: copyRate(limits.graphql) },
        throttle: { core: copyThrottle(throttle.core), graphql: copyThrottle(throttle.graphql) },
        budgetExhausted,
        retryExhaustions,
        counters: { ...counters },
        findings: { ...findings },
        problems: problems.map((p) => ({ ...p })),
      };
    },
  };
}
