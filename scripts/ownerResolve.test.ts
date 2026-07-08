import { expect, test, describe } from "bun:test";
import { resolveEffectiveOwners, EmptyOwnersError } from "./ownerResolve.ts";

const base = {
  organizations: null as string[] | null,
  excludeOrganizations: [] as string[],
  includePersonalNamespace: false,
  discoveredOrgs: [] as string[],
  personalLogin: null as string | null,
};

describe("resolveEffectiveOwners", () => {
  test("discovery mode: dedupes and sorts the discovered orgs", () => {
    const r = resolveEffectiveOwners({ ...base, discoveredOrgs: ["zeta", "alpha", "alpha"] });
    expect(r).toEqual({ owners: ["alpha", "zeta"], source: "discovered" });
  });
  test("configured allowlist: source is 'configured', discovery ignored", () => {
    const r = resolveEffectiveOwners({ ...base, organizations: ["org-b", "org-a"], discoveredOrgs: ["ignored"] });
    expect(r).toEqual({ owners: ["org-a", "org-b"], source: "configured" });
  });
  test("configured-empty [] with personal namespace yields just the personal login", () => {
    const r = resolveEffectiveOwners({ ...base, organizations: [], includePersonalNamespace: true, personalLogin: "me" });
    expect(r).toEqual({ owners: ["me"], source: "configured" });
  });
  test("personal namespace is appended in BOTH modes", () => {
    expect(resolveEffectiveOwners({ ...base, discoveredOrgs: ["o"], includePersonalNamespace: true, personalLogin: "me" }).owners)
      .toEqual(["me", "o"]);
    expect(resolveEffectiveOwners({ ...base, organizations: ["o"], includePersonalNamespace: true, personalLogin: "me" }).owners)
      .toEqual(["me", "o"]);
  });
  test("excludeOrganizations subtracts in BOTH modes", () => {
    expect(resolveEffectiveOwners({ ...base, discoveredOrgs: ["a", "b"], excludeOrganizations: ["b"] }).owners).toEqual(["a"]);
    expect(resolveEffectiveOwners({ ...base, organizations: ["a", "b"], excludeOrganizations: ["a"] }).owners).toEqual(["b"]);
  });
  test("empty discovery fails fast with read:org / personal-namespace hints", () => {
    expect(() => resolveEffectiveOwners({ ...base })).toThrow(EmptyOwnersError);
    try {
      resolveEffectiveOwners({ ...base });
    } catch (e) {
      expect((e as Error).message).toContain("read:org");
      expect((e as Error).message).toContain("includePersonalNamespace");
    }
  });
  test("configured-empty [] WITHOUT personal namespace fails fast", () => {
    expect(() => resolveEffectiveOwners({ ...base, organizations: [] })).toThrow(EmptyOwnersError);
  });
  test("excludes removing every owner fails fast and hints at excludeOrganizations", () => {
    try {
      resolveEffectiveOwners({ ...base, organizations: ["a"], excludeOrganizations: ["a"] });
    } catch (e) {
      expect((e as Error).message).toContain("excludeOrganizations");
    }
  });
  test("includePersonalNamespace true but no login resolved throws", () => {
    expect(() => resolveEffectiveOwners({ ...base, discoveredOrgs: ["o"], includePersonalNamespace: true, personalLogin: null }))
      .toThrow(EmptyOwnersError);
  });
});
