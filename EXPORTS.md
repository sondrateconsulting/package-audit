# EXPORTS.md — the data contract for `bun run export`

`export` writes run-scoped snapshots of the five audit tables as CSV **and** JSONL under
`<outputDir>/xray/`, plus a `manifest.json` written last. This document is the contract for
those files. It is **sync-tested against the code**: the column tables and row-order lines
below are parsed by `scripts/exportsDoc.test.ts` and compared to the column registry in
`scripts/export.ts`, so this document cannot silently drift from the writers.

## Scope: run-scoped snapshots (the default)

The default export is the **selected run's view of the world** — the same semantics as the
JSON report:

- Finding rows (`dependency_findings`, `usage_findings`) are joined through the run's own
  `run_unit_head` snapshot (a REPORTABLE head — `status IN ('scanned','reused')` — matching
  organization/repository/branch/commit_sha) and filtered to the run's tracked packages.
  Rows are **never** selected by `findings.run_id` — that column is last-writer bookkeeping,
  not run ownership.
- `package_api_surface` is sliced to the run's `versionsSeen` (the distinct, valid-semver
  resolved versions over the run's own dependency rows) for tracked packages, restricted to
  versions whose introspection **completed** (the same completion-marker rule the report
  applies), with the internal `__complete__` marker rows themselves excluded.
- `runs` contains exactly the selected run's row.

Run selection: `--run-id <id>`, or the latest completed reportable run by default.

## `--raw`: the forensic escape hatch

`--raw` dumps **every row of the five tables** — including introspection marker rows, rows from
other runs and other configs, and rows superseded by later scans. Filenames gain a `raw-`
prefix and the export emits a loud `warning` JSONL event. Raw dumps are for forensics; the
run-scoped default is the supported contract. **Stale data warning:** raw rows may span
multiple runs and configurations — never treat a raw dump as any single run's view.

## File inventory

| File | Contents |
|---|---|
| `dependency_findings.csv` / `.jsonl` | manifest/lockfile declarations of tracked packages |
| `usage_findings.csv` / `.jsonl` | usage sites (imports/requires/re-exports/CLI invocations) |
| `package_api_surface.csv` / `.jsonl` | introspected exports/bins per (package, version) |
| `run_unit_head.csv` / `.jsonl` | the run's per-branch disposition snapshot — one of nine dispositions per branch (scan-attempt: scanned / reused / deferred-throttle / deferred-network / deferred-service / error; discovery-time: skipped-cutoff / policy-excluded / past-cap) with its branch-policy attribution |
| `runs.csv` / `.jsonl` | the selected run's metadata row |
| `manifest.json` | `{formatVersion, runId, artifacts:[{path, kind, sha256, bytes}]}` — written **last**; artifacts in `xray/` not listed in a coherent manifest are swept by the next generation |

`xray/` holds ONE run's artifacts at a time: exports and dossiers of the **same** run coexist
(each command adopts the other's manifest entries), but generating either surface for a
*different* run sweeps the other surface's now-stale files. Re-run the other command with the
same `--run-id` to regenerate them — the database still has everything.

## Format rules

**CSV** (RFC 4180): header row of column names; `\r\n` row endings including a trailing one;
fields containing comma, double-quote, CR or LF are double-quoted with embedded quotes
doubled. **Formula-injection defense (OWASP):** a *string* cell is prefixed with a literal
apostrophe inside the field — so spreadsheet applications render it as text instead of executing
it — when its first byte is TAB or CR, **or** when its first *visible* character (after any leading
whitespace, which some importers trim before evaluating) is one of `=` `+` `-` `@`. A benign
leading-whitespace value whose first visible character is not a trigger (e.g. ` ^50.0.0`) is left
unchanged. Typed number cells are never prefixed
(a negative count is a sign, not a formula). `NULL` is the empty field. **Note for programmatic
consumers:** because scoped package names begin with `@`, their CSV cells carry this leading
apostrophe (`@scope/pkg` → `'@scope/pkg`) — a spreadsheet hides it, but an exact-match query or a
CSV↔JSONL join sees it. Use the **JSONL** export (below), whose values are byte-faithful, as the
source of truth for identifiers; treat the CSV as the spreadsheet-facing view.

**JSONL**: one JSON object per row per line; keys in the column order below; values
byte-faithful (no formula defense — JSONL consumers are not spreadsheets); SQL `NULL` is
JSON `null`; numbers are JSON numbers.

**Determinism**: identical database + identical arguments → byte-identical artifacts.
Row order is total (each table's full unique key) and documented per table below.

## Versioning

The manifest's `formatVersion` (currently 2) covers the artifact set, the manifest shape,
and the column contract below. Any breaking change to this contract bumps it; bumping it is
the one sanctioned way the golden fixtures change. (v2 added the `run_unit_head` table.)

## dependency_findings

One row per (unit, package, dependency key, dependency type, manifest path) — where a unit
is an (organization, repository, branch, commit) the run scanned.

| column | type |
|---|---|
| run_id | string |
| organization | string |
| repository | string |
| branch | string |
| commit_sha | string |
| date_fetched | string |
| package_name | string |
| dependency_key | string |
| dependency_type | string |
| manifest_path | string |
| manifest_line | number |
| manifest_permalink | string |
| declared_version | string |
| lockfile_path | nullable-string |
| lockfile_kind | nullable-string |
| lockfile_lines | nullable-string |
| lockfile_permalink | nullable-string |
| resolved_version | nullable-string |
| resolved_version_source | nullable-string |

Row order: `organization, repository, branch, commit_sha, package_name, dependency_key, dependency_type, manifest_path`

Notes: `run_id` is the last run that (re)wrote the row — provenance, not ownership.
`resolved_version_source` is `lockfile` or `range-resolved`; it and `resolved_version` may both
be null when no resolution was possible. `lockfile_lines` is a JSON array serialized as text.

## usage_findings

One row per usage site. `export_name` is empty for whole-module usage (namespace,
side-effect, whole-require, whole dynamic-import, re-export) and for CLI invocations;
`context` is set only for CLI usage (script name, Dockerfile stage, or file kind);
`dependency_key` is empty only for CLI invocations (imports always carry the resolving
manifest key).

| column | type |
|---|---|
| run_id | string |
| organization | string |
| repository | string |
| branch | string |
| commit_sha | string |
| package_name | string |
| dependency_key | string |
| usage_type | string |
| export_name | string |
| context | string |
| file_path | string |
| line_number | number |
| permalink | string |
| snippet | string |
| found_at | string |

Row order: `organization, repository, branch, commit_sha, package_name, dependency_key, usage_type, file_path, line_number, export_name, context`

## package_api_surface

The introspected published surface per (package, version). Global cache semantics: versions
appear because the selected run resolved them (default scope) — the same version's rows are
shared across runs.

| column | type |
|---|---|
| package_name | string |
| version | string |
| version_source | string |
| export_name | string |
| export_kind | string |
| source | string |
| introspected_at | string |

Row order: `package_name, version, export_kind, export_name`

## run_unit_head

One row per branch that reached a per-run DISPOSITION this run — the immutable per-run disposition
snapshot. Unlike the findings tables, this exports every disposition TYPE. There are NINE, in two families:

- **SCAN-ATTEMPT** dispositions, decided AT a known head and carrying the OBSERVED commit in `commit_sha`:
  `scanned` (freshly scanned), `reused` (skip-as-current — the stored head was live WHEN RECORDED, so its
  prior-run findings stand and JOIN into the report; like `scanned`, it may be preserved-stale after a later
  moved-head transient failure — see the retention note below), `deferred-throttle` / `deferred-network` / `deferred-service`
  (attempted but requeued — un-covered THIS run, finished on a later run), and `error` (a permanent scan
  failure — a terminal "covered-by-failure" result recorded at the commit that was attempted).
- **DISCOVERY-time** dispositions, decided BEFORE any scan and carrying `commit_sha=''`: `skipped-cutoff`,
  `policy-excluded`, `past-cap` — plus the branch-policy columns, which live largely on these rows.

A discovered branch has NO row here only when it reached NO disposition at all — e.g. its scan errored
before a row could be written (a `scope='scan'` entry in the report's `errors[]`), or its repo's discovery
failed. The report's `branchesErrored` counts BOTH the `error` heads AND those rowless scan errors (two
disjoint sets — an `error` head IS a row). Scoped to the selected run only (`--raw` dumps all runs).

On a **resumed** run (one interrupted and re-invoked, which reuses the same `run_id`), `branchesErrored`'s
ROWLESS component still diverges from "every branch whose scan errored" in **both** directions. `errors[]`
is append-only — its one reconciliation is the excluded-owner prune (an `excludeOrganizations` owner's rows
are dropped) — while the rows in *this* table **are** pruned for branches gone
since an earlier invocation — though only within a repo this run re-discovered and kept: the prune runs per
repo, so a repo that dropped out of the kept set entirely (deleted, renamed, newly archived/fork-filtered,
or displaced past `maxReposPerOrg`) is never revisited and keeps its prior rows.
So a branch that errored in an earlier invocation and reached no row-bearing disposition in the final one —
deleted, or its repo's discovery failed — is still counted via its append-only error while correctly holding
no row here. (A throttle-requeued retry is NOT such a case: it writes a `deferred-throttle` row, or the
findings-preservation guard keeps a prior scan's row — either way it holds a row here.) Conversely, a branch
that kept a row from an earlier invocation is counted by THAT row's disposition — an `error` head is itself
counted in `branchesErrored`, a `scanned` row under `branchesScanned` — never a second time via `errors[]`.

This table itself stays exact either way: every row is a disposition the run genuinely recorded. Note a
**scan-attempt** row may be pinned to an older head than the branch's current one (same-name stale head):
its `commit_sha` and `scanned_commit_date` name the commit that was actually attempted, which on a resumed
run may predate the live head. A resumed run whose re-scan of an advanced head hits a TRANSIENT failure
(error / deferral) keeps the branch's prior REPORTABLE scan (findings-preservation, §3.1a) rather than
demoting it — so a `scanned` row can describe an older evaluation of a branch whose live head has since
moved. (A prior NON-reportable row — `skipped-cutoff` / `policy-excluded` / `past-cap` — is instead
superseded by the moved-head observation, a genuine re-disposition.) (On a
DISCOVERY-time row — `skipped-cutoff` / `policy-excluded` / `past-cap` — `commit_sha` is `''` and
`scanned_commit_date` is the discovered-head date; a SCAN-ATTEMPT row carries the observed commit and its
date — see the column notes below.)

| column | type |
|---|---|
| run_id | string |
| organization | string |
| repository | string |
| branch | string |
| commit_sha | string |
| status | string |
| is_default_branch | nullable-number |
| policy_status | nullable-string |
| policy_matched_pattern | nullable-string |
| scanned_commit_date | nullable-string |

Row order: `run_id, organization, repository, branch`

Notes: `status` is one of the NINE dispositions above (SCAN-ATTEMPT: `scanned` / `reused` /
`deferred-throttle` / `deferred-network` / `deferred-service` / `error`; DISCOVERY-time: `skipped-cutoff` /
`policy-excluded` / `past-cap`). `WHERE status = 'policy-excluded'` is the whole filter for branch-policy
exclusions; `WHERE status IN ('scanned','reused')` is the findings-bearing (reportable) slice. `policy_status`
(`excluded-by-deny` / `excluded-by-allow` / null) names WHICH rule decided: always present on a
`policy-excluded` row, always null on `skipped-cutoff` / `past-cap` (policy is applied BEFORE
cutoff/cap, so those rows never carry a verdict), and on a SCAN-ATTEMPT row it marks a **default-branch
override** — the counterfactual verdict on a branch policy would have dropped but which is always
scan-attempted anyway because it is the default. That override is the reason `policy_status` is its own
column and not folded into `status`: the branch was scan-attempted, so it keeps its real disposition
(`scanned`/`reused` when the attempt completed, `deferred-*`/`error` when it did not), and the verdict is
advisory. (The report's scan-scope ledger labels the completed case `scanned-default-override` and the
un-completed case `attempted-default-override`; `defaultBranchPolicyOverrides` counts only the completed,
scanned overrides — a true subset of `branchesScanned`.)
`policy_matched_pattern` is the stored deny-attribution pattern (null otherwise). Writes verify it
matches `branch`; the read gate does not re-match it — report, compare, and JSONL export surface the
stored value on otherwise-sound pre-verifier or externally edited rows (a malformed row still fails the
read gate on shape; the default CSV export still applies its documented formula-injection defense),
without re-running version-sensitive glob matching — so the value is not read-time attested.
`scanned_commit_date` is the attempted commit's date on a SCAN-ATTEMPT row, the discovered-head date on a
DISCOVERY-time row (null only for pre-v4 migrated rows). `is_default_branch` is `1`/`0`/null: null means
UNKNOWN (pre-v3 migrated rows) — never read it as "not the default". A `1` row always carries a SCAN-ATTEMPT
status (the default is always scan-attempted); `past-cap` and `policy-excluded` rows are always `0`.

## runs

| column | type |
|---|---|
| run_id | string |
| started_at | string |
| completed_at | nullable-string |
| config_hash | string |
| effective_owners | string |
| owners_source | string |
| tracked_packages | string |
| cutoff_date | string |
| github_host | string |
| status | string |
| outcome | nullable-string |
| coverage_complete | nullable-number |
| discovery_failures | number |
| discovery_deferrals | number |

Row order: `run_id`

Notes: `effective_owners` and `tracked_packages` are JSON arrays serialized as text —
DuckDB reads them with `from_json(...)`, jq with `fromjson`.

`outcome` is the run's finalized disposition — `complete` (full estate coverage; the only
outcome a default report/export serves, alongside migrated `legacy-unknown`), a `partial-*`
variant (`partial-deferred`/`partial-degraded`/`partial-budget` — the run stopped early or
left units un-scanned), `fatal`, or `NULL` for a crashed, never-finalized run. `coverage_complete`
is `1` when this run covered the whole estate, `0` when a coverage gap remained — a discovery
failure/deferral left the denominator unknown, OR a unit-level deferral left a known branch un-scanned
(including a deferral preserved over a prior scan, which writes no deferred-* row) — `NULL` for migrated
pre-v5 runs. `discovery_failures`/`discovery_deferrals` count the discovery-level gaps specifically.

## Analyzing the exports

Ready-made DuckDB and jq recipes live in the README's "Analyze the exports" section. They
are executed **verbatim in CI** against a synthetic fixture export (via a SHA-pinned DuckDB
CLI), and a local test keeps their table/column identifiers in sync with the registry — a
renamed column fails the build, not your query. Local `bun test` does not execute DuckDB
itself: spawning external binaries from this codebase is confined to the audited `gh`/`git`/
`tar` chokepoint by a repo-wide guarantee, so recipe execution lives in CI.
