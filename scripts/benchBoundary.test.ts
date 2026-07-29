// benchBoundary.test.ts — CI tests for the boundary probe's deterministic cell planning
// (§4.4): the pinned sweep shape, small-blob selection, content-target packing, and the
// fail-closed guards. The dispatch loop itself is network-bound and untested here.
import { describe, expect, test } from "bun:test";
import {
  BOUNDARY_ALIAS_CONTENT_PAIRS, BOUNDARY_ALIAS_COUNTS, BOUNDARY_SMALL_BLOB_MAX_BYTES,
  BenchBoundaryError, planBoundaryCells, type BoundaryBlob,
} from "./benchBoundary.ts";

const blob = (i: number, size: number): BoundaryBlob => ({ path: `f${String(i).padStart(4, "0")}.ts`, oid: "a".repeat(40), size });

describe("planBoundaryCells", () => {
  const blobs: BoundaryBlob[] = [
    ...Array.from({ length: 600 }, (_, i) => blob(i, 100 + (i % 50))), // plenty of small blobs
    ...Array.from({ length: 300 }, (_, i) => blob(1000 + i, 8_000 + i * 40)), // mid-size spread
  ];
  test("the pinned sweep: 7 alias cells at small content + 4 alias×content cells, deterministic", () => {
    const cells = planBoundaryCells(blobs);
    expect(cells.length).toBe(BOUNDARY_ALIAS_COUNTS.length + BOUNDARY_ALIAS_CONTENT_PAIRS.length);
    expect(cells.slice(0, 7).map((c) => c.aliasCount)).toEqual([...BOUNDARY_ALIAS_COUNTS]);
    for (const c of cells.slice(0, 7)) {
      expect(c.contentTargetBytes).toBeNull();
      expect(c.blobs.length).toBe(c.aliasCount);
      expect(new Set(c.blobs.map((b) => b.path)).size).toBe(c.aliasCount); // distinct paths
      for (const b of c.blobs) expect(b.size).toBeLessThanOrEqual(BOUNDARY_SMALL_BLOB_MAX_BYTES);
    }
    // identical input → identical plan (the probe is reproducible)
    expect(planBoundaryCells(blobs)).toEqual(cells);
  });
  test("content cells record the ACTUAL sum beside the nominal target", () => {
    const cells = planBoundaryCells(blobs);
    for (const [i, pair] of BOUNDARY_ALIAS_CONTENT_PAIRS.entries()) {
      const cell = cells[BOUNDARY_ALIAS_COUNTS.length + i]!;
      expect(cell.aliasCount).toBe(pair.aliases);
      expect(cell.contentTargetBytes).toBe(pair.targetBytes);
      expect(cell.blobs.length).toBe(pair.aliases);
      expect(cell.actualContentBytes).toBe(cell.blobs.reduce((n, b) => n + b.size, 0));
      expect(cell.actualContentBytes).toBeGreaterThan(0);
    }
  });
  test("too few small blobs for the largest alias cell fails closed", () => {
    const few = Array.from({ length: 100 }, (_, i) => blob(i, 100));
    expect(() => planBoundaryCells(few)).toThrow(BenchBoundaryError);
  });
});
