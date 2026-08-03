// contentStore.ts — the T2c unit content store (ADR-0001, accepted 2026-08-03): the per-unit
// canonical ls-tree index, the unit-lived `cat-file --batch` child manager (adapted from the
// benchmark's review-hardened prototype in benchSpawn.ts), symlink mode-routing to the injected
// REST dereference fallback under the per-unit budget, and the separated counters (checks 3, 6,
// 7, 8). The store holds NO process surface of its own: every operation that touches a process
// — the one-shot byte capture the enumeration rides, the interactive child launch, the
// child-pool permit, the REST fallback — is an INJECTED capability built from github.ts's
// guarded chokepoint, so the §6 guards run for every operation and this module stays out of the
// repo-wide launch-site scan by construction.
//
// Failure philosophy: every error here is UNIT-scoped — processUnit's catch records it as that
// unit's errors[] row and the run continues. Three fail-closed rules are load-bearing:
//   • the store OPEN checks the enumeration's exit/timeout BEFORE parsing (empty bytes are a
//     LEGAL empty listing, so an unchecked failed capture would read as an empty repo and
//     record zero findings silently);
//   • `<oid> missing` for an oid the unit's own enumeration listed is object-store corruption
//     and fails the unit closed — never the ReadFile seam's benign null, which scanUnit would
//     silently skip;
//   • frame bytes must hash to the enumerated oid (gitBlobOid) BEFORE the seam decode runs.

import {
  killWithEscalation, MAX_SPAWN_OUTPUT_BYTES, SPAWN_KILL_GRACE_MS,
  type GitBytesResult, type LaunchedChild, type StreamReader,
} from "./github.ts";
import {
  BatchFrameParser, ByteRing, GitFrameError, encodeOidRequest, gitBlobOid, parseLsTreeZ, seamDecode,
  type BatchExpectation, type BatchFrame, type GitObjectFormat, type LsTreeEntry,
} from "./gitFrame.ts";
import type { TreeEntry } from "./unitPipeline.ts";

// ---- ratified constants (rvo Q4: the bench trio + the framed-child limits) --------------------
export const CONTENT_READ_DEADLINE_MS = 60_000; // per-read deadline on the interactive child
export const CONTENT_DISPOSE_DEADLINE_MS = 10_000; // stdin-close → exit wait before escalation
export const CONTENT_FRAME_HEADER_BYTES = 256; // bounded pre-LF batch header
export const CONTENT_STDERR_RING_BYTES = 64 * 1024; // capped stderr retention ring
export const LS_TREE_MAX_ENTRIES = 1_000_000; // explicit enumeration bound (replaces the cliff)
export const LS_TREE_MAX_RECORD_BYTES = 64 * 1024; // one NUL-terminated ls-tree record

export interface ContentStoreLimits {
  maxHeaderBytes: number;
  frameCeiling: number; // pinned to the spawn-output cap by the bill — never an independent knob
  stderrRingBytes: number;
  readDeadlineMs: number;
  disposeDeadlineMs: number;
  lsTree: { maxEntries: number; maxRecordBytes: number };
}

export const DEFAULT_CONTENT_STORE_LIMITS: ContentStoreLimits = {
  maxHeaderBytes: CONTENT_FRAME_HEADER_BYTES,
  frameCeiling: MAX_SPAWN_OUTPUT_BYTES,
  stderrRingBytes: CONTENT_STDERR_RING_BYTES,
  readDeadlineMs: CONTENT_READ_DEADLINE_MS,
  disposeDeadlineMs: CONTENT_DISPOSE_DEADLINE_MS,
  lsTree: { maxEntries: LS_TREE_MAX_ENTRIES, maxRecordBytes: LS_TREE_MAX_RECORD_BYTES },
};

// Unit-scoped failure vehicle (NOT an operator error — see cliErrors.test.ts's exclusion note).
// `code` is the machine-checkable discriminant the unit-failure taxonomy and the tests key on.
export class ContentStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`CONTENT STORE: ${message}`);
    this.name = "ContentStoreError";
    this.code = code;
  }
}

// ---- injected capabilities --------------------------------------------------------------------
// Built by the caller from the guarded chokepoint (production wiring: gitBytes with the exact
// enumeration tuple, launchBatchChild, acquireChildPermit, and the apiReader-parity REST read).
export interface ContentStoreCaps {
  runLsTree(cwd: string): Promise<GitBytesResult>;
  launchBatchChild(cwd: string): LaunchedChild;
  acquireChildPermit(): Promise<() => void>;
  // The symlink dereference lane (ratified policy: mode-120000 entries keep today's
  // dereferenced-bytes findings). Its 404 → null parity travels with the injected reader.
  readViaRestFallback(path: string, entry: TreeEntry): Promise<string | null>;
}

export interface ContentStoreOptions {
  cwd: string; // the acquired no-checkout store (already containment-checked by the capabilities)
  format: GitObjectFormat; // derived from the discovery-pinned head oid (oidFormatOf)
  restFallbackBudget: number; // max REST fallback reads this unit may spend (check 8)
  limits?: ContentStoreLimits;
}

export interface ContentStoreCounters {
  localCanonicalReads: number;
  restFallbackReads: { symlink: number };
  fallbackBudgetSpend: number;
  childRespawns: number;
}

// The store-level teardown verdict. `clean` means: no child was ever needed, or the FINAL
// child closed with exit 0 and no protocol fault — `git cat-file --batch` exits 0 on a clean
// stdin close and nothing else, so anything short of that means delivered bytes cannot be
// vouched for and the caller must not record the unit as fully read.
export interface StoreDisposal {
  clean: boolean;
  detail: string | null;
}

// ---- the framed interactive child -------------------------------------------------------------

interface ChildDisposal {
  exitCode: number | null; // null = the child never settled inside the bounded waits
  stderrTail: Uint8Array;
  stderrDroppedBytes: number;
  protocolError: string | null; // the fatal condition that poisoned the child, if any
}

function formatDisposal(d: ChildDisposal): string {
  const stderr = seamDecode(d.stderrTail).trim().slice(0, 300);
  const exit = d.exitCode === null ? "never settled" : `exit ${d.exitCode}`;
  const dropped = d.stderrDroppedBytes > 0 ? ` (+${d.stderrDroppedBytes} stderr bytes dropped)` : "";
  return `${d.protocolError ?? "no protocol fault"}; ${exit}${stderr === "" ? "" : `; stderr: ${stderr}`}${dropped}`;
}

interface PendingRead {
  resolve: (frame: BatchFrame) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

// One unit-lived interactive child serving pull-style reads: write one format-validated oid
// line, read exactly one frame (§3.1). Adapted from the benchmark's reviewed prototype with the
// same disciplines — continuous stdout/stderr pumps from birth (a full pipe must never wedge
// the child), per-read deadline with the kill escalation, fatal poisoning on any framing
// violation, and an ORDERED teardown with every wait BOUNDED, so the caller may delete the
// clone directory once dispose() RESOLVES. Resolution is not a proof of termination: a child
// whose exit never settles is escalated, unref'd, and REPORTED as an unclean disposal. The
// launch itself is the caller's injected capability; this class only owns the lifecycle.
class FramedChild {
  private readonly child: LaunchedChild;
  private readonly format: GitObjectFormat;
  private readonly limits: ContentStoreLimits;
  private readonly outReader: StreamReader;
  private readonly errReader: StreamReader;
  private readonly parser: BatchFrameParser;
  private readonly ring: ByteRing;
  private readonly pumpsDone: Promise<void>;
  private pending: PendingRead | null = null;
  private fatal: string | null = null;
  // a REAL fault observed while draining during teardown: it cannot claim the first-fatal
  // diagnosis slot (that would replace the original cause), but it must still dirty the
  // disposal verdict — a child that emitted protocol garbage on the way out is not clean
  private teardownFault: string | null = null;
  private exitedCode: number | null = null;
  private disposed: Promise<ChildDisposal> | null = null;

  constructor(child: LaunchedChild, format: GitObjectFormat, limits: ContentStoreLimits) {
    this.child = child;
    this.format = format;
    this.limits = limits;
    this.parser = new BatchFrameParser(format, {
      maxHeaderBytes: limits.maxHeaderBytes,
      frameCeiling: limits.frameCeiling,
    });
    this.ring = new ByteRing(limits.stderrRingBytes);
    this.outReader = child.stdout.getReader();
    this.errReader = child.stderr.getReader();
    this.child.exited.then(
      (code) => {
        this.exitedCode = code;
        // Before teardown, an exit is a protocol failure for any pending read. DURING
        // teardown the exit is the goal, not a fault — without this gate the normal
        // stdin-close exit would land in the teardown-fault slot and dirty every clean
        // disposal. (dispose() assigns `disposed` synchronously before any exit
        // notification can run: promise callbacks never fire in the registering tick.)
        if (this.disposed === null) this.poison(`child exited (${code}) mid-conversation`);
      },
      () => {
        // same gate: dispose()'s own bounded exit wait already maps a rejected exit promise
        // to the never-settled (unclean) path
        if (this.disposed === null) this.poison("child exit promise rejected");
      },
    );
    this.pumpsDone = Promise.all([this.pumpStdout(), this.pumpStderr()]).then(() => undefined);
  }

  private poison(reason: string): void {
    if (this.fatal === null) this.fatal = reason; // first fatal wins — it is the diagnosis
    else if (this.fatal === "disposed" && reason !== "disposed" && this.teardownFault === null)
      this.teardownFault = reason; // drain-time fault: preserved for the verdict, never the diagnosis slot
    const p = this.pending;
    if (p !== null) {
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(new ContentStoreError("child-fatal", reason));
    }
  }

  private async pumpStdout(): Promise<void> {
    for (;;) {
      let done: boolean | undefined;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await this.outReader.read());
      } catch (e) {
        this.poison(`stdout read failed: ${e instanceof Error ? e.message : String(e)}`);
        killWithEscalation(this.child, [this.outReader, this.errReader]);
        return;
      }
      if (value !== undefined && value.byteLength > 0) {
        let frame: BatchFrame | null = null;
        try {
          frame = this.parser.push(value);
        } catch (e) {
          const msg = e instanceof GitFrameError ? `${e.code}: ${e.message}` : String(e);
          this.poison(`framing violation — ${msg}`);
          killWithEscalation(this.child, [this.outReader, this.errReader]);
          return;
        }
        if (frame !== null) {
          const p = this.pending;
          if (p === null) {
            this.poison("frame completed with no read pending");
            killWithEscalation(this.child, [this.outReader, this.errReader]);
            return;
          }
          this.pending = null;
          clearTimeout(p.timer);
          p.resolve(frame);
        }
      }
      if (done === true) return;
    }
  }

  private async pumpStderr(): Promise<void> {
    for (;;) {
      let done: boolean | undefined;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await this.errReader.read());
      } catch (e) {
        // an undrained stderr pipe can wedge the child BEFORE its next frame and surface as a
        // misleading read timeout — a reader failure is fatal and escalates, ring retained
        this.poison(`stderr drain failed: ${e instanceof Error ? e.message : String(e)}`);
        killWithEscalation(this.child, [this.outReader, this.errReader]);
        return;
      }
      if (value !== undefined) this.ring.push(value);
      if (done === true) return;
    }
  }

  // Unit-scoped abort (§3.1's ordered abort teardown): poison any pending read NOW, start the
  // kill escalation, and let dispose() own the ordered wait — the caller still must await
  // dispose() before deleting the store.
  abort(reason: string): void {
    this.poison(`aborted: ${reason}`);
    killWithEscalation(this.child, [this.outReader, this.errReader]);
  }

  // Write one oid line, await exactly one frame. arm() refuses an over-ceiling size before
  // anything is written; the bytes that reach stdin are produced by encodeOidRequest or not at
  // all — the OID-only writer IS the stdin containment the argv guard cannot provide (check 2).
  async readObject(expected: BatchExpectation): Promise<BatchFrame> {
    if (this.disposed !== null) throw new ContentStoreError("child-disposed", "readObject() after dispose()");
    if (this.fatal !== null) throw new ContentStoreError("child-fatal", this.fatal);
    if (this.pending !== null) throw new ContentStoreError("child-busy", "a read is already in flight");
    this.parser.arm(expected); // validates oid format + size bound BEFORE the request is written
    const frameP = new Promise<BatchFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.poison(`per-read deadline (${this.limits.readDeadlineMs}ms) expired for ${expected.oid}`);
        killWithEscalation(this.child, [this.outReader, this.errReader]);
      }, this.limits.readDeadlineMs);
      this.pending = { resolve, reject, timer };
    });
    const sink = this.child.stdin;
    if (sink === null) {
      this.poison("child has no stdin pipe");
    } else {
      // DETACHED on purpose: the frame promise — governed by the per-read deadline — is
      // returned immediately, so a stalled structural sink can neither hold readObject past
      // the deadline nor leave the deadline's rejection unobserved. Write failures (an
      // encodeOidRequest refusal included: a request that cannot be validated is never
      // written) still poison through the same path, rejecting the pending read.
      void (async (): Promise<void> => {
        try {
          // backpressure-aware: write() may complete asynchronously; flush pushes the line out
          await sink.write(encodeOidRequest(expected.oid, this.format));
          await Promise.resolve(sink.flush());
        } catch (e) {
          this.poison(`stdin write failed: ${e instanceof Error ? e.message : String(e)}`);
          killWithEscalation(this.child, [this.outReader, this.errReader]);
        }
      })();
    }
    return frameP;
  }

  // Ordered, idempotent teardown, every wait BOUNDED: close stdin → await exit under the
  // dispose deadline (kill-escalate on expiry) → join the pumps (bounded) → report. Once this
  // RESOLVES the store may release the child permit and the caller may delete the clone.
  dispose(): Promise<ChildDisposal> {
    if (this.disposed !== null) return this.disposed;
    this.disposed = (async (): Promise<ChildDisposal> => {
      this.poison("disposed"); // rejects any pending read; first-fatal wins if one is already set
      try {
        const sink = this.child.stdin;
        // BOUNDED: a wedged async sink.end must not hang disposal — the exit wait below
        // governs teardown either way
        if (sink !== null) {
          let endTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            Promise.resolve(sink.end()).catch(() => undefined),
            new Promise<void>((resolve) => {
              endTimer = setTimeout(resolve, SPAWN_KILL_GRACE_MS);
            }),
          ]);
          clearTimeout(endTimer);
        }
      } catch {
        // stdin already closed/broken — the exit wait below still governs
      }
      const timedWait = async (ms: number): Promise<number | null> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const gaveUp = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        });
        try {
          // a REJECTED exit promise must not escape dispose() before the escalation and pump
          // join run — it reads as "never settled", keeping the disposal unclean
          return await Promise.race([this.child.exited.then((c) => c, () => null), gaveUp]);
        } finally {
          clearTimeout(timer);
        }
      };
      let exit = await timedWait(this.limits.disposeDeadlineMs);
      if (exit === null) {
        killWithEscalation(this.child, [this.outReader, this.errReader]);
        exit = await timedWait(SPAWN_KILL_GRACE_MS + 1_000);
      }
      // the pumps end when the streams close or their readers are cancelled by the escalation;
      // the join is BOUNDED so a wedged stream cannot hang disposal
      let pumpTimer: ReturnType<typeof setTimeout> | undefined;
      let pumpsWedged = true;
      await Promise.race([
        this.pumpsDone.then(() => {
          pumpsWedged = false;
        }),
        new Promise<void>((resolve) => {
          pumpTimer = setTimeout(resolve, SPAWN_KILL_GRACE_MS + 2_000);
        }),
      ]);
      clearTimeout(pumpTimer);
      if (pumpsWedged) {
        // a pump that never settled means the stream state cannot be vouched for — REQUEST the
        // cancellations, wait only a BOUNDED interval, and surface the wedge as unclean
        let cancelTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled([this.outReader, this.errReader].map((r) => r.cancel())),
          new Promise<void>((resolve) => {
            cancelTimer = setTimeout(resolve, SPAWN_KILL_GRACE_MS);
          }),
        ]);
        clearTimeout(cancelTimer);
        if (this.fatal === null || this.fatal === "disposed")
          this.fatal = "stream pumps did not settle within the bounded dispose wait";
      }
      const snap = this.ring.snapshot();
      return {
        exitCode: exit ?? this.exitedCode,
        stderrTail: snap.bytes,
        stderrDroppedBytes: snap.droppedBytes,
        // "disposed" alone is a clean teardown poison — but a fault observed while draining
        // (teardownFault) still dirties the verdict
        protocolError: this.fatal === "disposed" ? this.teardownFault : this.fatal,
      };
    })();
    return this.disposed;
  }
}

// ---- the unit content store -------------------------------------------------------------------

// Open a unit's content store over an acquired no-checkout clone: run the guarded enumeration,
// check its exit/timeout FIRST (a failed capture must never read as an empty repo), then parse
// fail-closed into the canonical index.
export async function openUnitContentStore(caps: ContentStoreCaps, opts: ContentStoreOptions): Promise<UnitContentStore> {
  const limits = opts.limits ?? DEFAULT_CONTENT_STORE_LIMITS;
  if (!Number.isSafeInteger(opts.restFallbackBudget) || opts.restFallbackBudget < 0)
    throw new ContentStoreError("budget", `restFallbackBudget must be a nonnegative safe integer (got ${opts.restFallbackBudget})`);
  const res = await caps.runLsTree(opts.cwd);
  if (res.timedOut)
    throw new ContentStoreError("ls-tree-failed", `enumeration timed out for the store at ${opts.cwd}`);
  if (res.exitCode !== 0)
    throw new ContentStoreError(
      "ls-tree-failed",
      `enumeration failed (exit ${res.exitCode}): ${seamDecode(res.stderr).trim().slice(0, 300)}`,
    );
  const entries = parseLsTreeZ(res.stdout, opts.format, limits.lsTree);
  return new UnitContentStore(caps, opts, limits, new Map(entries.map((e) => [e.path, e])));
}

export class UnitContentStore {
  readonly counters: ContentStoreCounters = {
    localCanonicalReads: 0,
    restFallbackReads: { symlink: 0 },
    fallbackBudgetSpend: 0,
    childRespawns: 0,
  };
  private readonly caps: ContentStoreCaps;
  private readonly cwd: string;
  private readonly format: GitObjectFormat;
  private readonly budget: number;
  private readonly limits: ContentStoreLimits;
  private readonly index: Map<string, LsTreeEntry>;
  private child: FramedChild | null = null;
  private permitRelease: (() => void) | null = null;
  private respawns = 0;
  private firstDisposal: ChildDisposal | null = null;
  private abortedReason: string | null = null;
  private disposedP: Promise<StoreDisposal> | null = null;
  private readInFlight = false;

  constructor(caps: ContentStoreCaps, opts: ContentStoreOptions, limits: ContentStoreLimits, index: Map<string, LsTreeEntry>) {
    this.caps = caps;
    this.cwd = opts.cwd;
    this.format = opts.format;
    this.budget = opts.restFallbackBudget;
    this.limits = limits;
    this.index = index;
  }

  // The unit's enumeration as the pipeline's TreeEntry rows: canonical ls-tree object sizes
  // (so the 2 MiB gate reads canonical sizes by construction), the oid in the sha slot, and
  // tree/commit rows carried through with null size exactly as the REST listing carried them.
  entries(): TreeEntry[] {
    return [...this.index.values()].map((e) => ({ path: e.path, type: e.type, sha: e.oid, size: e.size }));
  }

  // The ReadFile seam (unitPipeline): resolve a repo-relative path to its text, or null where
  // the REST reader answered null today (non-blob entries; the fallback's 404 parity). Every
  // OTHER miss fails closed — this index cannot race the reads it serves.
  async read(path: string, entry: TreeEntry): Promise<string | null> {
    if (this.disposedP !== null) throw new ContentStoreError("store-disposed", `read of ${path} after dispose()`);
    if (this.abortedReason !== null)
      throw new ContentStoreError("aborted", `read of ${path} aborted: ${this.abortedReason}`);
    if (this.readInFlight)
      throw new ContentStoreError("busy", "one read in flight at a time — the seam is pull-style by contract");
    const ls = this.index.get(path);
    if (ls === undefined)
      throw new ContentStoreError(
        "unknown-path",
        `${path} is not in the unit's own enumeration — a local index cannot race its reads, so absence is a wiring fault, never a benign miss`,
      );
    if (ls.type !== "blob") return null; // tree/commit entries: reader parity with the REST path
    if (ls.mode === "120000") return this.readSymlink(path, entry);
    const size = ls.size;
    if (size === null)
      throw new ContentStoreError("internal", `blob ${path} carries no enumerated size`); // parseLsTreeZ guarantees otherwise
    if (size > this.limits.frameCeiling)
      throw new ContentStoreError(
        "over-ceiling",
        `declared size ${size} of ${path} exceeds the absolute frame ceiling ${this.limits.frameCeiling} — refused before any request is written, failing as a cap-killed fetch fails today`,
      );
    this.readInFlight = true;
    try {
      let frame: BatchFrame;
      try {
        frame = await (await this.ensureChild()).readObject({ oid: ls.oid, size });
      } catch (e) {
        frame = await this.retryOnceOnFreshChild(ls.oid, size, path, e);
      }
      if (frame.kind === "missing")
        throw new ContentStoreError(
          "object-missing",
          `object-store corruption: ${path}'s enumerated oid ${ls.oid} is missing from the acquired store — the unit fails closed, never the seam's benign null`,
        );
      // self-verification BEFORE the seam decode: the frame bytes must hash to the tree oid
      if (gitBlobOid(frame.body, this.format) !== ls.oid)
        throw new ContentStoreError("hash-mismatch", `frame bytes do not hash to the enumerated oid at ${path}`);
      this.counters.localCanonicalReads++;
      return seamDecode(frame.body);
    } finally {
      this.readInFlight = false;
    }
  }

  private async readSymlink(path: string, entry: TreeEntry): Promise<string | null> {
    // trip BEFORE spending: the (budget+1)th fallback read must terminate the unit with the
    // distinct budget failure, not perform a request past the bound (check 8)
    if (this.counters.fallbackBudgetSpend >= this.budget)
      throw new ContentStoreError(
        "fallback-budget",
        `REST fallback budget (${this.budget}) exhausted at ${path} — the unit fails rather than exceeding its bounded API spend`,
      );
    this.readInFlight = true;
    try {
      this.counters.fallbackBudgetSpend++;
      this.counters.restFallbackReads.symlink++;
      const text = await this.caps.readViaRestFallback(path, entry);
      // an abort that landed while the request was in flight must reject THIS read — a
      // post-abort delivery would hand scanUnit content for a unit already being torn down
      // (the child route gets the same rejection through the poison path). The spend stands:
      // the request was already issued when the abort arrived.
      if (this.abortedReason !== null)
        throw new ContentStoreError("aborted", `read of ${path} aborted: ${this.abortedReason}`);
      return text;
    } finally {
      this.readInFlight = false;
    }
  }

  private async ensureChild(): Promise<FramedChild> {
    if (this.child !== null) return this.child;
    // lazy spawn at the unit's first canonical read (§3.1). The permit is acquired ONCE and
    // held across a respawn — the pool bounds LIVE-CHILD-HOLDING UNITS, and a unit between
    // child deaths is still one such unit.
    if (this.permitRelease === null) {
      const release = await this.caps.acquireChildPermit();
      // The grant can arrive AFTER an abort/dispose landed (a read queued on a saturated
      // pool): hand the permit STRAIGHT back and surface the store's state — a child
      // launched here would outlive every teardown (dispose() has already returned its
      // verdict) and the permit assignment below would never be released.
      if (this.abortedReason !== null || this.disposedP !== null) {
        release();
        if (this.abortedReason !== null)
          throw new ContentStoreError("aborted", `child launch abandoned: ${this.abortedReason}`);
        throw new ContentStoreError("store-disposed", "child launch abandoned: the store is disposed");
      }
      this.permitRelease = release;
    }
    this.child = new FramedChild(this.caps.launchBatchChild(this.cwd), this.format, this.limits);
    return this.child;
  }

  // At most ONE respawn per unit (§3.1): dispose the dead child (RETAINING its disposal as the
  // diagnosis — git's own stderr, the poisoning cause), replace it, retry the read once. A
  // second death fails the unit with the FIRST child's diagnosis attached. Abort/dispose
  // rejections surface as themselves — they must never burn the respawn allowance on a doomed
  // retry.
  private async retryOnceOnFreshChild(oid: string, size: number, path: string, firstError: unknown): Promise<BatchFrame> {
    if (this.abortedReason !== null)
      throw new ContentStoreError("aborted", `read of ${path} aborted: ${this.abortedReason}`);
    if (this.disposedP !== null) throw new ContentStoreError("store-disposed", `read of ${path} after dispose()`);
    const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    const withFirst = (msg: string): string =>
      `${msg}${this.firstDisposal === null ? "" : ` — first child: ${formatDisposal(this.firstDisposal)}`}`;
    if (this.respawns >= 1)
      throw new ContentStoreError("child-died-twice", withFirst(`batch child died twice: ${describe(firstError)}`));
    this.respawns++;
    this.counters.childRespawns++;
    this.firstDisposal = this.child === null ? null : await this.child.dispose();
    this.child = null;
    // an abort/dispose that landed DURING the dead child's teardown stops the respawn — a
    // replacement launched now would outlive the store's own teardown (the same grant-gap
    // hazard ensureChild closes at the permit)
    if (this.abortedReason !== null)
      throw new ContentStoreError("aborted", `read of ${path} aborted: ${this.abortedReason}`);
    if (this.disposedP !== null) throw new ContentStoreError("store-disposed", `read of ${path} after dispose()`);
    try {
      return await (await this.ensureChild()).readObject({ oid, size });
    } catch (e2) {
      // an immediately-failing REPLACEMENT is the same double death — the FIRST child's
      // retained diagnosis matters most on exactly this path
      throw new ContentStoreError("child-died-twice", withFirst(`batch child died twice: ${describe(e2)}`));
    }
  }

  // Unit-scoped abort (threaded from branchAbort in the rewiring phase): poison any in-flight
  // read now; the ordered teardown still runs through dispose(), which the unit's own finally
  // owns.
  abort(reason: string): void {
    if (this.abortedReason === null) this.abortedReason = reason;
    this.child?.abort(reason);
  }

  // Ordered, idempotent store teardown: the child's full bounded teardown FIRST, the child-pool
  // permit release only after it — and only after THIS resolves may the caller delete the clone
  // directory (§3.1 "Teardown is owned and ordered"), on completion, failure, and abort alike.
  dispose(): Promise<StoreDisposal> {
    if (this.disposedP !== null) return this.disposedP;
    this.disposedP = (async (): Promise<StoreDisposal> => {
      let verdict: StoreDisposal = { clean: true, detail: null };
      if (this.child !== null) {
        try {
          const d = await this.child.dispose();
          if (d.exitCode !== 0 || d.protocolError !== null) verdict = { clean: false, detail: formatDisposal(d) };
        } catch (e) {
          // a REJECTED dispose() must surface as an unclean verdict, never evaporate
          verdict = { clean: false, detail: `child dispose() itself failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      // permit release strictly AFTER the child teardown, as its own step, so a rejected child
      // dispose can never leak the permit
      this.permitRelease?.();
      this.permitRelease = null;
      return verdict;
    })();
    return this.disposedP;
  }
}
