// observations.ts — the dossier's "What this means" layer as a declarative rule table (CEO
// addendum 8). CONSTRAINT (binding, from the approved design): observations may ONLY RESTATE
// aggregates already visible in the dossier — counts, rankings, concentration percentages —
// NEVER recommendations, predictions, or difficulty judgments. Every rule is a pure
// (predicate, template) pair over a flat facts object derived from the SAME DossierModel the
// cards render from, so an observation can never disagree with a headline number.
//
// FALLBACK (launch never hinges on this layer): tryEvaluateObservations catches ANY throw during
// evaluation and returns { omitted: true } — the caller renders the dossier without the section,
// and the coordinator's JSONL event makes the omission visible.
//
// VOCABULARY (binding): "usage sites" / "import and use" — never invocation wording.

import type { DossierModel } from "./reportHtml.ts"; // type-only: no runtime cycle with the renderer

export interface ObservationFacts {
  readonly packageName: string;
  readonly scopeLabel: string; // 'default branches' | 'all branches'
  readonly repoCount: number; // headline repos
  readonly singleRepoName: string | null; // set iff repoCount === 1
  readonly usageSiteCount: number; // headline apiUsage sites (attributed + whole-module)
  readonly attributedSiteCount: number;
  readonly wholeModuleSiteCount: number;
  readonly distinctExportsUsed: number; // attributed exports with headline usage
  readonly topExportName: string | null; // most-used attributed export (headline scope)
  readonly topExportCount: number;
  readonly top3SharePct: number | null; // null when attributedSiteCount === 0
  readonly versionsSeenCount: number;
  readonly majorVersionCount: number;
  readonly cliSiteCount: number; // across all branches (matches the CLI table's honest total)
  readonly hotspotRepo: string | null;
  readonly hotspotExportCount: number;
  readonly hotspotSiteCount: number;
  readonly latestVersion: string | null;
  readonly latestSurfaceExportCount: number;
  readonly usedFromLatestSurfaceCount: number;
}

export interface Observation {
  readonly id: string;
  readonly text: string;
}

export interface ObservationRule {
  readonly id: string;
  readonly predicate: (facts: ObservationFacts) => boolean;
  readonly template: (facts: ObservationFacts) => string;
}

const pct = (part: number, whole: number): number => Math.round((part * 100) / whole);
const plural = (count: number, singular: string, pluralForm?: string): string =>
  `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;

// Rules fire in table order; each text is one falsifiable restatement of numbers the dossier
// already shows. Adding a rule = adding an entry + its unit tests, nothing else.
export const RULES: ReadonlyArray<ObservationRule> = [
  {
    id: "top3-concentration",
    predicate: (f) => f.top3SharePct !== null && f.distinctExportsUsed >= 4,
    template: (f) =>
      `${f.top3SharePct}% of attributed usage sits in the top 3 of ${f.distinctExportsUsed} exports used (${f.scopeLabel}).`,
  },
  {
    id: "dominant-export",
    predicate: (f) =>
      f.topExportName !== null && f.distinctExportsUsed >= 2 && f.attributedSiteCount > 0 && pct(f.topExportCount, f.attributedSiteCount) >= 50,
    template: (f) =>
      `The most-used export, ${f.topExportName}, accounts for ${pct(f.topExportCount, f.attributedSiteCount)}% of attributed usage ` +
      `(${f.topExportCount} of ${plural(f.attributedSiteCount, "usage site")}).`,
  },
  {
    id: "whole-module-share",
    predicate: (f) => f.wholeModuleSiteCount > 0 && f.usageSiteCount > 0,
    template: (f) =>
      `${f.wholeModuleSiteCount} of ${plural(f.usageSiteCount, "usage site")} (${pct(f.wholeModuleSiteCount, f.usageSiteCount)}%) ` +
      `import and use the package as a whole module rather than through a named export.`,
  },
  {
    id: "single-repo",
    predicate: (f) => f.repoCount === 1 && f.singleRepoName !== null && f.usageSiteCount > 0,
    template: (f) => `All ${plural(f.usageSiteCount, "usage site")} (${f.scopeLabel}) come from a single repository: ${f.singleRepoName}.`,
  },
  {
    id: "hotspot-leader",
    predicate: (f) => f.repoCount >= 2 && f.hotspotRepo !== null,
    template: (f) =>
      `${f.hotspotRepo} carries the largest usage surface: ${plural(f.hotspotExportCount, "distinct export")} ` +
      `across ${plural(f.hotspotSiteCount, "usage site")}.`,
  },
  {
    id: "multi-major",
    predicate: (f) => f.majorVersionCount >= 2,
    template: (f) =>
      `${plural(f.versionsSeenCount, "distinct version")} of the package are present, spanning ${f.majorVersionCount} major versions.`,
  },
  {
    id: "cli-usage",
    predicate: (f) => f.cliSiteCount > 0,
    template: (f) => `The package is also referenced as a CLI at ${plural(f.cliSiteCount, "usage site")}.`,
  },
  {
    id: "latest-surface-coverage",
    predicate: (f) => f.latestVersion !== null && f.latestSurfaceExportCount > 0 && f.attributedSiteCount > 0,
    template: (f) =>
      `This run's usage covers ${f.usedFromLatestSurfaceCount} of ${plural(f.latestSurfaceExportCount, "export")} ` +
      `in the latest introspected surface (${f.latestVersion}).`,
  },
];

// Flatten the renderer's computed model into the facts the rule table reads. Pure; called by the
// renderer inside its omit-on-throw guard, so a surprising model shape can only ever cost the
// observations section, never the dossier.
export function deriveFacts(model: DossierModel): ObservationFacts {
  const attributed = model.exportGroups.filter((g) => g.exportName !== "" && g.headlineCount > 0);
  const top = attributed[0] ?? null; // exportGroups are usage-sorted, so the first is the leader
  const majors = new Set(model.versionsSeen.map((v) => v.split(".")[0] ?? v));
  const latestNames = new Set(model.latestSurfaceExports.map((e) => e.name));
  const hotspot = model.hotspots[0] ?? null;
  return {
    packageName: model.packageName,
    scopeLabel: model.scopeLabel,
    repoCount: model.headlineRepos.length,
    singleRepoName: model.headlineRepos.length === 1 ? model.headlineRepos[0]! : null,
    usageSiteCount: model.headlineSiteCount,
    attributedSiteCount: model.attributedSiteCount,
    wholeModuleSiteCount: model.wholeModuleSiteCount,
    distinctExportsUsed: attributed.length,
    topExportName: top === null ? null : top.exportName,
    topExportCount: top === null ? 0 : top.headlineCount,
    top3SharePct: model.top3SharePct,
    versionsSeenCount: model.versionsSeen.length,
    majorVersionCount: majors.size,
    cliSiteCount: model.cliTotalCount,
    hotspotRepo: hotspot === null ? null : hotspot.repo,
    hotspotExportCount: hotspot === null ? 0 : hotspot.exportCount,
    hotspotSiteCount: hotspot === null ? 0 : hotspot.siteCount,
    latestVersion: model.latestVersion,
    latestSurfaceExportCount: model.latestSurfaceExports.length,
    usedFromLatestSurfaceCount: attributed.filter((g) => latestNames.has(g.exportName)).length,
  };
}

// Evaluate the rule table in order. Throws propagate — the safe wrapper below owns containment.
export function evaluateObservations(facts: ObservationFacts): Observation[] {
  const fired: Observation[] = [];
  for (const rule of RULES) {
    if (rule.predicate(facts)) fired.push({ id: rule.id, text: rule.template(facts) });
  }
  return fired;
}

export type ObservationsOutcome = { readonly observations: Observation[] } | { readonly omitted: true };

// The contained entry point the renderer uses: ANY throw during evaluation (a poisoned fact
// getter, a template bug, a future rule error) yields { omitted: true } instead of an exception —
// the dossier ships without the section rather than not shipping.
export function tryEvaluateObservations(facts: ObservationFacts): ObservationsOutcome {
  try {
    return { observations: evaluateObservations(facts) };
  } catch {
    return { omitted: true };
  }
}
