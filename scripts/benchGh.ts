// benchGh.ts — the benchmark's REST/GraphQL attempt layer (resolution plan §4.4/§4.6). Spawns
// ride the PRODUCTION chokepoint (GithubClient.gh — guard, sanitized env, semaphore, spawn
// deadline all production), while the attempt loop is a faithful transcription of restGet's
// semantics using the EXPORTED production classifiers (classifyRest / classifyGraphql /
// parseGhApiOutput) — reused, never reimplemented — because the drivers must OBSERVE what
// production hides: per-attempt status/headers/bodies, secondary-limit signals classified as
// production classifies them (github.ts:541), per-request GraphQL point costs, and
// errors[].path attribution (the production graphql() drops partial data by design, ADR §3).
// Every attempt that RETURNS from the spawn layer is recorded — including every failure it can
// describe. An attempt whose spawn REJECTS outright (production's byte-cap/stream diagnostics)
// throws past the recorder, so it leaves no row. The recorder feeds runs.jsonl and the G4 signal
// classifier.

import { createHash } from "node:crypto";
import {
  GithubClient, GithubApiError, classifyRest, classifyGraphql, parseGhApiOutput,
  type HttpResponse,
} from "./github.ts";
import type { AuditDb } from "./db.ts";
import type { BenchConfig } from "./benchConfig.ts";

export class BenchHttpError extends Error {
  readonly code: string;
  readonly status: number;
  // typed R1/R2 evidence (§4.5): the terminal attempt's classification + request class, so the
  // rerun predicate never regexes a message (codex R1 finding 7)
  readonly lastClassification: string | null;
  readonly requestClass: string | null;
  constructor(code: string, message: string, status = 0, evidence: { lastClassification?: string; requestClass?: string } = {}) {
    super(`BENCH HTTP: ${message}`);
    this.name = "BenchHttpError";
    this.code = code;
    this.status = status;
    this.lastClassification = evidence.lastClassification ?? null;
    this.requestClass = evidence.requestClass ?? null;
  }
}

// ---- recording -------------------------------------------------------------------------------
export type SecondarySignalKind = "status-429" | "retry-after-403" | "body-secondary" | "graphql-rate-limited";
// "rest-classifier" is the §4.4 SHA-form classifier's pinned-object probe: a CONSUMING core
// request the §4.8 worst case explicitly reserves ("one SHA-classifier attempt-loop
// allowance"). It must count as driver traffic — labeling it "rest-meta" excluded it from the
// harness-owned accounting, so its own consumption read as R3 foreign interference.
export type RequestClass = "rest-content" | "rest-tree" | "rest-fallback" | "rest-classifier" | "rest-meta" | "graphql-batch";

export interface BenchHttpAttemptRecord {
  type: "http-attempt";
  atMs: number;
  wallMs: number;
  kind: "rest" | "graphql";
  requestClass: RequestClass;
  label: string; // endpoint or batch label, never a token-bearing string
  attempt: number; // 1-based within this call
  status: number;
  exitCode: number;
  classification: string; // ok | not-modified | cache | primary | secondary | transient | fatal | no-response | truncated | malformed-body | unaccepted-2xx
  secondarySignal: SecondarySignalKind | null;
  pointsCost: number | null; // graphql rateLimit.cost when readable; 1 imputed by the caller's accounting
  remaining: number | null;
  resetEpochSec: number | null;
  servedFromCache: boolean;
  // NOTE: measured on the DECODED body re-encoded as UTF-8 (the production spawn hands strings,
  // not bytes) — invalid input bytes inflate to 3-byte replacement chars. Recorded as-is with
  // this caveat; raw byte counts would need a byte-mode transport production does not expose.
  bodyBytes: number;
}
export type BenchHttpRecorder = (rec: BenchHttpAttemptRecord) => void;

// production-shape secondary-signal detection (github.ts:541's classes, made visible):
// header-signalled 429/retry-after, body-signalled 403 secondary responses, and GraphQL
// RATE_LIMITED error codes.
const SECONDARY_BODY_RE = /secondary rate limit|abuse detection|abuse rate limit/i;
export function detectRestSecondarySignal(status: number, headers: Record<string, string>, body: string): SecondarySignalKind | null {
  if (status !== 403 && status !== 429) return null;
  if (headers["x-ratelimit-remaining"] === "0") return null; // PRIMARY exhaustion, not a secondary signal
  if (status === 429) return "status-429";
  if (headers["retry-after"] !== undefined) return "retry-after-403";
  if (SECONDARY_BODY_RE.test(body)) return "body-secondary";
  return null;
}

const headerInt = (v: string | undefined): number | null => {
  if (v === undefined || !/^\d+$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return Number.isSafeInteger(n) ? n : null;
};

// ---- bucket state (serial protocol — one run at a time, plan §4.5) ---------------------------
export interface BenchBucket {
  label: "core" | "graphql";
  pausedUntilMs: number; // the outstanding throttle horizon — washout reads it after the run
}

export interface BenchGhContext {
  client: GithubClient;
  db: AuditDb | null; // the run's fresh cache DB (null for probe/meta traffic)
  cfg: BenchConfig;
  core: BenchBucket;
  graphql: BenchBucket;
  record: BenchHttpRecorder;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function makeBuckets(): { core: BenchBucket; graphql: BenchBucket } {
  return { core: { label: "core", pausedUntilMs: 0 }, graphql: { label: "graphql", pausedUntilMs: 0 } };
}

// the outstanding throttle horizon across both buckets — §4.5's washout term
export function outstandingHorizonMs(ctx: BenchGhContext): number {
  return Math.max(ctx.core.pausedUntilMs, ctx.graphql.pausedUntilMs);
}

// mirror of production's endpointIsShaPinned gate (github.ts keeps it private): only a
// SHA-pinned endpoint may serve the zero-network immutable cache hit.
const HEX_OBJECT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
export function endpointIsShaPinned(endpoint: string): boolean {
  const [path, query = ""] = endpoint.split("?");
  if (/\/git\/(blobs|trees)\/[0-9a-f]{40}([0-9a-f]{24})?(\/|$)/i.test(path ?? "")) return true;
  const ref = new URLSearchParams(query).get("ref") ?? "";
  return HEX_OBJECT_ID_RE.test(ref);
}

const cacheKey = (host: string, endpoint: string): string => `bench1:${host}:${endpoint}`;

async function waitBucket(ctx: BenchGhContext, bucket: BenchBucket): Promise<void> {
  const wait = bucket.pausedUntilMs - ctx.now();
  if (wait > 0) await ctx.sleep(wait);
}

const backoffWait = (cfg: BenchConfig, kind: "secondary" | "transient", attempt: number, waitMs: number | null): number => {
  if (waitMs !== null) return waitMs;
  const base = kind === "secondary" ? cfg.rest.secondaryBaseWaitMs : cfg.rest.transientBaseWaitMs;
  return base * 2 ** attempt;
};

// ---- REST GET (restGet transcription, recorded) ----------------------------------------------
export interface BenchRestOptions {
  endpoint: string;
  accept?: string;
  immutable?: boolean;
  requestClass: RequestClass;
}

export async function benchRestGet(ctx: BenchGhContext, opts: BenchRestOptions): Promise<HttpResponse> {
  const accept = opts.accept ?? "";
  const immutable = opts.immutable === true && endpointIsShaPinned(opts.endpoint);
  const key = cacheKey(ctx.cfg.githubHost, opts.endpoint);
  const cached = ctx.db?.getApiCache("GET", key, accept) ?? null;
  if (immutable && cached !== null && cached.responseBody !== null) {
    ctx.record({
      type: "http-attempt", atMs: ctx.now(), wallMs: 0, kind: "rest", requestClass: opts.requestClass,
      label: opts.endpoint, attempt: 0, status: 200, exitCode: 0, classification: "cache",
      secondarySignal: null, pointsCost: null, remaining: null, resetEpochSec: null, servedFromCache: true,
      bodyBytes: 0,
    });
    return { status: 200, headers: {}, body: cached.responseBody };
  }
  const args = ["api", "-i", opts.endpoint];
  if (accept !== "") args.push("-H", `Accept: ${accept}`);
  if (cached?.etag != null && cached.responseBody !== null) args.push("-H", `If-None-Match: ${cached.etag}`);

  let lastClass = "unknown";
  // the WEAKEST classification seen across this attempt chain (see replayRank). Carrying the LAST
  // one let {429 secondary, status 0, status 0} throw bare "no-response" and buy an unconditional
  // R1 replay for a chain containing a signal §4.5 never replays, while the same attempts in the
  // reverse order were correctly refused.
  let weakestClass: string | null = null;
  const foldWeakest = (cls: string): void => {
    if (weakestClass === null || replayRank(cls) < replayRank(weakestClass)) weakestClass = cls;
  };
  for (let attempt = 0; attempt < ctx.cfg.rest.attemptCap; attempt++) {
    await waitBucket(ctx, ctx.core);
    const startedAt = ctx.now();
    const res = await ctx.client.gh(args);
    const now = ctx.now();
    const parsed = parseGhApiOutput(res.stdout);
    const emit = (classification: string, signal: SecondarySignalKind | null): void => {
      ctx.record({
        type: "http-attempt", atMs: startedAt, wallMs: now - startedAt, kind: "rest",
        requestClass: opts.requestClass, label: opts.endpoint, attempt: attempt + 1,
        status: parsed.status, exitCode: res.exitCode, classification,
        secondarySignal: signal, pointsCost: null,
        remaining: headerInt(parsed.headers["x-ratelimit-remaining"]),
        resetEpochSec: headerInt(parsed.headers["x-ratelimit-reset"]),
        servedFromCache: false,
        bodyBytes: Buffer.byteLength(parsed.body, "utf8"),
      });
    };
    if (parsed.status === 0) {
      emit("no-response", null);
      foldWeakest("no-response");
      if (attempt < ctx.cfg.rest.attemptCap - 1) {
        await ctx.sleep(backoffWait(ctx.cfg, "transient", attempt, null));
        continue;
      }
      // BOTH fields must move together: evidenceIsRerunnable grants R1 on the evidence CODE, so
      // demoting only the classification would change nothing. A chain whose weakest member is
      // still R1 keeps code "no-response"; anything weaker becomes "attempts-exhausted" (which it
      // literally is) carrying that weaker class, so an earlier secondary or transient is not
      // laundered away by whichever attempt happened to land last. The message is unchanged — it
      // still names the condition that terminated the chain.
      const weakest = weakestClass ?? "no-response";
      throw new BenchHttpError(
        replayRank(weakest) === 2 ? "no-response" : "attempts-exhausted",
        `gh api produced no HTTP response: ${res.stderr.trim().slice(0, 300)}`,
        0,
        { lastClassification: weakest, requestClass: opts.requestClass },
      );
    }
    if (parsed.status === 304 && cached !== null && cached.responseBody !== null) {
      emit("not-modified", null);
      return { status: 200, headers: parsed.headers, body: cached.responseBody };
    }
    if (parsed.status === 200 && res.exitCode !== 0) {
      emit("truncated", null);
      // fold it like every other recorded attempt: a truncated transfer is rank 0 (§4.5 replays
      // neither R1 nor R2 on it), so a chain of {truncated, truncated, status 0} must NOT throw
      // bare no-response and buy an unconditional replay. Missing this fold was the same
      // laundering one branch over — the branch RETRIES, so it can precede any later throw.
      foldWeakest("truncated");
      if (attempt < ctx.cfg.rest.attemptCap - 1) {
        await ctx.sleep(backoffWait(ctx.cfg, "transient", attempt, null));
        continue;
      }
      throw new BenchHttpError("truncated-transfer", `gh exited ${res.exitCode} with an HTTP 200 response`, parsed.status, { lastClassification: "truncated", requestClass: opts.requestClass });
    }
    const cls = classifyRest(parsed.status, parsed.headers, parsed.body, now);
    lastClass = cls.kind;
    foldWeakest(cls.kind);
    const signal = detectRestSecondarySignal(parsed.status, parsed.headers, parsed.body);
    if (cls.kind === "ok") {
      emit("ok", signal);
      if (parsed.status === 200 && ctx.db !== null) {
        const entry = { method: "GET" as const, url: key, variantHash: accept, etag: parsed.headers["etag"] ?? null, responseBody: parsed.body };
        if (immutable) ctx.db.putApiCacheImmutable(entry);
        else ctx.db.putApiCache(entry);
      }
      return parsed;
    }
    if (cls.kind === "fatal") {
      // a FATAL response (SSO / permission) is never a secondary-limit signal, whatever its
      // status/headers look like — the GraphQL side applies the same guard, and G4's count
      // must not be fed by conditions production fails fast on
      emit("fatal", null);
      throw new BenchHttpError("fatal", `${cls.message} (${opts.endpoint})`, cls.status);
    }
    if (cls.kind === "primary") {
      emit("primary", signal);
      ctx.core.pausedUntilMs = Math.max(ctx.core.pausedUntilMs, cls.untilMs);
      continue; // the next attempt's waitBucket sleeps the window
    }
    emit(cls.kind, signal); // secondary | transient
    const waitMs = backoffWait(ctx.cfg, cls.kind, attempt, cls.kind === "secondary" ? cls.waitMs : null);
    // a secondary horizon is bucket-global evidence the washout must see (codex R1 finding 13)
    if (cls.kind === "secondary") ctx.core.pausedUntilMs = Math.max(ctx.core.pausedUntilMs, now + waitMs);
    // a backoff sleep is the PREFACE to a retry: after the final attempt the loop exhausts, and
    // sleeping first would charge idle time to the scored wall for a retry that never happens
    // (the secondary horizon above is armed either way — the next CALL's waitBucket honours it)
    if (attempt < ctx.cfg.rest.attemptCap - 1) await ctx.sleep(waitMs);
  }
  // the chain's WEAKEST class, not its last: a 429 followed by transient 5xx through the cap is
  // still a chain containing a secondary signal, which §4.5 never replays
  throw new BenchHttpError("attempts-exhausted", `REST attempts exhausted for ${opts.endpoint}`, 0, { lastClassification: weakestClass ?? lastClass, requestClass: opts.requestClass });
}

export async function benchRestJson(ctx: BenchGhContext, opts: BenchRestOptions): Promise<unknown> {
  const res = await benchRestGet(ctx, opts);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new BenchHttpError("invalid-json", `invalid JSON from ${opts.endpoint}`, res.status);
  }
}

// ---- GraphQL dispatch (full-visibility envelope, single attempt) -----------------------------
// One PHYSICAL dispatch — the T1 driver owns the attempt loop, splits, and the transition
// table; this layer parses the envelope with errors[].path preserved and reads rateLimit.cost.
export interface BenchGraphqlErrorEntry {
  type: string | null;
  message: string | null;
  path: ReadonlyArray<string | number> | null;
}
export interface BenchGraphqlDispatch {
  status: number;
  exitCode: number;
  headers: Record<string, string>;
  bodyText: string;
  data: Record<string, unknown> | null;
  errors: BenchGraphqlErrorEntry[];
  malformedErrorEntries: number; // errors[] members with no readable shape — closed-default input
  jsonParseable: boolean;
  classification: string; // classifyGraphql's verdict on status/header/error-type semantics
  secondaryLike: boolean; // RATE_LIMITED body or secondary classification (G4 + backoff input)
  primaryUntilMs: number | null;
  pointsCost: number | null; // rateLimit.cost when the rider was readable
}

// How replayable ONE attempt's evidence is under §4.5, most permissive first. The two admitted
// shapes are NOT interchangeable:
//   2 = R1, a network-layer failure outside any HTTP response — rerunnable UNCONDITIONALLY;
//   1 = R2, a transient-5xx exhaustion — rerunnable ONLY where the §4.5 success ledger carries
//       the request class, so it is strictly weaker than R1;
//   0 = never replayable — a throttle (primary/secondary), a closed default, or a refused shape
//       (non-json, truncated). §4.5's default for everything outside R1/R2 is "driver failure,
//       no rerun", and secondary signals it names as never replayable at all.
// A multi-attempt CHAIN must surface its WEAKEST member, never its last. Both this module's REST
// attempt loop and runT1's circuit breaker had the same laundering bug: {429 secondary, status 0}
// and {transient, transient, status 0} each ended on a no-response and bought a free
// unconditional replay, while the SAME multiset in a different order was correctly refused —
// dispatch order alone decided whether a mandated failure got a replacement attempt.
// NB evidenceIsRerunnable keys R1 on the evidence CODE and R2 on the lastClassification; this
// rank keys on the classification alone, which is sound only because both call sites move the two
// together (status 0 sets BOTH to "no-response"). Keep them in lockstep.
export function replayRank(lastClassification: string | null | undefined): 0 | 1 | 2 {
  if (lastClassification === "no-response") return 2;
  if (lastClassification === "transient") return 1;
  return 0;
}

export function parseGraphqlBodyFull(bodyText: string): { data: Record<string, unknown> | null; errors: BenchGraphqlErrorEntry[]; malformedErrorEntries: number; jsonParseable: boolean } {
  let root: unknown;
  try {
    root = JSON.parse(bodyText);
  } catch {
    return { data: null, errors: [], malformedErrorEntries: 0, jsonParseable: false };
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) return { data: null, errors: [], malformedErrorEntries: 0, jsonParseable: false };
  const o = root as Record<string, unknown>;
  const dataRaw = o["data"];
  const data = typeof dataRaw === "object" && dataRaw !== null && !Array.isArray(dataRaw) ? (dataRaw as Record<string, unknown>) : null;
  const errors: BenchGraphqlErrorEntry[] = [];
  let malformedErrorEntries = 0;
  const errRaw = o["errors"];
  // a PRESENT non-array errors container is spec-malformed and must select the closed default,
  // never resolve as success beside valid data (codex R2 finding 11); the GraphQL spec requires
  // a NON-EMPTY errors list, and production's envelope parser rejects an empty one — accepting
  // it here let malformed subprocess output become a completed scored run
  if (errRaw !== undefined && !Array.isArray(errRaw)) malformedErrorEntries++;
  if (Array.isArray(errRaw) && errRaw.length === 0) malformedErrorEntries++;
  if (Array.isArray(errRaw)) {
    for (const e of errRaw) {
      // a member with no readable shape is EVIDENCE, never a silent drop (codex R1 finding 5):
      // the transition table's closed default fails the whole batch on it
      if (typeof e !== "object" || e === null || Array.isArray(e)) {
        malformedErrorEntries++;
        continue;
      }
      const eo = e as Record<string, unknown>;
      const pathRaw = eo["path"];
      const pathWellFormed = Array.isArray(pathRaw) && pathRaw.every((p) => typeof p === "string" || typeof p === "number");
      if (pathRaw !== undefined && !pathWellFormed) malformedErrorEntries++;
      const path = pathWellFormed ? (pathRaw as Array<string | number>) : null;
      // a PRESENT-but-wrong-typed type or message is malformed EVIDENCE, exactly as production's
      // envelope parser treats it — sanitizing it to null and proceeding accepted (e.g. routed a
      // TIMEOUT with an object-valued message through the split path) what production rejects
      if (eo["type"] !== undefined && typeof eo["type"] !== "string") malformedErrorEntries++;
      // NO null exemption: production flags every PRESENT non-string message (Object.hasOwn +
      // typeof !== "string" → note()), null included, and the `type` line above already counts a
      // present null. Exempting message:null let a partial-data 200 carrying
      // {type:"NOT_FOUND",message:null,path:[…]} resolve its valid aliases and record the batch
      // as a success — malformed transport evidence entering the §4.5 R2 ledger.
      if (eo["message"] !== undefined && typeof eo["message"] !== "string") malformedErrorEntries++;
      const type = typeof eo["type"] === "string" ? (eo["type"] as string) : null;
      const message = typeof eo["message"] === "string" ? (eo["message"] as string) : null;
      if (type === null && message === null && path === null) {
        malformedErrorEntries++;
        continue;
      }
      errors.push({ type, message, path });
    }
  }
  return { data, errors, malformedErrorEntries, jsonParseable: true };
}

// The RECORD's classification for a GraphQL dispatch, extracted PURE so CI can drive it.
// classifyGraphql's "ok" only means "no errors it could read" — an envelope that cannot
// support success (unparseable body, no data OBJECT, or malformed errors[] evidence) must not
// be recorded as an "ok" attempt: the analyzer rejects exactly those dispatches (benchT1's
// non-JSON-object http-failure and malformed-errors default-failure arms), and the §4.5 R2 ledger
// mints replay-authorizing successes from "ok" records. Degenerate-but-parseable envelopes
// ({}, {"data":null}, non-object data, errors:[]) are spec-invalid responses a proxy can
// fabricate with exit 0. At a NONZERO status, non-"ok" verdicts (fatal/throttle/transient) pass
// through — they are already excluded from the ledger and carry the classifier's own honest
// verdict (which classifyGraphql derives from the body's errors[] and the response headers, NOT
// from the status alone: a 200 carrying RATE_LIMITED is primary or secondary). Status 0 is the one
// exception, rewritten to "no-response" below: classifyGraphql has no status-0 arm, so its
// terminal `fatal` there is not an honest verdict at all.
export function graphqlRecordClassification(
  status: number,
  clsKind: string,
  envelope: { jsonParseable: boolean; data: Record<string, unknown> | null; malformedErrorEntries: number },
): string {
  // NO HTTP RESPONSE FIRST, ahead of the clsKind pass-through: classifyGraphql has no status-0
  // arm, so a network-layer failure falls to its terminal `fatal` branch and would be RECORDED
  // as fatal — the REST lane emits "no-response" for the identical condition, runT1 builds
  // "no-response" R1 evidence from the same dispatch, and a runs.jsonl row calling a network
  // failure fatal misreports a transient condition as a permanent one.
  if (status === 0) return "no-response";
  if (clsKind !== "ok") return clsKind;
  // benchT1's table accepts ONLY status-200 envelopes: production's classifier calls any
  // errorless 2xx "ok" (a proxy-transformed 203/206 included, with gh exiting 0), but the
  // analyzer routes every non-200 to its closed default — an "ok" record there would mint a
  // §4.5 R2 ledger success from a dispatch the driver rejects wholesale.
  if (status !== 200) return "unaccepted-2xx";
  if (!envelope.jsonParseable || envelope.data === null || envelope.malformedErrorEntries > 0) return "malformed-body";
  return clsKind;
}

export async function benchGraphqlDispatch(
  ctx: BenchGhContext,
  query: string,
  fields: Record<string, string>,
  label: string,
  attemptOrdinal = 1, // the chain's physical dispatch ordinal — recorded (codex R2 finding 25)
): Promise<BenchGraphqlDispatch> {
  await waitBucket(ctx, ctx.graphql);
  const args = ["api", "-i", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(fields)) args.push("-f", `${k}=${v}`);
  const startedAt = ctx.now();
  const res = await ctx.client.gh(args);
  const now = ctx.now();
  const parsed = parseGhApiOutput(res.stdout);
  const full = parseGraphqlBodyFull(parsed.body);
  const cls = classifyGraphql(
    parsed.status, parsed.headers,
    full.errors.map((e) => ({ ...(e.type === null ? {} : { type: e.type }), ...(e.message === null ? {} : { message: e.message }) })),
    now,
  );
  const rateLimited = full.errors.some((e) => e.type === "RATE_LIMITED");
  // a FATAL classification (SSO enforcement) is never throttle-like, whatever the body says —
  // production short-circuits SSO before the RATE_LIMITED branch for exactly this reason, and
  // recording it as a secondary signal let a fatal auth condition feed G4's irreversible ≥2
  const secondaryLike = cls.kind === "secondary" || (rateLimited && cls.kind !== "primary" && cls.kind !== "fatal");
  let pointsCost: number | null = null;
  const rl = full.data?.["rateLimit"];
  if (typeof rl === "object" && rl !== null && !Array.isArray(rl)) {
    const cost = (rl as Record<string, unknown>)["cost"];
    // the frozen accounting floor is ONE point per attempt (§4.6 item 2 imputes 1 where no
    // cost is readable, and §4.8 calls the 1-point minimum a floor): a reported cost below the
    // floor is treated as unreadable and imputed, never accepted — a 0 in expectedGraphql
    // would let the run's own 1-point consumption read as R3 foreign interference
    if (typeof cost === "number" && Number.isSafeInteger(cost) && cost >= 1) pointsCost = cost;
  }
  // PRIMARY exhaustion is not a secondary-limit signal: G4's classifier counts attributable
  // secondary signals, and recording a RATE_LIMITED body that classification already keyed as
  // primary (remaining 0) would let two primary exhaustions manufacture a permanent G4 fail —
  // the same remaining-0 exclusion detectRestSecondarySignal applies on the REST side
  const signal: SecondarySignalKind | null = rateLimited && cls.kind !== "primary" && cls.kind !== "fatal"
    ? "graphql-rate-limited"
    : cls.kind === "fatal" ? null : detectRestSecondarySignal(parsed.status, parsed.headers, parsed.body);
  ctx.record({
    type: "http-attempt", atMs: startedAt, wallMs: now - startedAt, kind: "graphql",
    requestClass: "graphql-batch", label, attempt: attemptOrdinal, status: parsed.status, exitCode: res.exitCode,
    classification: graphqlRecordClassification(parsed.status, cls.kind, full),
    secondarySignal: signal, pointsCost,
    remaining: headerInt(parsed.headers["x-ratelimit-remaining"]),
    resetEpochSec: headerInt(parsed.headers["x-ratelimit-reset"]),
    servedFromCache: false,
    bodyBytes: Buffer.byteLength(parsed.body, "utf8"),
  });
  if (cls.kind === "primary") ctx.graphql.pausedUntilMs = Math.max(ctx.graphql.pausedUntilMs, cls.untilMs);
  // a SECONDARY throttle's horizon (Retry-After or the production backoff base) is armed on the
  // bucket too — the next dispatch waits it out and the washout reads it (codex R1 finding 13)
  if (cls.kind === "secondary") {
    // no Retry-After → production's zero-based exponential (base × 2^(ordinal-1)); a fixed
    // base under-armed the horizon on consecutive throttles, undercounting T1's wall and the
    // successor's washout
    const waitMs = cls.waitMs ?? ctx.cfg.rest.secondaryBaseWaitMs * 2 ** Math.min(attemptOrdinal - 1, 5);
    ctx.graphql.pausedUntilMs = Math.max(ctx.graphql.pausedUntilMs, now + waitMs);
  }
  return {
    status: parsed.status, exitCode: res.exitCode, headers: parsed.headers, bodyText: parsed.body,
    data: full.data, errors: full.errors, malformedErrorEntries: full.malformedErrorEntries, jsonParseable: full.jsonParseable,
    classification: cls.kind, secondaryLike,
    primaryUntilMs: cls.kind === "primary" ? cls.untilMs : null,
    pointsCost,
  };
}

// ---- blob-hash validation (T1's per-alias check; T2c's frame check shares the helper) --------
export function gitBlobOid(bytes: Uint8Array, algo: "sha1" | "sha256"): string {
  const h = createHash(algo === "sha1" ? "sha1" : "sha256");
  h.update(`blob ${bytes.byteLength}\0`);
  h.update(bytes);
  return h.digest("hex");
}

// ---- rate_limit snapshots (bucket-delta accounting, §4.6) ------------------------------------
export interface RateLimitSnapshot {
  core: { remaining: number; reset: number; used: number };
  graphql: { remaining: number; reset: number; used: number };
  atMs: number;
}
// Parse one bucket out of a rate_limit response body. These figures drive R3/R4 verdicts and
// the §4.8 reservation, so they are VALIDATED, not cast: a null root previously escaped as a
// raw TypeError, and fractional or negative counters would have become authoritative — a
// fabricated delta can invalidate a run as foreign or admit a run the reservation should block.
export function parseRateLimitBucket(json: unknown, name: string): { remaining: number; reset: number; used: number } {
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new BenchHttpError("rate-limit-shape", "rate_limit response is not an object");
  const resources = (json as Record<string, unknown>)["resources"];
  if (typeof resources !== "object" || resources === null || Array.isArray(resources))
    throw new BenchHttpError("rate-limit-shape", "rate_limit response carries no resources object");
  const r = (resources as Record<string, unknown>)[name];
  if (typeof r !== "object" || r === null || Array.isArray(r))
    throw new BenchHttpError("rate-limit-shape", `rate_limit response missing resources.${name}`);
  const ro = r as Record<string, unknown>;
  const int = (key: string): number => {
    const v = ro[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
      throw new BenchHttpError("rate-limit-shape", `rate_limit resources.${name}.${key} is not a nonnegative integer`);
    return v;
  };
  return { remaining: int("remaining"), reset: int("reset"), used: int("used") };
}

export async function readRateLimit(ctx: BenchGhContext): Promise<RateLimitSnapshot> {
  // rate_limit is documented as not counting against the REST primary limit; it is still a
  // recorded spawn (requestClass rest-meta) so accounting can prove zero unexplained traffic.
  const json = await benchRestJson(ctx, { endpoint: "rate_limit", requestClass: "rest-meta" });
  return { core: parseRateLimitBucket(json, "core"), graphql: parseRateLimitBucket(json, "graphql"), atMs: ctx.now() };
}
