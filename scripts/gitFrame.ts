// gitFrame.ts — PURE byte-level parsers and validation cores for the T2c content path
// (ADR-0001, accepted 2026-08-03; adopted at implementation from the benchmark's Step-B
// prototype, which now re-exports from here — see benchFrame.ts). No I/O and no process
// machinery: the wrapper feeds bytes in, these parsers validate them fail-closed.
//
// Surfaces:
//   • BatchFrameParser — `cat-file --batch` reply framing: `<oid> SP <type> SP <size> LF`,
//     `<size>` raw body bytes, LF trailer, plus `<oid> missing LF` records. One armed request
//     ⇒ one frame; unsolicited bytes are a protocol violation, never data.
//   • parseLsTreeZ — enumeration output: NUL-delimited records split at the FIRST TAB
//     (metadata left, path bytes right — a legal git path may itself contain TAB or LF, which
//     then flow into path validation, not record framing), with a closed validation set over
//     modes, types, object-format oids, sizes, and canonical unique UTF-8 paths.
//   • ByteRing — the child's capped stderr retention.
//   • gitBlobOid / seamDecode / oidFormatOf / encodeOidRequest — blob self-verification
//     (Confirmation check 3), the deliberate UTF-8-with-replacement seam decode, object-format
//     derivation from the discovery-pinned head oid, and the OID-only stdin writer's
//     validation core (check 2 — the argv guard cannot see stdin, so containment lives here).
//
// Everything fails CLOSED on anything outside its grammar — the one-shot spawn path's
// irreversible UTF-8 decode would destroy exactly the evidence these parsers must reject on,
// which is why this seam consumes bytes.

// The CLOSED set of frame-failure codes. A literal union rather than a bare string because
// production and the tests both branch on `.code`: with a plain string, a typo at a throw site
// or in a comparison compiles clean and silently never matches — with the union, either is a
// compile error (a literal outside the set cannot be constructed, and comparing the field to
// one is a no-overlap comparison).
export type GitFrameErrorCode =
  | "arm-oid" | "arm-size" | "busy" | "echo-mismatch" | "entry-bound" | "header-shape"
  | "header-unterminated" | "limits" | "meta-nonascii" | "meta-shape" | "mode" | "mode-type"
  | "oid" | "over-ceiling" | "path-canonical" | "path-duplicate" | "path-utf8" | "poisoned"
  | "record-bound" | "record-shape" | "record-unterminated" | "size-mismatch" | "size-shape"
  | "trailer" | "trailing" | "type-mismatch" | "unsolicited" | "writer-oid";

export class GitFrameError extends Error {
  // machine-checkable discriminant for tests and the unit-failure taxonomy
  readonly code: GitFrameErrorCode;
  constructor(code: GitFrameErrorCode, message: string) {
    super(`GIT FRAME: ${message}`);
    this.name = "GitFrameError";
    this.code = code;
  }
}

// The two git object formats every validation here keys on — matching the dual format
// github.ts accepts for API oids (a hardcoded 40-hex would regress SHA-256 repositories).
export type GitObjectFormat = "sha1" | "sha256";
export const OID_LENGTH: Record<GitObjectFormat, number> = { sha1: 40, sha256: 64 };

// Derive the repository's object format from a full oid (the discovery-pinned head). Null for
// anything that is not a full LOWERCASE hex oid of either format — callers fail closed on it.
export function oidFormatOf(oid: string): GitObjectFormat | null {
  if (/^[0-9a-f]{40}$/.test(oid)) return "sha1";
  if (/^[0-9a-f]{64}$/.test(oid)) return "sha256";
  return null;
}

// The deliberate seam decode (ADR-0001 Decision Outcome "byte semantics"): the ReadFile seam
// is a string contract, and production applies UTF-8-with-replacement over CANONICAL bytes —
// never a throwing decode; the raw bytes were already self-verified against the tree oid.
const SEAM_DECODER = new TextDecoder("utf-8");
export function seamDecode(bytes: Uint8Array): string {
  return SEAM_DECODER.decode(bytes);
}

// Canonical git blob hashing: `blob <byte-length>\0<body>` under the repository's algorithm.
// Check 3's self-verification hashes the pre-decode frame bytes to the enumerated oid.
export function gitBlobOid(body: Uint8Array, format: GitObjectFormat): string {
  const hasher = new Bun.CryptoHasher(format === "sha1" ? "sha1" : "sha256");
  hasher.update(new TextEncoder().encode(`blob ${body.byteLength}\0`));
  hasher.update(body);
  return hasher.digest("hex");
}

// The OID-only stdin writer's validation core (check 2): `cat-file --batch` resolves arbitrary
// revs from stdin, which the argv guard cannot see — so the ONLY thing ever written is a
// format-validated full lowercase oid plus the terminating LF, produced here or nowhere.
// (JS `$` without the m flag anchors at true end-of-input, so an embedded newline fails the
// regex rather than smuggling a second request line.)
// The PRIMITIVE-string requirement is load-bearing, not a type-system formality: a stateful
// object whose toString() returns a conforming oid on the validating read and an arbitrary rev
// on the encoding read would validate here and then write `HEAD\n` to the child's stdin —
// defeating the containment this function exists to provide (santa round-3). Validate and
// encode ONE captured primitive.
export function encodeOidRequest(oid: string, format: GitObjectFormat): Uint8Array {
  if (typeof oid !== "string")
    throw new GitFrameError("writer-oid", "stdin writer refuses a non-string object id");
  if (oid.length !== OID_LENGTH[format] || !/^[0-9a-f]+$/.test(oid))
    throw new GitFrameError("writer-oid", `stdin writer refuses a non-${format} object id: ${JSON.stringify(oid.slice(0, 80))}`);
  return new TextEncoder().encode(`${oid}\n`);
}

const LF = 0x0a;
const TAB = 0x09;
const NUL = 0x00;

// strict UTF-8: any invalid sequence throws (no replacement characters — no mojibake keys);
// the caller converts the throw into its fail-closed error.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
// ASCII-only decode for metadata (mode/type/oid/size fields and their SP separators): a byte
// outside printable ASCII in metadata is malformed regardless of UTF-8 validity. Loop-built —
// a spread over a large hostile field would blow the argument limit before validation ran.
function asciiField(bytes: Uint8Array, what: string): string {
  let out = "";
  for (const b of bytes) {
    if (b < 0x20 || b > 0x7e) throw new GitFrameError("meta-nonascii", `${what} contains a non-printable/non-ASCII byte`);
    out += String.fromCharCode(b);
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

// ---- cat-file --batch framing ----------------------------------------------------------------

export interface BatchLimits {
  // bounded pre-LF header: a header not terminated within this many bytes is fatal
  maxHeaderBytes: number;
  // absolute per-frame ceiling — production's spawn-output cap, so an ungated manifest can
  // never allocate more than today's REST path could return before the cap kill
  frameCeiling: number;
}

export interface BatchExpectation {
  oid: string; // the format-validated oid the caller wrote to stdin
  size: number; // the ls-tree-declared object size — the EXACT per-frame bound
}

export type BatchFrame =
  | { kind: "content"; oid: string; size: number; body: Uint8Array }
  // `<oid> missing` for an oid the unit's own ls-tree enumerated is object-store corruption:
  // the STORE fails the unit closed on it — the parser only reports the frame.
  | { kind: "missing"; oid: string };

type BatchState =
  | { at: "idle" }
  | { at: "header"; expected: BatchExpectation }
  | { at: "body"; expected: BatchExpectation; body: Uint8Array; filled: number }
  | { at: "trailer"; expected: BatchExpectation; body: Uint8Array }
  | { at: "failed" };

// Incremental single-frame assembler. The child manager arms EXACTLY ONE expectation before
// writing the request line (the seam is pull-style, one read in flight), then feeds every
// stdout chunk through push() until it yields the frame. Memory stays O(one frame): the body
// buffer is allocated once at header acceptance, bounded by the declared size under the
// absolute ceiling.
export class BatchFrameParser {
  private readonly format: GitObjectFormat;
  private readonly limits: BatchLimits;
  private state: BatchState = { at: "idle" };
  private pending: Uint8Array = new Uint8Array(0);

  constructor(format: GitObjectFormat, limits: BatchLimits) {
    if (!Number.isSafeInteger(limits.maxHeaderBytes) || limits.maxHeaderBytes < 8)
      throw new GitFrameError("limits", "maxHeaderBytes must be a safe integer >= 8");
    if (!Number.isSafeInteger(limits.frameCeiling) || limits.frameCeiling < 0)
      throw new GitFrameError("limits", "frameCeiling must be a nonnegative safe integer");
    this.format = format;
    this.limits = limits;
  }

  private fail(code: GitFrameErrorCode, message: string): never {
    this.state = { at: "failed" };
    throw new GitFrameError(code, message);
  }

  // Arm the parser for one reply. Throws if a frame is already in flight (the one-request/
  // one-frame correspondence is structural) or if the declared size exceeds the ceiling — the
  // refusal happens BEFORE any request is written.
  arm(expected: BatchExpectation): void {
    if (this.state.at === "failed") this.fail("poisoned", "arm() after a fatal framing violation");
    if (this.state.at !== "idle") this.fail("busy", "arm() while a frame is already in flight");
    if (!/^[0-9a-f]+$/.test(expected.oid) || expected.oid.length !== OID_LENGTH[this.format])
      this.fail("arm-oid", `expected oid is not a full ${this.format} object id`);
    if (!Number.isSafeInteger(expected.size) || expected.size < 0)
      this.fail("arm-size", "expected size is not a nonnegative safe integer");
    if (expected.size > this.limits.frameCeiling)
      this.fail("over-ceiling", `declared size ${expected.size} exceeds the absolute frame ceiling ${this.limits.frameCeiling}`);
    this.state = { at: "header", expected };
  }

  // Feed one stdout chunk. Returns the completed frame when this chunk finishes one, else null.
  // Any grammar violation throws (and poisons the parser — the child must be killed).
  push(chunk: Uint8Array): BatchFrame | null {
    if (this.state.at === "failed") this.fail("poisoned", "push() after a fatal framing violation");
    this.pending = concatBytes(this.pending, chunk);
    // bytes with NOTHING armed are unsolicited child output — a protocol violation, not data
    if (this.state.at === "idle") {
      if (this.pending.byteLength > 0) this.fail("unsolicited", "child produced bytes with no request in flight");
      return null;
    }
    for (;;) {
      if (this.state.at === "header") {
        const lfAt = this.pending.indexOf(LF);
        if (lfAt === -1) {
          if (this.pending.byteLength > this.limits.maxHeaderBytes)
            this.fail("header-unterminated", `no LF within the ${this.limits.maxHeaderBytes}-byte header bound`);
          return null;
        }
        if (lfAt > this.limits.maxHeaderBytes)
          this.fail("header-unterminated", `header exceeds the ${this.limits.maxHeaderBytes}-byte bound`);
        const headerBytes = this.pending.slice(0, lfAt);
        this.pending = this.pending.slice(lfAt + 1);
        let header: string;
        try {
          header = asciiField(headerBytes, "batch header");
        } catch (e) {
          // the decode failure must POISON the parser like every other grammar violation — a
          // caught throw must not leave an armed parser accepting later frames
          this.fail("meta-nonascii", e instanceof GitFrameError ? e.message : String(e));
        }
        const expected: BatchExpectation = this.state.expected;
        const parts = header.split(" ");
        if (parts.length === 2 && parts[1] === "missing") {
          if (parts[0] !== expected.oid)
            this.fail("echo-mismatch", `missing-record echo ${JSON.stringify(parts[0])} is not the requested oid`);
          this.state = { at: "idle" };
          if (this.pending.byteLength > 0) this.fail("trailing", "bytes after a missing record with no request in flight");
          return { kind: "missing", oid: expected.oid };
        }
        if (parts.length !== 3) this.fail("header-shape", `batch header is not \`<oid> <type> <size>\`: ${JSON.stringify(header.slice(0, 120))}`);
        const [oid, type, sizeText] = parts as [string, string, string];
        if (oid !== expected.oid) this.fail("echo-mismatch", `header oid ${JSON.stringify(oid)} is not the requested oid`);
        if (type !== "blob") this.fail("type-mismatch", `object type ${JSON.stringify(type)} — the seam requests blobs only`);
        if (!/^(0|[1-9][0-9]*)$/.test(sizeText)) this.fail("size-shape", `non-canonical size field ${JSON.stringify(sizeText)}`);
        const size = Number(sizeText);
        if (!Number.isSafeInteger(size)) this.fail("size-shape", "size overflows the safe-integer range");
        // the per-frame bound is the ls-tree-declared size EXACTLY: a header disagreeing with
        // the enumeration is a protocol violation in either direction.
        if (size !== expected.size)
          this.fail("size-mismatch", `header size ${size} != ls-tree-declared size ${expected.size}`);
        this.state = { at: "body", expected, body: new Uint8Array(size), filled: 0 };
        continue;
      }
      if (this.state.at === "body") {
        const need = this.state.body.byteLength - this.state.filled;
        const take = Math.min(need, this.pending.byteLength);
        if (take > 0) {
          this.state.body.set(this.pending.subarray(0, take), this.state.filled);
          this.state = { ...this.state, filled: this.state.filled + take };
          this.pending = this.pending.slice(take);
        }
        if (this.state.filled < this.state.body.byteLength) return null;
        this.state = { at: "trailer", expected: this.state.expected, body: this.state.body };
        continue;
      }
      if (this.state.at === "trailer") {
        if (this.pending.byteLength === 0) return null;
        if (this.pending[0] !== LF) this.fail("trailer", "missing LF trailer after the frame body");
        this.pending = this.pending.slice(1);
        const frame: BatchFrame = { kind: "content", oid: this.state.expected.oid, size: this.state.body.byteLength, body: this.state.body };
        this.state = { at: "idle" };
        if (this.pending.byteLength > 0) this.fail("trailing", "bytes after a completed frame with no request in flight");
        return frame;
      }
      return null; // idle with empty pending
    }
  }
}

// ---- ls-tree -r -z -l parsing ----------------------------------------------------------------

export const LS_TREE_MODES = ["100644", "100755", "120000", "040000", "160000"] as const;
export type LsTreeMode = (typeof LS_TREE_MODES)[number];
// A type PREDICATE, not a bare `.includes` + `as` cast: the narrowing is compiler-linked to the
// membership check, so a future edit that drops or reorders the guard is a compile error rather
// than a silent bad LsTreeMode flowing into MODE_TYPE.
function isLsTreeMode(text: string): text is LsTreeMode {
  return (LS_TREE_MODES as readonly string[]).includes(text);
}
export type LsTreeType = "blob" | "tree" | "commit";
// exact mode→type coherence over the closed set
const MODE_TYPE: Record<LsTreeMode, LsTreeType> = {
  "100644": "blob", "100755": "blob", "120000": "blob", "040000": "tree", "160000": "commit",
};

export interface LsTreeEntry {
  path: string;
  mode: LsTreeMode;
  type: LsTreeType;
  oid: string;
  size: number | null; // canonical object size for blobs; null for tree/commit (`-` on the wire)
}

export interface LsTreeLimits {
  maxEntries: number;
  maxRecordBytes: number;
}

// mirror of github.ts's isCanonicalTreePath (the module keeps it private): no empty / "." /
// ".." segments; NUL is impossible here by construction (NUL delimits records).
function isCanonicalPath(p: string): boolean {
  if (p.length === 0) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// Parse the COMPLETE enumeration output (bytes, never a pre-decoded string). Record grammar:
// `<mode> SP <type> SP <oid> SP+ <size|-> TAB <pathbytes> NUL` — the -l size column is
// space-padded, hence SP+. Split at the FIRST TAB; path bytes run to the NUL and may legally
// contain TAB or LF (they then flow into path validation). Fail-closed on: unknown mode,
// mode↔type incoherence, wrong-format oid, non-canonical size, invalid-UTF-8 / non-canonical /
// duplicate paths, oversized records, entry-count overflow, and any trailing bytes after the
// last NUL.
export function parseLsTreeZ(bytes: Uint8Array, format: GitObjectFormat, limits: LsTreeLimits): LsTreeEntry[] {
  const entries: LsTreeEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset < bytes.byteLength) {
    const nulAt = bytes.indexOf(NUL, offset);
    if (nulAt === -1)
      throw new GitFrameError("record-unterminated", "trailing bytes after the last NUL-terminated record");
    const record = bytes.subarray(offset, nulAt);
    offset = nulAt + 1;
    if (record.byteLength > limits.maxRecordBytes)
      throw new GitFrameError("record-bound", `record exceeds ${limits.maxRecordBytes} bytes`);
    if (entries.length >= limits.maxEntries)
      throw new GitFrameError("entry-bound", `listing exceeds ${limits.maxEntries} entries`);
    const tabAt = record.indexOf(TAB);
    if (tabAt === -1) throw new GitFrameError("record-shape", "record has no TAB metadata/path separator");
    const meta = asciiField(record.subarray(0, tabAt), "ls-tree metadata");
    const pathBytes = record.subarray(tabAt + 1);

    // metadata: `<mode> SP <type> SP <oid> SP+ <size|->` — exactly four fields, the last
    // left-padded by -l. Reject doubled separators anywhere except the size padding run.
    const sp1 = meta.indexOf(" ");
    const sp2 = sp1 === -1 ? -1 : meta.indexOf(" ", sp1 + 1);
    const sp3 = sp2 === -1 ? -1 : meta.indexOf(" ", sp2 + 1);
    if (sp1 === -1 || sp2 === -1 || sp3 === -1)
      throw new GitFrameError("meta-shape", `metadata is not four fields: ${JSON.stringify(meta.slice(0, 120))}`);
    const modeText = meta.slice(0, sp1);
    const typeText = meta.slice(sp1 + 1, sp2);
    const oid = meta.slice(sp2 + 1, sp3);
    const sizeField = meta.slice(sp3 + 1); // may carry leading SP padding from -l
    if (!isLsTreeMode(modeText))
      throw new GitFrameError("mode", `mode ${JSON.stringify(modeText)} is outside the closed set`);
    const mode = modeText; // narrowed to LsTreeMode by the predicate above
    const type = MODE_TYPE[mode];
    if (typeText !== type)
      throw new GitFrameError("mode-type", `mode ${mode} must carry type ${type}, got ${JSON.stringify(typeText)}`);
    if (oid.length !== OID_LENGTH[format] || !/^[0-9a-f]+$/.test(oid))
      throw new GitFrameError("oid", `oid is not a full lowercase ${format} object id`);
    const sizeText = sizeField.replace(/^ +/, "");
    if (sizeText.includes(" "))
      throw new GitFrameError("size-shape", `size field carries interior spaces: ${JSON.stringify(sizeField)}`);
    let size: number | null;
    if (type === "blob") {
      if (!/^(0|[1-9][0-9]*)$/.test(sizeText))
        throw new GitFrameError("size-shape", `blob size is not a canonical nonnegative integer: ${JSON.stringify(sizeText)}`);
      size = Number(sizeText);
      if (!Number.isSafeInteger(size))
        throw new GitFrameError("size-shape", "blob size overflows the safe-integer range");
    } else {
      if (sizeText !== "-")
        throw new GitFrameError("size-shape", `non-blob size must be \`-\`, got ${JSON.stringify(sizeText)}`);
      size = null;
    }

    let path: string;
    try {
      path = STRICT_UTF8.decode(pathBytes);
    } catch {
      throw new GitFrameError("path-utf8", "path bytes are not valid UTF-8 (failing closed — no mojibake keys)");
    }
    if (!isCanonicalPath(path))
      throw new GitFrameError("path-canonical", `non-canonical path ${JSON.stringify(path.slice(0, 200))}`);
    if (seen.has(path)) throw new GitFrameError("path-duplicate", `duplicate path ${JSON.stringify(path.slice(0, 200))}`);
    seen.add(path);
    entries.push({ path, mode, type, oid, size });
  }
  return entries;
}

// ---- capped stderr retention ring ------------------------------------------------------------
// The child's stderr is drained CONTINUOUSLY (a full pipe would wedge the child) into a bounded
// ring that keeps the most recent bytes; overflow is noted, never fatal.
export class ByteRing {
  private readonly cap: number;
  private chunks: Uint8Array[] = [];
  private held = 0;
  private droppedBytes = 0;

  constructor(cap: number) {
    if (!Number.isSafeInteger(cap) || cap < 1) throw new GitFrameError("limits", "ring cap must be a positive safe integer");
    this.cap = cap;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    if (chunk.byteLength >= this.cap) {
      this.droppedBytes += this.held + (chunk.byteLength - this.cap);
      this.chunks = [chunk.slice(chunk.byteLength - this.cap)];
      this.held = this.cap;
      return;
    }
    this.chunks.push(chunk.slice());
    this.held += chunk.byteLength;
    while (this.held > this.cap) {
      const head = this.chunks[0]!;
      const excess = this.held - this.cap;
      if (head.byteLength <= excess) {
        this.chunks.shift();
        this.held -= head.byteLength;
        this.droppedBytes += head.byteLength;
      } else {
        this.chunks[0] = head.slice(excess);
        this.held -= excess;
        this.droppedBytes += excess;
      }
    }
  }

  snapshot(): { bytes: Uint8Array; droppedBytes: number } {
    let out: Uint8Array = new Uint8Array(0);
    for (const c of this.chunks) out = concatBytes(out, c);
    return { bytes: out, droppedBytes: this.droppedBytes };
  }
}
