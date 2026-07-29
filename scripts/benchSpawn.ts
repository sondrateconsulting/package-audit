// benchSpawn.ts — the benchmark's ONLY process-launch site (ADR-0001 resolution plan §4.1).
// The repo-wide chokepoint scan in github.test.ts allowlists exactly one launch call in this
// file, mirroring the github.ts discipline. Every launch is git, byte-oriented, and gated by
// its LANE before anything starts:
//
//   • "transport"   — an evaluated-transport operation; argv MUST pass the proposed grammars
//                     (benchGrammar.ts) or nothing is launched.
//   • "scaffolding" — the SHA-pinned acquisition fallback; argv MUST equal the bench-config
//                     pinned tuple verbatim (slots pre-substituted by the caller). Bench
//                     scaffolding, not proposed production grammar (plan §4.1).
//   • "pinning"     — pinning/diagnostic tooling, deliberately unconstrained by grammar
//                     (plan §4.3 "pinning tooling is unconstrained") but still recorded,
//                     containment-checked, and byte-capped.
//
// Streams are consumed as BYTES — no UTF-8 decode ever happens here (the production path's
// irreversible decode is exactly what the framed seam exists to avoid, plan §3.2). Write
// containment (cwd, clone/init destinations) is asserted against the bench root before launch,
// and the kill path copies the production escalation shape: deadline → terminate → grace →
// SIGKILL + best-effort group kill + reader cancellation + unref.

import { assertContained } from "./readOnlyGuard.ts";
import { SPAWN_KILL_GRACE_MS } from "./github.ts";
import {
  assertProposedReadOnlyGit, type BenchObjectFormat, type CloneShape,
} from "./benchGrammar.ts";
import {
  BatchFrameParser, ByteRing, BenchFrameError,
  type BatchExpectation, type BatchFrame,
} from "./benchFrame.ts";

export class BenchSpawnError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`BENCH SPAWN: ${message}`);
    this.name = "BenchSpawnError";
    this.code = code;
  }
}

// ---- lanes -----------------------------------------------------------------------------------
export type BenchLane =
  | { lane: "transport"; objectFormat: BenchObjectFormat; cloneShape?: CloneShape }
  | { lane: "scaffolding"; expectArgv: readonly string[] }
  | { lane: "pinning" };

// Every launch is reported here (argv is the exact vector launched, never a joined string).
export interface BenchSpawnRecord {
  lane: BenchLane["lane"];
  argv: readonly string[];
  cwd: string | null;
  startedAtMs: number;
  wallMs: number;
  exitCode: number | null; // null = never settled inside the bounded wait
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}
export type BenchSpawnObserver = (rec: BenchSpawnRecord) => void;

// ---- structural child shape ------------------------------------------------------------------
// Minimal structural view of the launched child (house precedent: github.ts's StreamReader) —
// enough for byte pumps, stdin writes, and the kill path, without runtime-specific generics.
interface ByteReader {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}
interface StdinSink {
  write(data: Uint8Array): number | Promise<number>;
  flush(): unknown;
  end(): unknown;
}
interface LaunchedChild {
  readonly pid: number;
  readonly stdout: { getReader(): ByteReader };
  readonly stderr: { getReader(): ByteReader };
  readonly stdin: StdinSink | null;
  readonly exited: Promise<number>;
  kill(signal?: number): void;
  unref(): void;
}

function resolveGitBin(env: Record<string, string>): string {
  const path = env["PATH"];
  return (path !== undefined ? Bun.which("git", { PATH: path }) : Bun.which("git")) ?? "git";
}

// THE single launch site. Lane assertion + containment run in the caller wrappers BEFORE this.
function launch(bin: string, argv: readonly string[], opts: {
  env: Record<string, string>; cwd?: string; stdinPipe: boolean;
}): LaunchedChild {
  return Bun.spawn({
    cmd: [bin, ...argv],
    env: opts.env,
    cwd: opts.cwd,
    stdin: opts.stdinPipe ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as LaunchedChild;
}

// production escalation shape (github.ts): terminate now; after the grace, SIGKILL + best-effort
// group kill + reader cancellation + unref, every step a no-op on a clean exit.
function killWithEscalation(child: LaunchedChild, readers: ByteReader[]): void {
  try {
    child.kill();
  } catch {
    // already exited
  }
  const escalate = setTimeout(() => {
    try {
      child.kill(9);
    } catch {
      // already exited
    }
    try {
      process.kill(-child.pid, 9);
    } catch {
      // not a group leader / already gone
    }
    for (const r of readers) r.cancel().catch(() => {});
    child.unref();
  }, SPAWN_KILL_GRACE_MS);
  escalate.unref?.();
}

// ---- lane + containment gate -----------------------------------------------------------------
function assertLane(argv: readonly string[], lane: BenchLane): void {
  if (lane.lane === "transport") {
    assertProposedReadOnlyGit([...argv], { objectFormat: lane.objectFormat, cloneShape: lane.cloneShape });
    return;
  }
  if (lane.lane === "scaffolding") {
    const exp = lane.expectArgv;
    const same = argv.length === exp.length && argv.every((a, i) => a === exp[i]);
    if (!same)
      throw new BenchSpawnError("scaffolding-argv", `argv does not equal the pinned scaffolding tuple: got [${argv.join(" ")}]`);
    return;
  }
  // "pinning": unconstrained by design, recorded by the observer
}

// The write destinations a git argv implies, for containment: a clone's <dest> positional and
// an init's <dir> positional. cwd containment covers everything else the lanes can launch.
function writeDestinations(argv: readonly string[]): string[] {
  const verb = argv[0];
  if (verb === "clone") {
    const positionals: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (a.startsWith("--")) {
        if (!a.includes("=") && (a === "--depth" || a === "--branch" || a === "--template")) i++;
      } else {
        positionals.push(a);
      }
    }
    return positionals.length >= 2 ? [positionals[1]!] : [];
  }
  if (verb === "init") {
    const positionals = argv.slice(1).filter((a) => !a.startsWith("-"));
    return positionals.length > 0 ? [positionals[positionals.length - 1]!] : [];
  }
  return [];
}

function gateLaunch(argv: readonly string[], lane: BenchLane, benchRoot: string, cwd: string | undefined): void {
  assertLane(argv, lane);
  if (cwd !== undefined) assertContained(cwd, [benchRoot]);
  for (const dest of writeDestinations(argv)) assertContained(dest, [benchRoot]);
}

// ---- one-shot capped byte capture ------------------------------------------------------------
export interface BenchGitRequest {
  argv: readonly string[]; // git argv WITHOUT the binary
  lane: BenchLane;
  env: Record<string, string>;
  benchRoot: string;
  cwd?: string;
  limits: { maxStdoutBytes: number; maxStderrBytes: number; deadlineMs: number };
  onRecord?: BenchSpawnObserver;
}
export interface BenchGitResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  timedOut: boolean;
  wallMs: number;
}

async function readAllCapped(reader: ByteReader, cap: number, onExceed: () => void): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) {
      total += value.byteLength;
      if (total > cap) {
        onExceed();
        throw new BenchSpawnError("byte-cap", `stream exceeded ${cap} bytes`);
      }
      chunks.push(value);
    }
    if (done) break;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// Launch one git child, capture BOTH streams as capped bytes, enforce the wall deadline with
// the production escalation, and hold the return until the exit promise settles (callers may
// delete the working directory the moment this resolves).
export async function runBenchGit(req: BenchGitRequest): Promise<BenchGitResult> {
  gateLaunch(req.argv, req.lane, req.benchRoot, req.cwd);
  const startedAtMs = Date.now();
  const bin = resolveGitBin(req.env);
  const child = launch(bin, req.argv, { env: req.env, cwd: req.cwd, stdinPipe: false });
  const outReader = child.stdout.getReader();
  const errReader = child.stderr.getReader();
  const kill = (): void => killWithEscalation(child, [outReader, errReader]);
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    kill();
  }, req.limits.deadlineMs);
  const record = (exitCode: number | null, stdoutBytes: number, stderrBytes: number): void => {
    req.onRecord?.({
      lane: req.lane.lane, argv: req.argv, cwd: req.cwd ?? null, startedAtMs,
      wallMs: Date.now() - startedAtMs, exitCode, timedOut, stdoutBytes, stderrBytes,
    });
  };
  try {
    const guard = (p: Promise<Uint8Array>): Promise<Uint8Array> => {
      p.catch(() => kill()); // ANY reader failure starts the escalation (production posture)
      return p;
    };
    const outP = guard(readAllCapped(outReader, req.limits.maxStdoutBytes, kill));
    const errP = guard(readAllCapped(errReader, req.limits.maxStderrBytes, kill));
    // capture the temporally-first reader error, hold everything until exit (github.ts's
    // joinSpawnOutcome discipline, byte-typed here)
    let firstErr: unknown;
    let failed = false;
    const capture = (p: Promise<Uint8Array>): Promise<Uint8Array> =>
      p.catch((e: unknown) => {
        if (!failed) {
          failed = true;
          firstErr = e;
        }
        return new Uint8Array(0);
      });
    // the exit join is BOUNDED once the deadline fires: a wedged exit promise must not hang
    // the caller, and a SIGTERM race must never surface as a clean {exitCode:0, timedOut:true}
    // outcome (codex R1 finding 15) — after a timeout the result is ALWAYS the synthetic 124.
    const joined = Promise.all([capture(outP), capture(errP), child.exited]);
    let gaveUpTimer: ReturnType<typeof setTimeout> | undefined;
    const bounded = await Promise.race([
      joined,
      new Promise<null>((resolve) => {
        gaveUpTimer = setTimeout(() => resolve(null), req.limits.deadlineMs + SPAWN_KILL_GRACE_MS + 2_000);
      }),
    ]);
    clearTimeout(gaveUpTimer);
    if (bounded === null) {
      record(null, 0, 0);
      throw new BenchSpawnError("exit-wedged", `child never settled within deadline+grace: git ${req.argv[0]}`);
    }
    const [stdout, stderr, exitCode] = bounded;
    // deadline first: an escalation-induced reader cancellation must surface as the promised
    // terminal 124, never as a reader error (codex R2 finding 30)
    if (timedOut) {
      record(124, stdout.byteLength, stderr.byteLength);
      return { exitCode: 124, stdout: new Uint8Array(0), stderr, timedOut: true, wallMs: Date.now() - startedAtMs };
    }
    if (failed) {
      record(exitCode, stdout.byteLength, stderr.byteLength);
      throw firstErr;
    }
    record(exitCode, stdout.byteLength, stderr.byteLength);
    return { exitCode, stdout, stderr, timedOut, wallMs: Date.now() - startedAtMs };
  } finally {
    clearTimeout(deadline);
  }
}

// ---- the unit-lived cat-file --batch child ---------------------------------------------------
export interface BatchChildOptions {
  objectFormat: BenchObjectFormat;
  env: Record<string, string>;
  cwd: string; // the acquired store (clone dir) — containment-checked against benchRoot
  benchRoot: string;
  limits: {
    maxHeaderBytes: number;
    frameCeiling: number;
    stderrRingBytes: number;
    readDeadlineMs: number; // per-read deadline (plan §3.1)
    disposeDeadlineMs: number; // stdin-close → exit wait before escalation
  };
  onRecord?: BenchSpawnObserver;
}

export interface BatchChildDisposal {
  exitCode: number | null; // null = the child never settled inside the bounded waits
  stderrTail: Uint8Array;
  stderrDroppedBytes: number;
  protocolError: string | null; // the fatal condition that poisoned the child, if any
}

interface PendingRead {
  resolve: (frame: BatchFrame) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

// One long-lived interactive child serving pull-style reads: write one format-validated oid
// line, read exactly one frame (plan §3.1). Lifecycle discipline: continuous stdout/stderr
// pumps from birth (a full pipe must never wedge the child), per-read deadline with the kill
// escalation, fatal-poisoning on any framing violation, and an ORDERED teardown — close stdin
// → await exit under a deadline → escalate → await the pumps — so the caller can delete the
// clone directory only after this child is provably gone (plan §3.1 "Teardown is owned and
// ordered").
export class BatchChild {
  private readonly child: LaunchedChild;
  private readonly outReader: ByteReader;
  private readonly errReader: ByteReader;
  private readonly parser: BatchFrameParser;
  private readonly ring: ByteRing;
  private readonly opts: BatchChildOptions;
  private readonly startedAtMs: number;
  private readonly pumpsDone: Promise<void>;
  private pending: PendingRead | null = null;
  private fatal: string | null = null;
  private exitedCode: number | null = null;
  private disposed: Promise<BatchChildDisposal> | null = null;
  private stdoutBytes = 0;
  private stderrBytes = 0;

  constructor(opts: BatchChildOptions) {
    const argv = ["cat-file", "--batch"] as const;
    gateLaunch(argv, { lane: "transport", objectFormat: opts.objectFormat }, opts.benchRoot, opts.cwd);
    this.opts = opts;
    this.parser = new BatchFrameParser(opts.objectFormat, {
      maxHeaderBytes: opts.limits.maxHeaderBytes,
      frameCeiling: opts.limits.frameCeiling,
    });
    this.ring = new ByteRing(opts.limits.stderrRingBytes);
    this.startedAtMs = Date.now();
    this.child = launch(resolveGitBin(opts.env), argv, { env: opts.env, cwd: opts.cwd, stdinPipe: true });
    this.outReader = this.child.stdout.getReader();
    this.errReader = this.child.stderr.getReader();
    this.child.exited.then(
      (code) => {
        this.exitedCode = code;
        // an exit while a read is pending is a protocol failure for that read
        this.poison(`child exited (${code}) mid-conversation`);
      },
      () => this.poison("child exit promise rejected"),
    );
    this.pumpsDone = Promise.all([this.pumpStdout(), this.pumpStderr()]).then(() => undefined);
  }

  private poison(reason: string): void {
    if (this.fatal === null) this.fatal = reason;
    const p = this.pending;
    if (p !== null) {
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(new BenchSpawnError("batch-fatal", reason));
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
        this.stdoutBytes += value.byteLength;
        let frame: BatchFrame | null = null;
        try {
          frame = this.parser.push(value);
        } catch (e) {
          const msg = e instanceof BenchFrameError ? `${e.code}: ${e.message}` : String(e);
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
        // misleading read timeout — a reader failure is fatal and escalates, with the captured
        // ring retained (codex R1 finding 28)
        this.poison(`stderr drain failed: ${e instanceof Error ? e.message : String(e)}`);
        killWithEscalation(this.child, [this.outReader, this.errReader]);
        return;
      }
      if (value !== undefined) {
        this.stderrBytes += value.byteLength;
        this.ring.push(value);
      }
      if (done === true) return;
    }
  }

  // Run-scoped abort (§3.1's ordered abort teardown): poison any pending read NOW, start the
  // kill escalation, and let dispose() own the ordered wait — callers still must await
  // dispose() before deleting the store (codex R1 finding 27).
  abort(reason: string): void {
    this.poison(`aborted: ${reason}`);
    killWithEscalation(this.child, [this.outReader, this.errReader]);
  }

  // Write one oid line, await exactly one frame. The expectation's size is the EXACT per-frame
  // bound (arm() refuses an over-ceiling size before anything is written). One read in flight,
  // structurally: a second concurrent call fails.
  async readObject(expected: BatchExpectation): Promise<BatchFrame> {
    if (this.disposed !== null) throw new BenchSpawnError("batch-disposed", "readObject() after dispose()");
    if (this.fatal !== null) throw new BenchSpawnError("batch-fatal", this.fatal);
    if (this.pending !== null) throw new BenchSpawnError("batch-busy", "a read is already in flight");
    this.parser.arm(expected); // validates oid format + size bound BEFORE the request is written
    const frameP = new Promise<BatchFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.poison(`per-read deadline (${this.opts.limits.readDeadlineMs}ms) expired for ${expected.oid}`);
        killWithEscalation(this.child, [this.outReader, this.errReader]);
      }, this.opts.limits.readDeadlineMs);
      this.pending = { resolve, reject, timer };
    });
    const sink = this.child.stdin;
    if (sink === null) throw new BenchSpawnError("batch-stdin", "child has no stdin pipe");
    try {
      // backpressure-aware: write() may complete asynchronously; flush pushes the line out now
      await sink.write(new TextEncoder().encode(`${expected.oid}\n`));
      await Promise.resolve(sink.flush());
    } catch (e) {
      this.poison(`stdin write failed: ${e instanceof Error ? e.message : String(e)}`);
      killWithEscalation(this.child, [this.outReader, this.errReader]);
    }
    return frameP;
  }

  get protocolError(): string | null {
    return this.fatal;
  }

  // Ordered, idempotent teardown. After this resolves the child is gone (or escalated and
  // unref'd past the bounded waits) and both pumps have ended — ONLY THEN may the caller
  // delete the clone directory and release the child-pool permit (plan §3.1).
  dispose(): Promise<BatchChildDisposal> {
    if (this.disposed !== null) return this.disposed;
    this.disposed = (async (): Promise<BatchChildDisposal> => {
      this.poison("disposed"); // rejects any pending read; first-fatal wins if one is already set
      try {
        const sink = this.child.stdin;
        if (sink !== null) await Promise.resolve(sink.end());
      } catch {
        // stdin already closed/broken — the exit wait below still governs
      }
      const timedWait = async (ms: number): Promise<number | null> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const gaveUp = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        });
        try {
          return await Promise.race([this.child.exited, gaveUp]);
        } finally {
          clearTimeout(timer);
        }
      };
      let exit = await timedWait(this.opts.limits.disposeDeadlineMs);
      if (exit === null) {
        killWithEscalation(this.child, [this.outReader, this.errReader]);
        exit = await timedWait(SPAWN_KILL_GRACE_MS + 1_000);
      }
      // the pumps end when the streams close or their readers are cancelled by the escalation;
      // the join is BOUNDED so a wedged stream cannot hang disposal (codex R2 f.32)
      let pumpTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.pumpsDone,
        new Promise<void>((resolve) => {
          pumpTimer = setTimeout(resolve, SPAWN_KILL_GRACE_MS + 2_000);
        }),
      ]);
      clearTimeout(pumpTimer);
      const snap = this.ring.snapshot();
      this.opts.onRecord?.({
        lane: "transport", argv: ["cat-file", "--batch"], cwd: this.opts.cwd,
        startedAtMs: this.startedAtMs, wallMs: Date.now() - this.startedAtMs,
        exitCode: exit ?? this.exitedCode, timedOut: false,
        stdoutBytes: this.stdoutBytes, stderrBytes: this.stderrBytes,
      });
      return {
        exitCode: exit ?? this.exitedCode,
        stderrTail: snap.bytes,
        stderrDroppedBytes: snap.droppedBytes,
        protocolError: this.fatal === "disposed" ? null : this.fatal,
      };
    })();
    return this.disposed;
  }
}
