import { expect, test, describe } from "bun:test";
import { classifyBranchPlan, planSummaryText } from "./orchestrate.ts";
import type { BranchHead } from "./github.ts";

const head = (name: string, committedDate: string): BranchHead => ({ name, oid: `oid-${name}`, committedDate, treeOid: `tree-${name}` });

describe("classifyBranchPlan (§5.B cutoff + cap)", () => {
  test("splits cutoff-skipped, eligible, and past-cap preserving input order", () => {
    const heads = [
      head("main", "2025-06-01T10:00:00Z"),
      head("dev", "2025-05-01T10:00:00Z"),
      head("stale", "2023-12-31T23:59:59Z"), // before cutoff
      head("feature", "2025-04-01T10:00:00Z"), // past cap (cap=2)
    ];
    const p = classifyBranchPlan(heads, "2024-01-01", 2);
    expect(p.cutoffSkipped.map((h) => h.name)).toEqual(["stale"]);
    expect(p.eligible.map((h) => h.name)).toEqual(["main", "dev"]);
    expect(p.pastCap.map((h) => h.name)).toEqual(["feature"]);
  });
  test("EVERY pre-cutoff branch is recorded regardless of the cap", () => {
    const heads = [
      head("a", "2023-01-01T00:00:00Z"),
      head("b", "2023-02-01T00:00:00Z"),
      head("c", "2023-03-01T00:00:00Z"),
    ];
    const p = classifyBranchPlan(heads, "2024-01-01", 1);
    expect(p.cutoffSkipped).toHaveLength(3); // cap never limits cutoff records
    expect(p.eligible).toHaveLength(0);
    expect(p.pastCap).toHaveLength(0);
  });
  test("a commit ON the cutoff date is eligible (skip is strictly before cutoffDate)", () => {
    const p = classifyBranchPlan([head("edge", "2024-01-01T00:00:00Z")], "2024-01-01", 25);
    expect(p.eligible.map((h) => h.name)).toEqual(["edge"]);
    expect(p.cutoffSkipped).toHaveLength(0);
  });
  test("empty input yields empty groups", () => {
    expect(classifyBranchPlan([], "2024-01-01", 25)).toEqual({ cutoffSkipped: [], eligible: [], pastCap: [] });
  });
});

describe("planSummaryText", () => {
  const config = {
    cutoffDate: "2024-01-01",
    maxBranchesPerRepo: 25,
    packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
  } as unknown as Parameters<typeof planSummaryText>[0];

  test("names the counts, the cutoff, the packages, and the no-writes guarantee", () => {
    const text = planSummaryText(config, {
      owners: ["org-a", "org-b"], ownersSource: "discovered",
      reposDiscovered: 42, reposKept: 37,
      branchesEligible: 210, branchesSkippedByCutoff: 58, branchesPastCap: 12, discoveryErrors: 0,
    });
    expect(text).toContain("PLAN — preview only");
    expect(text).toContain("no database opened");
    expect(text).toContain("org-a, org-b");
    expect(text).toContain("42 discovered, 37 kept");
    expect(text).toContain("210 eligible");
    expect(text).toContain("58 skipped by cutoff (< 2024-01-01)");
    expect(text).toContain("12 past the per-repo cap (25)");
    expect(text).toContain("expo");
    expect(text).toContain("Discovery errors:     0");
  });
});
