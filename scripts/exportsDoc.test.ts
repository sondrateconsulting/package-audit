import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_REGISTRY, EXPORT_TABLE_NAMES, type ExportTableName } from "./export.ts";

// EXPORTS.md and the README recipes are CONTRACT documents — these sync tests make them
// impossible to silently drift from the export column registry (house precedent:
// config.schema.json↔config.ts and reportSchema↔db.ts sync tests).

const REPO_ROOT = join(import.meta.dir, "..");
const EXPORTS_MD = readFileSync(join(REPO_ROOT, "EXPORTS.md"), "utf8");
const README = readFileSync(join(REPO_ROOT, "README.md"), "utf8");

// Parse "## <table>" sections: the first markdown table's "| name | type |" rows (in order)
// and the "Row order: `a, b, c`" line.
function parseDocTable(table: ExportTableName): { columns: Array<{ name: string; type: string }>; order: string[] } {
  const section = EXPORTS_MD.split(new RegExp(`^## ${table}$`, "m"))[1]?.split(/^## /m)[0];
  expect(section, `EXPORTS.md must have a "## ${table}" section`).toBeDefined();
  const columns: Array<{ name: string; type: string }> = [];
  for (const m of section!.matchAll(/^\| ([a-z_]+) \| ([a-z-]+) \|$/gm)) {
    if (m[1] === "column") continue; // the markdown header row
    columns.push({ name: m[1]!, type: m[2]! });
  }
  const orderMatch = section!.match(/^Row order: `([^`]+)`$/m);
  expect(orderMatch, `EXPORTS.md "## ${table}" must carry a Row order line`).not.toBeNull();
  return { columns, order: orderMatch![1]!.split(",").map((s) => s.trim()) };
}

describe("EXPORTS.md ↔ export registry sync", () => {
  for (const table of EXPORT_TABLE_NAMES) {
    test(`"${table}" column table matches the registry (names, types, ORDER)`, () => {
      const doc = parseDocTable(table);
      const reg = EXPORT_REGISTRY[table];
      expect(doc.columns).toEqual(reg.columns.map((c) => ({ name: c.name, type: c.type })));
      expect(doc.order).toEqual([...reg.orderBy]);
    });
  }

  test("the documented artifact inventory names every table exactly once", () => {
    for (const table of EXPORT_TABLE_NAMES) {
      expect(EXPORTS_MD).toContain(`\`${table}.csv\``);
    }
  });
});

// ---- prose claims (2026-08-02 decision batch) ------------------------------------------------
// The column/row-order sync above pins identifiers only, so it cannot detect PROSE drift — which
// is how two false absolutes survived in EXPORTS.md until the round that corrected them
// (ratification.json records both). These pin the corrected qualifiers: weakening either claim
// back toward its old absolute fails CI and forces a review-visible edit here. Matching is over
// whitespace-normalised text so an innocent re-wrap does not trip it; the WORDS are the pin.
const EXPORTS_PROSE = EXPORTS_MD.replace(/\s+/g, " ");

describe("EXPORTS.md prose claims ↔ code reality", () => {
  test("run_unit_head's coverage claim keeps its terminal-disposition qualifier and absence caveat", () => {
    // code reality: every TERMINAL disposition upserts a row (orchestrate.ts carries upsert
    // sites for policy-excluded, skipped-cutoff, past-cap and scanned), but the scan-error and
    // throttle-requeue arms exit through setUnitStatus BEFORE any upsert — so those branches
    // have no row, exactly as the caveat says
    expect(EXPORTS_PROSE).toContain("every branch that REACHED a terminal disposition");
    expect(EXPORTS_PROSE).toContain("A branch whose scan errored or was throttle-requeued before the row was written has none");
  });
  test("a rowless branch's section names BOTH counts that can hold it — errored AND deferred", () => {
    // The section already told a reader where a rowless ERRORED branch shows up (branchesErrored),
    // but said nothing about where a rowless THROTTLE-REQUEUED one does — leaving the deferred
    // remainder looking uncounted on the very surface that documents its absence from this table.
    expect(EXPORTS_PROSE).toContain("branchesErrored");
    expect(EXPORTS_PROSE).toContain("while its queue row stays pending the report's current-backlog `branchesDeferred` counts it");
  });
  test("the determinism claim keeps its starting-xray/ qualifier and the adoption sentence", () => {
    // code reality: ArtifactBundle.finalize folds adoptableEntries — still-present same-run
    // manifest entries of the OTHER kind — into manifest.json (artifactWrite.ts), so identical
    // database + identical arguments alone do NOT pin the manifest bytes
    expect(EXPORTS_PROSE).toContain("byte-identical artifacts, GIVEN an identical starting `xray/`");
    expect(EXPORTS_PROSE).toContain("The bundle adopts still-present manifest entries from other kinds of the SAME run");
  });
});

// ---- README recipes: extraction + identifier sync ------------------------------------------
// Recipe EXECUTION happens in CI via a SHA-pinned DuckDB CLI (spawning binaries from this
// codebase is confined to the audited gh/git/tar chokepoint by the repo-wide scan, so bun test
// never executes duckdb). What runs HERE is the drift protection: every table file a recipe
// reads must be a real export artifact, and every column-like identifier must exist in the
// referenced tables' registries — a renamed column fails this test, not the reader's query.

function extractRecipes(): { sql: string[]; sh: string[] } {
  const section = README.split(/^## Analyze the exports$/m)[1]?.split(/^## /m)[0];
  expect(section, 'README must have an "## Analyze the exports" section').toBeDefined();
  const sql = [...section!.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const sh = [...section!.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]!);
  return { sql, sh };
}

// SQL words the recipes may use that are NOT export columns. Additions here are deliberate
// review-visible decisions — keep it minimal.
const SQL_ALLOWLIST = new Set([
  "select", "from", "where", "and", "or", "not", "group", "by", "order", "limit", "as",
  "count", "distinct", "left", "join", "on", "is", "null", "desc", "asc",
  // recipe-local aliases (string literals and file paths are stripped before scanning, so
  // path/value words like output/xray/csv/cli never reach the check — keep this list tight):
  "usage_sites", "repo", "distinct_exports", "declarations", "s", "u", "branches",
]);

describe("README recipes ↔ export registry sync", () => {
  const { sql, sh } = extractRecipes();

  test("there are recipes to sync (the section is not empty)", () => {
    expect(sql.length).toBeGreaterThanOrEqual(4);
    expect(sh.length).toBeGreaterThanOrEqual(1);
  });

  test("every file a recipe reads is a real export artifact", () => {
    for (const recipe of [...sql, ...sh]) {
      for (const m of recipe.matchAll(/output\/xray\/([a-z_]+)\.(csv|jsonl)/g)) {
        expect(EXPORT_TABLE_NAMES).toContain(m[1]! as ExportTableName);
      }
    }
  });

  test("every column-like identifier in a SQL recipe exists in a referenced table's registry", () => {
    for (const recipe of sql) {
      const referenced = [...recipe.matchAll(/output\/xray\/([a-z_]+)\.csv/g)].map((m) => m[1]! as ExportTableName);
      expect(referenced.length).toBeGreaterThan(0);
      const known = new Set(referenced.flatMap((t) => EXPORT_REGISTRY[t].columns.map((c) => c.name)));
      const stripped = recipe
        .replace(/'[^']*'/g, " ") // string literals + quoted file paths
        .replace(/--[^\n]*/g, " "); // comments
      for (const m of stripped.matchAll(/\b([a-z][a-z0-9_]*)\b/g)) {
        const token = m[1]!;
        if (SQL_ALLOWLIST.has(token)) continue;
        expect(known.has(token), `recipe references unknown identifier "${token}"`).toBe(true);
      }
    }
  });

  test("the jq recipe only touches registry columns of the file it reads", () => {
    for (const recipe of sh) {
      const referenced = [...recipe.matchAll(/output\/xray\/([a-z_]+)\.jsonl/g)].map((m) => m[1]! as ExportTableName);
      const known = new Set(referenced.flatMap((t) => EXPORT_REGISTRY[t].columns.map((c) => c.name)));
      for (const m of recipe.matchAll(/\.([a-z][a-z0-9_]*)/g)) {
        const token = m[1]!;
        if (token === "jsonl" || token === "csv") continue; // file extensions in the path
        expect(known.has(token), `jq recipe references unknown field ".${token}"`).toBe(true);
      }
    }
  });
});
