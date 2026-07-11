import { expect, test, describe } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditDb } from "./db.ts";
import { buildReport } from "./report.ts";
import { ArtifactBundle, ArtifactWriteError } from "./artifactWrite.ts";
import {
  CSP_CONTENT,
  EVIDENCE_CAP,
  MATRIX_MAX_EXPORT_COLUMNS,
  STATIC_SCRIPT,
  STATIC_SCRIPT_SHA256,
  computeDossierModel,
  dossierFilename,
  renderDossier,
  renderDossierDetailed,
  type DossierContext,
  type DossierPackage,
  type DossierUnit,
} from "./reportHtml.ts";

const mem = (): AuditDb => AuditDb.open({ sqlitePath: ":memory:" });

// Extract a copy-as-markdown mirror's text (the templates hold escaped text; the copy handler
// reads it back through textContent, which is exactly this unescape).
const templateMd = (html: string, id: string): string => {
  const open = `<template id="${id}-md">`;
  const start = html.indexOf(open);
  const end = html.indexOf("</template>", start);
  if (start === -1 || end === -1) throw new Error(`template ${id}-md not found`);
  return html
    .slice(start + open.length, end)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
};

// Fixed timestamps so DB-built fixtures render byte-identically run after run (goldens below).
const T0 = "2026-01-01T00:00:00.000Z";

const FIXED_CTX: DossierContext = {
  runId: "run-fixture",
  generatedAt: T0,
  config: { cutoffDate: "2024-01-01", githubHost: "github.com", organizations: ["org-a"] },
  summary: { repositoriesScanned: 2, branchesScanned: 3, branchesSkippedByCutoff: 1 },
  formatVersion: 1,
};

// Seed idiom from report.test.ts, with deterministic timestamps and a DEFAULT-BRANCH unit plus a
// non-default sibling branch, so headline-vs-annotation semantics are exercised end to end.
// Tracks a second package (left-pad) with zero findings for the empty-state fixture.
function seed(db: AuditDb) {
  const { runId } = db.startRun({
    configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered",
    trackedPackages: ["expo", "left-pad"], cutoffDate: "2024-01-01", githubHost: "github.com",
  });
  const main = { organization: "org-a", repository: "svc", branch: "main", commitSha: "abc123def4567" };
  const dev = { organization: "org-a", repository: "svc", branch: "dev", commitSha: "abc999def0000" };
  db.upsertRunUnitHead({ runId, ...main, status: "scanned", isDefaultBranch: true });
  db.upsertRunUnitHead({ runId, ...dev, status: "scanned", isDefaultBranch: false });
  db.upsertDependencyFinding({
    runId, ...main, dateFetched: T0, packageName: "expo", dependencyKey: "expo", dependencyType: "dependencies",
    manifestPath: "package.json", manifestLine: 5, manifestPermalink: "https://github.com/org-a/svc/blob/abc123def4567/package.json#L5",
    declaredVersion: "^50.0.0", lockfilePath: "package-lock.json", lockfileKind: "npm", lockfileLines: [10, 11],
    lockfilePermalink: "https://github.com/org-a/svc/blob/abc123def4567/package-lock.json#L10-L11",
    resolvedVersion: "50.0.7", resolvedVersionSource: "lockfile",
  });
  const use = (unit: typeof main, exportName: string, file: string, line: number, snippet: string) =>
    db.upsertUsageFinding({
      runId, ...unit, packageName: "expo", dependencyKey: "expo", usageType: "named-import", exportName,
      context: "", filePath: file, lineNumber: line,
      permalink: `https://github.com/org-a/svc/blob/${unit.commitSha}/${file}#L${line}`, snippet, foundAt: T0,
    });
  use(main, "registerRootComponent", "src/index.ts", 1, "import { registerRootComponent } from 'expo';");
  use(main, "registerRootComponent", "src/app.ts", 4, "import { registerRootComponent } from 'expo';");
  use(main, "", "src/all.ts", 2, "import * as Expo from 'expo';");
  // the SAME (file, line, export) on the dev branch — must collapse into an 'also on' annotation
  use(dev, "registerRootComponent", "src/index.ts", 1, "import { registerRootComponent } from 'expo';");
  // a dev-only site — must be listed after headline rows with an 'on: dev' note
  use(dev, "AppConfig", "src/dev.ts", 8, "import { AppConfig } from 'expo';");
  db.upsertUsageFinding({
    runId, ...main, packageName: "expo", dependencyKey: "", usageType: "cli", exportName: "",
    context: "scripts.start", filePath: "package.json", lineNumber: 7,
    permalink: "https://github.com/org-a/svc/blob/abc123def4567/package.json#L7", snippet: "\"start\": \"expo start\"", foundAt: T0,
  });
  db.writeApiSurface({ packageName: "expo", version: "50.0.7", versionSource: "lockfile", rows: [
    { exportName: "registerRootComponent", exportKind: "named", source: "index.d.ts" },
    { exportName: "AppConfig", exportKind: "type", source: "index.d.ts" },
    { exportName: "unusedThing", exportKind: "named", source: "index.d.ts" },
    { exportName: "expo", exportKind: "cli-bin", source: "package.json#bin" },
  ] });
  db.completeRun(runId);
  return db.getRun(runId)!;
}

function fixturePackages(): DossierPackage[] {
  const db = mem();
  const run = seed(db);
  const report = buildReport(db, run);
  db.close();
  return report.packages as DossierPackage[];
}

// Synthetic package builders (no DB) for the overflow/cap/chaos suites — deterministic loops.
const syntheticUsage = (exportName: string, file: string, line: number) => ({
  exportName, dependencyKey: "pkg", usageType: "named-import", file, line,
  permalink: `https://github.com/o/r/blob/abc123def4567/${file}#L${line}`, snippet: `import { x } from 'pkg'; // ${line}`,
});
const syntheticUnit = (over: Partial<DossierUnit>): DossierUnit => ({
  organization: "o", repository: "r", branch: "main", isDefaultBranch: true, commitSha: "abc123def4567",
  declarations: [], apiUsage: [], cliUsage: [], ...over,
});
const syntheticPkg = (units: DossierUnit[], over: Partial<DossierPackage> = {}): DossierPackage => ({
  name: "pkg", versionsSeen: [], apiSurface: {}, usageByRepo: units, ...over,
});

// ---- golden byte pins ---------------------------------------------------------------------------
// sha256 of the rendered fixture dossier. SANCTIONED-CHANGE RULE: these pins may only change in a
// commit that bumps the report-format version (XRAY_FORMAT_VERSION) — any other diff here is an
// unintended output change and must be treated as a regression, not re-pinned.
// PRE-LAUNCH RE-PIN (2026-07-11, sanctioned): codex re-pass fixes — exec-sentence importing-repo
// count, matrix branch-column relabel, versions-card semver restriction, row-id separator '.',
// markdown code-span fencing, bidi isolation CSS. Absorbed without a formatVersion bump under the
// pre-public-launch rule; post-launch output changes require bumping XRAY_FORMAT_VERSION.
const GOLDEN_DOSSIER_SHA256 = "8c32159cc75475665ced03bdca45377d0ae07ff58ae289d26433d439f09b98db";
const GOLDEN_EMPTY_SHA256 = "0b5f954d9d70c5be81410be4cff3fd6a851982b8153712bd4f7d0ecc359c9eb4";

describe("renderDossier — determinism and golden bytes", () => {
  test("double-render byte equality (same DB, two builds, two renders)", () => {
    const [a] = fixturePackages();
    const [b] = fixturePackages();
    expect(renderDossier(a!, FIXED_CTX)).toBe(renderDossier(b!, FIXED_CTX));
  });

  test("golden byte pin: the fixture dossier hashes to the pinned sha256", () => {
    const [pkg] = fixturePackages();
    const html = renderDossier(pkg!, FIXED_CTX);
    expect(createHash("sha256").update(html, "utf8").digest("hex")).toBe(GOLDEN_DOSSIER_SHA256);
  });

  test("golden byte pin: the empty-state dossier hashes to the pinned sha256", () => {
    const pkgs = fixturePackages();
    const html = renderDossier(pkgs[1]!, FIXED_CTX); // left-pad: tracked, zero findings
    expect(createHash("sha256").update(html, "utf8").digest("hex")).toBe(GOLDEN_EMPTY_SHA256);
  });
});

describe("renderDossier — content contract on the real report object", () => {
  const pkg = fixturePackages()[0]!;
  const html = renderDossier(pkg, FIXED_CTX);

  test("executive sentence restates headline aggregates with CT1 vocabulary", () => {
    expect(html).toContain("expo is imported by 1 repository (default branches) across 3 usage sites, concentrated in 1 export.");
    expect(html).not.toContain("call site"); // CT1: usage sites, never invocation wording
  });

  test("fixed section ids + copy-as-markdown mirrors exist for each section", () => {
    for (const id of ["exec", "cards", "surface", "matrix", "evidence", "observations"]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`data-copy-target="${id}"`);
      expect(html).toContain(`<template id="${id}-md">`);
    }
  });

  test("decision cards: default-branch headlines with the also-seen annotation and honest totals", () => {
    expect(html).toContain("also seen on 1 other branch"); // dev
    expect(html).toContain("of attributed usage in the top 3 exports"); // concentration label (CV3)
    expect(html).toContain("(whole-module): 1 usage site"); // counted whole-module card line
    expect(html).toContain("1 repository across all branches"); // honest total
  });

  test("api-surface table: usage-sorted rows, whole-module row, in-latest tri-column", () => {
    expect(html).toContain("<code>(whole-module)</code>");
    expect(html).toContain("<code>unusedThing</code>"); // in latest surface, zero usage
    expect(html).toContain("surface rows come from the latest introspected version, 50.0.7");
    // AppConfig is used only on dev — headline count 0, still in the latest surface
    expect(html).toContain("<code>AppConfig</code>");
  });

  test("CLI usage renders its own table with context, location and permalink", () => {
    expect(html).toContain("CLI usage — 1 site (default branches), 1 total");
    expect(html).toContain("<code>scripts.start</code>");
    expect(html).toContain('href="https://github.com/org-a/svc/blob/abc123def4567/package.json#L7"');
  });

  test("evidence: collapsed cross-branch row carries 'also on', dev-only site carries 'on: dev'", () => {
    expect(html).toContain("also on: dev"); // (src/index.ts:1, registerRootComponent) on main + dev
    expect(html).toContain("on: dev"); // the dev-only AppConfig site
    expect(html).toContain("full data lives in the exports (xray/usage_findings.csv)");
    expect(html).toContain("<code>abc123d</code>"); // short SHA
  });

  test("anchor grammar: drawer and row ids follow e-<slug>[.<n>]", () => {
    expect(html).toContain('id="e-registerrootcomponent"');
    expect(html).toContain('id="e-registerrootcomponent.1"');
    expect(html).toContain('id="e-registerrootcomponent.2"');
    expect(html).toContain('id="e-whole-module"');
    expect(html).toContain('id="e-whole-module.1"');
  });

  test("print drawers: evidence rows are duplicated into id-free print-only blocks", () => {
    expect(html).toContain('<div class="print-drawer">');
    // ids exist exactly once (screen copy only) — the print copy must not duplicate anchors
    expect(html.split('id="e-registerrootcomponent.1"').length - 1).toBe(1);
    // but the evidence snippet appears twice: once in the drawer, once in the print block
    const snippet = "import { registerRootComponent } from &#39;expo&#39;;";
    expect(html.split(snippet).length - 1).toBeGreaterThanOrEqual(2);
  });

  test("format version: meta tag + footer line", () => {
    expect(html).toContain('<meta name="xray-format-version" content="1">');
    expect(html).toContain("report-format version 1");
    expect(html).toContain("run run-fixture");
  });

  test("observations section renders restated aggregates", () => {
    expect(html).toContain("What this means");
    expect(html).toContain("come from a single repository: org-a/svc.");
  });

  test("renderDossierDetailed reports the observations outcome for the coordinator's JSONL event", () => {
    const detailed = renderDossierDetailed(pkg, FIXED_CTX);
    expect(detailed.html).toBe(html);
    expect(detailed.observationsStatus).toBe("emitted");
    expect(detailed.observationCount).toBeGreaterThan(0);
  });
});

describe("the one static script + CSP (CEO addendum 5/7)", () => {
  const html = renderDossier(fixturePackages()[0]!, FIXED_CTX);

  test("CSP hash sync: an independent recompute matches the exported hash and the meta tag", () => {
    const independent = createHash("sha256").update(STATIC_SCRIPT, "utf8").digest("base64");
    expect(STATIC_SCRIPT_SHA256).toBe(independent);
    expect(CSP_CONTENT).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; script-src 'sha256-${independent}'`,
    );
    // the meta tag carries the escaped policy (quotes → &#39;)
    expect(html).toContain(`script-src &#39;sha256-${independent}&#39;`);
    expect(html).toContain(`http-equiv="Content-Security-Policy"`);
  });

  test("the rendered <script> element is EXACTLY the static constant — nothing interpolated", () => {
    expect(html).toContain(`<script>${STATIC_SCRIPT}</script>`);
    expect(html.split("<script").length - 1).toBe(1); // one opening tag in the whole document
    expect(html.split("</script").length - 1).toBe(1); // one closing tag
  });

  test("source scan: reportHtml.ts emits the script tag as the exact literal `<script>${STATIC_SCRIPT}</script>`", () => {
    const src = readFileSync(join(import.meta.dir, "reportHtml.ts"), "utf8");
    expect(src).toContain("<script>" + "${STATIC_SCRIPT}" + "</script>");
    // and the script constant itself contains no interpolation syntax and no closing-tag sequence
    expect(STATIC_SCRIPT).not.toContain("${");
    expect(STATIC_SCRIPT).not.toContain("</script");
  });
});

describe("adversarial fixture — hostile snippets, paths, branch names (escape-by-construction)", () => {
  function adversarialPkg(): DossierPackage {
    const db = mem();
    const { runId } = db.startRun({
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered",
      trackedPackages: ["evil"], cutoffDate: "2024-01-01", githubHost: "github.com",
    });
    const main = { organization: "org-a", repository: "svc", branch: "main", commitSha: "abc123def4567" };
    const hostileBranch = { organization: "org-a", repository: "svc", branch: `dev"><img src=x onerror=alert(2)>`, commitSha: "abc999def0000" };
    db.upsertRunUnitHead({ runId, ...main, status: "scanned", isDefaultBranch: true });
    db.upsertRunUnitHead({ runId, ...hostileBranch, status: "scanned", isDefaultBranch: false });
    const use = (unit: typeof main, exportName: string, file: string, line: number, snippet: string, permalink?: string) =>
      db.upsertUsageFinding({
        runId, ...unit, packageName: "evil", dependencyKey: "evil", usageType: "named-import", exportName,
        context: "", filePath: file, lineNumber: line,
        permalink: permalink ?? `https://github.com/org-a/svc/blob/${unit.commitSha}/x#L${line}`, snippet, foundAt: T0,
      });
    use(main, "a", "src/a.ts", 1, "</script><script>alert(1)</script>");
    use(main, "b", `src/"><img src=x onerror=alert(1)>.ts`, 2, `"><img src=x onerror=alert(1)>`);
    use(main, "c", "src/c.ts", 3, "=cmd|' /C calc'!A0");
    use(main, "d", "src/d.ts", 4, "line1\r\nline2 ‮evil 🚀");
    // hostile permalink: must never become an href
    use(main, "e", "src/e.ts", 5, "import { e } from 'evil';", "javascript:alert(1)");
    use(hostileBranch, "a", "src/f.ts", 6, "import { a } from 'evil';");
    db.completeRun(runId);
    const report = buildReport(db, db.getRun(runId)!);
    db.close();
    return (report.packages as DossierPackage[])[0]!;
  }
  const html = renderDossier(adversarialPkg(), FIXED_CTX);

  test("script-breakout snippet renders escaped; no raw </script> outside the one static script", () => {
    expect(html).toContain("&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html.split("</script").length - 1).toBe(1); // exactly the static script's closing tag
    expect(html.split("<script").length - 1).toBe(1);
  });

  test("attribute-breakout snippet and file path render escaped", () => {
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain(`"><img src=x onerror=alert(1)>`);
  });

  test("formula-injection text passes through as escaped TEXT (the CSV defense lives in csvWrite)", () => {
    expect(html).toContain("=cmd|&#39; /C calc&#39;!A0");
  });

  test("CR/LF, RTL and emoji pass through byte-identically (escapeHtml touches only the five)", () => {
    expect(html).toContain("line1\r\nline2 ‮evil 🚀");
  });

  test("a non-https permalink renders as plain text, never an href", () => {
    expect(html).toContain("<code>javascript:alert(1)</code>");
    expect(html).not.toContain('href="javascript:');
  });

  test("hostile branch name in the 'on:' annotation renders escaped", () => {
    expect(html).toContain("on: dev&quot;&gt;&lt;img src=x onerror=alert(2)&gt;");
  });
});

describe("dossierFilename — sanitization against the artifact name grammar", () => {
  test("scoped name: '/' → '__'", () => {
    expect(dossierFilename("@expo/vector-icons")).toBe("@expo__vector-icons-dossier.html");
    expect(dossierFilename("expo")).toBe("expo-dossier.html");
  });

  test("every produced name matches artifactWrite's flat ASCII grammar", () => {
    const grammar = /^[A-Za-z0-9@._~-]+$/; // pinned to artifactWrite.ts NAME_GRAMMAR
    for (const name of ["@expo/vector-icons", "expo", "left-pad", "a.b~c_d"])
      expect(dossierFilename(name)).toMatch(grammar);
  });

  test("a name that cannot sanitize to the grammar throws (producer bug, loud)", () => {
    expect(() => dossierFilename("bad name with spaces")).toThrow(/does not sanitize/);
    expect(() => dossierFilename("")).toThrow(/does not sanitize/);
  });

  test("NOT injective by itself ('a/b' aliases 'a__b') — the bundle's collision error is the guard", () => {
    expect(dossierFilename("a/b")).toBe(dossierFilename("a__b"));
    const root = mkdtempSync(join(realpathSync(tmpdir()), "dossier-name-"));
    try {
      const bundle = new ArtifactBundle(root, "dossier");
      bundle.write(dossierFilename("@expo/vector-icons"), "x"); // grammar-accepted by the real writer
      bundle.write(dossierFilename("a/b"), "x");
      expect(() => bundle.write(dossierFilename("a__b"), "x")).toThrow(ArtifactWriteError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("empty state (CEO addendum 12 + CT4)", () => {
  const pkg = fixturePackages()[1]!; // left-pad: tracked, zero findings
  const html = renderDossier(pkg, FIXED_CTX);

  test("designed page with coverage receipts — never 'not coupled'", () => {
    expect(html).toContain("No usage of left-pad detected in this run&#39;s scanned slice.");
    expect(html).toContain("2 repositories scanned");
    expect(html).toContain("3 branches scanned");
    expect(html).toContain("1 branch skipped by the 2024-01-01 cutoff");
    expect(html).toContain("Detection is scoped to the scanned slice");
    expect(html).not.toContain("not coupled");
  });

  test("keeps the byte-identical static script and the format-version footer", () => {
    expect(html).toContain(`<script>${STATIC_SCRIPT}</script>`);
    expect(html).toContain("report-format version 1");
    const detailed = renderDossierDetailed(pkg, FIXED_CTX);
    expect(detailed.observationsStatus).toBe("emitted");
    expect(detailed.observationCount).toBe(0);
  });
});

describe("partial state — versionsSeen entries missing from apiSurface", () => {
  test("renders the introspection-failure band; other sections render normally", () => {
    const db = mem();
    const run = seed(db);
    db.upsertDependencyFinding({
      runId: run.runId, organization: "org-a", repository: "svc2", branch: "main", commitSha: "def456abc7890",
      dateFetched: T0, packageName: "expo", dependencyKey: "expo", dependencyType: "dependencies",
      manifestPath: "package.json", manifestLine: 3, manifestPermalink: "https://github.com/org-a/svc2/blob/def456abc7890/package.json#L3",
      declaredVersion: "^49.0.0", resolvedVersion: "49.0.0", resolvedVersionSource: "lockfile",
    });
    db.upsertRunUnitHead({ runId: run.runId, organization: "org-a", repository: "svc2", branch: "main", commitSha: "def456abc7890", status: "scanned", isDefaultBranch: true });
    const report = buildReport(db, run);
    db.close();
    const html = renderDossier((report.packages as DossierPackage[])[0]!, FIXED_CTX);
    // static band prose is our own literal (raw apostrophe is legal HTML); only the version list is dynamic
    expect(html).toContain("API surface unavailable for version(s) 49.0.0 (introspection failed — see the run report's errors[]).");
    expect(html).toContain('id="surface"'); // the rest of the dossier still renders
    expect(html).toContain("surface rows come from the latest introspected version, 50.0.7");
  });
});

describe("default-branch tri-state (E1/CT5)", () => {
  test("ANY isDefaultBranch=null unit → visible band + all-branches fallback headlines", () => {
    const pkg = syntheticPkg([
      syntheticUnit({ branch: "main", isDefaultBranch: null, apiUsage: [syntheticUsage("a", "src/a.ts", 1)] }),
      syntheticUnit({ branch: "dev", isDefaultBranch: false, apiUsage: [syntheticUsage("b", "src/b.ts", 2)] }),
    ]);
    const html = renderDossier(pkg, FIXED_CTX);
    expect(html).toContain("default branch unknown for this run — re-run the audit to record it");
    // fallback: headlines count ALL branches (2 sites), never a silent undercount
    expect(html).toContain("across 2 usage sites");
    expect(html).toContain("all branches — default branch unknown for this run");
    expect(html).toContain("all branches (default branch unknown)"); // the per-card annotation
  });

  test("no default-true units and no nulls → headlines are 0, the branch annotation carries the weight", () => {
    const pkg = syntheticPkg([
      syntheticUnit({ branch: "dev", isDefaultBranch: false, apiUsage: [syntheticUsage("a", "src/a.ts", 1)] }),
      syntheticUnit({ branch: "feat-x", isDefaultBranch: false, apiUsage: [syntheticUsage("a", "src/c.ts", 3)] }),
    ]);
    const m = computeDossierModel(pkg);
    expect(m.scopeMode).toBe("default-branch");
    expect(m.headlineSiteCount).toBe(0);
    expect(m.otherBranchCount).toBe(2);
    const html = renderDossier(pkg, FIXED_CTX);
    expect(html).toContain("pkg shows no default-branch usage in this run; 2 usage sites appear on other branches.");
    expect(html).toContain("also seen on 2 other branches");
    expect(html).not.toContain("default branch unknown for this run"); // no band without nulls
  });
});

describe("repo × export matrix — overflow and cells", () => {
  const exportsPkg = (count: number, wholeModule: boolean): DossierPackage => {
    // export e001..eNNN with strictly decreasing usage so the kept-column ordering is unambiguous:
    // e001 gets `count` sites, e002 gets count-1, … (all on one default-branch unit).
    const rows = [];
    let line = 1;
    for (let i = 1; i <= count; i++)
      for (let k = 0; k <= count - i; k++) rows.push(syntheticUsage(`e${String(i).padStart(3, "0")}`, `src/f${i}.ts`, line++));
    if (wholeModule) rows.push(syntheticUsage("", "src/whole.ts", line++));
    return syntheticPkg([syntheticUnit({ apiUsage: rows })]);
  };

  test("42 attributed exports → 39 kept + one 'other' rollup (whole-module outside the budget)", () => {
    const m = computeDossierModel(exportsPkg(42, true));
    const labels = m.matrix.columns.map((c) => c.label);
    expect(labels[0]).toBe("(whole-module)"); // REAL pseudo-column, first after the name column
    expect(labels.length).toBe(1 + MATRIX_MAX_EXPORT_COLUMNS); // 1 whole-module + 39 kept + 1 other
    expect(labels[1]).toBe("e001"); // top by usage
    expect(labels[39]).toBe("e039");
    expect(labels[40]).toBe("other (3 exports)");
    const otherTotal = m.matrix.columns[40]!.total;
    expect(otherTotal).toBe(3 + 2 + 1); // e040 + e041 + e042 site counts
    expect(m.matrix.overflowedExportCount).toBe(3);
    const html = renderDossier(exportsPkg(42, true), FIXED_CTX);
    expect(html).toContain("other (3 exports)");
    expect(html).toContain('3 lower-usage exports are rolled into the "other" column.'); // static prose, raw quotes
  });

  test("exactly 40 attributed exports → no rollup", () => {
    const m = computeDossierModel(exportsPkg(40, false));
    expect(m.matrix.columns.length).toBe(40);
    expect(m.matrix.overflowedExportCount).toBe(0);
    expect(m.matrix.columns.some((c) => c.label.startsWith("other ("))).toBe(false);
  });

  test("cells: zero renders as a quiet dot, never 0; branch count is branches-with-findings, not a multiplier", () => {
    const pkg = syntheticPkg([
      syntheticUnit({ apiUsage: [syntheticUsage("a", "src/a.ts", 1)] }),
      syntheticUnit({ branch: "dev", isDefaultBranch: false }),
      syntheticUnit({ repository: "r2", apiUsage: [syntheticUsage("b", "src/b.ts", 2)] }),
    ]);
    const html = renderDossier(pkg, FIXED_CTX);
    expect(html).toContain('<td class="dot">·</td>');
    expect(html).toContain("the branches column counts branches where this package was found, never a multiplier");
    const m = computeDossierModel(pkg);
    expect(m.matrix.rows.find((r) => r.repo === "o/r")!.branchCount).toBe(2);
    expect(m.matrix.rows.find((r) => r.repo === "o/r")!.cells).toEqual([1, 0]);
  });
});

describe("evidence wall — cap, honest totals, anchor stability", () => {
  test("30 sites → 25 shown with the honest 'showing 25 of 30' line; ids stop at .25", () => {
    const rows = [];
    for (let i = 1; i <= 30; i++) rows.push(syntheticUsage("hot", `src/f${String(i).padStart(2, "0")}.ts`, i));
    const html = renderDossier(syntheticPkg([syntheticUnit({ apiUsage: rows })]), FIXED_CTX);
    expect(html).toContain(`showing ${EVIDENCE_CAP} of 30 evidence rows`);
    expect(html).toContain('id="e-hot.25"');
    expect(html).not.toContain('id="e-hot.26"');
    expect(html).toContain("30 total across branches"); // honest drawer total
  });

  test("the CLI table is capped like evidence, with an honest total", () => {
    const cli = [];
    for (let i = 1; i <= 30; i++) {
      const nn = String(i).padStart(2, "0"); // zero-padded so lexicographic file order = numeric
      cli.push({
        file: `pkg${nn}.json`, line: i, context: `scripts.s${nn}`,
        permalink: `https://github.com/o/r/blob/abc123def4567/pkg${nn}.json#L${i}`, snippet: `"s${nn}": "pkg"`,
      });
    }
    const html = renderDossier(syntheticPkg([syntheticUnit({ cliUsage: cli })]), FIXED_CTX);
    expect(html).toContain(`showing ${EVIDENCE_CAP} of 30 CLI usage sites`);
    expect(html).toContain("CLI usage — 30 sites (default branches), 30 total");
    expect(html).toContain("<code>scripts.s01</code>");
    expect(html).toContain("<code>scripts.s25</code>"); // last row inside the cap
    expect(html).not.toContain("<code>scripts.s26</code>"); // first row beyond the cap
  });

  test("slug disambiguation: exports that fold to one slug get '~2' suffixes, in drawer order", () => {
    const pkg = syntheticPkg([
      syntheticUnit({
        apiUsage: [
          syntheticUsage("Foo", "src/a.ts", 1),
          syntheticUsage("Foo", "src/b.ts", 2), // 2 sites — drawer sorts first
          syntheticUsage("foo", "src/c.ts", 3), // 1 site — same slug, gets ~2
        ],
      }),
    ]);
    const html = renderDossier(pkg, FIXED_CTX);
    expect(html).toContain('id="e-foo"');
    expect(html).toContain('id="e-foo~2"');
    expect(html).toContain('id="e-foo.1"');
    expect(html).toContain('id="e-foo~2.1"');
  });

  test("anchor grammar is stable across renders (deep links keep working)", () => {
    const pkg = fixturePackages()[0]!;
    const ids = (html: string): string[] => [...html.matchAll(/ id="(e-[^"]+)"/g)].map((m) => m[1]!);
    const a = ids(renderDossier(pkg, FIXED_CTX));
    expect(a.length).toBeGreaterThan(0);
    expect(new Set(a).size).toBe(a.length); // unique
    expect(a).toEqual(ids(renderDossier(pkg, FIXED_CTX)));
  });
});

describe("chaos fixture (CV9): 10k usage sites", () => {
  test("renders to completion within a generous bound and under 15MB", () => {
    // 200 exports × 50 sites = 10,000 usage sites across 20 default-branch repos. Deterministic
    // loops, no randomness.
    const units: DossierUnit[] = [];
    for (let repo = 0; repo < 20; repo++) {
      const rows = [];
      for (let i = 0; i < 500; i++) {
        const exp = `export${String((repo * 500 + i) % 200).padStart(3, "0")}`;
        rows.push(syntheticUsage(exp, `src/dir${repo}/file${i % 40}.ts`, i + 1));
      }
      units.push(syntheticUnit({ repository: `repo${String(repo).padStart(2, "0")}`, apiUsage: rows }));
    }
    const pkg = syntheticPkg(units, { versionsSeen: ["1.0.0"] });
    const started = performance.now();
    const html = renderDossier(pkg, FIXED_CTX);
    const elapsed = performance.now() - started;
    console.error(`[chaos] 10k-site dossier: ${Math.round(elapsed)}ms, ${Buffer.byteLength(html, "utf8")} bytes`);
    expect(elapsed).toBeLessThan(10_000); // generous — this is a regression tripwire, not a benchmark
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(15 * 1024 * 1024);
    expect(html).toContain("10000 usage sites"); // exec sentence carries the honest headline count
  });
});

// ---- codex re-pass regressions (2026-07-11) ------------------------------------------------------
// One test per confirmed finding from the post-rebase codex comprehensive pass over
// fae5435..5b91a03; each pins the corrected behavior so the defect cannot silently return.
describe("codex re-pass regressions", () => {
  test("exec sentence: declaration-only and CLI-only repos are not counted as importing (F1)", () => {
    const units = [
      syntheticUnit({ repository: "importer", apiUsage: [syntheticUsage("foo", "src/a.ts", 1)] }),
      syntheticUnit({ repository: "decl-only", declarations: [{ resolvedVersion: "1.0.0" }] }),
      syntheticUnit({
        repository: "cli-only",
        cliUsage: [{ file: "package.json", line: 1, context: "scripts.x", permalink: "https://github.com/o/r/blob/abc123def4567/package.json#L1", snippet: '"x": "pkg"' }],
      }),
    ];
    const html = renderDossier(syntheticPkg(units, { versionsSeen: ["1.0.0"] }), FIXED_CTX);
    expect(html).toContain("pkg is imported by 1 repository");
    expect(html).toContain("declared or used by 3 repositories");
  });

  test("exec sentence: no declared-or-used suffix when every counted repo imports (F1)", () => {
    const units = [syntheticUnit({ apiUsage: [syntheticUsage("foo", "src/a.ts", 1)] })];
    const html = renderDossier(syntheticPkg(units), FIXED_CTX);
    expect(html).toContain("pkg is imported by 1 repository");
    expect(html).not.toContain("declared or used by");
  });

  test("matrix: branch column claims branches with findings, not scan coverage (F2)", () => {
    const units = [
      syntheticUnit({ apiUsage: [syntheticUsage("foo", "src/a.ts", 1)] }),
      syntheticUnit({ branch: "dev", isDefaultBranch: false, commitSha: "def456abc7890", apiUsage: [syntheticUsage("foo", "src/a.ts", 1)] }),
    ];
    const html = renderDossier(syntheticPkg(units), FIXED_CTX);
    expect(html).toContain("branches with findings</th>");
    expect(html).not.toContain("branches scanned</th>");
    expect(html).toContain("the branches column counts branches where this package was found, never a multiplier");
  });

  test("versions card: non-semver resolutions cannot inflate the headline count (F3)", () => {
    const units = [
      syntheticUnit({
        declarations: [{ resolvedVersion: "git+https://github.com/o/dep#abc123" }],
        apiUsage: [syntheticUsage("foo", "src/a.ts", 1)],
      }),
    ];
    const m = computeDossierModel(syntheticPkg(units)); // versionsSeen: [] — the git ref is not a version
    expect(m.headlineVersions).toEqual([]);
    expect(m.otherOnlyVersions).toEqual([]);
    const html = renderDossier(syntheticPkg(units), FIXED_CTX);
    expect(html).toContain("no resolved versions in this run&#39;s slice");
  });

  test("anchor grammar: export names foo and foo_1 produce globally unique ids (F4)", () => {
    const units = [
      syntheticUnit({
        apiUsage: [syntheticUsage("foo", "src/a.ts", 1), syntheticUsage("foo", "src/b.ts", 2), syntheticUsage("foo_1", "src/c.ts", 3)],
      }),
    ];
    const html = renderDossier(syntheticPkg(units), FIXED_CTX);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(html).toContain('id="e-foo-1"'); // the foo_1 drawer keeps its natural slug
    expect(html).toContain('id="e-foo.1"'); // foo's first evidence row — '.' is outside the slug alphabet
  });

  test("copy-as-markdown: backticked snippets stay inside code spans (F11)", () => {
    const hostile = "const q = `[click](https://evil.example)`;";
    const units = [syntheticUnit({ apiUsage: [{ ...syntheticUsage("foo", "src/a.ts", 1), snippet: hostile }] })];
    const md = templateMd(renderDossier(syntheticPkg(units), FIXED_CTX), "evidence");
    expect(md).toContain("``const q = `[click](https://evil.example)`;``"); // no pad: edges are not backticks/spaces
    expect(md).not.toContain("- `const q");
  });

  test("copy-as-markdown: backslashes in snippets stay literal inside code spans (F11)", () => {
    const units = [syntheticUnit({ apiUsage: [{ ...syntheticUsage("foo", "src/a.ts", 1), snippet: "require('.\\win\\path')" }] })];
    const md = templateMd(renderDossier(syntheticPkg(units), FIXED_CTX), "evidence");
    expect(md).toContain("require('.\\win\\path')"); // code spans are literal — no backslash doubling
  });
});

// The bidi guard is CSS (visual isolation, not markup safety — markup was always inert): pin the
// rules so a stylesheet refactor cannot silently drop them and reopen the display-spoofing vector
// (a hostile U+202E in a snippet visually reordering the rest of its evidence row's location line).
test("bidi isolation: code and .loc carry unicode-bidi:isolate", () => {
  const [pkg] = fixturePackages();
  const html = renderDossier(pkg!, FIXED_CTX);
  expect(html).toContain("unicode-bidi:isolate");
  expect(html).toMatch(/code \{[^}]*unicode-bidi:isolate/);
  expect(html).toMatch(/\.loc \{[^}]*unicode-bidi:isolate/);
});

// ---- dual-review round-2 regressions (2026-07-11) ------------------------------------------------
describe("dual-review round-2 regressions", () => {
  test("exec sentence: CLI-only usage without declarations is not called 'declared by'", () => {
    const units = [
      syntheticUnit({
        cliUsage: [{ file: "package.json", line: 1, context: "scripts.x", permalink: "https://github.com/o/r/blob/abc123def4567/package.json#L1", snippet: '"x": "pkg"' }],
      }),
    ];
    const html = renderDossier(syntheticPkg(units), FIXED_CTX);
    expect(html).toContain("pkg is declared or used by 1 repository");
    expect(html).not.toContain("pkg is declared by 1 repository");
  });

  test("matrix markdown mirror header carries the corrected branch-column semantics", () => {
    const units = [syntheticUnit({ apiUsage: [syntheticUsage("foo", "src/a.ts", 1)] })];
    const md = templateMd(renderDossier(syntheticPkg(units), FIXED_CTX), "matrix");
    expect(md).toContain("| branches with findings |");
    expect(md).not.toContain("| branches |");
  });

  test("mdCode: padding only when CommonMark needs it (backtick or space edges); plain edges stay unpadded", () => {
    const render = (snippet: string): string =>
      templateMd(renderDossier(syntheticPkg([syntheticUnit({ apiUsage: [{ ...syntheticUsage("foo", "src/a.ts", 1), snippet }] })]), FIXED_CTX), "evidence");
    expect(render("plain(x)")).toContain("- `plain(x)` —"); // unpadded
    expect(render("`lead")).toContain("- `` `lead `` —"); // backtick edge → padded, out-fenced
    expect(render(" spaced ")).toContain("- `  spaced  ` —"); // space edges → padded so the renderer's strip preserves them
  });
});
