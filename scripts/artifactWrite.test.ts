import { expect, test, describe, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadOnlyViolation } from "./readOnlyGuard.ts";
import {
  ArtifactBundle, ArtifactWriteError, XRAY_DIR_NAME, XRAY_FORMAT_VERSION, sweepVictims, writeFileAtomic,
} from "./artifactWrite.ts";

// artifactWrite takes EXPLICIT containment roots (unlike AuditDb.open's hardcoded ./data|./output),
// so tests run against disposable temp dirs — no repo-tree writes to clean up beyond TEST_ROOT.
const TEST_ROOT = mkdtempSync(join(tmpdir(), "artifact-write-test-"));
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));
let dirCounter = 0;
const nextOutputDir = (): string => {
  const dir = join(TEST_ROOT, `out-${dirCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("writeFileAtomic", () => {
  test("writes exact bytes and leaves no temp sibling", () => {
    const dir = nextOutputDir();
    const path = join(dir, "a.json");
    writeFileAtomic(path, '{"x":1}\n', [dir]);
    expect(readFileSync(path, "utf8")).toBe('{"x":1}\n');
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  test("creates missing parent directories inside the contained root", () => {
    const dir = nextOutputDir();
    const path = join(dir, "xray", "a.txt");
    writeFileAtomic(path, "hello", [dir]);
    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  test("overwrites an existing artifact atomically (rename, not truncate-then-write)", () => {
    const dir = nextOutputDir();
    const path = join(dir, "a.txt");
    writeFileAtomic(path, "first", [dir]);
    writeFileAtomic(path, "second", [dir]);
    expect(readFileSync(path, "utf8")).toBe("second");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });

  test("rejects a target outside the contained roots (§0)", () => {
    const dir = nextOutputDir();
    expect(() => writeFileAtomic(join(TEST_ROOT, "escape.txt"), "x", [dir])).toThrow(ReadOnlyViolation);
    expect(existsSync(join(TEST_ROOT, "escape.txt"))).toBe(false);
  });

  test("a failing rename never leaves a truncated destination and cleans its temp", () => {
    const dir = nextOutputDir();
    const path = join(dir, "a.txt");
    writeFileAtomic(path, "intact", [dir]);
    const boom = new Error("rename exploded");
    expect(() =>
      writeFileAtomic(path, "replacement", [dir], {
        renameSync: () => {
          throw boom;
        },
      }),
    ).toThrow(boom);
    expect(readFileSync(path, "utf8")).toBe("intact"); // old artifact untouched
    expect(readdirSync(dir)).toEqual(["a.txt"]); // temp cleaned up
  });

  test("a failing write never creates the destination", () => {
    const dir = nextOutputDir();
    const path = join(dir, "b.txt");
    expect(() =>
      writeFileAtomic(path, "x", [dir], {
        writeFileSync: () => {
          throw new Error("disk full");
        },
      }),
    ).toThrow("disk full");
    expect(existsSync(path)).toBe(false);
  });
});

describe("ArtifactBundle — write + manifest", () => {
  test("write() lands the artifact under <outputDir>/xray and returns {path, sha256, bytes}", () => {
    const out = nextOutputDir();
    const bundle = new ArtifactBundle(out, "dossier");
    const rec = bundle.write("expo-dossier.html", "<html>hi</html>");
    expect(rec).toEqual({ path: "expo-dossier.html", kind: "dossier", sha256: sha256("<html>hi</html>"), bytes: 15 });
    expect(readFileSync(join(out, XRAY_DIR_NAME, "expo-dossier.html"), "utf8")).toBe("<html>hi</html>");
  });

  test("byte counts are UTF-8 bytes, not code units", () => {
    const out = nextOutputDir();
    const bundle = new ArtifactBundle(out, "dossier");
    const rec = bundle.write("emoji.txt", "é🙂");
    expect(rec.bytes).toBe(Buffer.byteLength("é🙂", "utf8"));
  });

  test("finalize() writes manifest.json LAST with sorted entries, run id and format version", () => {
    const out = nextOutputDir();
    const bundle = new ArtifactBundle(out, "dossier");
    bundle.write("z.csv", "a,b\n");
    bundle.write("a.jsonl", '{"x":1}\n');
    expect(existsSync(join(out, XRAY_DIR_NAME, "manifest.json"))).toBe(false); // not before finalize
    const result = bundle.finalize({ runId: "run-1" });
    const manifest = JSON.parse(readFileSync(join(out, XRAY_DIR_NAME, "manifest.json"), "utf8")) as {
      runId: string;
      formatVersion: number;
      artifacts: Array<{ path: string; kind: string; sha256: string; bytes: number }>;
    };
    expect(manifest.runId).toBe("run-1");
    expect(manifest.formatVersion).toBe(XRAY_FORMAT_VERSION);
    expect(manifest.artifacts.map((a) => a.path)).toEqual(["a.jsonl", "z.csv"]); // sorted by path
    expect(manifest.artifacts[1]).toEqual({ path: "z.csv", kind: "dossier", sha256: sha256("a,b\n"), bytes: 4 });
    expect(result.manifestPath).toBe(join(out, XRAY_DIR_NAME, "manifest.json"));
  });

  test("finalize() is byte-deterministic across identical bundles", () => {
    const build = (): string => {
      const out = nextOutputDir();
      const bundle = new ArtifactBundle(out, "dossier");
      bundle.write("b.txt", "bee");
      bundle.write("a.txt", "ay");
      bundle.finalize({ runId: "run-x" });
      return readFileSync(join(out, XRAY_DIR_NAME, "manifest.json"), "utf8");
    };
    expect(build()).toBe(build());
  });

  test("duplicate artifact names within one bundle are a named error", () => {
    const out = nextOutputDir();
    const bundle = new ArtifactBundle(out, "dossier");
    bundle.write("a.txt", "one");
    expect(() => bundle.write("a.txt", "two")).toThrow(ArtifactWriteError);
  });

  test("name-SHAPE violations are producer bugs: plain Error, nothing lands", () => {
    const out = nextOutputDir();
    const bundle = new ArtifactBundle(out, "dossier");
    const badShapes = [
      "../evil.txt", "a/b.txt", "a\\b.txt", "", ".", "..",
      "manifest.json", "MANIFEST.JSON", // reserved (case-insensitively)
      "caf\u00e9.txt", // outside the ASCII grammar — kills the Unicode-aliasing class at the root
      "manife\u017ft.json", // U+017F long s — folds to "manifest" on case-folding filesystems
      "sp ace.txt", // space is outside the grammar too
    ];
    for (const bad of badShapes) {
      let caught: unknown;
      try {
        bundle.write(bad, "x");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(ArtifactWriteError); // bug, not operator condition
    }
    expect(existsSync(join(out, XRAY_DIR_NAME))).toBe(false); // nothing landed, dir never created
    expect(existsSync(join(TEST_ROOT, "evil.txt"))).toBe(false);
  });

  test("names that alias case-insensitively collide loudly (operator-facing)", () => {
    const out = nextOutputDir();
    const bundle = new ArtifactBundle(out, "dossier");
    bundle.write("A.txt", "upper"); // npm legacy names genuinely differ only by case
    expect(() => bundle.write("a.txt", "lower")).toThrow(ArtifactWriteError);
  });

  test("returned records are frozen — a caller cannot falsify the manifest", () => {
    const out = nextOutputDir();
    const bundle = new ArtifactBundle(out, "dossier");
    const rec = bundle.write("a.txt", "content");
    expect(Object.isFrozen(rec)).toBe(true);
    expect(() => {
      (rec as { path: string }).path = "manifest.json";
    }).toThrow(TypeError);
  });

  test("write after finalize and double finalize are lifecycle BUGS — plain Error, stack kept", () => {
    const out = nextOutputDir();
    const bundle = new ArtifactBundle(out, "dossier");
    bundle.write("a.txt", "x");
    bundle.finalize({ runId: "r" });
    for (const call of [() => bundle.write("b.txt", "y"), () => bundle.finalize({ runId: "r" })]) {
      let caught: unknown;
      try {
        call();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(ArtifactWriteError); // NOT operator-facing/message-only
      expect((caught as Error).message).toContain("already finalized");
    }
  });

  test("a PERSISTENT temp collision exhausts its attempts loudly, renaming nothing", () => {
    const dir = nextOutputDir();
    const path = join(dir, "a.txt");
    writeFileAtomic(path, "intact", [dir]);
    let renames = 0;
    expect(() =>
      writeFileAtomic(path, "never", [dir], {
        writeFileSync: () => {
          const err = new Error("EEXIST") as Error & { code: string };
          err.code = "EEXIST";
          throw err;
        },
        renameSync: () => {
          renames++;
        },
      }),
    ).toThrow(/after 16 attempts/);
    expect(renames).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("intact");
  });

  test("a dot basename (parent-directory write) is a producer bug, rejected up front", () => {
    const dir = nextOutputDir();
    mkdirSync(join(dir, "sub"));
    // raw strings — join() would lexically collapse the dot components away
    for (const bad of [`${dir}/sub/..`, `${dir}/sub/.`]) {
      expect(() => writeFileAtomic(bad, "x", [dir])).toThrow(/real file basename/);
    }
    // a trailing-slash root path fails closed too (its PARENT escapes the containment root)
    expect(() => writeFileAtomic(dir + "/", "x", [dir])).toThrow(ReadOnlyViolation);
    expect(readdirSync(dir).sort()).toEqual(["sub"]); // no sibling temp of the root appeared
  });

  test("a lexical ..-detour path cannot make mkdir create directories outside the root", () => {
    const dir = nextOutputDir();
    // Resolves INSIDE dir (probe/.. cancels), but a lexical recursive mkdir would create
    // TEST_ROOT/probe as a side effect. The canonical-parent fix must not.
    const detour = `${dir}/../probe/../${dir.split("/").pop()!}/a.txt`;
    writeFileAtomic(detour, "content", [dir]);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("content");
    expect(existsSync(join(TEST_ROOT, "probe"))).toBe(false);
  });

  test("a temp-name collision retries with the next candidate (exclusive create)", () => {
    const dir = nextOutputDir();
    const path = join(dir, "a.txt");
    let calls = 0;
    writeFileAtomic(path, "content", [dir], {
      writeFileSync: (p, data, opts) => {
        calls++;
        if (calls === 1) {
          const err = new Error("EEXIST: file already exists") as Error & { code: string };
          err.code = "EEXIST";
          throw err;
        }
        writeFileSync(p, data, opts);
      },
    });
    expect(calls).toBe(2);
    expect(readFileSync(path, "utf8")).toBe("content");
    expect(readdirSync(dir)).toEqual(["a.txt"]); // no stray temp from the collided candidate
  });
});

describe("ArtifactBundle — symlink hostility", () => {
  test("a symlinked xray/ root is refused before anything is written or swept", () => {
    const out = nextOutputDir();
    mkdirSync(join(out, "operator-dir"));
    writeFileSync(join(out, "operator-dir", "precious.txt"), "keep me");
    symlinkSync(join(out, "operator-dir"), join(out, XRAY_DIR_NAME));

    const bundle = new ArtifactBundle(out, "dossier");
    expect(() => bundle.write("a.html", "<html/>")).toThrow(ArtifactWriteError);
    expect(readFileSync(join(out, "operator-dir", "precious.txt"), "utf8")).toBe("keep me");
    expect(readdirSync(join(out, "operator-dir"))).toEqual(["precious.txt"]); // nothing landed there
  });

  test("a terminal symlink at the artifact path is REPLACED, never followed", () => {
    const out = nextOutputDir();
    const xray = join(out, XRAY_DIR_NAME);
    mkdirSync(xray, { recursive: true });
    writeFileSync(join(out, "run-77.json"), '{"history":true}');
    symlinkSync(join("..", "run-77.json"), join(xray, "expo-dossier.html")); // points INSIDE outputDir

    const bundle = new ArtifactBundle(out, "dossier");
    bundle.write("expo-dossier.html", "<html/>");
    expect(readFileSync(join(out, "run-77.json"), "utf8")).toBe('{"history":true}'); // NOT clobbered
    expect(lstatSync(join(xray, "expo-dossier.html")).isSymbolicLink()).toBe(false); // link replaced
    expect(readFileSync(join(xray, "expo-dossier.html"), "utf8")).toBe("<html/>");
  });

  test("a terminal symlink pointing OUTSIDE the roots fails closed", () => {
    const out = nextOutputDir();
    const xray = join(out, XRAY_DIR_NAME);
    mkdirSync(xray, { recursive: true });
    const outside = join(TEST_ROOT, "outside-target.txt");
    symlinkSync(outside, join(xray, "evil.html"));

    const bundle = new ArtifactBundle(out, "dossier");
    expect(() => bundle.write("evil.html", "payload")).toThrow(ReadOnlyViolation);
    expect(existsSync(outside)).toBe(false); // nothing written through the link
  });
});

describe("ArtifactBundle — sweep confinement", () => {
  test("finalize() sweeps unmanifested files INSIDE xray/ only; outputDir history survives", () => {
    const out = nextOutputDir();
    const xray = join(out, XRAY_DIR_NAME);
    mkdirSync(xray, { recursive: true });
    // stale artifacts from a previous generation + a crashed write's temp file
    writeFileSync(join(xray, "removed-package-dossier.html"), "stale");
    writeFileSync(join(xray, ".tmp-crashed-123"), "partial");
    // DECOYS in the manifest-OWNED directory's PARENT: report history + an operator file.
    // outputDir accumulates run-*.json by design — a flat sweep would delete it (E2).
    writeFileSync(join(out, "run-77.json"), '{"history":true}');
    writeFileSync(join(out, "latest.json"), '{"latest":true}');
    writeFileSync(join(out, "operator-notes.txt"), "keep me");

    const bundle = new ArtifactBundle(out, "dossier");
    bundle.write("expo-dossier.html", "<html/>");
    const { swept } = bundle.finalize({ runId: "run-2" });

    expect(swept).toEqual([".tmp-crashed-123", "removed-package-dossier.html"]); // production-sorted
    expect(existsSync(join(xray, "removed-package-dossier.html"))).toBe(false);
    expect(existsSync(join(xray, ".tmp-crashed-123"))).toBe(false);
    // survivors: the fresh artifact, the manifest, and EVERYTHING outside xray/
    expect(readFileSync(join(xray, "expo-dossier.html"), "utf8")).toBe("<html/>");
    expect(existsSync(join(xray, "manifest.json"))).toBe(true);
    expect(readFileSync(join(out, "run-77.json"), "utf8")).toBe('{"history":true}');
    expect(readFileSync(join(out, "latest.json"), "utf8")).toBe('{"latest":true}');
    expect(readFileSync(join(out, "operator-notes.txt"), "utf8")).toBe("keep me");
  });

  test("sweep unlinks a symlink itself and NEVER follows it out of xray/", () => {
    const out = nextOutputDir();
    const xray = join(out, XRAY_DIR_NAME);
    mkdirSync(xray, { recursive: true });
    writeFileSync(join(out, "target.txt"), "outside");
    symlinkSync(join(out, "target.txt"), join(xray, "sneaky-link"));

    const bundle = new ArtifactBundle(out, "dossier");
    bundle.write("index.html", "<html/>");
    const { swept } = bundle.finalize({ runId: "run-3" });

    expect(swept).toEqual(["sneaky-link"]);
    expect(existsSync(join(xray, "sneaky-link"))).toBe(false); // link removed
    expect(readFileSync(join(out, "target.txt"), "utf8")).toBe("outside"); // target untouched
  });

  test("sweep unlinks a symlink-to-DIRECTORY itself (lstat, not stat) and never recurses into it", () => {
    const out = nextOutputDir();
    const xray = join(out, XRAY_DIR_NAME);
    mkdirSync(xray, { recursive: true });
    mkdirSync(join(out, "linked-dir"));
    writeFileSync(join(out, "linked-dir", "inside.txt"), "keep");
    symlinkSync(join(out, "linked-dir"), join(xray, "dir-link"));

    const bundle = new ArtifactBundle(out, "dossier");
    bundle.write("index.html", "<html/>");
    const { swept } = bundle.finalize({ runId: "run-5" });

    expect(swept).toEqual(["dir-link"]); // a stat()-based check would have skipped it as a directory
    expect(existsSync(join(xray, "dir-link"))).toBe(false);
    expect(readFileSync(join(out, "linked-dir", "inside.txt"), "utf8")).toBe("keep"); // target untouched
  });

  test("sweep leaves directories inside xray/ in place (files only, never recursive)", () => {
    const out = nextOutputDir();
    const xray = join(out, XRAY_DIR_NAME);
    mkdirSync(join(xray, "operator-subdir"), { recursive: true });
    writeFileSync(join(xray, "operator-subdir", "note.txt"), "keep");

    const bundle = new ArtifactBundle(out, "dossier");
    bundle.write("index.html", "<html/>");
    const { swept } = bundle.finalize({ runId: "run-4" });

    expect(swept).toEqual([]);
    expect(readFileSync(join(xray, "operator-subdir", "note.txt"), "utf8")).toBe("keep");
  });

  test("sweep and stale case-variants: kept on case-insensitive filesystems (it IS the artifact), swept on case-sensitive ones (distinct twin)", () => {
    const out = nextOutputDir();
    const xray = join(out, XRAY_DIR_NAME);
    mkdirSync(xray, { recursive: true });
    // A previous generation left EXPO-dossier.html. On a case-insensitive filesystem, writing
    // expo-dossier.html OVERWRITES that entry but readdir keeps the ORIGINAL spelling — an
    // exact-match keep-set would then sweep our own fresh artifact. On a case-SENSITIVE
    // filesystem the two names are distinct files, and the stale twin must sweep (the
    // sweepVictims contract) — so this test branches on the filesystem's actual behavior.
    writeFileSync(join(xray, "EXPO-dossier.html"), "stale");
    const caseInsensitive = existsSync(join(xray, "expo-DOSSIER.html"));

    const bundle = new ArtifactBundle(out, "dossier");
    bundle.write("expo-dossier.html", "<html>fresh</html>");
    const { swept } = bundle.finalize({ runId: "run-6" });

    expect(swept).toEqual(caseInsensitive ? [] : ["EXPO-dossier.html"]);
    expect(readFileSync(join(xray, "expo-dossier.html"), "utf8")).toBe("<html>fresh</html>");
  });

  test("sweep never unlinks a directory entry that IS a kept artifact (same inode) — Unicode case-fold aliases cannot delete the manifest", () => {
    // JS toLowerCase can never replicate a filesystem's Unicode case folding exactly (e.g.
    // APFS folds U+017F ſ → s, JS does not), so keep/sweep name math alone could classify a
    // directory entry that ALIASES a just-written artifact as a victim. The inode guard makes
    // that class impossible: an entry whose inode matches a kept artifact is never unlinked.
    // A hardlink is the deterministic cross-filesystem stand-in for such an alias.
    const out = nextOutputDir();
    const xray = join(out, XRAY_DIR_NAME);
    const bundle = new ArtifactBundle(out, "dossier");
    bundle.write("expo-dossier.html", "<html>fresh</html>");
    linkSync(join(xray, "expo-dossier.html"), join(xray, "alias-of-artifact.html"));
    const { swept } = bundle.finalize({ runId: "run-6b" });
    expect(swept).toEqual([]); // the alias shares the artifact's inode — kept, not swept
    expect(readFileSync(join(xray, "expo-dossier.html"), "utf8")).toBe("<html>fresh</html>");
    expect(existsSync(join(xray, "alias-of-artifact.html"))).toBe(true);
  });

  test("sweep removes a stale file whose name contains a backslash (legal POSIX basename)", () => {
    const out = nextOutputDir();
    const xray = join(out, XRAY_DIR_NAME);
    mkdirSync(xray, { recursive: true });
    writeFileSync(join(xray, "old\\artifact"), "stale");

    const bundle = new ArtifactBundle(out, "dossier");
    bundle.write("index.html", "<html/>");
    const { swept } = bundle.finalize({ runId: "run-7" });

    expect(swept).toEqual(["old\\artifact"]);
    expect(existsSync(join(xray, "old\\artifact"))).toBe(false);
  });

  test("a DANGLING xray/ symlink gets the operator-facing error, not a raw EEXIST", () => {
    const out = nextOutputDir();
    symlinkSync(join(out, "does-not-exist"), join(out, XRAY_DIR_NAME));
    const bundle = new ArtifactBundle(out, "dossier");
    expect(() => bundle.write("a.html", "<html/>")).toThrow(ArtifactWriteError);
  });

  test("a second generation with fewer packages sweeps exactly the dropped dossier", () => {
    const out = nextOutputDir();
    const first = new ArtifactBundle(out, "dossier");
    first.write("expo-dossier.html", "<html>expo</html>");
    first.write("@expo__vector-icons-dossier.html", "<html>icons</html>");
    first.write("index.html", "<html>index</html>");
    first.finalize({ runId: "run-a" });

    const second = new ArtifactBundle(out, "dossier");
    second.write("expo-dossier.html", "<html>expo v2</html>");
    second.write("index.html", "<html>index v2</html>");
    const { swept } = second.finalize({ runId: "run-b" });

    expect(swept).toEqual(["@expo__vector-icons-dossier.html"]);
    const survivors = readdirSync(join(out, XRAY_DIR_NAME)).sort();
    expect(survivors).toEqual(["expo-dossier.html", "index.html", "manifest.json"]);
  });
});

describe("ArtifactBundle — cross-kind manifest adoption (export + dossier share xray/)", () => {
  test("a dossier generation ADOPTS same-run export artifacts: nothing of theirs is swept", () => {
    const out = nextOutputDir();
    const exports = new ArtifactBundle(out, "export");
    exports.write("usage_findings.csv", "a,b\r\n");
    exports.finalize({ runId: "run-1" });

    const dossiers = new ArtifactBundle(out, "dossier");
    dossiers.write("expo-dossier.html", "<html/>");
    const { artifacts, swept } = dossiers.finalize({ runId: "run-1" });

    expect(swept).toEqual([]);
    expect(artifacts.map((a) => `${a.kind}:${a.path}`)).toEqual([
      "dossier:expo-dossier.html",
      "export:usage_findings.csv",
    ]);
    expect(readFileSync(join(out, XRAY_DIR_NAME, "usage_findings.csv"), "utf8")).toBe("a,b\r\n");
    // and the merged manifest is what landed on disk
    const manifest = JSON.parse(readFileSync(join(out, XRAY_DIR_NAME, "manifest.json"), "utf8"));
    expect(manifest.artifacts.length).toBe(2);
  });

  test("a tampered manifest path (../evil) is name-validated and NEVER adopted or lstat-probed (L1)", () => {
    const out = nextOutputDir();
    const exports = new ArtifactBundle(out, "export");
    exports.write("usage_findings.csv", "a,b\r\n");
    exports.finalize({ runId: "run-1" });

    // Tamper the on-disk manifest: inject a traversal path an attacker with write access could plant.
    const mpath = join(out, XRAY_DIR_NAME, "manifest.json");
    const m = JSON.parse(readFileSync(mpath, "utf8")) as { artifacts: Array<Record<string, unknown>> };
    m.artifacts.push({ path: "../evil.txt", kind: "export", sha256: "0".repeat(64), bytes: 1 });
    writeFileSync(mpath, JSON.stringify(m));
    // A real file at the traversal TARGET (outside xray/): without the name-grammar guard,
    // adoptableEntries would lstat(join(xray, "../evil.txt")) = out/evil.txt, find it, and adopt
    // the escaping entry into the new manifest.
    writeFileSync(join(out, "evil.txt"), "x");

    const dossiers = new ArtifactBundle(out, "dossier");
    dossiers.write("expo-dossier.html", "<html/>");
    const { artifacts } = dossiers.finalize({ runId: "run-1" });

    // the legit export IS adopted; the traversal entry is skipped by NAME_GRAMMAR, never adopted
    expect(artifacts.map((a) => a.path)).toEqual(["expo-dossier.html", "usage_findings.csv"]);
    expect(artifacts.some((a) => a.path.includes(".."))).toBe(false);
    expect(existsSync(join(out, "evil.txt"))).toBe(true); // the out-of-bundle file is never touched
  });

  test("a tampered manifest path of exactly `.` or `..` is rejected (the non-regex adoption branch)", () => {
    // `.` and `..` match NAME_GRAMMAR's char class, so they need the explicit reject in
    // adoptableEntries — exercise it directly (distinct from the `/`-bearing `../evil.txt` case).
    const out = nextOutputDir();
    const exports = new ArtifactBundle(out, "export");
    exports.write("usage_findings.csv", "a,b\r\n");
    exports.finalize({ runId: "run-1" });
    const mpath = join(out, XRAY_DIR_NAME, "manifest.json");
    const m = JSON.parse(readFileSync(mpath, "utf8")) as { artifacts: Array<Record<string, unknown>> };
    m.artifacts.push({ path: "..", kind: "export", sha256: "0".repeat(64), bytes: 1 });
    m.artifacts.push({ path: ".", kind: "export", sha256: "0".repeat(64), bytes: 1 });
    writeFileSync(mpath, JSON.stringify(m));

    const dossiers = new ArtifactBundle(out, "dossier");
    dossiers.write("expo-dossier.html", "<html/>");
    const { artifacts } = dossiers.finalize({ runId: "run-1" });
    expect(artifacts.map((a) => a.path)).toEqual(["expo-dossier.html", "usage_findings.csv"]); // neither . nor .. adopted
  });

  test("a tampered manifest with a null entry or the reserved manifest.json name doesn't crash or poison", () => {
    const out = nextOutputDir();
    const exports = new ArtifactBundle(out, "export");
    exports.write("usage_findings.csv", "a,b\r\n");
    exports.finalize({ runId: "run-1" });
    const mpath = join(out, XRAY_DIR_NAME, "manifest.json");
    const m = JSON.parse(readFileSync(mpath, "utf8")) as { artifacts: unknown[] };
    m.artifacts.push(null); // null array element — must be skipped, not dereferenced (would throw)
    m.artifacts.push({ path: "manifest.json", kind: "export", sha256: "0".repeat(64), bytes: 1 }); // reserved name
    writeFileSync(mpath, JSON.stringify(m));

    const dossiers = new ArtifactBundle(out, "dossier");
    dossiers.write("expo-dossier.html", "<html/>");
    const { artifacts } = dossiers.finalize({ runId: "run-1" }); // must not throw on the null entry
    // manifest.json is never adopted as an artifact row (its integrity stays self-defined); only the
    // legit two entries remain
    expect(artifacts.map((a) => a.path)).toEqual(["expo-dossier.html", "usage_findings.csv"]);
  });

  test("a manifest whose JSON root is bare `null` (or non-object) is ignored, not crashed", () => {
    const out = nextOutputDir();
    const exports = new ArtifactBundle(out, "export");
    exports.write("usage_findings.csv", "a,b\r\n");
    exports.finalize({ runId: "run-1" });
    writeFileSync(join(out, XRAY_DIR_NAME, "manifest.json"), "null"); // valid JSON, but not an object

    const dossiers = new ArtifactBundle(out, "dossier");
    dossiers.write("expo-dossier.html", "<html/>");
    const { artifacts, swept } = dossiers.finalize({ runId: "run-1" }); // must NOT throw (null.formatVersion)
    expect(artifacts.map((a) => a.path)).toEqual(["expo-dossier.html"]); // null root adopts nothing
    expect(swept).toEqual(["usage_findings.csv"]); // the now-unmanifested export sweeps
  });

  test("adopted entries with a non-safe-integer `bytes` or non-64-hex sha256 are rejected (no poison)", () => {
    const out = nextOutputDir();
    const exports = new ArtifactBundle(out, "export");
    exports.write("usage_findings.csv", "a,b\r\n");
    exports.finalize({ runId: "run-1" });
    writeFileSync(join(out, XRAY_DIR_NAME, "evil1.csv"), "x");
    writeFileSync(join(out, XRAY_DIR_NAME, "evil2.csv"), "x");
    // hand-write the JSON so `bytes:1e400` survives as a number literal (JSON.parse → Infinity, which
    // would reserialize as bytes:null); evil2 has a non-hex sha256.
    writeFileSync(
      join(out, XRAY_DIR_NAME, "manifest.json"),
      // formatVersion MUST match the current version — otherwise adoption bails on the
      // version gate (line ~256) and the poison entries are never even evaluated, making
      // this test pass for the wrong reason.
      `{"formatVersion":${XRAY_FORMAT_VERSION},"runId":"run-1","artifacts":[` +
        `{"path":"evil1.csv","kind":"export","sha256":"${"0".repeat(64)}","bytes":1e400},` +
        `{"path":"evil2.csv","kind":"export","sha256":"nothex","bytes":5}]}`,
    );

    const dossiers = new ArtifactBundle(out, "dossier");
    dossiers.write("expo-dossier.html", "<html/>");
    const { artifacts } = dossiers.finalize({ runId: "run-1" });
    expect(artifacts.map((a) => a.path)).toEqual(["expo-dossier.html"]); // neither poisoned entry adopted
    expect(artifacts.every((a) => Number.isSafeInteger(a.bytes) && a.bytes >= 0)).toBe(true);
  });

  test("a DIFFERENT runId is a wholesale replacement: the other kind's stale artifacts die", () => {
    const out = nextOutputDir();
    const exports = new ArtifactBundle(out, "export");
    exports.write("usage_findings.csv", "old-run data");
    exports.finalize({ runId: "run-1" });

    const dossiers = new ArtifactBundle(out, "dossier");
    dossiers.write("expo-dossier.html", "<html/>");
    const { artifacts, swept } = dossiers.finalize({ runId: "run-2" });

    expect(swept).toEqual(["usage_findings.csv"]); // stale generation, not adopted
    expect(artifacts.map((a) => a.path)).toEqual(["expo-dossier.html"]);
  });

  test("same-kind stale entries are NEVER adopted: a dropped dossier dies even within one run", () => {
    const out = nextOutputDir();
    const first = new ArtifactBundle(out, "dossier");
    first.write("expo-dossier.html", "v1");
    first.write("react-dossier.html", "v1");
    first.finalize({ runId: "run-1" });

    const second = new ArtifactBundle(out, "dossier");
    second.write("expo-dossier.html", "v2"); // react was removed from the tracked set
    const { swept, artifacts } = second.finalize({ runId: "run-1" });

    expect(swept).toEqual(["react-dossier.html"]);
    expect(artifacts.map((a) => a.path)).toEqual(["expo-dossier.html"]);
  });

  test("an adopted entry whose file vanished is dropped from the manifest", () => {
    const out = nextOutputDir();
    const exports = new ArtifactBundle(out, "export");
    exports.write("runs.csv", "x\r\n");
    exports.finalize({ runId: "run-1" });
    rmSync(join(out, XRAY_DIR_NAME, "runs.csv")); // operator deleted it between commands

    const dossiers = new ArtifactBundle(out, "dossier");
    dossiers.write("index.html", "<html/>");
    const { artifacts } = dossiers.finalize({ runId: "run-1" });
    expect(artifacts.map((a) => a.path)).toEqual(["index.html"]); // no ghost entry
  });

  test("a torn/unparseable manifest adopts nothing (everything unmanifested sweeps)", () => {
    const out = nextOutputDir();
    const xray = join(out, XRAY_DIR_NAME);
    mkdirSync(xray, { recursive: true });
    writeFileSync(join(xray, "manifest.json"), "{ torn");
    writeFileSync(join(xray, "orphan.csv"), "stale");

    const dossiers = new ArtifactBundle(out, "dossier");
    dossiers.write("index.html", "<html/>");
    const { swept } = dossiers.finalize({ runId: "run-1" });
    expect(swept).toEqual(["orphan.csv"]);
  });

  test("adoption never resurrects an entry this generation rewrote (kind change by rewrite)", () => {
    const out = nextOutputDir();
    const exports = new ArtifactBundle(out, "export");
    exports.write("shared-name.csv", "export version");
    exports.finalize({ runId: "run-1" });

    const dossiers = new ArtifactBundle(out, "dossier");
    dossiers.write("shared-name.csv", "dossier rewrote it");
    const { artifacts } = dossiers.finalize({ runId: "run-1" });
    const entries = artifacts.filter((a) => a.path === "shared-name.csv");
    expect(entries).toEqual([{ path: "shared-name.csv", kind: "dossier", sha256: entries[0]!.sha256, bytes: 18 }]);
  });
});

// ---- codex re-pass regressions (2026-07-11, F6 + F7) ---------------------------------------------
describe("bundle dir containment before creation (F6)", () => {
  test("an outputDir whose lexical xray join diverges from its resolved location is refused BEFORE any mkdir", () => {
    // out/link -> out/a/b, outputDir 'out/link/../..': symlink-aware resolution lands INSIDE
    // out/, but path.join collapses the dots LEXICALLY, so the bundle dir computes to
    // <root>/xray — outside the root the config validated. The bundle must fail closed without
    // creating that directory.
    const root = mkdtempSync(join(tmpdir(), "aw-f6-"));
    try {
      mkdirSync(join(root, "out", "a", "b"), { recursive: true });
      symlinkSync(join("a", "b"), join(root, "out", "link"));
      const bundle = new ArtifactBundle(`${root}/out/link/../..`, "export");
      expect(() => bundle.write("x.csv", "data")).toThrow();
      expect(existsSync(join(root, "xray"))).toBe(false); // nothing may be created outside the roots
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sweepVictims (F7)", () => {
  // Pure decision function: a true case-twin state cannot be CONSTRUCTED on a case-insensitive
  // filesystem (macOS dev machines), so the fs-shape matrix is pinned here directly.
  const kept = ["expo-dossier.html", "index.html", "manifest.json"];

  test("case-sensitive twin: a stale case variant sweeps when the kept spelling is present beside it", () => {
    expect(sweepVictims(["EXPO-dossier.html", "expo-dossier.html", "index.html", "manifest.json"], kept)).toEqual(["EXPO-dossier.html"]);
  });

  test("case-insensitive stale spelling: the artifact itself under its old case survives", () => {
    expect(sweepVictims(["EXPO-dossier.html", "index.html", "manifest.json"], kept)).toEqual([]);
  });

  test("unmanifested names sweep regardless of case games", () => {
    expect(sweepVictims(["stray.txt", "STRAY.TXT", "expo-dossier.html", "index.html", "manifest.json"], kept)).toEqual(["STRAY.TXT", "stray.txt"]);
  });

  test("the manifest itself is protected in both spellings", () => {
    expect(sweepVictims(["MANIFEST.JSON", "expo-dossier.html", "index.html"], kept)).toEqual([]);
    expect(sweepVictims(["MANIFEST.JSON", "manifest.json", "expo-dossier.html", "index.html"], kept)).toEqual(["MANIFEST.JSON"]);
  });
});
