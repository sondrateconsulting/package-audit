// benchWorkload.test.ts — the recording harness runs the REAL production selection; the route
// matrix derives pure and re-derives on parse (ground-truth drift is a parse failure).
import { describe, expect, test } from "bun:test";
import type { TreeEntry } from "./unitPipeline.ts";
import {
  BenchWorkloadError, buildUnitWorkload, countReplacementChars, deriveRoutes, parseUnitWorkload,
  recordSelection, seamSha256, seamStringSha256,
  type UnitContext, type WorkloadEntry,
} from "./benchWorkload.ts";

const sha = (c: string): string => c.repeat(40);
const blob = (path: string, size: number, c: string): TreeEntry => ({ path, type: "blob", sha: sha(c), size });

const LOC = { githubHost: "github.com", organization: "o", repository: "r", branch: "main", commitSha: sha("0") };

describe("recordSelection — the production pipeline under a recording reader", () => {
  const entries: TreeEntry[] = [
    blob("package.json", 200, "1"),
    blob("package-lock.json", 500, "2"),
    blob("src/a.ts", 100, "3"),
    blob("README.md", 100, "4"), // never selected
    blob("run.sh", 50, "5"),
    blob(".github/workflows/ci.yml", 80, "6"),
    blob("pkg/package.json", 150, "7"),
    blob("pkg/bun.lockb", 900, "8"), // elected binary lockfile — never read
    blob("pkg/big.ts", 3 * 1024 * 1024, "9"), // gated source — never read
    blob("huge.sh", 5 * 1024 * 1024, "a"), // gated CLI — never read
    blob("node_modules/x/package.json", 10, "b"), // always skipped
  ];
  const texts: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { pino: "^9.0.0" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
    "src/a.ts": "import pino from \"pino\";\n",
    "run.sh": "#!/bin/sh\necho hi\n",
    ".github/workflows/ci.yml": "on: push\n",
    "pkg/package.json": JSON.stringify({ dependencies: { pino: "^9.0.0" } }),
  };
  const readFile = async (path: string): Promise<string | null> => texts[path] ?? null;

  test("read set, classes, duplicate-read counts, and both no-read outcomes", async () => {
    const rec = await recordSelection({
      loc: LOC, trackedPackages: ["pino"], excludeDirGlobs: [], maxScanBytes: 2 * 1024 * 1024,
      entries, readFile: (p) => readFile(p),
    });
    expect(rec.classes.get("package.json")).toBe("manifest");
    expect(rec.classes.get("pkg/package.json")).toBe("manifest");
    expect(rec.classes.get("package-lock.json")).toBe("lockfile");
    expect(rec.classes.get("src/a.ts")).toBe("source");
    expect(rec.classes.get("run.sh")).toBe("cli");
    expect(rec.classes.get(".github/workflows/ci.yml")).toBe("cli");
    expect(rec.readPaths).not.toContain("README.md");
    expect(rec.readPaths).not.toContain("node_modules/x/package.json");
    expect(rec.readPaths).not.toContain("pkg/big.ts");
    expect(rec.readPaths).not.toContain("huge.sh");
    // production reads package.json twice: as a manifest, then as a CLI-kind file
    expect(rec.readCounts.get("package.json")).toBe(2);
    expect(rec.noReads).toContainEqual({ path: "pkg/bun.lockb", reason: "binary-lockfile-skip" });
    expect(rec.noReads).toContainEqual({ path: "pkg/big.ts", reason: "size-gate-skip" });
    expect(rec.noReads).toContainEqual({ path: "huge.sh", reason: "size-gate-skip" });
    expect(rec.noReads.length).toBe(3);
  });
});

// ---- deriveRoutes ----------------------------------------------------------------------------
const HASHES = {
  canonicalSeamSha256: seamStringSha256("canonical"),
  restDerefSeamSha256: seamStringSha256("deref"),
  checkoutSeamSha256: seamStringSha256("checkout"),
};
const readEntry = (over: Partial<WorkloadEntry> = {}): WorkloadEntry => ({
  path: "f.txt", mode: "100644", blobOid: sha("c"), size: 10, class: "source",
  read: true, noReadReason: null,
  canonicalSeamSha256: HASHES.canonicalSeamSha256, rawSha256: seamStringSha256("raw"),
  restDerefSeamSha256: null, checkoutSeamSha256: HASHES.checkoutSeamSha256,
  gql: { isBinary: false, isTruncated: false, textNull: false },
  ...over,
});
const CTX: UnitContext = { truncatedTree: false, escapeTripped: false, batchContentBytesCap: 1_572_864 };

describe("deriveRoutes — the §4.3 matrix over the complete vocabulary", () => {
  test("regular text entry: T0/T2c canonical, T1 primary + 4 permitted operational fallbacks, T2a checkout", () => {
    const r = deriveRoutes(readEntry(), CTX);
    expect(r.T0).toEqual({ primary: "primary", declaredCaveat: false, permittedFallbacks: [], expected: { primary: { seamSha256: HASHES.canonicalSeamSha256 } } });
    expect(r.T1.primary).toBe("primary");
    expect(r.T1.permittedFallbacks).toEqual(["batch-error-fallback", "validation-fallback", "timeout-singleton", "missing-alias-fallback"]);
    expect(r.T1.expected["validation-fallback"]).toEqual({ seamSha256: HASHES.canonicalSeamSha256 });
    expect(r.T2a.expected["primary"]).toEqual({ seamSha256: HASHES.checkoutSeamSha256 }); // checkout is T2a's PRIMARY — no caveat shelter
    expect(r.T2a.declaredCaveat).toBe(false);
    expect(r.T2c.expected["primary"]).toEqual({ seamSha256: HASHES.canonicalSeamSha256 });
  });
  test("symlink: T0 primary delivers the dereferenced bytes; T1/T2a/T2c route symlink-fallback", () => {
    const link = readEntry({ mode: "120000", restDerefSeamSha256: HASHES.restDerefSeamSha256, gql: null });
    const r = deriveRoutes(link, CTX);
    expect(r.T0.expected["primary"]).toEqual({ seamSha256: HASHES.restDerefSeamSha256 });
    for (const d of ["T1", "T2a", "T2c"] as const) {
      expect(r[d].primary).toBe("symlink-fallback");
      expect(r[d].expected["symlink-fallback"]).toEqual({ seamSha256: HASHES.restDerefSeamSha256 });
    }
  });
  test("GitHub's own pinned judgment routes T1: binary / truncated blob / content-cap singleton", () => {
    expect(deriveRoutes(readEntry({ gql: { isBinary: true, isTruncated: false, textNull: true } }), CTX).T1.primary).toBe("binary-fallback");
    expect(deriveRoutes(readEntry({ gql: { isBinary: false, isTruncated: true, textNull: false } }), CTX).T1.primary).toBe("truncated-blob-fallback");
    expect(deriveRoutes(readEntry({ size: 2_000_000 }), CTX).T1.primary).toBe("content-cap-singleton");
  });
  test("C4 truncated tree: T0/T1 take the DECLARED-CAVEAT checkout route; T2c stays canonical", () => {
    const r = deriveRoutes(readEntry(), { ...CTX, truncatedTree: true });
    for (const d of ["T0", "T1"] as const) {
      expect(r[d].primary).toBe("truncated-tree-checkout");
      expect(r[d].declaredCaveat).toBe(true);
      expect(r[d].expected["truncated-tree-checkout"]).toEqual({ seamSha256: HASHES.checkoutSeamSha256 });
    }
    expect(r.T2a.primary).toBe("primary"); // checkout primary, no caveat
    expect(r.T2c.primary).toBe("primary");
    expect(r.T2c.expected["primary"]).toEqual({ seamSha256: HASHES.canonicalSeamSha256 });
  });
  test("T2a's pinned api-escape resolves with T0 semantics — except truncated trees clone anyway", () => {
    const escaped = deriveRoutes(readEntry(), { ...CTX, escapeTripped: true });
    expect(escaped.T2a.primary).toBe("api-escape");
    expect(escaped.T2a.expected["api-escape"]).toEqual({ seamSha256: HASHES.canonicalSeamSha256 });
    const escapedLink = deriveRoutes(readEntry({ mode: "120000", restDerefSeamSha256: HASHES.restDerefSeamSha256, gql: null }), { ...CTX, escapeTripped: true });
    expect(escapedLink.T2a.expected["api-escape"]).toEqual({ seamSha256: HASHES.restDerefSeamSha256 });
    const both = deriveRoutes(readEntry(), { ...CTX, escapeTripped: true, truncatedTree: true });
    expect(both.T2a.primary).toBe("primary"); // the exhibited hole: oversized AND truncated → clone
  });
  test("no-read entries carry verified non-acquisition for EVERY driver", () => {
    const nr = deriveRoutes(readEntry({ read: false, noReadReason: "binary-lockfile-skip", canonicalSeamSha256: null, gql: null }), CTX);
    for (const d of ["T0", "T1", "T2a", "T2c"] as const) {
      expect(nr[d].primary).toBe("binary-lockfile-skip");
      expect(nr[d].expected["binary-lockfile-skip"]).toEqual({ nonAcquisition: true });
    }
  });
  test("a route whose measured hash is missing refuses to derive (pinning must measure first)", () => {
    expect(() => deriveRoutes(readEntry({ checkoutSeamSha256: null }), CTX)).toThrow(BenchWorkloadError);
    expect(() => deriveRoutes(readEntry({ mode: "120000", restDerefSeamSha256: null, gql: null }), CTX)).toThrow(BenchWorkloadError);
    expect(() => deriveRoutes(readEntry({ gql: null }), CTX)).toThrow(BenchWorkloadError);
  });
});

describe("selected/*.json round-trip + drift rejection", () => {
  const workload = buildUnitWorkload({
    unit: "C2:o/r@main", sha: sha("0"), treeOid: sha("f"), objectFormat: "sha1",
    generatedAtIso: "2026-07-28T00:00:00Z", truncatedTree: false, escapeTripped: false,
    batchContentBytesCap: 1_572_864,
    entries: [readEntry(), readEntry({ path: "pkg/bun.lockb", class: "lockfile", read: false, noReadReason: "binary-lockfile-skip", canonicalSeamSha256: null, rawSha256: null, checkoutSeamSha256: null, gql: null })],
  });
  test("round-trips", () => {
    const parsed = parseUnitWorkload(JSON.stringify(workload));
    expect(parsed.entries.length).toBe(2);
    expect(parsed.routes["f.txt"]!.T1.primary).toBe("primary");
  });
  test("a tampered committed matrix is a parse failure (ground-truth drift)", () => {
    const tampered = structuredClone(workload) as unknown as { routes: Record<string, Record<string, { primary: string }>> };
    tampered.routes["f.txt"]!["T0"]!.primary = "symlink-fallback";
    expect(() => parseUnitWorkload(JSON.stringify(tampered))).toThrow(BenchWorkloadError);
  });
  test("read/noReadReason incoherence and duplicate paths are parse failures", () => {
    const bad = structuredClone(workload) as unknown as { entries: Array<{ read: boolean }> };
    bad.entries[0]!.read = false;
    expect(() => parseUnitWorkload(JSON.stringify(bad))).toThrow(BenchWorkloadError);
    const dup = structuredClone(workload) as unknown as { entries: unknown[]; routes: Record<string, unknown> };
    dup.entries.push(structuredClone((workload.entries as unknown[])[0]!));
    expect(() => parseUnitWorkload(JSON.stringify(dup))).toThrow(BenchWorkloadError);
  });
});

describe("seam helpers", () => {
  test("seamSha256 hashes the UTF-8 re-encoding of the replacement-decoded string", () => {
    const invalid = Uint8Array.from([0x61, 0xff, 0x62]); // a<invalid>b
    expect(seamSha256(invalid)).toBe(seamStringSha256("a�b"));
    expect(countReplacementChars(invalid)).toBe(1);
    expect(countReplacementChars(new TextEncoder().encode("clean"))).toBe(0);
  });
});
