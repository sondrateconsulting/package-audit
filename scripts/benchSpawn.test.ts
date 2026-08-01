// benchSpawn.test.ts — integration tests for the benchmark's single launch site against REAL
// local git (house precedent: apiSurface.test.ts runs real system tar). Everything here is
// offline: a throwaway repo under a pa-bench-* temp root, built through the PINNING lane
// (unconstrained by design, plan §4.3), then exercised through the TRANSPORT lane's proposed
// grammars — ls-tree bytes into parseLsTreeZ, and the unit-lived interactive batch child.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadOnlyViolation } from "./readOnlyGuard.ts";
import { BenchGrammarViolation } from "./benchGrammar.ts";
import { parseLsTreeZ } from "./benchFrame.ts";
import {
  BatchChild, BenchSpawnError, runBenchGit, substituteTuple,
  type BenchGitRequest, type BenchSpawnRecord,
} from "./benchSpawn.ts";

const BENCH_ROOT = mkdtempSync(join(realpathSync(tmpdir()), "pa-bench-test-"));
const REPO = join(BENCH_ROOT, "repo");
const GITCFG = join(BENCH_ROOT, "gitconfig");
const ENV: Record<string, string> = {
  PATH: process.env["PATH"] ?? "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: GITCFG,
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  NO_COLOR: "1",
  TERM: "dumb",
};
const LIMITS = { maxStdoutBytes: 10 * 1024 * 1024, maxStderrBytes: 1024 * 1024, deadlineMs: 60_000 };

const pin = (argv: string[], cwd?: string, over?: Partial<BenchGitRequest>): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> =>
  runBenchGit({ argv, lane: { lane: "pinning" }, env: ENV, benchRoot: BENCH_ROOT, cwd, limits: LIMITS, ...over });

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

let headOid = "";
let blobOid = "";

beforeAll(async () => {
  writeFileSync(GITCFG, `[user]\n\tname = bench\n\temail = bench@example.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n`);
  expect((await pin(["init", "-q", REPO])).exitCode).toBe(0);
  writeFileSync(join(REPO, "hello.txt"), "hello framed seam\n");
  writeFileSync(join(REPO, "tab\tname.txt"), "tabbed\n"); // a legal-but-hostile path byte
  writeFileSync(join(REPO, "run.sh"), "#!/bin/sh\necho hi\n");
  symlinkSync("hello.txt", join(REPO, "link")); // mode 120000 in the committed tree
  expect((await pin(["add", "-A"], REPO)).exitCode).toBe(0);
  expect((await pin(["commit", "-q", "-m", "fixture"], REPO)).exitCode).toBe(0);
  const rev = await runBenchGit({
    argv: ["rev-parse", "HEAD"], lane: { lane: "transport", objectFormat: "sha1" },
    env: ENV, benchRoot: BENCH_ROOT, cwd: REPO, limits: LIMITS,
  });
  headOid = text(rev.stdout).trim();
  expect(headOid).toMatch(/^[0-9a-f]{40}$/);
});
afterAll(() => {
  rmSync(BENCH_ROOT, { recursive: true, force: true });
});

describe("lane gating happens BEFORE anything launches", () => {
  test("transport lane rejects off-grammar argv with no launch and no record", async () => {
    const records: BenchSpawnRecord[] = [];
    await expect(
      runBenchGit({
        argv: ["log", "--oneline"], lane: { lane: "transport", objectFormat: "sha1" },
        env: ENV, benchRoot: BENCH_ROOT, cwd: REPO, limits: LIMITS, onRecord: (r) => records.push(r),
      }),
    ).rejects.toThrow(BenchGrammarViolation);
    expect(records).toEqual([]); // nothing launched, nothing recorded
  });
  // The scaffolding lane DERIVES its argv from the pinned tuple + slots inside runBenchGit.
  // The previous shape compared a caller-substituted argv against a caller-supplied expectArgv,
  // and every production caller passed the SAME object as both — a gate that could never fail.
  test("scaffolding argv is derived from the pinned tuple; the record carries the substitution", async () => {
    const records: BenchSpawnRecord[] = [];
    const res = await runBenchGit({
      lane: { lane: "scaffolding", tuple: ["rev-parse", "{what}"], slots: { what: "--git-dir" } },
      env: ENV, benchRoot: BENCH_ROOT, cwd: REPO, limits: LIMITS, onRecord: (r) => records.push(r),
    });
    expect(res.exitCode).toBe(0);
    expect(records.map((r) => [...r.argv])).toEqual([["rev-parse", "--git-dir"]]);
  });
  test("a caller-supplied argv on the scaffolding lane is rejected — it would bypass the single source", async () => {
    const records: BenchSpawnRecord[] = [];
    await expect(
      runBenchGit({
        argv: ["checkout", "--detach", "FETCH_HEAD"],
        lane: { lane: "scaffolding", tuple: ["checkout", "--detach", "FETCH_HEAD"], slots: {} },
        env: ENV, benchRoot: BENCH_ROOT, cwd: REPO, limits: LIMITS, onRecord: (r) => records.push(r),
      }),
    ).rejects.toThrow(BenchSpawnError);
    expect(records).toEqual([]); // nothing launched, nothing recorded
  });
  test("a tuple slot with no substitution fails closed before anything launches", async () => {
    const records: BenchSpawnRecord[] = [];
    await expect(
      runBenchGit({
        lane: { lane: "scaffolding", tuple: ["fetch", "origin", "{sha}"], slots: {} },
        env: ENV, benchRoot: BENCH_ROOT, cwd: REPO, limits: LIMITS, onRecord: (r) => records.push(r),
      }),
    ).rejects.toThrow(/slot \{sha\} has no substitution/);
    expect(records).toEqual([]);
  });
  test("substituteTuple substitutes every {slot} and leaves literal tokens alone", () => {
    expect(substituteTuple(["init", "--template=", "--object-format={objectFormat}", "{dest}"], { objectFormat: "sha1", dest: "/tmp/x" }))
      .toEqual(["init", "--template=", "--object-format=sha1", "/tmp/x"]);
  });
  test("cwd outside the bench root is a containment violation, launch never happens", async () => {
    await expect(pin(["status"], realpathSync(tmpdir()))).rejects.toThrow(ReadOnlyViolation);
  });
});

describe("one-shot byte capture", () => {
  test("transport ls-tree bytes parse: modes incl. 120000 symlink and TAB-in-path survive", async () => {
    const res = await runBenchGit({
      argv: ["ls-tree", "-r", "-z", "-l", "--full-tree", "HEAD"],
      lane: { lane: "transport", objectFormat: "sha1" },
      env: ENV, benchRoot: BENCH_ROOT, cwd: REPO, limits: LIMITS,
    });
    expect(res.exitCode).toBe(0);
    const entries = parseLsTreeZ(res.stdout, "sha1", { maxEntries: 100, maxRecordBytes: 4096 });
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(byPath.get("hello.txt")?.mode).toBe("100644");
    expect(byPath.get("hello.txt")?.size).toBe("hello framed seam\n".length);
    expect(byPath.get("link")?.mode).toBe("120000");
    expect(byPath.get("link")?.size).toBe("hello.txt".length); // the LINK payload, canonically sized
    expect(byPath.get("tab\tname.txt")?.mode).toBe("100644"); // first-TAB split kept the path's TAB
    blobOid = byPath.get("hello.txt")!.oid;
  });
  test("the stdout byte cap kills and surfaces as a BenchSpawnError", async () => {
    await expect(
      pin(["cat-file", "blob", blobOid], REPO, { limits: { ...LIMITS, maxStdoutBytes: 4 } }),
    ).rejects.toThrow(BenchSpawnError);
  });
  test("the observer records lane and exit for each launch", async () => {
    const records: BenchSpawnRecord[] = [];
    await pin(["rev-parse", "--git-dir"], REPO, { onRecord: (r) => records.push(r) });
    expect(records.length).toBe(1);
    expect(records[0]!.lane).toBe("pinning");
    expect(records[0]!.exitCode).toBe(0);
    expect(records[0]!.stdoutBytes).toBeGreaterThan(0);
    expect(records[0]!.timedOut).toBe(false);
  });
});

describe("BatchChild — the unit-lived interactive seam", () => {
  const childOpts = () => ({
    objectFormat: "sha1" as const,
    env: ENV, cwd: REPO, benchRoot: BENCH_ROOT,
    limits: { maxHeaderBytes: 256, frameCeiling: 1024 * 1024, stderrRingBytes: 4096, readDeadlineMs: 30_000, disposeDeadlineMs: 5_000 },
  });
  test("pull-style reads: one oid line in, exactly one verified frame out; ordered dispose", async () => {
    const child = new BatchChild(childOpts());
    const frame = await child.readObject({ oid: blobOid, size: "hello framed seam\n".length });
    if (frame.kind !== "content") throw new Error("expected content");
    expect(text(frame.body)).toBe("hello framed seam\n");
    const again = await child.readObject({ oid: blobOid, size: "hello framed seam\n".length });
    expect(again.kind).toBe("content");
    const disposal = await child.dispose();
    expect(disposal.exitCode).toBe(0); // stdin close ends --batch cleanly
    expect(disposal.protocolError).toBeNull();
    await expect(child.readObject({ oid: blobOid, size: 5 })).rejects.toThrow(BenchSpawnError);
  });
  test("an oid git does not serve yields a missing frame", async () => {
    const child = new BatchChild(childOpts());
    const frame = await child.readObject({ oid: "0123456789".repeat(4), size: 1 });
    expect(frame).toEqual({ kind: "missing", oid: "0123456789".repeat(4) });
    await child.dispose();
  });
  test("a size disagreeing with the enumeration is a fatal protocol violation that kills the child", async () => {
    const child = new BatchChild(childOpts());
    await expect(child.readObject({ oid: blobOid, size: 3 })).rejects.toThrow(BenchSpawnError);
    expect(child.protocolError).toContain("size-mismatch");
    const disposal = await child.dispose();
    expect(disposal.protocolError).toContain("size-mismatch");
  });
  test("an over-ceiling declared size is refused BEFORE any request is written", async () => {
    const child = new BatchChild({ ...childOpts(), limits: { ...childOpts().limits, frameCeiling: 4 } });
    await expect(child.readObject({ oid: blobOid, size: 18 })).rejects.toThrow(/over-ceiling|ceiling/);
    // the child was never spoken to and is still healthy — dispose is clean
    const disposal = await child.dispose();
    expect(disposal.protocolError).toBeNull();
    expect(disposal.exitCode).toBe(0);
  });
});

describe("BatchChild — a fired per-read deadline is durable TIMEOUT evidence (§4.6 item 5)", () => {
  test("the disposal spawn record carries timedOut:true after a read deadline fires", async () => {
    // Deterministic: a fake `git` that never replies is the ONLY entry on the child's PATH, so
    // the per-read deadline ALWAYS fires — no race against a real cat-file's reply. The fake
    // must block using shell BUILTINS only: that same one-entry PATH is inherited by the script,
    // so an external command (`sleep`) would fail lookup and exit the fake instantly — on a fast
    // runner that death reached the pending read before the 50 ms deadline and the rejection
    // carried a non-deadline error (caught as a CI-only flake). `while read` consumes whatever
    // the harness writes, then blocks until dispose closes stdin. The disposal's spawn record
    // previously hardcoded timedOut:false, hiding real interactive-read timeouts from the run
    // evidence.
    const fakeBin = mkdtempSync(join(realpathSync(tmpdir()), "pa-bench-fakegit-"));
    writeFileSync(join(fakeBin, "git"), "#!/bin/sh\nwhile read _x; do :; done\n", { mode: 0o755 });
    const records: BenchSpawnRecord[] = [];
    const child = new BatchChild({
      objectFormat: "sha1", env: { ...ENV, PATH: fakeBin }, cwd: REPO, benchRoot: BENCH_ROOT,
      limits: { maxHeaderBytes: 256, frameCeiling: 1024 * 1024, stderrRingBytes: 4096, readDeadlineMs: 50, disposeDeadlineMs: 500 },
      onRecord: (r) => records.push(r),
    });
    try {
      await expect(child.readObject({ oid: "c".repeat(40), size: 10 })).rejects.toThrow(/deadline/);
    } finally {
      const disposal = await child.dispose();
      expect(disposal.protocolError).toContain("deadline");
      rmSync(fakeBin, { recursive: true, force: true });
    }
    expect(records.length).toBe(1);
    expect(records[0]?.timedOut).toBe(true);
  });
});
