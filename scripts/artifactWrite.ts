// artifactWrite.ts — the shared SYNC atomic artifact writer for the presentation layer (report
// JSON, exports, dossiers). Two guarantees, both load-bearing for the launch contract:
//   1. ATOMIC WRITES: every artifact is written to a same-directory temp file (created
//      exclusively — O_EXCL) and renamed into place, so a PROCESS crash mid-write can never
//      leave a plausible truncated artifact — only an unmanifested temp, which (for xray/
//      bundle artifacts) the next generation's sweep removes. (Scope: process-crash atomicity.
//      No fsync by design, so a power/OS failure may still lose data the OS had not flushed.)
//   2. CONFINED SWEEP: xray/ artifacts are bundle-managed — a manifest.json ({path, kind, sha256,
//      bytes} per artifact + run id + format version) is written LAST, and stale unmanifested
//      files are swept ONLY inside <outputDir>/xray/. The sweep never reaches the parent
//      outputDir BY GEOMETRY: outputDir accumulates run-<id>.json history and operator files by
//      design, and a flat sweep there would delete them. The xray/ root is verified to be a
//      real directory (never a symlink) before any write and again before the sweep.
//
// Concurrency posture (deliberate, per the manifest design): one bundle generation at a time.
// Two concurrent generations over one xray/ are NOT serialized — a torn mix is DETECTABLE
// (manifest hash mismatch), not prevented; a single generation at a time is the operator's
// responsibility. Likewise the sweep guards against PRE-EXISTING symlink tricks, not an attacker
// actively racing the sweep with directory swaps — a local process with write access to the
// operator's own output directory could simply delete files itself.

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertContained } from "./readOnlyGuard.ts";

// Operator-facing (registered in KNOWN_OPERATOR_ERRORS, rendered message-only): naming
// collisions and environment conditions an operator can fix — e.g. two tracked packages whose
// sanitized dossier filenames alias each other, or a symlinked xray/ directory. Internal
// lifecycle violations (write-after-finalize, double finalize) are plain Errors and keep
// their stacks: those are bugs, not operator conditions.
export class ArtifactWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactWriteError";
  }
}

// The manifest-owned subdirectory under outputDir that holds every launch-surface artifact
// (dossiers, index, CSV/JSONL exports) and the ONLY directory the sweep may touch.
export const XRAY_DIR_NAME = "xray";

// The report-format version embedded in the manifest (and in the HTML artifacts).
// Bumping this is the ONE sanctioned way golden files change. (The pre-launch addition of
// per-entry `kind` tags was deliberately absorbed into v1 — no manifest had shipped yet;
// after launch, any manifest-shape change bumps this.)
// v2 (branch allow/deny, T8): the report JSON gains formatVersion + scanScope + policy summary counts,
// a new run_unit_head export table, and the HTML scan-scope panel — an artifact-set change.
export const XRAY_FORMAT_VERSION = 2;

// Injectable failure seam for the crash-behavior tests; production always uses node:fs.
export interface AtomicWriteIo {
  writeFileSync: (path: string, data: string, opts: { flag: string }) => void;
  renameSync: (from: string, to: string) => void;
}
const DEFAULT_IO: AtomicWriteIo = { writeFileSync, renameSync };

let tempCounter = 0;
const TEMP_CREATE_ATTEMPTS = 16;

// Write `data` to `path` atomically: exclusive same-directory temp, then rename. The path must
// resolve inside one of `containRoots` (§0 write containment — same contract as report.ts's
// writeJson); a leaf symlink pointing OUTSIDE the roots fails that check closed. A leaf symlink
// pointing INSIDE the roots is REPLACED, never followed: the rename destination is rebuilt as
// <resolved parent>/<basename>, so only the parent chain is symlink-resolved — POSIX rename
// then overwrites the leaf entry itself. On failure the temp is removed best-effort (its own
// error can never mask the original); the destination is either the old intact artifact or the
// new complete one, never a truncation.
export function writeFileAtomic(
  path: string, data: string, containRoots: string[], io: Partial<AtomicWriteIo> = {},
): void {
  const { writeFileSync: writeImpl, renameSync: renameImpl } = { ...DEFAULT_IO, ...io };
  const base = basename(path);
  // A dot basename would make `dest` below the parent itself (and its temp a SIBLING of the
  // root). Producer bug — fail loudly with the stack.
  if (base === "" || base === "." || base === "..")
    throw new Error(`writeFileAtomic requires a path with a real file basename, got: ${path}`);
  assertContained(path, containRoots); // full-path check: rejects out-of-root leaf symlinks
  // Canonicalize the parent BEFORE mkdir: resolveWritePath applies `..` (and symlinks)
  // left-to-right, so the recursive mkdir below can only ever create canonical directories
  // INSIDE the root — running it on the raw lexical path would create the intermediate
  // components of a `<root>/../sibling/../<root-name>/f` path outside it.
  let parent = assertContained(dirname(path), containRoots);
  mkdirSync(parent, { recursive: true });
  parent = assertContained(parent, containRoots); // re-assert now that it exists (db.ts precedent)
  const dest = join(parent, base);

  // Exclusive temp create: 'wx' (O_CREAT|O_EXCL) fails on ANY existing entry — including a
  // pre-planted symlink or an artifact whose NAME happens to equal a temp candidate — so a
  // collision bumps the counter and retries instead of clobbering. The temp is `dest` plus a
  // suffix, so it lives in the same (containment-checked) directory by construction.
  let temp: string | null = null;
  for (let attempt = 0; attempt < TEMP_CREATE_ATTEMPTS && temp === null; attempt++) {
    const candidate = `${dest}.tmp-${process.pid}-${tempCounter++}`;
    try {
      writeImpl(candidate, data, { flag: "wx" });
      temp = candidate;
    } catch (e) {
      if ((e as { code?: unknown }).code !== "EEXIST") {
        // The exclusive create may have succeeded and the WRITE failed (ENOSPC/EIO) — don't
        // strand a partial temp; its own cleanup error must never mask the real failure.
        try {
          rmSync(candidate, { force: true });
        } catch {
          // unmanifested — (for xray/ bundle temps) the next generation's sweep removes it
        }
        throw e;
      }
    }
  }
  if (temp === null) throw new Error(`could not create an exclusive temp file for ${dest} after ${TEMP_CREATE_ATTEMPTS} attempts`);

  try {
    renameImpl(temp, dest);
  } catch (e) {
    try {
      rmSync(temp, { force: true }); // best-effort; never mask the original failure
    } catch {
      // the orphaned temp is unmanifested — (for xray/ bundle temps) the next generation's sweep removes it
    }
    throw e;
  }
}

// The xray/ bundle is shared by SEPARATE commands (`export` writes CSV/JSONL, `report --html`
// writes dossiers), so every manifest entry is tagged with the KIND that produced it. A
// generation finalizing kind K replaces ALL kind-K entries (stale K-artifacts die) and ADOPTS
// the other kinds' entries verbatim — but only when the existing manifest carries the SAME
// runId and formatVersion; otherwise the whole previous generation is stale and everything
// unmanifested is swept. This keeps "stale dossiers from removed packages die" true without
// one command's sweep destroying the other command's artifacts.
export type ArtifactKind = "export" | "dossier";

export interface ArtifactRecord {
  readonly path: string; // filename relative to the xray/ directory (flat by contract)
  readonly kind: ArtifactKind;
  readonly sha256: string;
  readonly bytes: number;
}

export interface BundleResult {
  manifestPath: string;
  artifacts: ArtifactRecord[]; // the full manifest content: this generation's + adopted entries
  swept: string[]; // unmanifested filenames removed from xray/, sorted
}

// Artifact names are restricted to a flat ASCII grammar. This kills the entire
// filesystem-aliasing class at the root: no Unicode normalization games (HFS+ re-spells NFC as
// NFD in readdir), no exotic case-folding aliases (U+017F ſ folds to s on folding filesystems)
// — every legal name is free of those Unicode-normalization and case-folding rewrites (plain ASCII
// case-aliasing on case-insensitive filesystems is a separate axis the sweep handles). All real producers fit:
// npm package names are URL-safe ASCII (scoped names sanitize '/' to '__' upstream), export
// files and index.html are fixed ASCII.
const NAME_GRAMMAR = /^[A-Za-z0-9@._~-]+$/;

// ASCII case-insensitive collision key: case-insensitive filesystems (macOS/Windows defaults)
// alias A.txt and a.txt to one physical file, and npm LEGACY package names genuinely differ
// only by case (JSONStream vs jsonstream) — that must collide loudly, not silently overwrite.
const collisionKey = (name: string): string => name.toLowerCase();
const MANIFEST_NAME = "manifest.json";

// Name-shape violations are PRODUCER bugs (the dossier/export layers own sanitization), so they
// are plain Errors with stacks — only genuine collisions and environment conditions are the
// operator-facing ArtifactWriteError.
function assertArtifactName(name: string): void {
  if (name === "." || name === ".." || !NAME_GRAMMAR.test(name))
    throw new Error(`invalid artifact name (flat ASCII ${NAME_GRAMMAR.source} required): ${JSON.stringify(name)}`);
  if (collisionKey(name) === MANIFEST_NAME)
    throw new Error(`${MANIFEST_NAME} is reserved — it is written by finalize(), last`);
}

// One generation of the xray/ bundle. Usage: write() every artifact, then finalize() exactly
// once — it writes manifest.json LAST (so a torn generation is detectable: artifacts without a
// matching manifest) and sweeps stale files. All writes go through writeFileAtomic.
export class ArtifactBundle {
  private readonly outputDir: string;
  private readonly dir: string;
  private readonly kind: ArtifactKind;
  private readonly records: ArtifactRecord[] = [];
  private readonly nameKeys = new Set<string>();
  private readonly names = new Set<string>();
  private finalized = false;

  constructor(outputDir: string, kind: ArtifactKind) {
    this.outputDir = outputDir;
    this.dir = join(outputDir, XRAY_DIR_NAME);
    this.kind = kind;
  }

  // The sweep-confinement precondition: xray/ must be a REAL directory. A symlinked xray/
  // would redirect both the writes and — catastrophically — the flat sweep into whatever it
  // points at (readdir follows it), so it is refused outright, before the first write and
  // again before the sweep. lstat FIRST: mkdir would follow a symlink-to-dir silently and
  // throw a raw EEXIST on a dangling/file symlink — every non-real-directory shape must get
  // the same operator-facing remediation.
  private ensureRealDir(): void {
    // Containment BEFORE creation: this.dir is a LEXICAL join (path.join collapses '..' without
    // consulting symlinks), so an outputDir like 'output/link/../..' — whose symlink-aware
    // resolution config.ts validated as inside the roots — can lexically collapse to a path
    // OUTSIDE them. writeFileAtomic would fail closed on the first write, but only after the
    // mkdir below had already created the escaped directory; assert the same containment here
    // so nothing is created at all.
    assertContained(this.dir, [this.outputDir]);
    let st;
    try {
      st = lstatSync(this.dir);
    } catch {
      mkdirSync(this.dir, { recursive: true }); // did not exist — create it for real
      return;
    }
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new ArtifactWriteError(
        `${this.dir} must be a real directory (found a ${st.isSymbolicLink() ? "symlink" : "non-directory"}) — ` +
          "remove it and re-run; artifacts and the sweep are confined to a real xray/ directory only",
      );
  }

  write(name: string, content: string): ArtifactRecord {
    if (this.finalized) throw new Error("bundle already finalized — no further writes");
    assertArtifactName(name);
    const key = collisionKey(name);
    if (this.nameKeys.has(key))
      throw new ArtifactWriteError(
        `artifact name collision in bundle: ${name} (names are compared case-insensitively — ` +
          "two tracked packages may sanitize to the same dossier filename)",
      );
    this.ensureRealDir();
    writeFileAtomic(join(this.dir, name), content, [this.outputDir]);
    const record: ArtifactRecord = Object.freeze({
      path: name,
      kind: this.kind,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      bytes: Buffer.byteLength(content, "utf8"),
    });
    this.nameKeys.add(key);
    this.names.add(name);
    this.records.push(record); // frozen — the caller and the manifest see the same immutable row
    return record;
  }

  // Adoption input: the previous generation's manifest, IF it is coherent with this one
  // (parseable, same formatVersion, same runId). Only OTHER kinds' entries are candidates —
  // this generation is the new truth for its own kind — and an entry whose file has vanished
  // is dropped (the manifest must not reference a file that is absent from disk).
  private adoptableEntries(runId: string): ArtifactRecord[] {
    let root: unknown;
    try {
      root = JSON.parse(readFileSync(join(this.dir, MANIFEST_NAME), "utf8"));
    } catch {
      return []; // absent or torn manifest → nothing to adopt, everything unmanifested sweeps
    }
    // A tampered manifest can be ANY valid JSON — including bare `null` (JSON.parse succeeds), which
    // would throw on the field access below. Require a non-null, non-array object root first.
    if (root === null || typeof root !== "object" || Array.isArray(root)) return [];
    const parsed = root as { formatVersion?: unknown; runId?: unknown; artifacts?: unknown };
    if (parsed.formatVersion !== XRAY_FORMAT_VERSION || parsed.runId !== runId) return [];
    if (!Array.isArray(parsed.artifacts)) return [];
    const adopted: ArtifactRecord[] = [];
    for (const e of parsed.artifacts) {
      // A tampered manifest can hold anything: null/non-object array elements (dereferencing them
      // would throw and fail the whole finalize) are skipped before any field access.
      if (e === null || typeof e !== "object") continue;
      const rec = e as Record<string, unknown>;
      // `bytes` must be a non-negative SAFE integer: a tampered `bytes:1e400` is `typeof "number"`
      // (Infinity) and would reserialize as `bytes:null`, poisoning the new manifest. sha256 must be
      // the 64-hex digest shape it is written as.
      if (
        typeof rec["path"] !== "string" ||
        typeof rec["sha256"] !== "string" ||
        !/^[0-9a-f]{64}$/.test(rec["sha256"] as string) ||
        typeof rec["bytes"] !== "number" ||
        !Number.isSafeInteger(rec["bytes"]) ||
        (rec["bytes"] as number) < 0
      )
        continue;
      const kind = rec["kind"];
      if (kind === this.kind || (kind !== "export" && kind !== "dossier")) continue;
      const name = rec["path"];
      // A prior manifest is data on disk; a tampered `path` must never reach join()/lstat or poison
      // the new manifest — validate it against the SAME rules fresh writes use (flat-name grammar,
      // no `.`/`..`, and NOT the reserved manifest.json name), and skip (never throw) anything else.
      if (name === "." || name === ".." || !NAME_GRAMMAR.test(name) || collisionKey(name) === MANIFEST_NAME) continue;
      if (this.nameKeys.has(collisionKey(name))) continue; // this generation rewrote it
      let st;
      try {
        st = lstatSync(join(this.dir, name));
      } catch {
        continue; // vanished since the last generation
      }
      if (!st.isFile()) continue;
      adopted.push(Object.freeze({ path: name, kind, sha256: rec["sha256"], bytes: rec["bytes"] }));
    }
    return adopted;
  }

  // Write manifest.json (LAST), then sweep unmanifested files inside xray/ ONLY. The sweep
  // removes regular files and symlinks (unlinked, never followed) and leaves directories in
  // place — it is flat by construction, never recursive.
  finalize(meta: { runId: string }): BundleResult {
    if (this.finalized) throw new Error("bundle already finalized");
    this.finalized = true;
    this.ensureRealDir();
    const artifacts = [...this.records, ...this.adoptableEntries(meta.runId)].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    const manifest = { formatVersion: XRAY_FORMAT_VERSION, runId: meta.runId, artifacts };
    const manifestPath = join(this.dir, MANIFEST_NAME);
    writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n", [this.outputDir]);

    // Sweep decisions live in sweepVictims (pure, fs-agnostic — see its comment for the
    // case-fold matrix). (No realpath-containment on victims: assertContained FOLLOWS
    // symlinks, and the whole point is to unlink a stale link itself without ever following
    // it. Entries are readdir basenames — including legal-but-odd POSIX names like
    // `old\artifact` — swept normally.)
    const kept = artifacts.map((a) => a.path).concat(MANIFEST_NAME);
    // Inode guard: JS case math (collisionKey's toLowerCase) can never replicate a
    // filesystem's Unicode case folding exactly (APFS folds U+017F ſ → s; toLowerCase does
    // not), so a directory entry could ALIAS a just-written artifact under a spelling the
    // keep-set doesn't recognize — and sweeping it would delete the artifact itself. An entry
    // whose inode matches a kept file is therefore never unlinked, whatever it is named.
    // Key on `dev:ino`, not `ino` alone: inode numbers are unique only per filesystem, so a
    // cross-device or bind-mounted entry under xray/ could share a bare inode with a kept file and
    // be wrongly spared; pairing the device id keeps the guard exact.
    const keptInodes = new Set<string>();
    const inodeKey = (st: { dev: number; ino: number }): string => `${st.dev}:${st.ino}`;
    for (const name of kept) {
      try {
        keptInodes.add(inodeKey(lstatSync(join(this.dir, name))));
      } catch {
        /* vanished — nothing to protect */
      }
    }
    const swept: string[] = [];
    for (const entry of sweepVictims(readdirSync(this.dir), kept)) {
      const target = join(this.dir, entry);
      const st = lstatSync(target);
      if (st.isDirectory()) continue; // operator dirs survive; never recurse
      if (keptInodes.has(inodeKey(st))) continue; // IS a kept artifact under an aliased spelling
      rmSync(target, { force: true }); // unlinks files and symlinks themselves; never follows
      swept.push(entry);
    }
    swept.sort();
    return { manifestPath, artifacts, swept };
  }
}

// The sweep's keep/remove decision, pure and fs-agnostic (unit-tested directly — a true
// case-twin state cannot be CONSTRUCTED on the case-insensitive filesystems the suite may run
// on). A directory entry survives iff (a) it IS a kept path's exact spelling, or (b) it
// case-folds to a kept path whose exact spelling is ABSENT from the listing — the
// case-insensitive-filesystem shape where the entry is that very artifact under a stale case
// (readdir preserves an overwritten name's original case, and an exact-match sweep would
// delete the freshly manifested artifact). When the kept spelling IS present alongside
// (case-sensitive filesystem), the variant is a distinct stale file and sweeps like any other
// unmanifested entry — so successive runs tracking case-variant package names (`JSONStream`
// then `jsonstream`) cannot strand an unmanifested twin next to the manifested one.
export function sweepVictims(listing: readonly string[], keptPaths: readonly string[]): string[] {
  const keepExact = new Set(keptPaths);
  const exactByKey = new Map(keptPaths.map((p) => [collisionKey(p), p] as const));
  const present = new Set(listing);
  return listing
    .filter((entry) => {
      if (keepExact.has(entry)) return false;
      const kept = exactByKey.get(collisionKey(entry));
      if (kept !== undefined && !present.has(kept)) return false; // the artifact itself, stale case
      return true;
    })
    .sort();
}
