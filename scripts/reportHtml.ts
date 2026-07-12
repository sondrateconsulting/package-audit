// reportHtml.ts — the editorial coupling dossier renderer (design §Recommended-Approach item 2 +
// CEO addenda 1/5/6/7/12/13, CT1/CT4/CT5, E1/CV3). PURE: renderDossier(pkg, ctx) is a function of
// its arguments ALONE — no wall clock, no randomness, no env reads, no locale-dependent
// formatting (integers via String(), never toLocaleString) — so identical input yields identical
// bytes (golden + double-render tested).
//
// ESCAPE-BY-CONSTRUCTION (the safety argument, structural): every dynamic value passes through
// htmlEscape.ts's ONE escapeHtml, and dynamic values are emitted ONLY into (a) element bodies,
// (b) double-quoted id="..." attributes (slug grammar, see below), and (c) double-quoted
// href="..." attributes of exactly two shapes — evidence permalinks that START WITH https://
// (anything else renders as plain text, never a link) and intra-page "#<slug>" anchors. The one
// inline <script> is the STATIC_SCRIPT constant — 100% static, zero interpolation — and the CSP
// script-src hash is computed FROM that constant at module load, so the policy can never drift
// from the script it authorizes.
//
// VOCABULARY (CT1, binding): "usage sites" / "import and use" — the scanner records
// import/require/re-export/CLI usage, never invocation expressions.
//
// SCOPE SEMANTICS (CT5 + E1 tri-state): headline numbers count units with isDefaultBranch===true
// ONLY, with an "also seen on N other branches" annotation from the rest. If ANY unit carries
// isDefaultBranch===null (pre-v3 rows), headlines FALL BACK to all-branches counts behind a
// visible band — never a silent undercount.

import { createHash } from "node:crypto";
import { escapeHtml, stripBidiControls } from "./htmlEscape.ts";
import { mdCell, mdCode, mdTable, mdUrl } from "./markdownEscape.ts";
import { deriveFacts, tryEvaluateObservations, type Observation } from "./observations.ts";

// ---- input types (structural mirror of the §7 report object) ---------------------------------
// Deliberately NOT imported from report.ts/reportSchema.ts: reportSchema is test-only by source
// scan. These interfaces name a selected subset of the report's fields — a MINIMAL contract that the
// full emitted report (a superset with cli/declarations/dateFetched) stays assignable to. report.ts
// types EmittedReport.packages as buildPackage's output precisely so that assignability is checked
// at compile time (the emitDossiers render calls are the check); the tests additionally feed REAL
// buildReport output through the renderer.

export interface DossierApiUsage {
  readonly exportName: string; // '' = whole-module usage (namespace/side-effect/whole-require/reexport)
  readonly dependencyKey: string;
  readonly usageType: string;
  readonly file: string;
  readonly line: number;
  readonly permalink: string;
  readonly snippet: string;
}
export interface DossierCliUsage {
  readonly file: string;
  readonly line: number;
  readonly context: string;
  readonly permalink: string;
  readonly snippet: string;
}
export interface DossierDeclaration {
  readonly resolvedVersion: string | null; // the only declaration field the dossier consumes
}
export interface DossierUnit {
  readonly organization: string;
  readonly repository: string;
  readonly branch: string;
  readonly isDefaultBranch: boolean | null; // tri-state (§5.B): null = unknown (pre-v3 rows)
  readonly commitSha: string;
  readonly declarations: readonly DossierDeclaration[];
  readonly apiUsage: readonly DossierApiUsage[];
  readonly cliUsage: readonly DossierCliUsage[];
}
export interface DossierApiSurfaceEntry {
  readonly exports: ReadonlyArray<{ readonly name: string; readonly kind: string }>;
}
export interface DossierPackage {
  readonly name: string;
  readonly versionsSeen: readonly string[];
  readonly apiSurface: Readonly<Record<string, DossierApiSurfaceEntry>>; // keys in versionsSeen order
  readonly usageByRepo: readonly DossierUnit[];
}
export interface DossierConfig {
  readonly cutoffDate: string;
  readonly githubHost: string;
  readonly organizations: readonly string[];
}
export interface DossierSummary {
  readonly repositoriesScanned: number;
  readonly branchesScanned: number;
  readonly branchesSkippedByCutoff: number;
}
export interface DossierContext {
  readonly runId: string;
  readonly generatedAt: string;
  readonly config: DossierConfig;
  readonly summary: DossierSummary;
  readonly formatVersion: number;
}
// The top-level report shape indexHtml.ts consumes (same structural-mirror rationale).
export interface DossierReport {
  readonly runId: string;
  readonly generatedAt: string;
  readonly config: DossierConfig;
  readonly packages: readonly DossierPackage[];
  readonly summary: DossierSummary;
}

// ---- constants --------------------------------------------------------------------------------

// Rank cap for evidence drawers and the CLI table (CEO addendum 1): top-N rows, honest totals,
// standing pointer to the full exports.
export const EVIDENCE_CAP = 25;
// Matrix overflow rule: beyond this many attributed export columns, keep the top
// (MATRIX_MAX_EXPORT_COLUMNS - 1) by usage plus one "other" rollup column. The "(whole-module)"
// pseudo-column sits outside this budget.
export const MATRIX_MAX_EXPORT_COLUMNS = 40;

// THE one static script (CEO addenda 5+7). Exactly two behaviors, both data-free:
//   (a) open every ancestor <details> of the location.hash target on load and on hashchange, so
//       deep links into evidence drawers reveal their content;
//   (b) copy-as-markdown: a click on button[data-copy-target] reads the PRE-RENDERED markdown
//       mirror from <template id="<target>-md"> (built and escaped at render time — the script
//       never constructs content) and writes it to the clipboard.
// It is byte-identical across every dossier and the index, contains no interpolation, and its
// sha256 below IS the CSP script-src source — computed from this constant so they cannot drift.
export const STATIC_SCRIPT: string = [
  "(function () {",
  '  "use strict";',
  "  function openAncestors() {",
  "    var hash = location.hash;",
  "    if (hash.length < 2) return;",
  "    var el = document.getElementById(hash.slice(1));",
  "    for (var node = el; node; node = node.parentElement) {",
  '      if (node.tagName === "DETAILS") node.setAttribute("open", "");',
  "    }",
  "  }",
  '  addEventListener("hashchange", openAncestors);',
  "  openAncestors();",
  '  document.addEventListener("click", function (ev) {',
  "    var t = ev.target;",
  '    var btn = t && t.closest ? t.closest("button[data-copy-target]") : null;',
  "    if (!btn || !navigator.clipboard) return;",
  '    var tpl = document.getElementById(btn.getAttribute("data-copy-target") + "-md");',
  "    if (!tpl || !tpl.content) return;",
  "    navigator.clipboard.writeText(tpl.content.textContent).then(function () {",
  '      btn.setAttribute("data-copied", "");',
  '      btn.setAttribute("aria-label", "copied");', // aria-live announces the accessible-name change
  "      setTimeout(function () {",
  '        btn.removeAttribute("data-copied");',
  '        btn.removeAttribute("aria-label");',
  "      }, 1500);",
  "    });",
  "  });",
  "})();",
].join("\n");

// Computed at module load from the constant itself — deterministic (no wall clock), and the one
// place the hash exists, so the CSP meta can never disagree with the script it whitelists.
export const STATIC_SCRIPT_SHA256: string = createHash("sha256").update(STATIC_SCRIPT, "utf8").digest("base64");

// base-uri/form-action are NOT covered by default-src — pinned to 'none' as defense-in-depth
// (escape-by-construction already prevents injecting <base>/<form> tags; belt and braces).
export const CSP_CONTENT: string =
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; script-src 'sha256-${STATIC_SCRIPT_SHA256}'`;

// ---- filename ----------------------------------------------------------------------------------

// Must stay in sync with artifactWrite.ts's NAME_GRAMMAR (flat ASCII artifact names).
const FILENAME_GRAMMAR = /^[A-Za-z0-9@._~-]+$/;

// <package>-dossier.html, with '/' sanitized to '__' so scoped names are filesystem-safe
// ("@expo/vector-icons" → "@expo__vector-icons-dossier.html"). NOT claimed injective: npm names
// MAY legally contain a literal "__" ('a__b' is a valid name), so 'a/b' and 'a__b' alias — the
// CALLER (ArtifactBundle.write's case-insensitive collision error) is what enforces uniqueness
// across the tracked-package set, and that is the sanctioned failure mode for an alias.
export function dossierFilename(packageName: string): string {
  const name = `${packageName.replaceAll("/", "__")}-dossier.html`;
  if (packageName === "" || !FILENAME_GRAMMAR.test(name))
    throw new Error(`package name does not sanitize to a valid artifact filename: ${JSON.stringify(packageName)}`);
  return name;
}

// ---- anchor grammar ----------------------------------------------------------------------------
// Deterministic id grammar (documented here, pinned by tests):
//   slug(export) = lowercase, every char outside [a-z0-9] → '-', runs collapsed, ends trimmed;
//                  '' (the whole-module bucket, or a name with no usable chars) → 'whole-module'.
//   Uniqueness: slugs are assigned in drawer order; a repeat gets a '~2', '~3', … suffix ('~' is
//   outside the slug alphabet, so suffixed ids can never collide with unsuffixed ones).
//   drawer id = 'e-<slug>'; evidence row id = 'e-<slug>.<n>' (n = 1-based position in the
//   drawer's rendered order). The row separator is '.' — NOT '-' — because '-' is inside the
//   slug alphabet: exports `foo` and `foo_1` slug to `foo` and `foo-1`, so a '-'-separated row
//   id for the former (`e-foo-1`) would collide with the latter's drawer id. '.' appears in no
//   slug and no '~' dedup suffix, so row ids can never collide with any drawer id or each
//   other. Section ids are fixed: exec, cards, surface, matrix, evidence, observations;
//   markdown mirrors live in '<section id>-md' templates.

function slugOf(exportName: string): string {
  const s = exportName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s === "" ? "whole-module" : s;
}

// ---- computed model ----------------------------------------------------------------------------

export type ScopeMode = "default-branch" | "all-branches-fallback";

export interface EvidenceSite {
  readonly repo: string; // org/repo
  readonly branch: string;
  readonly file: string;
  readonly line: number;
  readonly permalink: string;
  readonly snippet: string;
  readonly shortSha: string;
  readonly fromHeadline: boolean;
  readonly alsoOn: readonly string[]; // other branches carrying the same (repo, file, line, export)
}
export interface ExportGroup {
  readonly exportName: string; // '' = whole-module bucket
  readonly label: string; // exportName, or '(whole-module)'
  readonly slug: string;
  readonly headlineCount: number; // usage sites in headline scope (raw, per-branch)
  readonly totalCount: number; // usage sites across all branches
  readonly headlineRepoCount: number;
  readonly sites: readonly EvidenceSite[]; // collapsed by (repo,file,line); headline first
}
export interface MatrixColumn {
  readonly label: string; // export name, '(whole-module)', or 'other (N exports)'
  readonly total: number;
}
export interface MatrixRow {
  readonly repo: string;
  readonly branchCount: number;
  readonly cells: readonly number[]; // aligned with MatrixModel.columns
}
export interface MatrixModel {
  readonly columns: readonly MatrixColumn[];
  readonly rows: readonly MatrixRow[];
  readonly overflowedExportCount: number; // attributed exports rolled into the 'other' column
}
export interface HotspotEntry {
  readonly repo: string;
  readonly exportCount: number; // distinct exports used (whole-module bucket counts as one)
  readonly siteCount: number; // usage sites (headline scope, whole-module included)
  readonly score: number; // exportCount × siteCount
}
export interface CliSite {
  readonly repo: string;
  readonly branch: string;
  readonly context: string;
  readonly file: string;
  readonly line: number;
  readonly permalink: string;
  readonly fromHeadline: boolean;
}

export interface DossierModel {
  readonly packageName: string;
  readonly isEmpty: boolean; // zero (org,repo,branch,sha) units — the designed empty state
  readonly scopeMode: ScopeMode;
  readonly scopeLabel: string; // 'default branches' | 'all branches'
  readonly headlineRepos: readonly string[];
  readonly allRepos: readonly string[];
  readonly otherBranchCount: number; // distinct branches outside headline scope
  readonly totalBranchCount: number;
  readonly headlineSiteCount: number; // apiUsage sites in headline scope (attributed + whole-module)
  readonly headlineImportingRepoCount: number; // headline repos with ≥1 apiUsage site — the "imported by" count (headlineRepos also admits declaration-only and CLI-only units)
  readonly totalSiteCount: number;
  readonly attributedSiteCount: number; // headline scope, exportName !== ''
  readonly wholeModuleSiteCount: number; // headline scope, exportName === ''
  readonly exportGroups: readonly ExportGroup[]; // usage DESC; includes the whole-module bucket
  readonly top3SharePct: number | null; // null when attributedSiteCount === 0
  readonly versionsSeen: readonly string[];
  readonly headlineVersions: readonly string[];
  readonly otherOnlyVersions: readonly string[];
  readonly latestVersion: string | null; // LAST apiSurface key = highest-precedence version
  readonly latestSurfaceExports: ReadonlyArray<{ readonly name: string; readonly kind: string }>;
  readonly missingSurfaceVersions: readonly string[]; // versionsSeen with no apiSurface entry
  readonly hotspots: readonly HotspotEntry[]; // score DESC, repo ASC
  readonly matrix: MatrixModel;
  readonly cliSites: readonly CliSite[]; // headline first; uncapped (render caps)
  readonly cliHeadlineCount: number;
  readonly cliTotalCount: number;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort(cmp);
const repoKeyOf = (u: { organization: string; repository: string }): string => `${u.organization}/${u.repository}`;
const pct = (part: number, whole: number): number => Math.round((part * 100) / whole);

// The shared aggregate computation renderDossier, the observations facts, and indexHtml all
// derive from — ONE source for every headline number, so sections can never disagree.
export function computeDossierModel(pkg: DossierPackage): DossierModel {
  const units = pkg.usageByRepo;
  const anyNull = units.some((u) => u.isDefaultBranch === null);
  const scopeMode: ScopeMode = anyNull ? "all-branches-fallback" : "default-branch";
  const isHeadline = (u: DossierUnit): boolean => anyNull || u.isDefaultBranch === true;
  const headlineUnits = units.filter(isHeadline);
  const otherUnits = units.filter((u) => !isHeadline(u));

  const branchKey = (u: DossierUnit): string => `${repoKeyOf(u)}\0${u.branch}`;
  const raw = units.flatMap((u) => u.apiUsage.map((row) => ({ u, row, headline: isHeadline(u) })));

  // ---- export groups + collapsed evidence rows
  const byExport = new Map<string, typeof raw>();
  for (const s of raw) {
    const list = byExport.get(s.row.exportName);
    if (list === undefined) byExport.set(s.row.exportName, [s]);
    else list.push(s);
  }
  const unsortedGroups = [...byExport.entries()].map(([exportName, sites]) => {
    // Collapse to one evidence row per (repo, file, line); the primary occurrence is the
    // headline one (smallest branch name) when it exists, else the smallest branch overall —
    // every other branch becomes the row's 'also on' annotation (CT5).
    const byOcc = new Map<string, typeof sites>();
    for (const s of sites) {
      const k = `${repoKeyOf(s.u)}\0${s.row.file}\0${s.row.line}`;
      const list = byOcc.get(k);
      if (list === undefined) byOcc.set(k, [s]);
      else list.push(s);
    }
    const rows: EvidenceSite[] = [...byOcc.values()].map((occ) => {
      const ordered = occ.slice().sort((a, b) => Number(b.headline) - Number(a.headline) || cmp(a.u.branch, b.u.branch));
      const primary = ordered[0]!;
      return {
        repo: repoKeyOf(primary.u),
        branch: primary.u.branch,
        file: primary.row.file,
        line: primary.row.line,
        permalink: primary.row.permalink,
        snippet: primary.row.snippet,
        shortSha: primary.u.commitSha.slice(0, 7),
        fromHeadline: primary.headline,
        alsoOn: sortedUnique(ordered.slice(1).map((s) => s.u.branch)).filter((b) => b !== primary.u.branch),
      };
    });
    rows.sort(
      (a, b) =>
        Number(b.fromHeadline) - Number(a.fromHeadline) || cmp(a.repo, b.repo) || cmp(a.file, b.file) || a.line - b.line || cmp(a.branch, b.branch),
    );
    return {
      exportName,
      label: exportName === "" ? "(whole-module)" : exportName,
      headlineCount: sites.filter((s) => s.headline).length,
      totalCount: sites.length,
      headlineRepoCount: new Set(sites.filter((s) => s.headline).map((s) => repoKeyOf(s.u))).size,
      sites: rows,
    };
  });
  unsortedGroups.sort((a, b) => b.headlineCount - a.headlineCount || b.totalCount - a.totalCount || cmp(a.exportName, b.exportName));
  const slugSeen = new Map<string, number>();
  const exportGroups: ExportGroup[] = unsortedGroups.map((g) => {
    const base = slugOf(g.exportName);
    const n = (slugSeen.get(base) ?? 0) + 1;
    slugSeen.set(base, n);
    return { ...g, slug: n === 1 ? base : `${base}~${n}` };
  });

  const attributedGroups = exportGroups.filter((g) => g.exportName !== "");
  const attributedSiteCount = raw.filter((s) => s.headline && s.row.exportName !== "").length;
  const top3 = attributedGroups.slice(0, 3).reduce((sum, g) => sum + g.headlineCount, 0);
  const top3SharePct = attributedSiteCount === 0 ? null : pct(top3, attributedSiteCount);

  // ---- versions (from versionsSeen + declarations)
  // Only versions the report itself recognizes count: versionsSeen is the valid-semver slice
  // (report.ts), so a raw non-registry resolution (git ref, link:, catalog:) in a declaration
  // must not inflate the headline count — the card's detail line branches on versionsSeen and
  // would otherwise contradict its own headline ("1" beside "no resolved versions").
  const resolvedIn = (list: readonly DossierUnit[]): Set<string> => {
    const set = new Set<string>();
    for (const u of list)
      for (const d of u.declarations)
        if (d.resolvedVersion !== null && pkg.versionsSeen.includes(d.resolvedVersion)) set.add(d.resolvedVersion);
    return set;
  };
  const orderVersions = (set: ReadonlySet<string>): string[] =>
    pkg.versionsSeen.filter((v) => set.has(v)).concat([...set].filter((v) => !pkg.versionsSeen.includes(v)).sort(cmp));
  const headlineVersionSet = resolvedIn(headlineUnits);
  const otherOnly = new Set([...resolvedIn(otherUnits)].filter((v) => !headlineVersionSet.has(v)));

  // ---- latest api surface (LAST key = highest-precedence version) + partial state
  const surfaceVersions = Object.keys(pkg.apiSurface);
  const latestVersion = surfaceVersions.length > 0 ? surfaceVersions[surfaceVersions.length - 1]! : null;
  const latestSurfaceExports = latestVersion === null ? [] : pkg.apiSurface[latestVersion]!.exports.map((e) => ({ name: e.name, kind: e.kind }));
  const missingSurfaceVersions = pkg.versionsSeen.filter((v) => !Object.hasOwn(pkg.apiSurface, v));

  // ---- hotspots (headline scope; whole-module bucket counts in BOTH factors, CV3)
  const perRepo = new Map<string, { exports: Set<string>; sites: number }>();
  for (const s of raw) {
    if (!s.headline) continue;
    const k = repoKeyOf(s.u);
    const agg = perRepo.get(k) ?? { exports: new Set<string>(), sites: 0 };
    agg.exports.add(s.row.exportName);
    agg.sites += 1;
    perRepo.set(k, agg);
  }
  const hotspots: HotspotEntry[] = [...perRepo.entries()]
    .map(([repo, agg]) => ({ repo, exportCount: agg.exports.size, siteCount: agg.sites, score: agg.exports.size * agg.sites }))
    .sort((a, b) => b.score - a.score || cmp(a.repo, b.repo));

  // ---- repo × export matrix (cells = headline usage-site counts)
  const cellCounts = new Map<string, number>();
  for (const s of raw) {
    if (!s.headline) continue;
    const k = `${repoKeyOf(s.u)}\0${s.row.exportName}`;
    cellCounts.set(k, (cellCounts.get(k) ?? 0) + 1);
  }
  const wholeGroup = exportGroups.find((g) => g.exportName === "" && g.headlineCount > 0);
  const attributedCols = attributedGroups.filter((g) => g.headlineCount > 0);
  const overflowing = attributedCols.length > MATRIX_MAX_EXPORT_COLUMNS;
  const keptCols = overflowing ? attributedCols.slice(0, MATRIX_MAX_EXPORT_COLUMNS - 1) : attributedCols;
  const overflowCols = overflowing ? attributedCols.slice(MATRIX_MAX_EXPORT_COLUMNS - 1) : [];
  const columns: MatrixColumn[] = [
    ...(wholeGroup === undefined ? [] : [{ label: "(whole-module)", total: wholeGroup.headlineCount }]),
    ...keptCols.map((g) => ({ label: g.label, total: g.headlineCount })),
    ...(overflowing
      ? [{ label: `other (${overflowCols.length} exports)`, total: overflowCols.reduce((sum, g) => sum + g.headlineCount, 0) }]
      : []),
  ];
  const allRepos = sortedUnique(units.map(repoKeyOf));
  const rows: MatrixRow[] = allRepos.map((repo) => {
    const cellFor = (exportName: string): number => cellCounts.get(`${repo}\0${exportName}`) ?? 0;
    const cells = [
      ...(wholeGroup === undefined ? [] : [cellFor("")]),
      ...keptCols.map((g) => cellFor(g.exportName)),
      ...(overflowing ? [overflowCols.reduce((sum, g) => sum + cellFor(g.exportName), 0)] : []),
    ];
    return { repo, branchCount: new Set(units.filter((u) => repoKeyOf(u) === repo).map((u) => u.branch)).size, cells };
  });

  // ---- CLI usage
  const cliRaw = units.flatMap((u) =>
    u.cliUsage.map((row) => ({
      repo: repoKeyOf(u),
      branch: u.branch,
      context: row.context,
      file: row.file,
      line: row.line,
      permalink: row.permalink,
      fromHeadline: isHeadline(u),
    })),
  );
  cliRaw.sort(
    (a, b) =>
      Number(b.fromHeadline) - Number(a.fromHeadline) || cmp(a.repo, b.repo) || cmp(a.file, b.file) || a.line - b.line || cmp(a.context, b.context) || cmp(a.branch, b.branch),
  );

  return {
    packageName: pkg.name,
    isEmpty: units.length === 0,
    scopeMode,
    scopeLabel: scopeMode === "default-branch" ? "default branches" : "all branches",
    headlineRepos: sortedUnique(headlineUnits.map(repoKeyOf)),
    allRepos,
    otherBranchCount: new Set(otherUnits.map(branchKey)).size,
    totalBranchCount: new Set(units.map(branchKey)).size,
    headlineSiteCount: raw.filter((s) => s.headline).length,
    headlineImportingRepoCount: new Set(raw.filter((s) => s.headline).map((s) => repoKeyOf(s.u))).size,
    totalSiteCount: raw.length,
    attributedSiteCount,
    wholeModuleSiteCount: raw.filter((s) => s.headline && s.row.exportName === "").length,
    exportGroups,
    top3SharePct,
    versionsSeen: pkg.versionsSeen,
    headlineVersions: orderVersions(headlineVersionSet),
    otherOnlyVersions: orderVersions(otherOnly),
    latestVersion,
    latestSurfaceExports,
    missingSurfaceVersions,
    hotspots,
    matrix: { columns, rows, overflowedExportCount: overflowCols.length },
    cliSites: cliRaw,
    cliHeadlineCount: cliRaw.filter((s) => s.fromHeadline).length,
    cliTotalCount: cliRaw.length,
  };
}

// ---- shared page shell (dossiers AND the index — same CSP, theming, and byte-identical script)

const esc = escapeHtml;
const num = (v: number): string => esc(String(v));
const plural = (count: number, singular: string, pluralForm?: string): string =>
  `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;

// Editorial print-report direction (CEO addendum 13): serif display for the exec sentence,
// system sans body, tabular numerals on sans-rendered counts (serif card headlines keep
// Georgia's old-style figures — deliberate), ONE semantic accent (hotspots/warning
// bands), restrained hairlines. Dark values under prefers-color-scheme; @media print comes LAST
// so it forces the light palette. Print drawers: closed <details> content is NOT reliably
// renderable via pure CSS (Chromium/Firefox skip layout for closed details content; the
// ::details-content / content-visibility escape hatch is not cross-browser yet), so evidence
// rows are rendered TWICE — once inside the native <details> drawer (screen; carries the anchor
// ids) and once inside a .print-drawer block (display:none on screen, block in print; no ids, so
// ids stay unique). That keeps drawers native on screen and complete on paper (CEO addendum 6).
const PAGE_CSS = `
:root { color-scheme: light dark; --bg:#faf9f6; --ink:#1c1b19; --muted:#6b675f; --accent:#a34808; --hairline:#dcd8cf; --card:#ffffff; --code-bg:#f1efe9; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#171614; --ink:#e8e5de; --muted:#98938a; --accent:#e08a4a; --hairline:#37342f; --card:#1f1d1a; --code-bg:#24221e; }
}
* { box-sizing: border-box; }
body { margin:0 auto; max-width:72rem; padding:2.5rem 1.5rem 4rem; background:var(--bg); color:var(--ink);
  font:16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1,h2,h3 { line-height:1.25; }
h2 { font-size:1.05rem; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); border-bottom:1px solid var(--hairline);
  padding-bottom:.4rem; margin:3rem 0 1rem; }
h3.subhead { font-size:.95rem; letter-spacing:.03em; text-transform:uppercase; color:var(--muted); font-weight:600; margin:2rem 0 .75rem; }
.exec { font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif; overflow-wrap:anywhere; font-size:1.65rem; line-height:1.4; margin:1rem 0 .5rem; font-weight:400; }
.meta, .cap, .pointer, .note { color:var(--muted); font-size:.85rem; }
.num { font-variant-numeric: tabular-nums; }
.band { border-left:3px solid var(--accent); background:var(--card); padding:.6rem .9rem; margin:1rem 0; font-size:.9rem; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(13rem,1fr)); gap:1rem; }
.card { background:var(--card); border:1px solid var(--hairline); padding:1rem 1.1rem; }
.card h3 { margin:0 0 .5rem; font-size:.78rem; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); font-weight:600; }
.card .headline { font-size:2rem; line-height:1.1; font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif; overflow-wrap:anywhere; }
.card .hot { color:var(--accent); }
.card p { margin:.35rem 0 0; font-size:.85rem; }
.card .annot { color:var(--muted); font-size:.78rem; margin-top:.5rem; }
table { border-collapse:collapse; width:100%; font-size:.88rem; }
th,td { text-align:left; padding:.35rem .6rem; border-bottom:1px solid var(--hairline); vertical-align:top; }
th { font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); font-weight:600; }
/* identifiers in column headers keep their exact case — uppercase transform would merge
   exports differing only by case and misrender everything camelCased */
th code { text-transform:none; letter-spacing:0; }
td.n, th.n { text-align:right; font-variant-numeric: tabular-nums; }
td.dot { text-align:right; color:var(--muted); }
.tablewrap { overflow-x:auto; }
/* unicode-bidi isolation: a hostile RLO/LRO override inside a snippet (third-party source
   code) must not visually reorder the SURROUNDING location line — the spoof stays boxed
   inside its own span. Markup was never affected (text nodes only); this closes the
   display-spoofing residue. */
code { font:.85em/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--code-bg); padding:.1em .3em; border-radius:2px; unicode-bidi:isolate; }
details.drawer { border:1px solid var(--hairline); background:var(--card); margin:.6rem 0; }
details.drawer > summary { cursor:pointer; padding:.55rem .9rem; font-weight:600; }
details.drawer > summary .num { color:var(--muted); font-weight:400; }
details.drawer ol { margin:0; padding:.2rem 1rem .8rem 2.4rem; }
details.drawer li, .print-drawer li { margin:.45rem 0; font-size:.87rem; overflow-wrap:anywhere; }
.loc { color:var(--muted); unicode-bidi:isolate; }
.branchnote { color:var(--accent); font-size:.8rem; unicode-bidi:isolate; }
a { color:var(--accent); }
a:hover { text-decoration-thickness:2px; }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
details.drawer > summary:hover { background:var(--code-bg); }
details.drawer, details.drawer li { scroll-margin-top:.9rem; }
details.drawer li:target { outline:1px solid var(--accent); outline-offset:3px; }
button.copy { float:right; margin-top:-2.2rem; font:.72rem system-ui, sans-serif; color:var(--muted); background:none;
  border:1px solid var(--muted); padding:.15rem .55rem; cursor:pointer; }
button.copy:hover { color:var(--ink); border-color:var(--ink); }
@media (max-width: 40rem) { button.copy { float:none; margin:0 0 .6rem; display:inline-block; } }
button.copy[data-copied]::after { content:" — copied"; }
.print-drawer { display:none; }
footer { margin-top:3.5rem; border-top:1px solid var(--hairline); padding-top:.8rem; color:var(--muted); font-size:.8rem; }
@media print {
  :root { color-scheme: light; --bg:#ffffff; --ink:#111111; --muted:#555555; --accent:#8a3d06; --hairline:#cccccc; --card:#ffffff; --code-bg:#f2f2f2; }
  /* paper cannot click: expand each evidence link to its actual URL */
  .print-drawer a[href]::after, td a[href]::after { content:" (" attr(href) ")"; font-size:.85em; word-break:break-all; }
  body { max-width:none; padding:0; font-size:12px; }
  button.copy { display:none; }
  details.drawer { display:none; }
  .print-drawer { display:block; border:1px solid var(--hairline); padding:.4rem .8rem; margin:.5rem 0; }
  .print-drawer ol { padding-left:1.6rem; }
}
`;

export function renderShell(opts: { title: string; body: string; formatVersion: number }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(CSP_CONTENT)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="xray-format-version" content="${esc(String(opts.formatVersion))}">
<title>${esc(opts.title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
${opts.body}
<script>${STATIC_SCRIPT}</script>
</body>
</html>
`;
}

// Evidence permalinks are third-party data: only https:// URLs become links; anything else is
// rendered as escaped plain text — never an href (the one dynamic-href rule, see file header).
function permalinkAnchor(url: string): string {
  if (url.startsWith("https://")) return `<a href="${esc(url)}" rel="noopener">permalink</a>`;
  return `<code>${esc(url)}</code>`;
}

// A section's copy-as-markdown control + its pre-rendered markdown mirror. The mirror is plain
// markdown TEXT rendered here (build time) and escaped into a <template>; the browser decodes
// entities on parse, so template.content.textContent is the raw markdown again.
function copyControl(sectionId: string, markdown: string): string {
  return (
    `<button class="copy" type="button" aria-live="polite" data-copy-target="${esc(sectionId)}">copy as markdown</button>` +
    `<template id="${esc(sectionId)}-md">${esc(markdown)}</template>`
  );
}

// mdCell / mdCode / mdTable — the copy-as-markdown escapers — live in markdownEscape.ts, shared
// with indexHtml.ts so the two "copy as markdown" mirrors can never drift apart in safety.

// ---- dossier sections ---------------------------------------------------------------------------

function execSentence(m: DossierModel): string {
  const scope = m.scopeMode === "default-branch" ? "default branches" : "all branches — default branch unknown for this run";
  const repos = plural(m.headlineRepos.length, "repository", "repositories");
  if (m.headlineSiteCount > 0) {
    const exportCount = m.exportGroups.filter((g) => g.exportName !== "" && g.headlineCount > 0).length;
    const tail = exportCount > 0 ? `concentrated in ${plural(exportCount, "export")}` : "all of it whole-module usage";
    // "imported by" counts only repos with actual import-usage sites; declaration-only and
    // CLI-only repos surface in the suffix (and in the cards) instead of inflating the claim.
    const importing = plural(m.headlineImportingRepoCount, "repository", "repositories");
    const suffix = m.headlineRepos.length > m.headlineImportingRepoCount ? `; declared or used by ${repos} in total` : "";
    return `${m.packageName} is imported by ${importing} (${scope}) across ${plural(m.headlineSiteCount, "usage site")}, ${tail}${suffix}.`;
  }
  // "declared or used": this branch also covers CLI-only units with no declaration row — a
  // bare "declared by" would claim a manifest entry the scan never found.
  if (m.headlineRepos.length > 0)
    return `${m.packageName} is declared or used by ${repos} (${scope}); no import usage sites were detected in the scanned slice.`;
  return `${m.packageName} shows no default-branch usage in this run; ${plural(m.totalSiteCount, "usage site")} appear on other branches.`;
}

interface Card {
  readonly title: string;
  readonly headline: string;
  readonly hot: boolean;
  readonly lines: readonly string[]; // plain text — escaped at emission
}

function buildCards(m: DossierModel): Card[] {
  const wholeLine = `(whole-module): ${plural(m.wholeModuleSiteCount, "usage site")}`;
  const attributedExports = m.exportGroups.filter((g) => g.exportName !== "" && g.headlineCount > 0).length;
  const otherOnlyExports = m.exportGroups.filter((g) => g.exportName !== "" && g.headlineCount === 0 && g.totalCount > 0).length;
  const top = m.hotspots[0];
  return [
    {
      title: "repos affected",
      headline: String(m.headlineRepos.length),
      hot: false,
      lines: [`${plural(m.allRepos.length, "repository", "repositories")} across all branches`],
    },
    {
      title: "versions present",
      headline: String(m.headlineVersions.length),
      hot: false,
      lines: [
        m.versionsSeen.length === 0 ? "no resolved versions in this run's slice" : `seen anywhere: ${m.versionsSeen.join(", ")}`,
        ...(m.otherOnlyVersions.length > 0 ? [`only on other branches: ${m.otherOnlyVersions.join(", ")}`] : []),
      ],
    },
    {
      title: "exports used",
      headline: String(attributedExports),
      hot: false,
      lines: [wholeLine, ...(otherOnlyExports > 0 ? [`${plural(otherOnlyExports, "more export")} used only on other branches`] : [])],
    },
    {
      title: "concentration",
      headline: m.top3SharePct === null ? "n/a" : `${m.top3SharePct}%`,
      hot: false,
      lines: ["of attributed usage in the top 3 exports", `${plural(m.attributedSiteCount, "attributed usage site")} in scope`],
    },
    {
      title: "migration hotspots",
      headline: top === undefined ? "—" : top.repo,
      hot: top !== undefined,
      lines: m.hotspots
        .slice(0, 3)
        .map((h) => `${h.repo} — ${plural(h.exportCount, "export")} × ${plural(h.siteCount, "usage site")}`),
    },
  ];
}

function cardAnnotation(m: DossierModel): string {
  if (m.scopeMode === "all-branches-fallback") return "all branches (default branch unknown)";
  return m.otherBranchCount > 0 ? `also seen on ${plural(m.otherBranchCount, "other branch", "other branches")}` : "";
}

function renderCards(m: DossierModel): string {
  const cards = buildCards(m);
  const annot = cardAnnotation(m);
  const md = mdTable(
    ["card", "headline", "notes"],
    cards.map((c) => [c.title, c.headline, [...c.lines, annot].filter((l) => l !== "").join("; ")]),
  );
  const html = cards
    .map(
      (c) =>
        `<div class="card"><h3>${esc(c.title)}</h3><div class="headline${c.hot ? " hot" : ""}">${esc(c.headline)}</div>` +
        c.lines.map((l) => `<p>${esc(l)}</p>`).join("") +
        (annot === "" ? "" : `<p class="annot">${esc(annot)}</p>`) +
        `</div>`,
    )
    .join("\n");
  return `<section id="cards" aria-labelledby="h-cards"><h2 id="h-cards">Decision cards</h2>${copyControl("cards", md)}<div class="cards">\n${html}\n</div></section>`;
}

function renderSurface(m: DossierModel): string {
  const latestNames = new Map(m.latestSurfaceExports.map((e) => [e.name, e.kind]));
  const usedByName = new Map(m.exportGroups.map((g) => [g.exportName, g]));
  interface Row {
    label: string;
    kind: string;
    count: number;
    repos: number;
    inLatest: string;
    slug: string | null;
  }
  const rows: Row[] = [];
  for (const g of m.exportGroups) {
    rows.push({
      label: g.label,
      kind: g.exportName === "" ? "—" : (latestNames.get(g.exportName) ?? "—"),
      count: g.headlineCount,
      repos: g.headlineRepoCount,
      inLatest: g.exportName === "" ? "—" : m.latestVersion === null ? "—" : latestNames.has(g.exportName) ? "yes" : "no",
      slug: g.slug,
    });
  }
  for (const e of m.latestSurfaceExports) {
    if (usedByName.has(e.name)) continue;
    rows.push({ label: e.name, kind: e.kind, count: 0, repos: 0, inLatest: "yes", slug: null });
  }
  rows.sort((a, b) => b.count - a.count || cmp(a.label, b.label));

  const scopeHead = `usage sites (${m.scopeLabel})`;
  const md = mdTable(
    ["export", "kind", scopeHead, "repos using it", "in latest surface?"],
    rows.map((r) => [r.label, r.kind, String(r.count), String(r.repos), r.inLatest]),
  );
  const body = rows
    .map((r) => {
      // any export with a drawer (≥1 usage site on ANY branch) links into its evidence
      const name = r.slug === null ? `<code>${esc(r.label)}</code>` : `<a href="#e-${esc(r.slug)}"><code>${esc(r.label)}</code></a>`;
      const dot = (n: number): string => (n === 0 ? `<td class="dot">·</td>` : `<td class="n">${num(n)}</td>`);
      return `<tr><td>${name}</td><td>${esc(r.kind)}</td>${dot(r.count)}${dot(r.repos)}<td>${esc(r.inLatest)}</td></tr>`;
    })
    .join("\n");
  const versionNote =
    m.latestVersion === null
      ? `<p class="note">no introspected API surface is available for this run.</p>`
      : `<p class="note">surface rows come from the latest introspected version, ${esc(m.latestVersion)}.</p>`;
  const cli = renderCliTable(m);
  return (
    `<section id="surface" aria-labelledby="h-surface"><h2 id="h-surface">API surface, sorted by real usage</h2>${copyControl("surface", md)}` +
    `${versionNote}<div class="tablewrap"><table><thead><tr><th scope="col">export</th><th scope="col">kind</th><th class="n" scope="col">${esc(scopeHead)}</th>` +
    `<th class="n" scope="col">repos using it</th><th scope="col">in latest surface?</th></tr></thead><tbody>\n${body}\n</tbody></table></div>${cli}</section>`
  );
}

function renderCliTable(m: DossierModel): string {
  if (m.cliTotalCount === 0) return "";
  const shown = m.cliSites.slice(0, EVIDENCE_CAP);
  const rows = shown
    .map(
      (s) =>
        `<tr><td><code>${esc(s.context)}</code></td><td><span class="loc">${esc(s.repo)} · ${esc(s.file)}:${num(s.line)}</span>` +
        (s.fromHeadline ? "" : ` <span class="branchnote">on: ${esc(s.branch)}</span>`) +
        `</td><td>${permalinkAnchor(s.permalink)}</td></tr>`,
    )
    .join("\n");
  const capLine =
    m.cliSites.length > EVIDENCE_CAP ? `<p class="cap">showing ${num(EVIDENCE_CAP)} of ${num(m.cliSites.length)} CLI usage sites</p>` : "";
  return (
    `<h3 class="subhead">CLI usage — ${esc(plural(m.cliHeadlineCount, "site"))} (${esc(m.scopeLabel)}), ${esc(String(m.cliTotalCount))} total</h3>` +
    `<div class="tablewrap"><table><thead><tr><th scope="col">context</th><th scope="col">location</th><th scope="col">evidence</th></tr></thead><tbody>\n${rows}\n</tbody></table></div>${capLine}`
  );
}

function renderMatrix(m: DossierModel): string {
  if (m.matrix.columns.length === 0) {
    const note =
      m.totalSiteCount > 0
        ? `no ${m.scopeLabel === "default branches" ? "default-branch" : ""} usage sites to chart; ${plural(m.totalSiteCount, "usage site")} exist on other branches.`
        : "no usage sites to chart in this run.";
    return `<section id="matrix" aria-labelledby="h-matrix"><h2 id="h-matrix">Repository × export matrix</h2><p class="note">${esc(note)}</p></section>`;
  }
  const header = ["repository", "branches with findings", ...m.matrix.columns.map((c) => c.label)];
  const md = mdTable(
    header,
    m.matrix.rows.map((r) => [r.repo, String(r.branchCount), ...r.cells.map((c) => (c === 0 ? "" : String(c)))]),
  );
  const head = m.matrix.columns.map((c) => `<th class="n" scope="col"><code>${esc(c.label)}</code></th>`).join("");
  const body = m.matrix.rows
    .map(
      (r) =>
        `<tr><td>${esc(r.repo)}</td><td class="n">${num(r.branchCount)}</td>` +
        r.cells.map((c) => (c === 0 ? `<td class="dot">·</td>` : `<td class="n">${num(c)}</td>`)).join("") +
        `</tr>`,
    )
    .join("\n");
  const overflowNote =
    m.matrix.overflowedExportCount > 0
      ? `<p class="note">${num(m.matrix.overflowedExportCount)} lower-usage exports are rolled into the "other" column.</p>`
      : "";
  // The branch column derives from usageByRepo (units with findings for THIS package) — the
  // report has no per-repo scanned-branch data — so the label must claim findings, not scan
  // coverage (global coverage receipts live in the footer / empty state).
  const scopeNote = `<p class="note">cells count usage sites on ${esc(m.scopeLabel)}; the branches column counts branches where this package was found, never a multiplier.</p>`;
  return (
    `<section id="matrix" aria-labelledby="h-matrix"><h2 id="h-matrix">Repository × export matrix</h2>${copyControl("matrix", md)}${scopeNote}` +
    `<div class="tablewrap"><table><thead><tr><th scope="col">repository</th><th class="n" scope="col">branches with findings</th>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>${overflowNote}</section>`
  );
}

function renderSiteRow(g: ExportGroup, s: EvidenceSite, index: number, withIds: boolean): string {
  const idAttr = withIds ? ` id="e-${esc(g.slug)}.${esc(String(index + 1))}"` : "";
  const branchNote = s.fromHeadline
    ? s.alsoOn.length > 0
      ? ` <span class="branchnote">also on: ${esc(s.alsoOn.join(", "))}</span>`
      : ""
    : ` <span class="branchnote">on: ${esc(s.branch)}${s.alsoOn.length > 0 ? `, also on: ${esc(s.alsoOn.join(", "))}` : ""}</span>`;
  return (
    `<li${idAttr}><code>${esc(s.snippet)}</code><br>` +
    `<span class="loc">${esc(s.repo)} · ${esc(s.file)}:${num(s.line)} · <code>${esc(s.shortSha)}</code></span> · ${permalinkAnchor(s.permalink)}${branchNote}</li>`
  );
}

function renderEvidence(m: DossierModel): string {
  const groups = m.exportGroups.filter((g) => g.totalCount > 0);
  if (groups.length === 0)
    return `<section id="evidence" aria-labelledby="h-evidence"><h2 id="h-evidence">Evidence</h2><p class="note">no usage sites were detected in the scanned slice.</p></section>`;
  const mdParts: string[] = [];
  const html = groups
    .map((g) => {
      const shown = g.sites.slice(0, EVIDENCE_CAP);
      const capLine = g.sites.length > EVIDENCE_CAP ? `<p class="cap">showing ${num(EVIDENCE_CAP)} of ${num(g.sites.length)} evidence rows</p>` : "";
      const summary =
        `<summary><code>${esc(g.label)}</code> <span class="num">— ${esc(plural(g.headlineCount, "usage site"))} (${esc(m.scopeLabel)}), ` +
        `${esc(String(g.totalCount))} total across branches</span></summary>`;
      const screenRows = shown.map((s, i) => renderSiteRow(g, s, i, true)).join("\n");
      const printRows = shown.map((s, i) => renderSiteRow(g, s, i, false)).join("\n");
      mdParts.push(
        `### ${mdCell(g.label)} — ${plural(g.headlineCount, "usage site")} (${m.scopeLabel}), ${g.totalCount} total`,
        ...shown.map((s) => `- ${mdCode(s.snippet)} — ${mdCell(s.repo)} ${mdCell(s.file)}:${s.line} @ ${s.shortSha} — ${mdUrl(s.permalink)}`),
        ...(g.sites.length > EVIDENCE_CAP ? [`- … showing ${EVIDENCE_CAP} of ${g.sites.length} evidence rows`] : []),
      );
      return (
        `<details class="drawer" id="e-${esc(g.slug)}">${summary}<ol>\n${screenRows}\n</ol>${capLine}</details>` +
        `<div class="print-drawer"><p><code>${esc(g.label)}</code> — ${esc(plural(g.headlineCount, "usage site"))} (${esc(m.scopeLabel)}), ` +
        `${esc(String(g.totalCount))} total</p><ol>\n${printRows}\n</ol>${capLine}</div>`
      );
    })
    .join("\n");
  return (
    `<section id="evidence" aria-labelledby="h-evidence"><h2 id="h-evidence">Evidence</h2>${copyControl("evidence", mdParts.join("\n"))}` +
    `${html}<p class="pointer">full data lives in the exports (xray/usage_findings.csv)</p></section>`
  );
}

function renderObservations(observations: readonly Observation[]): string {
  if (observations.length === 0) return "";
  // o.text embeds attacker-controlled identifiers (e.g. the dominant export name). Unlike the
  // evidence code/loc spans, this prose is NOT wrapped in a unicode-bidi:isolate field, so a hostile
  // RTL/override control could reorder the whole sentence — strip the bidi controls on both sides.
  // (mdCell strips them too, and additionally neutralizes markdown link/image formers for the paste.)
  const md = observations.map((o) => `- ${mdCell(o.text)}`).join("\n");
  const items = observations.map((o) => `<li>${esc(stripBidiControls(o.text))}</li>`).join("\n");
  return `<section id="observations" aria-labelledby="h-observations"><h2 id="h-observations">What this means</h2>${copyControl("observations", md)}<ul>\n${items}\n</ul></section>`;
}

function renderBands(m: DossierModel): string {
  const bands: string[] = [];
  if (m.scopeMode === "all-branches-fallback")
    bands.push(
      `<div class="band">default branch unknown for this run — re-run the audit to record it. Headline numbers below count all scanned branches.</div>`,
    );
  if (m.missingSurfaceVersions.length > 0)
    bands.push(
      `<div class="band">API surface unavailable for version(s) ${esc(m.missingSurfaceVersions.join(", "))} (introspection failed — see the run report's errors[]).</div>`,
    );
  return bands.join("\n");
}

function renderFooter(ctx: DossierContext): string {
  return `<footer>package usage x-ray · report-format version ${num(ctx.formatVersion)} · run ${esc(ctx.runId)} · generated ${esc(ctx.generatedAt)}</footer>`;
}

// The designed EMPTY state (CEO addendum 12 + CT4): coverage receipts, never "not coupled" —
// scanning is fail-open and caps/cutoff bound the scanned slice, so absence of findings is a
// statement about the slice, not the estate.
function renderEmptyBody(pkg: DossierPackage, ctx: DossierContext): string {
  const sentence = `No usage of ${pkg.name} detected in this run's scanned slice.`;
  const receipts = [
    `${plural(ctx.summary.repositoriesScanned, "repository", "repositories")} scanned`,
    `${plural(ctx.summary.branchesScanned, "branch", "branches")} scanned`,
    `${plural(ctx.summary.branchesSkippedByCutoff, "branch", "branches")} skipped by the ${ctx.config.cutoffDate} cutoff`,
  ].join(" · ");
  return (
    `<header id="exec"><p class="meta">package usage dossier</p><h1 class="exec">${esc(sentence)}</h1>` +
    `<p class="meta num">${esc(receipts)}</p></header>` +
    `<main><section id="coverage" aria-labelledby="h-coverage"><h2 id="h-coverage">What was scanned</h2>` +
    `<p>Detection is scoped to the scanned slice: repositories and branches admitted by this run's configuration ` +
    `(cutoff ${esc(ctx.config.cutoffDate)}, host ${esc(ctx.config.githubHost)}). A finding requires the package to be declared, imported, ` +
    `or invoked in that slice; branches outside it were not examined.</p></section></main>` +
    renderFooter(ctx)
  );
}

// ---- entry points --------------------------------------------------------------------------------

export interface DossierRenderResult {
  readonly html: string;
  readonly observationsStatus: "emitted" | "omitted"; // omitted = fact derivation or rule evaluation threw (CEO addendum 8 fallback)
  readonly observationCount: number;
}

// Returns the html PLUS the observations outcome, so the coordinator's per-dossier JSONL event
// (CEO addendum 10) can report emitted|omitted without re-deriving anything.
export function renderDossierDetailed(pkg: DossierPackage, ctx: DossierContext): DossierRenderResult {
  const title = `${pkg.name} — package usage dossier`;
  const m = computeDossierModel(pkg);
  if (m.isEmpty)
    return { html: renderShell({ title, body: renderEmptyBody(pkg, ctx), formatVersion: ctx.formatVersion }), observationsStatus: "emitted", observationCount: 0 };

  // The observations layer may never take the dossier down: any throw (from fact derivation or
  // rule evaluation) drops the section and reports omitted.
  let observations: readonly Observation[] = [];
  let observationsStatus: "emitted" | "omitted" = "emitted";
  try {
    const outcome = tryEvaluateObservations(deriveFacts(m));
    if ("omitted" in outcome) observationsStatus = "omitted";
    else observations = outcome.observations;
  } catch {
    observationsStatus = "omitted";
  }

  const sentence = execSentence(m);
  const header =
    `<header id="exec"><p class="meta">package usage dossier</p>${copyControl("exec", mdCell(sentence))}<h1 class="exec">${esc(sentence)}</h1>` +
    `<p class="meta num">run ${esc(ctx.runId)} · generated ${esc(ctx.generatedAt)} · headline scope: ${esc(m.scopeLabel)}</p></header>`;
  const body = [
    header,
    "<main>",
    renderBands(m),
    renderCards(m),
    renderSurface(m),
    renderMatrix(m),
    renderEvidence(m),
    observationsStatus === "emitted" ? renderObservations(observations) : "",
    "</main>",
    renderFooter(ctx),
  ]
    .filter((part) => part !== "")
    .join("\n");
  return { html: renderShell({ title, body, formatVersion: ctx.formatVersion }), observationsStatus, observationCount: observations.length };
}

// ONE self-contained HTML document for one tracked package — the §Dossier contract surface.
export function renderDossier(pkg: DossierPackage, ctx: DossierContext): string {
  return renderDossierDetailed(pkg, ctx).html;
}
