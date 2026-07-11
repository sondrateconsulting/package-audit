// artifactWrite.ts — the shared SYNC atomic artifact writer for the presentation layer (report
// JSON, exports, dossiers). Two guarantees, both load-bearing for the launch contract:
//   1. ATOMIC WRITES: every artifact is written to a same-directory temp file (created
//      exclusively — O_EXCL) and renamed into place, so a PROCESS crash mid-write can never
//      leave a plausible truncated artifact — only an unmanifested temp, which the next
//      generation's sweep removes. (Scope: process-crash atomicity. No fsync by design, so a
//      power/OS failure may still lose data the OS had not flushed.)
//   2. CONFINED SWEEP: xray/ artifacts are bundle-managed — a manifest.json ({path, sha256,
//      bytes} per artifact + run id + format version) is written LAST, and stale unmanifested
//      files are swept ONLY inside <outputDir>/xray/. The sweep never reaches the parent
//      outputDir BY GEOMETRY: outputDir accumulates run-<id>.json history and operator files by
//      design, and a flat sweep there would delete them. The xray/ root is verified to be a
//      real directory (never a symlink) before any write and again before the sweep.
//
// Concurrency posture (deliberate, per the manifest design): one bundle generation at a time.
// Two concurrent generations over one xray/ are NOT serialized — a torn mix is DETECTABLE
// (manifest hash mismatch), not prevented; the README documents the single-invocation
// expectation. Likewise the sweep guards against PRE-EXISTING symlink tricks, not an attacker
// actively racing the sweep with directory swaps — a local process with write access to the
// operator's own output directory could simply delete files itself.

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

// The report-format version embedded in the manifest (and by the artifacts themselves).
// Bumping this is the ONE sanctioned way golden files change.
export const XRAY_FORMAT_VERSION = 1;

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
          // unmanifested — the next generation's sweep removes it
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
      // the orphaned temp is unmanifested — the next generation's sweep removes it
    }
    throw e;
  }
}

export interface ArtifactRecord {
  readonly path: string; // filename relative to the xray/ directory (flat by contract)
  readonly sha256: string;
  readonly bytes: number;
}

export interface BundleResult {
  manifestPath: string;
  artifacts: ArtifactRecord[];
  swept: string[]; // unmanifested filenames removed from xray/, sorted
}

// Artifact names are restricted to a flat ASCII grammar. This kills the entire
// filesystem-aliasing class at the root: no Unicode normalization games (HFS+ re-spells NFC as
// NFD in readdir), no exotic case-folding aliases (U+017F ſ folds to s on folding filesystems)
// — every legal name round-trips readdir byte-identically everywhere. All real producers fit:
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
  private readonly records: ArtifactRecord[] = [];
  private readonly nameKeys = new Set<string>();
  private readonly names = new Set<string>();
  private finalized = false;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    this.dir = join(outputDir, XRAY_DIR_NAME);
  }

  // The sweep-confinement precondition: xray/ must be a REAL directory. A symlinked xray/
  // would redirect both the writes and — catastrophically — the flat sweep into whatever it
  // points at (readdir follows it), so it is refused outright, before the first write and
  // again before the sweep. lstat FIRST: mkdir would follow a symlink-to-dir silently and
  // throw a raw EEXIST on a dangling/file symlink — every non-real-directory shape must get
  // the same operator-facing remediation.
  private ensureRealDir(): void {
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
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      bytes: Buffer.byteLength(content, "utf8"),
    });
    this.nameKeys.add(key);
    this.names.add(name);
    this.records.push(record); // frozen — the caller and the manifest see the same immutable row
    return record;
  }

  // Write manifest.json (LAST), then sweep unmanifested files inside xray/ ONLY. The sweep
  // removes regular files and symlinks (unlinked, never followed) and leaves directories in
  // place — it is flat by construction, never recursive.
  finalize(meta: { runId: string }): BundleResult {
    if (this.finalized) throw new Error("bundle already finalized");
    this.finalized = true;
    this.ensureRealDir();
    const artifacts = [...this.records].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const manifest = { formatVersion: XRAY_FORMAT_VERSION, runId: meta.runId, artifacts };
    const manifestPath = join(this.dir, MANIFEST_NAME);
    writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n", [this.outputDir]);

    // The keep-set compares by collision key, not raw spelling: on a case-insensitive
    // filesystem an overwritten artifact KEEPS the directory entry's original case (a stale
    // `EXPO-dossier.html` overwritten via `expo-dossier.html` still readdirs as the former),
    // and an exact-match sweep would delete the freshly manifested artifact. Conservative by
    // design — a same-key stale file on a case-SENSITIVE filesystem is never swept (harmless:
    // the manifest names the exact artifact path, so it cannot shadow anything).
    // (No realpath-containment on victims: assertContained FOLLOWS symlinks, and the whole
    // point is to unlink a stale link itself without ever following it. Entries are readdir
    // basenames — including legal-but-odd POSIX names like `old\artifact` — swept normally.)
    const keepKeys = new Set<string>([...this.names].map(collisionKey).concat(MANIFEST_NAME));
    const swept: string[] = [];
    for (const entry of readdirSync(this.dir)) {
      if (keepKeys.has(collisionKey(entry))) continue;
      const target = join(this.dir, entry);
      if (lstatSync(target).isDirectory()) continue; // operator dirs survive; never recurse
      rmSync(target, { force: true }); // unlinks files and symlinks themselves; never follows
      swept.push(entry);
    }
    swept.sort();
    return { manifestPath, artifacts, swept };
  }
}
