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

export interface RateSnapshot {
  remaining: number | null;
  limit: number | null;
  resetEpochSec: number | null;
  asOfMs: number;
}

export interface ThrottleSnapshot {
  horizonMs: number; // PAUSED is DERIVED at render: horizonMs > nowMs() — time, not events, clears it
  budgetSpentMs: number;
}

// There is deliberately NO "cleared" event (§U2): with concurrent callers the pause horizon can
// be extended while another caller wakes, so "cleared" cannot be emitted race-free. Time clears it.
export function isPaused(t: ThrottleSnapshot | null, nowMs: number): boolean {
  return t !== null && t.horizonMs > nowMs;
}

export interface Problem {
  atMs: number;
  kind: "error" | "warning";
  scope: string;
  target: string;
  message: string;
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
  readonly phase: string | null;
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
  readonly branchCap: number | null; // PER-REPO — render "≤B per repo", never a global fraction
  readonly limits: Readonly<Record<LimitResource, RateSnapshot | null>>;
  readonly throttle: Readonly<Record<LimitResource, ThrottleSnapshot | null>>;
  readonly budgetExhausted: boolean; // sticky — it cannot un-happen within a run
  readonly retryExhaustions: number; // transient per-call exhaustions, surfaced as a count
  readonly counters: Readonly<SessionCounters>; // THIS-SESSION activity, never report totals
  readonly findings: Readonly<{ deps: number; usage: number; cli: number }>;
  readonly problems: readonly Problem[]; // newest LAST; render slices the tail
}

export interface TuiStore {
  readonly version: number; // incremented per DISPATCH, changed state or not (render-skip
  //                             signal: cheap monotonic "anything arrived", not a diff)
  snapshot(): TuiSnapshot;
  dispatch(e: ProgressEvent): void;
}

// ---- defensive readers for the tapped JSONL projection ---------------------------------------
// The tapped fold must never throw on ANY event shape — unknown events fold to nothing by design
// (the vocabulary can grow without touching the TUI).
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function createTuiStore(nowMs: () => number): TuiStore {
  let version = 0;
  let phase: string | null = null;
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
  // mode never mounts).
  const foldJsonl = (ev: Readonly<Record<string, unknown>>): void => {
    const event = str(ev["event"]);
    if (event === null) return;
    switch (event) {
      case "run": {
        runId = str(ev["runId"]);
        resumed = bool(ev["resumed"]);
        return; // counts are whole-database row totals — deliberately unread (§U4)
      }
      case "concurrency": {
        ownerCap = num(ev["organizations"]);
        branchCap = num(ev["branches"]);
        spawnCap = num(ev["repositories"]);
        return;
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
        } else if (action === "skip-current") counters.skipCurrent++;
        else if (action === "skip-cutoff") counters.skipCutoff++;
        else if (action === "skip-policy") counters.skipPolicy++;
        else if (action === "past-cap") counters.pastCap++;
        else if (action === "requeue-throttle") counters.requeued++;
        else if (action === "error") {
          counters.errored++;
          pushProblem("error", "scan", target, str(ev["message"]) ?? "scan error");
        }
        return;
      }
      case "discovery": {
        const error = str(ev["error"]);
        if (error !== null) {
          const repo = str(ev["repo"]);
          pushProblem("error", "discovery", repo === null ? (str(ev["org"]) ?? "?") : `${str(ev["org"]) ?? "?"}/${repo}`, error);
        }
        return;
      }
      case "introspection": {
        const error = str(ev["error"]);
        if (error !== null) {
          const v = str(ev["version"]);
          pushProblem("error", "introspection", `${str(ev["packageName"]) ?? "?"}${v === null ? "" : `@${v}`}`, error);
        }
        return;
      }
      case "warning": {
        pushProblem("warning", str(ev["reason"]) ?? "warning", str(ev["target"]) ?? "", str(ev["message"]) ?? "");
        return;
      }
      case "policy-warning": {
        const kind = str(ev["kind"]) ?? "policy-warning";
        const pattern = str(ev["pattern"]);
        pushProblem("warning", "policy", pattern === null ? kind : `${kind} ${pattern}`, "");
        return;
      }
      default:
        return; // unknown events fold to nothing by design
    }
  };

  const dispatch = (e: ProgressEvent): void => {
    switch (e.type) {
      case "phase":
        phase = e.phase;
        break;
      case "spawn-start":
        spawns.set(e.id, { tool: e.tool, label: e.label, sinceMs: nowMs() });
        break;
      case "spawn-end":
        spawns.delete(e.id);
        break;
      case "spawn-queue":
        spawnWaiting = e.waiting;
        break;
      case "fetch-start":
        fetches.set(e.id, { kind: e.kind, label: e.label, sinceMs: nowMs() });
        break;
      case "fetch-end":
        fetches.delete(e.id);
        break;
      case "rate-limit":
        limits[e.resource] = { remaining: e.remaining, limit: e.limit, resetEpochSec: e.resetEpochSec, asOfMs: nowMs() };
        break;
      case "rate-limit-seed":
        // fold-if-absent ONLY: a live snapshot always wins — the seed must not clobber it with nulls
        if (limits[e.resource] === null) limits[e.resource] = { remaining: e.remaining, limit: null, resetEpochSec: null, asOfMs: nowMs() };
        break;
      case "throttle": {
        if (e.state === "exhausted") {
          if (e.reason === "budget") budgetExhausted = true; // sticky — cannot un-happen this run
          else retryExhaustions++;
        }
        const prev = throttle[e.bucket];
        const horizonMs = Math.max(prev?.horizonMs ?? 0, e.untilMs ?? 0);
        throttle[e.bucket] = { horizonMs, budgetSpentMs: e.budgetSpentMs };
        break;
      }
      case "owner-start":
        activeOwners.add(e.owner);
        break;
      case "owner-end":
        activeOwners.delete(e.owner);
        break;
      case "repo-start":
        activeRepos.add(`${e.owner}/${e.repo}`);
        break;
      case "repo-end":
        activeRepos.delete(`${e.owner}/${e.repo}`);
        break;
      case "unit-dispatch":
        unitWorkers.set(`${e.owner}/${e.repo}@${e.branch}`, { sinceMs: nowMs() });
        break;
      case "unit-settle": {
        // settle is the ONLY reliable end (§U2): it clears BOTH the worker slot and any active
        // scan — tapped JSONL events never clear active state (the `scanned` line fires before
        // cleanup finishes, and fatal escapes emit no terminal unit line at all).
        const key = `${e.owner}/${e.repo}@${e.branch}`;
        unitWorkers.delete(key);
        scanningUnits.delete(key);
        break;
      }
      case "unit-start":
        scanningUnits.set(`${e.owner}/${e.repo}@${e.branch}`, { sinceMs: nowMs() });
        break;
      case "introspect-start":
        introspections.set(e.id, { packageName: e.packageName, version: e.version, sinceMs: nowMs() });
        break;
      case "introspect-end":
        introspections.delete(e.id);
        break;
      case "divert":
        logPath = e.path;
        break;
      case "jsonl":
        foldJsonl(e.event);
        break;
      default:
        assertNever(e, "ProgressEvent");
    }
    version++;
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
        limits: { ...limits },
        throttle: { ...throttle },
        budgetExhausted,
        retryExhaustions,
        counters: { ...counters },
        findings: { ...findings },
        problems: [...problems],
      };
    },
  };
}
