import { expect, test, describe } from "bun:test";
import { createHash } from "node:crypto";
import { AuditDb } from "./db.ts";
import { buildReport } from "./report.ts";
import { INDEX_FILENAME, renderIndex } from "./indexHtml.ts";
import { STATIC_SCRIPT, dossierFilename, type DossierReport, type DossierUnit } from "./reportHtml.ts";

const T0 = "2026-01-01T00:00:00.000Z";

// Seed idiom from report.test.ts (fixed timestamps): two tracked packages — one scoped name with
// real usage on a default branch, one with zero findings — so the index exercises both a live row
// and an empty row, plus the scoped-name filename mapping.
function fixtureReport(): DossierReport {
  const db = AuditDb.open({ sqlitePath: ":memory:" });
  const { runId } = db.startRun({
    configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered",
    trackedPackages: ["@expo/vector-icons", "left-pad"], cutoffDate: "2024-01-01", githubHost: "github.com",
  });
  const unit = { organization: "org-a", repository: "app", branch: "main", commitSha: "abc123def4567" };
  db.upsertRunUnitHead({ runId, ...unit, status: "scanned", isDefaultBranch: true });
  db.upsertDependencyFinding({
    runId, ...unit, dateFetched: T0, packageName: "@expo/vector-icons", dependencyKey: "@expo/vector-icons",
    dependencyType: "dependencies", manifestPath: "package.json", manifestLine: 5,
    manifestPermalink: "https://github.com/org-a/app/blob/abc123def4567/package.json#L5",
    declaredVersion: "^14.0.0", resolvedVersion: "14.0.2", resolvedVersionSource: "lockfile",
  });
  db.upsertUsageFinding({
    runId, ...unit, packageName: "@expo/vector-icons", dependencyKey: "@expo/vector-icons", usageType: "named-import",
    exportName: "Ionicons", context: "", filePath: "src/icons.tsx", lineNumber: 3,
    permalink: "https://github.com/org-a/app/blob/abc123def4567/src/icons.tsx#L3",
    snippet: "import { Ionicons } from '@expo/vector-icons';", foundAt: T0,
  });
  db.completeRun(runId);
  const report = buildReport(db, db.getRun(runId)!) as unknown as DossierReport;
  db.close();
  // Pin the two wall-clock-derived envelope fields so the index renders byte-identically
  // (renderIndex itself is pure — this is fixture stabilization, not renderer behavior).
  return { ...report, runId: "run-fixture", generatedAt: T0 };
}

const OPTS = { formatVersion: 1 };

// sha256 of the rendered fixture index. SANCTIONED-CHANGE RULE: this pin may only change in a
// commit that bumps the report-format version (XRAY_FORMAT_VERSION) — any other diff is an
// unintended output change and must be treated as a regression, not re-pinned.
// PRE-LAUNCH RE-PIN (2026-07-11, sanctioned): the index shares the dossier page CSS — the codex
// re-pass bidi-isolation rule moved these bytes. Same sanction rule as reportHtml.test.ts.
const GOLDEN_INDEX_SHA256 = "a1168b3e556cb1fd4c2450b7abf4f851898bfa16b8e3aa1b41dbe6b7f79fe661";

describe("renderIndex — copy-as-markdown neutralizes a hostile value through the real render path", () => {
  // Package names are validated and versionsSeen is the valid-semver slice, so a payload cannot
  // reach here through buildReport in practice — but the index mirror must still be inert by
  // construction (shared mdCell), not merely by upstream validation. Drive a hostile version
  // straight into a package (computeDossierModel passes versionsSeen through) and prove the
  // packages-md mirror cannot form a live image/link juncture.
  test("a hostile version string cannot inject a markdown image into packages-md", () => {
    const base = fixtureReport();
    const BEACON = "![v](https://evil.example/x.png)";
    const poisoned: DossierReport = {
      ...base,
      packages: base.packages.map((p, i) => (i === 0 ? { ...p, versionsSeen: [BEACON] } : p)),
    };
    const html = renderIndex(poisoned, OPTS);
    const open = `<template id="packages-md">`;
    const start = html.indexOf(open);
    const md = html
      .slice(start + open.length, html.indexOf("</template>", start))
      .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
    expect(md).toContain("evil.example"); // the poisoned value survives (not silently dropped)
    expect(md).not.toContain("](https://evil.example/x.png)"); // ...but the image/link juncture is broken
  });
});

describe("renderIndex", () => {
  const report = fixtureReport();
  const html = renderIndex(report, OPTS);

  test("is deterministic: double-render byte equality + golden pin", () => {
    expect(renderIndex(fixtureReport(), OPTS)).toBe(html);
    expect(createHash("sha256").update(html, "utf8").digest("hex")).toBe(GOLDEN_INDEX_SHA256);
  });

  test("one summary row per tracked package with name, counts, and versions", () => {
    expect(html).toContain("<code>@expo/vector-icons</code>");
    expect(html).toContain("<code>left-pad</code>");
    expect(html).toContain("Package usage dossiers — 2 tracked packages.");
    expect(html).toContain("14.0.2"); // versions seen
  });

  test("links resolve to the dossier filenames (the artifact the coordinator writes)", () => {
    for (const pkg of report.packages) {
      expect(html).toContain(`href="${dossierFilename(pkg.name)}"`);
    }
    expect(html).toContain(`href="@expo__vector-icons-dossier.html"`);
    expect(html).toContain(`href="left-pad-dossier.html"`);
  });

  test("coverage receipts and run identity render from the report envelope", () => {
    expect(html).toContain("1 repository scanned");
    expect(html).toContain("1 branch scanned");
    expect(html).toContain("0 branches skipped by the 2024-01-01 cutoff");
    expect(html).toContain("run run-fixture");
    expect(html).toContain(`generated ${T0}`);
  });

  test("carries the BYTE-IDENTICAL static script and the same CSP as every dossier", () => {
    expect(html).toContain(`<script>${STATIC_SCRIPT}</script>`);
    expect(html.split("<script").length - 1).toBe(1);
    expect(html).toContain(`http-equiv="Content-Security-Policy"`);
    expect(html).toContain(`script-src &#39;sha256-`);
  });

  test("format version: meta tag + footer line; copy-as-markdown mirror for the table", () => {
    expect(html).toContain('<meta name="xray-format-version" content="1">');
    expect(html).toContain("report-format version 1");
    expect(html).toContain('data-copy-target="packages"');
    expect(html).toContain('<template id="packages-md">');
  });

  test("CT1 vocabulary: usage sites, never invocation wording", () => {
    expect(html).toContain("usage sites");
    expect(html).not.toContain("call site");
  });
});

describe("renderIndex — edge states", () => {
  const baseReport = (packages: DossierReport["packages"]): DossierReport => ({
    runId: "run-x",
    generatedAt: T0,
    config: { cutoffDate: "2024-01-01", githubHost: "github.com", organizations: ["org-a"] },
    packages,
    summary: { repositoriesScanned: 0, branchesScanned: 0, branchesSkippedByCutoff: 0 },
  });

  test("no tracked packages: a designed empty table state", () => {
    const html = renderIndex(baseReport([]), OPTS);
    expect(html).toContain("no tracked packages in this run.");
    expect(html).toContain("0 tracked packages");
  });

  test("a package with unknown default branches gets the * fallback marker and footnote", () => {
    const unit: DossierUnit = {
      organization: "org-a", repository: "app", branch: "main", isDefaultBranch: null, commitSha: "abc123def4567",
      declarations: [], cliUsage: [],
      apiUsage: [{
        exportName: "x", dependencyKey: "pkg", usageType: "named-import", file: "src/a.ts", line: 1,
        permalink: "https://github.com/org-a/app/blob/abc123def4567/src/a.ts#L1", snippet: "import { x } from 'pkg';",
      }],
    };
    const html = renderIndex(baseReport([{ name: "pkg", versionsSeen: [], apiSurface: {}, usageByRepo: [unit] }]), OPTS);
    expect(html).toContain('<span class="branchnote">*</span>');
    expect(html).toContain("* default branch unknown for this run — counts cover all scanned branches; re-run the audit to record it.");
  });

  test("INDEX_FILENAME matches the artifact name grammar", () => {
    expect(INDEX_FILENAME).toBe("index.html");
    expect(INDEX_FILENAME).toMatch(/^[A-Za-z0-9@._~-]+$/);
  });
});
