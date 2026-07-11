import { expect, test, describe } from "bun:test";
import {
  RULES,
  deriveFacts,
  evaluateObservations,
  tryEvaluateObservations,
  type ObservationFacts,
} from "./observations.ts";
import { computeDossierModel, type DossierPackage, type DossierUnit } from "./reportHtml.ts";

// A fully-populated baseline facts object; tests override single fields to probe predicate
// boundaries. Values are mutually consistent (they describe one plausible package).
function facts(overrides: Partial<ObservationFacts> = {}): ObservationFacts {
  return {
    packageName: "expo",
    scopeLabel: "default branches",
    repoCount: 3,
    singleRepoName: null,
    usageSiteCount: 20,
    attributedSiteCount: 16,
    wholeModuleSiteCount: 4,
    distinctExportsUsed: 5,
    topExportName: "registerRootComponent",
    topExportCount: 10,
    top3SharePct: 88,
    versionsSeenCount: 3,
    majorVersionCount: 2,
    cliSiteCount: 2,
    hotspotRepo: "org-a/app",
    hotspotExportCount: 4,
    hotspotSiteCount: 12,
    latestVersion: "50.0.7",
    latestSurfaceExportCount: 8,
    usedFromLatestSurfaceCount: 5,
    ...overrides,
  };
}

const textOf = (id: string, f: ObservationFacts): string | undefined =>
  evaluateObservations(f).find((o) => o.id === id)?.text;

describe("RULES — per-rule predicate boundaries and template output", () => {
  test("top3-concentration: fires at 4 exports used, not at 3; needs attributed usage", () => {
    expect(textOf("top3-concentration", facts({ distinctExportsUsed: 4 }))).toBe(
      "88% of attributed usage sits in the top 3 of 4 exports used (default branches).",
    );
    expect(textOf("top3-concentration", facts({ distinctExportsUsed: 3 }))).toBeUndefined();
    expect(textOf("top3-concentration", facts({ top3SharePct: null }))).toBeUndefined();
  });

  test("dominant-export: fires at exactly 50% share, not below; needs a second export", () => {
    // 8 of 16 = 50% — the boundary fires
    expect(textOf("dominant-export", facts({ topExportCount: 8 }))).toBe(
      "The most-used export, registerRootComponent, accounts for 50% of attributed usage (8 of 16 usage sites).",
    );
    // 7 of 16 = 44% — below the boundary (Math.round(43.75) = 44)
    expect(textOf("dominant-export", facts({ topExportCount: 7 }))).toBeUndefined();
    expect(textOf("dominant-export", facts({ distinctExportsUsed: 1 }))).toBeUndefined();
    expect(textOf("dominant-export", facts({ topExportName: null }))).toBeUndefined();
    expect(textOf("dominant-export", facts({ attributedSiteCount: 0 }))).toBeUndefined();
  });

  test("whole-module-share: fires on 1 whole-module site, silent on 0", () => {
    expect(textOf("whole-module-share", facts({ wholeModuleSiteCount: 1, usageSiteCount: 20 }))).toBe(
      "1 of 20 usage sites (5%) import and use the package as a whole module rather than through a named export.",
    );
    expect(textOf("whole-module-share", facts({ wholeModuleSiteCount: 0 }))).toBeUndefined();
    expect(textOf("whole-module-share", facts({ usageSiteCount: 0, wholeModuleSiteCount: 0 }))).toBeUndefined();
  });

  test("single-repo: fires only when exactly one headline repo carries usage", () => {
    expect(textOf("single-repo", facts({ repoCount: 1, singleRepoName: "org-a/app", usageSiteCount: 1 }))).toBe(
      "All 1 usage site (default branches) come from a single repository: org-a/app.",
    );
    expect(textOf("single-repo", facts({ repoCount: 2 }))).toBeUndefined();
    expect(textOf("single-repo", facts({ repoCount: 1, singleRepoName: "org-a/app", usageSiteCount: 0 }))).toBeUndefined();
    expect(textOf("single-repo", facts({ repoCount: 1, singleRepoName: null }))).toBeUndefined();
  });

  test("hotspot-leader: fires at 2+ repos with a ranked hotspot, silent for a single repo", () => {
    expect(textOf("hotspot-leader", facts({ repoCount: 2 }))).toBe(
      "org-a/app carries the largest usage surface: 4 distinct exports across 12 usage sites.",
    );
    expect(textOf("hotspot-leader", facts({ repoCount: 1, singleRepoName: "org-a/app" }))).toBeUndefined();
    expect(textOf("hotspot-leader", facts({ hotspotRepo: null }))).toBeUndefined();
  });

  test("multi-major: fires at 2 major versions, not at 1", () => {
    expect(textOf("multi-major", facts({ majorVersionCount: 2, versionsSeenCount: 3 }))).toBe(
      "3 distinct versions of the package are present, spanning 2 major versions.",
    );
    expect(textOf("multi-major", facts({ majorVersionCount: 1 }))).toBeUndefined();
    // singular form when only one version somehow spans... (guarded: needs >= 2 majors, so >= 2 versions)
    expect(textOf("multi-major", facts({ majorVersionCount: 2, versionsSeenCount: 2 }))).toBe(
      "2 distinct versions of the package are present, spanning 2 major versions.",
    );
  });

  test("cli-usage: fires on 1 site (singular), silent on 0", () => {
    expect(textOf("cli-usage", facts({ cliSiteCount: 1 }))).toBe("The package is also referenced as a CLI at 1 usage site.");
    expect(textOf("cli-usage", facts({ cliSiteCount: 3 }))).toBe("The package is also referenced as a CLI at 3 usage sites.");
    expect(textOf("cli-usage", facts({ cliSiteCount: 0 }))).toBeUndefined();
  });

  test("latest-surface-coverage: needs an introspected surface AND attributed usage", () => {
    expect(textOf("latest-surface-coverage", facts())).toBe(
      "This run's usage covers 5 of 8 exports in the latest introspected surface (50.0.7).",
    );
    expect(textOf("latest-surface-coverage", facts({ latestVersion: null }))).toBeUndefined();
    expect(textOf("latest-surface-coverage", facts({ latestSurfaceExportCount: 0 }))).toBeUndefined();
    expect(textOf("latest-surface-coverage", facts({ attributedSiteCount: 0 }))).toBeUndefined();
  });
});

describe("evaluateObservations", () => {
  test("fires rules in table order with unique ids", () => {
    const fired = evaluateObservations(facts());
    const ids = fired.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    // order matches RULES order
    const ruleOrder = RULES.map((r) => r.id).filter((id) => ids.includes(id));
    expect(ids).toEqual(ruleOrder);
    expect(fired.length).toBeGreaterThan(0);
  });

  test("is deterministic: identical facts yield identical observations", () => {
    const a = JSON.stringify(evaluateObservations(facts()));
    const b = JSON.stringify(evaluateObservations(facts()));
    expect(a).toBe(b);
  });

  test("an inert facts object (empty dataset) fires nothing", () => {
    const inert = facts({
      repoCount: 0, singleRepoName: null, usageSiteCount: 0, attributedSiteCount: 0,
      wholeModuleSiteCount: 0, distinctExportsUsed: 0, topExportName: null, topExportCount: 0,
      top3SharePct: null, versionsSeenCount: 0, majorVersionCount: 0, cliSiteCount: 0,
      hotspotRepo: null, hotspotExportCount: 0, hotspotSiteCount: 0,
      latestVersion: null, latestSurfaceExportCount: 0, usedFromLatestSurfaceCount: 0,
    });
    expect(evaluateObservations(inert)).toEqual([]);
  });

  test("restatement-only vocabulary: no recommendations, predictions, difficulty judgments, or invocation wording", () => {
    // Render every rule's template against the full baseline facts and scan for banned words.
    // 'call site(s)' is banned by CT1; the rest are the never-editorialize constraint.
    const banned = /\b(should|recommend|must|easy|hard|difficult|risky|likely|predict|consider|suggests|indicates|implies|migrate soon|migration|invoked|call sites?)\b/i;
    for (const rule of RULES) {
      const text = rule.template(facts({ repoCount: 1, singleRepoName: "org-a/app" }));
      expect({ id: rule.id, banned: banned.test(text) }).toEqual({ id: rule.id, banned: false });
    }
  });
});

describe("tryEvaluateObservations — the omit-on-throw containment", () => {
  test("returns the observations on a healthy facts object", () => {
    const outcome = tryEvaluateObservations(facts());
    if ("omitted" in outcome) throw new Error("expected observations, got omitted");
    expect(outcome.observations.length).toBeGreaterThan(0);
  });

  test("a poisoned facts object (getter that throws) yields { omitted: true }, never an exception", () => {
    const poisoned = Object.defineProperty({ ...facts() }, "top3SharePct", {
      get() {
        throw new Error("poisoned fact");
      },
    }) as ObservationFacts;
    expect(tryEvaluateObservations(poisoned)).toEqual({ omitted: true });
  });

  test("a template throwing mid-evaluation is contained the same way", () => {
    // NaN-free facts but a hostile string field that a future template might .toLowerCase() —
    // simulate a template bug directly with a getter on a field only templates read.
    const poisoned = Object.defineProperty({ ...facts() }, "hotspotRepo", {
      get() {
        throw new Error("template-time read");
      },
    }) as ObservationFacts;
    expect(tryEvaluateObservations(poisoned)).toEqual({ omitted: true });
  });
});

describe("deriveFacts — flattening the renderer's model", () => {
  const unit = (over: Partial<DossierUnit> = {}): DossierUnit => ({
    organization: "org-a",
    repository: "app",
    branch: "main",
    isDefaultBranch: true,
    commitSha: "abc123def4567",
    declarations: [{ resolvedVersion: "50.0.7" }],
    apiUsage: [],
    cliUsage: [],
    ...over,
  });
  const usage = (exportName: string, file: string, line: number) => ({
    exportName,
    dependencyKey: "expo",
    usageType: "named-import",
    file,
    line,
    permalink: `https://github.com/org-a/app/blob/abc123def4567/${file}#L${line}`,
    snippet: `import from 'expo' // ${exportName || "whole"}`,
  });

  test("maps model aggregates onto the flat facts (headline scope, majors, surface coverage)", () => {
    const pkg: DossierPackage = {
      name: "expo",
      versionsSeen: ["49.0.0", "50.0.7"],
      apiSurface: {
        "49.0.0": { exports: [{ name: "old", kind: "named" }] },
        "50.0.7": { exports: [{ name: "A", kind: "named" }, { name: "B", kind: "named" }] },
      },
      usageByRepo: [
        unit({ apiUsage: [usage("A", "src/a.ts", 1), usage("A", "src/a.ts", 2), usage("", "src/b.ts", 3)] }),
        unit({ repository: "web", branch: "dev", isDefaultBranch: false, apiUsage: [usage("C", "src/c.ts", 9)] }),
      ],
    };
    const f = deriveFacts(computeDossierModel(pkg));
    expect(f.packageName).toBe("expo");
    expect(f.scopeLabel).toBe("default branches");
    expect(f.repoCount).toBe(1);
    expect(f.singleRepoName).toBe("org-a/app");
    expect(f.usageSiteCount).toBe(3); // headline only — the dev-branch C site is excluded
    expect(f.attributedSiteCount).toBe(2);
    expect(f.wholeModuleSiteCount).toBe(1);
    expect(f.distinctExportsUsed).toBe(1); // A (C has no headline usage)
    expect(f.topExportName).toBe("A");
    expect(f.topExportCount).toBe(2);
    expect(f.versionsSeenCount).toBe(2);
    expect(f.majorVersionCount).toBe(2); // 49 and 50
    expect(f.latestVersion).toBe("50.0.7"); // LAST apiSurface key
    expect(f.latestSurfaceExportCount).toBe(2);
    expect(f.usedFromLatestSurfaceCount).toBe(1); // A is in the latest surface, C is not headline
    expect(f.hotspotRepo).toBe("org-a/app");
    expect(f.hotspotExportCount).toBe(2); // A + the whole-module bucket (CV3)
    expect(f.hotspotSiteCount).toBe(3);
  });

  test("derived facts drive a coherent end-to-end evaluation", () => {
    const pkg: DossierPackage = {
      name: "expo",
      versionsSeen: ["50.0.7"],
      apiSurface: { "50.0.7": { exports: [{ name: "A", kind: "named" }] } },
      usageByRepo: [unit({ apiUsage: [usage("A", "src/a.ts", 1), usage("", "src/b.ts", 2)] })],
    };
    const outcome = tryEvaluateObservations(deriveFacts(computeDossierModel(pkg)));
    if ("omitted" in outcome) throw new Error("expected observations");
    const ids = outcome.observations.map((o) => o.id);
    expect(ids).toContain("whole-module-share");
    expect(ids).toContain("single-repo");
    expect(ids).toContain("latest-surface-coverage");
    expect(ids).not.toContain("multi-major");
  });
});
