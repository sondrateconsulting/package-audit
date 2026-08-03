// benchFrame.test.ts — CI unit tests for the framed-seam parsers, including the plan-mandated
// synthetic fixtures: invalid-UTF-8 paths, TAB/LF-in-path records, and malformed frames
// (resolution plan §4.1 "its parser is a pure function with CI unit tests").
import { describe, expect, test } from "bun:test";
import { BatchFrameParser, BenchFrameError, ByteRing, parseLsTreeZ, type LsTreeLimits } from "./benchFrame.ts";

const te = new TextEncoder();
const OID = "ab".repeat(20); // 40-hex sha1
const OID2 = "cd".repeat(20);
const OID256 = "ef".repeat(32); // 64-hex sha256
const LIMITS = { maxHeaderBytes: 256, frameCeiling: 1024 * 1024 };

const bytes = (...parts: Array<string | Uint8Array | number[]>): Uint8Array => {
  const chunks = parts.map((p) => (typeof p === "string" ? te.encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof BenchFrameError) return e.code;
    throw e;
  }
  throw new Error("expected a BenchFrameError");
};

describe("BatchFrameParser — content frames", () => {
  test("one frame in one chunk, LF trailer consumed, parser returns to idle", () => {
    const p = new BatchFrameParser("sha1", LIMITS);
    p.arm({ oid: OID, size: 5 });
    const frame = p.push(bytes(`${OID} blob 5\n`, "hello", "\n"));
    expect(frame).not.toBeNull();
    expect(frame!.kind).toBe("content");
    if (frame!.kind === "content") {
      expect(frame!.size).toBe(5);
      expect(new TextDecoder().decode(frame!.body)).toBe("hello");
    }
    p.arm({ oid: OID2, size: 0 }); // idle again — a second arm succeeds
  });
  test("a frame split across arbitrary chunk boundaries (header / body / trailer)", () => {
    const p = new BatchFrameParser("sha1", LIMITS);
    p.arm({ oid: OID, size: 4 });
    expect(p.push(bytes(`${OID} bl`))).toBeNull();
    expect(p.push(bytes(`ob 4\nab`))).toBeNull();
    expect(p.push(bytes(`cd`))).toBeNull();
    const frame = p.push(bytes(`\n`));
    expect(frame?.kind).toBe("content");
  });
  test("a zero-size blob is a legal frame", () => {
    const p = new BatchFrameParser("sha1", LIMITS);
    p.arm({ oid: OID, size: 0 });
    const frame = p.push(bytes(`${OID} blob 0\n\n`));
    expect(frame?.kind).toBe("content");
    if (frame?.kind === "content") expect(frame.body.byteLength).toBe(0);
  });
  test("body bytes are raw — an LF inside the body is data, not framing", () => {
    const p = new BatchFrameParser("sha1", LIMITS);
    p.arm({ oid: OID, size: 3 });
    const frame = p.push(bytes(`${OID} blob 3\n`, [0x0a, 0x00, 0xff], "\n"));
    if (frame?.kind !== "content") throw new Error("expected content");
    expect([...frame.body]).toEqual([0x0a, 0x00, 0xff]);
  });
});

describe("BatchFrameParser — missing records and violations", () => {
  test("`<oid> missing` yields a missing frame", () => {
    const p = new BatchFrameParser("sha1", LIMITS);
    p.arm({ oid: OID, size: 9 });
    const frame = p.push(bytes(`${OID} missing\n`));
    expect(frame).toEqual({ kind: "missing", oid: OID });
  });
  test("malformed frames are fatal, each with its own code", () => {
    const arm = (expected = { oid: OID, size: 5 }) => {
      const p = new BatchFrameParser("sha1", LIMITS);
      p.arm(expected);
      return p;
    };
    expect(code(() => arm().push(bytes(`${OID2} blob 5\nhello\n`)))).toBe("echo-mismatch");
    expect(code(() => arm().push(bytes(`${OID2} missing\n`)))).toBe("echo-mismatch");
    expect(code(() => arm().push(bytes(`${OID} tree 5\nhello\n`)))).toBe("type-mismatch");
    expect(code(() => arm().push(bytes(`${OID} blob 6\nhello!\n`)))).toBe("size-mismatch");
    expect(code(() => arm().push(bytes(`${OID} blob 05\nhello\n`)))).toBe("size-shape");
    expect(code(() => arm().push(bytes(`${OID} blob +5\nhello\n`)))).toBe("size-shape");
    expect(code(() => arm().push(bytes(`${OID} blob\nhello\n`)))).toBe("header-shape");
    expect(code(() => arm().push(bytes(`${OID} blob 5 x\nhello\n`)))).toBe("header-shape");
    expect(code(() => arm().push(bytes(`${OID} blob 5\nhellox`)))).toBe("trailer");
    expect(code(() => arm().push(bytes([0xc3, 0x28], ` blob 5\n`)))).toBe("meta-nonascii");
  });
  test("an unterminated header beyond the bound is fatal and kills forward progress", () => {
    const p = new BatchFrameParser("sha1", { maxHeaderBytes: 16, frameCeiling: 100 });
    p.arm({ oid: OID, size: 1 });
    expect(code(() => p.push(bytes("x".repeat(17))))).toBe("header-unterminated");
    expect(code(() => p.push(bytes("\n")))).toBe("poisoned");
    expect(code(() => p.arm({ oid: OID, size: 1 }))).toBe("poisoned");
  });
  test("one-request/one-frame correspondence is structural", () => {
    const idle = new BatchFrameParser("sha1", LIMITS);
    expect(code(() => idle.push(bytes("unsolicited")))).toBe("unsolicited");
    const p = new BatchFrameParser("sha1", LIMITS);
    p.arm({ oid: OID, size: 2 });
    expect(code(() => p.push(bytes(`${OID} blob 2\nok\nEXTRA`)))).toBe("trailing");
    const busy = new BatchFrameParser("sha1", LIMITS);
    busy.arm({ oid: OID, size: 2 });
    expect(code(() => busy.arm({ oid: OID2, size: 2 }))).toBe("busy");
  });
  test("arm() refuses BEFORE any request: bad oid, bad size, over-ceiling", () => {
    const p = () => new BatchFrameParser("sha1", { maxHeaderBytes: 64, frameCeiling: 10 });
    expect(code(() => p().arm({ oid: "main", size: 1 }))).toBe("arm-oid");
    expect(code(() => p().arm({ oid: OID256, size: 1 }))).toBe("arm-oid"); // format-keyed length
    expect(code(() => p().arm({ oid: OID, size: -1 }))).toBe("arm-size");
    expect(code(() => p().arm({ oid: OID, size: 11 }))).toBe("over-ceiling");
    const ok = p();
    ok.arm({ oid: OID, size: 10 }); // exactly at the ceiling is admissible
  });
});

// ---- ls-tree -z ------------------------------------------------------------------------------

const LSL: LsTreeLimits = { maxEntries: 10_000, maxRecordBytes: 64 * 1024 };
const rec = (meta: string, path: string | Uint8Array | number[]): Uint8Array => bytes(meta, "\t", path, [0]);

describe("parseLsTreeZ — accepted listings", () => {
  test("all five modes parse with -l space padding; non-blobs carry `-` sizes", () => {
    const input = bytes(
      rec(`100644 blob ${OID}     123`, "a.txt"),
      rec(`100755 blob ${OID2}       7`, "bin/run.sh"),
      rec(`120000 blob ${"12".repeat(20)}      17`, "link"),
      rec(`040000 tree ${"34".repeat(20)}       -`, "dir"),
      rec(`160000 commit ${"56".repeat(20)}       -`, "vendored"),
    );
    const entries = parseLsTreeZ(input, "sha1", LSL);
    expect(entries.map((e) => [e.path, e.mode, e.type, e.size])).toEqual([
      ["a.txt", "100644", "blob", 123],
      ["bin/run.sh", "100755", "blob", 7],
      ["link", "120000", "blob", 17],
      ["dir", "040000", "tree", null],
      ["vendored", "160000", "commit", null],
    ]);
  });
  test("TAB and LF inside PATH bytes are data: the record splits at the FIRST TAB only", () => {
    const entries = parseLsTreeZ(
      bytes(rec(`100644 blob ${OID}       1`, "weird\tname\nwith\tboth")),
      "sha1", LSL,
    );
    expect(entries[0]!.path).toBe("weird\tname\nwith\tboth");
  });
  test("sha256 listings validate against the 64-hex format", () => {
    const entries = parseLsTreeZ(bytes(rec(`100644 blob ${OID256}       1`, "f")), "sha256", LSL);
    expect(entries[0]!.oid).toBe(OID256);
    expect(code(() => parseLsTreeZ(bytes(rec(`100644 blob ${OID}       1`, "f")), "sha256", LSL))).toBe("oid");
  });
  test("empty output is an empty listing (an empty tree is legal)", () => {
    expect(parseLsTreeZ(new Uint8Array(0), "sha1", LSL)).toEqual([]);
  });
});

describe("parseLsTreeZ — fail-closed set", () => {
  const one = (meta: string, path: string | Uint8Array | number[] = "f"): (() => unknown) =>
    () => parseLsTreeZ(bytes(rec(meta, path)), "sha1", LSL);
  test("invalid-UTF-8 path bytes fail closed (no mojibake keys)", () => {
    expect(code(one(`100644 blob ${OID}       1`, [0xff, 0xfe, 0x61]))).toBe("path-utf8");
    expect(code(one(`100644 blob ${OID}       1`, [0xc3, 0x28]))).toBe("path-utf8"); // overlong-ish pair
  });
  test("non-canonical and duplicate paths fail closed", () => {
    expect(code(one(`100644 blob ${OID}       1`, "a//b"))).toBe("path-canonical");
    expect(code(one(`100644 blob ${OID}       1`, "./a"))).toBe("path-canonical");
    expect(code(one(`100644 blob ${OID}       1`, "a/../b"))).toBe("path-canonical");
    expect(code(one(`100644 blob ${OID}       1`, ""))).toBe("path-canonical");
    const dup = bytes(rec(`100644 blob ${OID}       1`, "same"), rec(`100644 blob ${OID2}       2`, "same"));
    expect(code(() => parseLsTreeZ(dup, "sha1", LSL))).toBe("path-duplicate");
  });
  test("mode/type/oid/size violations each fail with their code", () => {
    expect(code(one(`100600 blob ${OID}       1`))).toBe("mode");
    expect(code(one(`100644 tree ${OID}       1`))).toBe("mode-type");
    expect(code(one(`040000 blob ${OID}       -`))).toBe("mode-type");
    expect(code(one(`100644 blob ${OID.toUpperCase()}       1`))).toBe("oid");
    expect(code(one(`100644 blob ${OID.slice(1)}       1`))).toBe("oid");
    expect(code(one(`100644 blob ${OID}       -`))).toBe("size-shape"); // blob needs a size
    expect(code(one(`040000 tree ${"34".repeat(20)}       0`))).toBe("size-shape"); // tree must be `-`
    expect(code(one(`100644 blob ${OID}      01`))).toBe("size-shape");
    expect(code(one(`100644 blob ${OID}     1 2`))).toBe("size-shape"); // interior space
    expect(code(one(`100644 blob ${OID}`))).toBe("meta-shape");
  });
  test("a size beyond the safe-integer range fails closed — the digit regex alone would admit it rounded", () => {
    // `9007199254740993` is canonical decimal (the shape check passes) but unrepresentable:
    // Number() rounds it to 2**53, so without the safe-integer rejection the parser would
    // publish a size that is not the one git declared, and the frame's exact-size check would
    // then compare against a rounded value. Same for a digit run long enough to reach Infinity.
    expect(code(one(`100644 blob ${OID}       9007199254740993`))).toBe("size-shape");
    expect(code(one(`100644 blob ${OID}       ${"9".repeat(400)}`))).toBe("size-shape");
  });
  test("framing violations: no TAB, unterminated tail, record and entry bounds", () => {
    expect(code(() => parseLsTreeZ(bytes(`100644 blob ${OID}       1 f`, [0]), "sha1", LSL))).toBe("record-shape");
    expect(code(() => parseLsTreeZ(bytes(rec(`100644 blob ${OID}       1`, "f"), "dangling"), "sha1", LSL))).toBe("record-unterminated");
    const tiny: LsTreeLimits = { maxEntries: 1, maxRecordBytes: 64 * 1024 };
    const two = bytes(rec(`100644 blob ${OID}       1`, "a"), rec(`100644 blob ${OID2}       1`, "b"));
    expect(code(() => parseLsTreeZ(two, "sha1", tiny))).toBe("entry-bound");
    const short: LsTreeLimits = { maxEntries: 10, maxRecordBytes: 32 };
    expect(code(() => parseLsTreeZ(bytes(rec(`100644 blob ${OID}       1`, "x".repeat(64))), "sha1", short))).toBe("record-bound");
  });
  test("a non-ASCII byte in METADATA is malformed regardless of UTF-8 validity", () => {
    const evil = bytes([0xc3, 0xa9], ` blob ${OID}       1`, "\t", "f", [0]);
    expect(code(() => parseLsTreeZ(evil, "sha1", LSL))).toBe("meta-nonascii");
  });
});

describe("ByteRing — capped stderr retention", () => {
  test("under the cap everything is retained; over it only the newest bytes survive", () => {
    const ring = new ByteRing(8);
    ring.push(te.encode("abc"));
    ring.push(te.encode("def"));
    expect(new TextDecoder().decode(ring.snapshot().bytes)).toBe("abcdef");
    expect(ring.snapshot().droppedBytes).toBe(0);
    ring.push(te.encode("ghij")); // 10 held > 8 → drop the oldest 2
    const snap = ring.snapshot();
    expect(new TextDecoder().decode(snap.bytes)).toBe("cdefghij");
    expect(snap.droppedBytes).toBe(2);
  });
  test("a single chunk larger than the cap keeps its tail and notes the drop", () => {
    const ring = new ByteRing(4);
    ring.push(te.encode("ab"));
    ring.push(te.encode("0123456789"));
    const snap = ring.snapshot();
    expect(new TextDecoder().decode(snap.bytes)).toBe("6789");
    expect(snap.droppedBytes).toBe(8); // the 2 held + 6 of the oversized chunk
  });
});
