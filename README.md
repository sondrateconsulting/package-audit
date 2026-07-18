# Package usage X-ray

*A dependency coupling report for your whole org.*

<!-- hero screenshot: flagship dossier (public-org data only) — captured in launch phase -->

package-audit is an operator-run instrument that measures org-wide coupling of the npm packages you track: which of a package's exports your repos actually import and use, where, at which lockfile-resolved (or explicitly range-resolved) versions — every finding pinned to a commit SHA with a clickable permalink. You run it to completion on your own machine (Bun + SQLite, driving the `gh` CLI, [read-only by construction](#trust-why-it-cannot-write-to-your-org)) and it ships the answer as a document: a deterministic JSON report today, with an editorial HTML dossier, CSV/JSONL exports, and run comparison landing in this release cycle — all backed by a durable local database. We couldn't find another operator-run instrument that measures per-export usage across an org's repositories and branches and hands back a commit-pinned evidence document — code search platforms can measure usage too, as queries and dashboards on running infrastructure, and dependency scanners tell you *that* you depend on something; this ships *how deeply* as a standalone document and dataset, with receipts.

## Quickstart

```sh
git clone https://github.com/sondrateconsulting/package-audit.git
cd package-audit
bun install   # required: `typescript` powers the .d.ts/source scanners at runtime; dev-only `@types/bun` + `zod` (report-schema tests)
```

1. **Edit [config.json](config.json)** — set the packages you track. Your editor validates it against [config.schema.json](config.schema.json) via the `$schema` key, and unknown keys are rejected at startup (close typos get a did-you-mean hint). One *owner*-scoping decision matters up front: `"organizations": null` (the default) is discovery mode — the tool enumerates *every* organization your gh token is a member of and scans all of them. Right for "audit everything I can see"; wrong for a client engagement run under a token with memberships outside the engagement. For engagements, set an explicit allowlist: `"organizations": ["client-org"]`. Branch scope is a separate lever — see [Branch policy](#branch-policy).

2. **Preview the scope** — resolves owners and discovers repos/branches, prints what *would* be scanned, and exits. Opens no database, writes nothing, fetches no file content:

```sh
bun run audit --plan
```

3. **Run the audit:**

```sh
bun run audit
```

The finished run writes `output/run-<run_id>.json` and `output/latest.json`. A long first run is normal for large orgs — interrupt it any time; the next invocation resumes where it left off and re-runs skip unchanged branches. `bun run report` exists to (re-)emit reports from the database: the default form refreshes `latest.json`, and `--run-id <id>` re-emits a historical run. The audit already emits the report itself. Both entrypoints take `--help`.

### HTML dossier (`report --html`)

`bun run report --html` additionally renders one self-contained HTML dossier per tracked package plus an `index.html` into `output/xray/`: an executive sentence, five decision cards, a usage-sorted API-surface table, a repo×export matrix, and collapsible permalinked evidence drawers (a package with no usage in the scanned slice renders a coverage-only empty state instead) — default-branch headline metrics (labeled all-branch fallback when attribution is unknown), printable, light + dark themes, no external resources. `--run-id <id>` renders a historical run's dossiers.
<!-- hero screenshot for the README is captured from the flagship dossier in the launch phase -->

### Data exports (`export`)

`bun run export` writes run-scoped CSV + JSONL snapshots of the five audit tables (plus a `manifest.json`) into `output/xray/` — the same run-selection and snapshot semantics as the report, portable into Sheets, Excel, DuckDB, and jq. `--run-id <id>` exports a historical run; `--raw` is a loudly-labeled full-table forensic dump. The column-by-column contract is [EXPORTS.md](EXPORTS.md) (sync-tested against the writers). See [Analyze the exports](#analyze-the-exports) below.

### Run comparison (`compare`)

`bun run compare <runA> <runB>` prints a deterministic run-diff as one JSON line: usage sites added and removed per export, repos entering and leaving — headline counts scoped to default branches when attribution is known (otherwise all branches, with an explicit note), plus all-branch detail, and a branch-policy churn dimension — branches that entered or left policy exclusion between the two runs, exclusions reclassified (deny/allow flipped or the stored matched pattern changed), and default-branch override changes — reported as unavailable (with the reason) when either run predates the policy-provenance schema or recorded no heads. Note: `--fresh` erases run history, so runs from before a `--fresh` cannot be compared; keep the data directory if you want trends.

## Prerequisites

Checked at startup with actionable errors (nothing here is silently assumed):

| Requirement | Why |
|---|---|
| [Bun](https://bun.sh) ≥ 1.1 (CI tests against 1.3.14) | runtime (`bun:sqlite`, shell, glob) |
| `gh` CLI, authenticated | GitHub API access (`gh auth status` must pass); oversized trees fall back to a hardened shallow `git clone` over HTTPS |
| git ≥ 2.45.1 | fallback shallow clones; older releases carry the May-2024 clone CVEs |
| `tar` (GNU or bsdtar) | registry tarball extraction |

### What the gh token needs

- **Repo read access** via a stock `gh auth login` — the tool reads repository content, branch listings, and commit metadata through `gh`; it exercises no write permission of any kind.
- Discovery mode needs the `read:org` scope. A stock `gh auth login` grants it; if missing: `gh auth refresh -h <githubHost> -s read:org`. (Scope evidence comes from classic-token headers; fine-grained tokens can't prove it, so for engagements prefer an explicit `organizations` allowlist over discovery.)
- **SAML/SSO orgs:** until the token is SSO-authorized (`gh auth refresh`), an org may 403 on content — or be silently *omitted from enumeration entirely*, under-reporting discovery. SSO failures are classified distinctly in the report's `errors` array with the remediation named.
- **Private registries:** per-package `registryAuthEnvVar` names an env var holding a bearer token. The token is sent only to that registry's origin, never logged, never cached, and never read from any scanned repo's `.npmrc`.
- GitHub Enterprise: set `githubHost`; every call runs through `GH_HOST` (API paths are never hand-built).

## Analyze the exports

The exports are a data layer, not just files. Every recipe below runs **verbatim** from the
repo root after a `bun run export` — and CI executes them against a synthetic fixture with a
pinned DuckDB, with an identifier sync-test tying them to the export column registry, so
they can't silently rot.

Top exports by usage sites:

```sql
SELECT export_name, COUNT(*) AS usage_sites
FROM 'output/xray/usage_findings.csv'
WHERE usage_type <> 'cli' AND export_name <> ''
GROUP BY export_name
ORDER BY usage_sites DESC, export_name
LIMIT 10;
```

Most-coupled repositories (distinct exports × usage sites):

```sql
SELECT organization || '/' || repository AS repo,
       COUNT(DISTINCT export_name) AS distinct_exports,
       COUNT(*) AS usage_sites
FROM 'output/xray/usage_findings.csv'
WHERE export_name <> ''
GROUP BY repo
ORDER BY usage_sites DESC, repo
LIMIT 10;
```

Resolved versions across the estate:

```sql
SELECT resolved_version, COUNT(*) AS declarations
FROM 'output/xray/dependency_findings.csv'
WHERE resolved_version IS NOT NULL AND resolved_version_source IS NOT NULL
GROUP BY resolved_version
ORDER BY declarations DESC, resolved_version;
```

Branches excluded by branch policy, by disposition and matched pattern (grouped on the CSV-exported
value — a formula-shaped `policy_matched_pattern` is apostrophe-prefixed there; use the JSONL export
for the byte-faithful value):

```sql
SELECT policy_status, policy_matched_pattern, COUNT(*) AS branches
FROM 'output/xray/run_unit_head.csv'
WHERE status = 'policy-excluded'
GROUP BY policy_status, policy_matched_pattern
ORDER BY policy_status, policy_matched_pattern;
```

Published exports nobody imports (per the scanned slice):

```sql
SELECT s.export_name
FROM 'output/xray/package_api_surface.csv' s
LEFT JOIN 'output/xray/usage_findings.csv' u
  ON u.export_name = s.export_name AND u.package_name = s.package_name
WHERE u.export_name IS NULL AND s.export_kind <> 'cli-bin'
GROUP BY s.export_name
ORDER BY s.export_name;
```

Usage-type breakdown with jq:

```sh
jq -s 'group_by(.usage_type) | map({usage_type: .[0].usage_type, sites: length})' output/xray/usage_findings.jsonl
```

## Configuration

Every field is documented in [config.schema.json](config.schema.json) (your editor shows the descriptions inline). Unknown keys are **rejected at startup** — close typos get a did-you-mean hint — so a typo can never silently widen or narrow the scan. Config file precedence: `--config <path>` > `CONFIG_PATH` env var > `./config.json`.

### Branch policy

`branches` (allowlist) and `excludeBranches` (denylist) select branches by name — exact strings or Bun globs, case-sensitive, never regex. `*` does not cross `/` but `**` does, so `release/**` catches `release/v2/rc1` and `release/*` does not. A leading `!` is rejected (no negation). Both are root-level — `concurrency.branches` is an unrelated setting that merely shares the word.

Precedence:

1. **A repository's default branch is always eligible** — exempt from both lists, and from `cutoffDate` and `maxBranchesPerRepo`. A default a rule *would* have dropped is scanned anyway, and the report records that counterfactual verdict.
2. **Deny beats allow** — for every other branch.

`branches` is tri-state: omitted or `null` is unrestricted (deny still applies); `[]` leaves only default branches; a non-empty list restricts eligibility to matches. `excludeBranches` omitted, `null`, or `[]` all mean no deny rules. Eligible is not scanned: surviving non-defaults still face the cutoff and the cap.

Policy is applied **before** cutoff and cap, so a denied recent branch never consumes a cap slot an allowed older branch could have used — and it is recorded as `policy-excluded`, never as a cutoff skip.

```json
{
  "branches": null,
  "excludeBranches": ["release/**"]
}
```

Every non-default branch stays eligible except `release/…` at any depth — but a repository whose *default* is `release/2.x` is still scanned.

Configuring a policy changes `config_hash`, so the next audit starts a fresh run rather than resuming; the old hash's queue rows survive and are reused if you change back. Not every edit counts: the lists are canonicalized, so reordering or duplicating entries changes nothing, and a policy-free spelling hashes the same either way (`excludeBranches: []` and `null` are identical; `branches: []` is a configured policy and does differ from `null`). Preview with `bun run audit --plan`. It also prints advisory warnings: two for a rule that is doing nothing (a pattern that matched no discovered branch; a deny pattern whose only matches were default branches), and one for `branches: []`, which is the opposite — a rule doing a great deal, since it drops every non-default branch.

### Repository policy

`excludeRepositories` is a **deny-only** list that drops whole repositories by their `owner/repo` full name — exact strings or Bun globs, never regex. `acme/*` drops one org, `*/legacy-*` drops a family across every org, and `acme/legacy-api` drops one repo. As with branch globs, `*` does not cross `/` but `**` does: `["*"]` matches nothing (every full name has a `/`), while `["**"]` matches everything. A leading `!` or empty entry is rejected at startup. There is no repository allowlist — the counterpart to `organizations` at the repo grain is deferred.

Two deliberate differences from `excludeBranches`, both because GitHub repository identity is not git branch identity:

- **Matching is case-INSENSITIVE** (an ASCII fold: `A`–`Z` only). `acme/Legacy-API` and `acme/legacy-api` are the same repo, unlike the case-sensitive `excludeBranches`. The fold is intentionally ASCII-only, so a non-ASCII name is compared byte-for-byte rather than through Unicode case rules a self-hosted host might not share.
- **There is no dead-pattern warning.** `excludeBranches` warns when a pattern matches nothing; `excludeRepositories` does not (the warning's original purpose — catching case typos — is already handled by case-insensitivity). Confirm a pattern caught the repos you meant with `bun run audit --plan`, which lists every excluded `owner/repo` and a `repositoriesExcluded` count.

Denial is applied to the **raw** discovered list, **before** archived/fork filtering and the `maxReposPerOrg` cap — so a denied repository never consumes a cap slot an eligible one could have used (the repo-grain analog of branch policy running before the cap).

```json
{
  "excludeRepositories": ["*/legacy-*", "acme/generated-monorepo"]
}
```

Like branch policy, a non-empty `excludeRepositories` changes `config_hash` (a policy-free config keeps its pre-feature hash and resumes cleanly); the list is canonicalized, so reordering, duplicating, or case-only edits change nothing.

### Concurrency

The optional `concurrency` block sets three fan-out widths (all default when omitted; each capped at 64):

| Key | Default | What it bounds |
|-----|---------|----------------|
| `organizations` | 3 | Owners processed concurrently. |
| `branches` | 4 | Branch-units scanned concurrently **per repo** (repos within an owner stay sequential). |
| `repositories` | 8 | **Global** in-flight cap on `gh`/`git`/`tar` subprocesses. |

`repositories` is the network-politeness governor, **not** a repo-loop parallelism degree despite its name: no matter how `organizations × branches` compose, at most `repositories` subprocesses ever run at once. So the two fan-out knobs govern how much work is *dispatched*, while `repositories` bounds the actual `gh`/`git`/`tar` subprocess concurrency (an immutable, SHA-pinned cache hit is served with no subprocess, so it consumes no slot; a conditional revalidation still spends one on its `304` round-trip). npm-registry fetches use their own request timeout and run outside this cap. Higher values speed up large estates; `organizations: 1, branches: 1` reproduces a fully sequential run — one owner, one branch-unit at a time, and a fatal stops dispatching further units at once. `--plan` traversal is always sequential regardless of these widths.

Tuning `concurrency` never changes `config_hash` — it is excluded from the hash, so raising or lowering these knobs between runs never orphans resumable work. (`concurrency.branches` is unrelated to the root-level `branches` allow/deny list above; they merely share the word.)

## Reading a run

**stdout is pure JSONL during audit and plan runs** — one structured event per line, safe to pipe. Vocabulary: `config`, `concurrency` (the configured fan-out widths — `organizations`, `branches`, `repositories`; emitted for both audit and `--plan`, though `--plan` traversal is sequential; see [Concurrency](#concurrency)), `preflight`, `owners`, `run`, `rescan-branch`, `cli-terms`, `plan`, `plan-excluded` (a `--plan`-only, per-owner list of the `owner/repo` names dropped by the `excludeRepositories` denylist — emitted only when that owner had exclusions, so a developer can confirm each pattern caught the repositories it meant; the aggregate `repositoriesExcluded` count rides on `plan-summary`), `plan-summary`, `unit` (actions `scanned`, `skip-current`, `skip-cutoff`, `skip-policy`, `past-cap`, `error`, `requeue-throttle`), `reconciliation` (actions `prune-stale` — a repo-scoped line emitted when a resume prunes `run_unit_head` rows for branches deleted since a prior invocation, so a re-discovered repo's rows reflect its live branch set; the prune runs per repo, so a repo that is itself no longer discovered or kept this run — deleted, renamed, newly archived/fork-filtered, or displaced past `maxReposPerOrg` — is never revisited and keeps its prior rows — and `prune-excluded-owner` — a run-scoped line (with `prunedHeads`/`prunedErrors` counts) emitted when a resume drops an owner's `run_unit_head` AND `errors` rows because `excludeOrganizations` now excludes it case-insensitively but did not before a prior invocation, so a resumed run never reports an excluded owner in its findings, dispositions, or errors), `discovery`, `introspection`, `warning` (a `reason` names the trigger — `fresh-dropped-completed-runs` when `--fresh` drops completed runs, `temp-sweep-failed` when the startup temp-dir sweep can't list or reclaim a stale clone directory, `clone-cleanup-failed` when a per-unit clone-fallback temp dir can't be reclaimed after the scan), `policy-warning` (advisory branch-policy notices — kinds `unmatched-pattern` for a configured `branches`/`excludeBranches` pattern that matched no branch discovered this run, `default-only-deny` for an `excludeBranches` pattern whose only matches were default branches (which are always scanned, so it excluded nothing) — both rules doing nothing — and `empty-allowlist`, the opposite: `branches: []` drops every non-default branch), `owner-discovery-throttled`, `done`. When GitHub rate-limiting persists past the retry budget, throttled work is **deferred, not failed**: a `unit` or `discovery` line carries `action` `requeue-throttle`, and an `owner-discovery-throttled` event carries `action` `retry-next-run` — the affected units are finished on the next run (a resumed run skips already-scanned units).

The presentation commands emit their own events: `report --html` writes one `dossier` line per package (`observations: emitted|omitted` makes the fallback visible) plus a `dossier-summary`; `export` writes one `export` line per artifact plus an `export-summary` (and a `warning` under `--raw`). Note `output/xray/` holds one run's artifacts at a time — regenerating either surface for a different run sweeps the other's stale files (re-run it with the same `--run-id`; the database keeps everything).

**Mid-run `"action":"error"`, `"event":"discovery"`, and `"event":"introspection"` lines are fail-soft**: the failure (a branch scan, a repo/branch listing for one owner, or a registry packument/tarball/bin-discovery step for one package version) is recorded in the report's `errors` array and the run continues — one unreachable repo or registry hiccup never kills an org-wide audit. Org-scoped `discovery` lines (a whole owner's repo listing failed) carry no `repo` field; branch-scoped ones do. `introspection` lines are package-scoped (`packageName`, plus `version` when the failure is version-specific). The human-readable end-of-run summary prints to **stderr**.

## Report anatomy

`output/latest.json` / `output/run-<id>.json` — the shape's authoritative, field-by-field reference is the Zod schema in [scripts/reportSchema.ts](scripts/reportSchema.ts) (fields carry inline descriptions; schema-validation tests cover emitted reports). The semantics people trip on:

- `versionsSeen` lists only valid-semver resolved versions; non-registry specs (`git+`, `file:`, `workspace:`…) are excluded and logged as package-scoped skips in `errors` on the run that first scans them.
- `apiSurface` keys are a **subset** of `versionsSeen`: only versions introspected to completion appear. For a **completed** run, a version missing from `apiSurface` has a recorded introspection *failure* (see `errors`) — never silently absent data (the same-commit `--rescan-branch` caveat below is the one exception: a rescan that adds a version records its introspection outcome on the rescan run). (A `--run-id` report of a still-running or failed run can be legitimately partial.) Surface enumeration is declaration-backed: a package that ships no resolvable type declarations can genuinely introspect to a small or empty surface.
- `usageByRepo` is the **union** of dependency-declaration and usage units — a CLI-only package with no manifest declaration still appears.
- `report --run-id <id>` pins each unit to the commit that run scanned (findings join through a per-run head snapshot), so later runs advancing branch heads never change it. One caveat: a forced same-commit `--rescan-branch` can add or refresh the shared finding rows that older run ids read through — newly detected findings, plus updated row details (timestamps, snippets).
- Reports are deterministic and byte-reproducible: same database, same run, same bytes.

## Exactly one runtime dependency

The audit path has exactly one runtime npm dependency: `typescript` — the scanner parses target code with the TS compiler API. The report path imports zero npm packages (the export/dossier surfaces are built to the same rule). And the tool never invokes a package manager at runtime: registry tarballs arrive via plain `fetch` and are only parsed statically, so nothing in a scanned repo or fetched package can run a lifecycle script. `bun install` fetches that one dependency plus dev tooling (`@types/bun`; `zod`, which backs the report-schema tests) — and that is the last time a package manager runs.

## Trust: why it cannot write to your org

This tool is built to be pointed at organizations you don't own. The guarantees, and where to verify each one:

1. **Argv-array allowlist on every shell-out** ([scripts/readOnlyGuard.ts](scripts/readOnlyGuard.ts)): every `gh`/`git`/`tar` invocation is checked as an argv *array* (no substring tricks). `gh api` with a non-GET method throws; body flags throw on REST endpoints. GraphQL is the one deliberate body exception: the guard requires an inline `query=` string it can statically verify is a read — mutations/subscriptions are rejected, and `--input` / `query=@file` bodies it cannot inspect are refused. (GraphQL *variable* values are not inspected; variables cannot change the operation type, which comes only from the verified `query=` text.) git mutations and config/exec injection options, and tar's create/append/command-execution options, all throw before anything spawns.
2. **Single chokepoint, grep-enforced**: a repo-wide test fails if any file other than the wrapper reaches a spawn surface in its source text — a dotted, optional-chained, or whitespaced `Bun.spawn`/`spawnSync`/`$`; any `"bun"`-module import (quote or backtick); `Bun` aliased, parenthesized, bracket-indexed, or reached via `globalThis.Bun`; `child_process` in any form; or a dynamic import whose specifier is a bare variable/expression or is built with `+`/`${}` ([scripts/github.test.ts](scripts/github.test.ts), "single chokepoint"). It is a best-effort textual tripwire, **not** a semantic proof: it catches the common direct routes but not deliberately evasive ones — a token split across comments, a module name assembled by other means (`.concat`, char codes), or the `Bun` global routed through several intermediate bindings — which are the domain of code review, not this grep. The load-bearing read-only guarantee is guarantee 1 (the argv allowlist, which validates every invocation that goes *through* the wrapper); this tripwire's job is to keep every spawn inside that wrapper by failing the common bypasses in CI.
3. **Blanket package-manager ban**: `npm`/`npx`/`yarn`/`pnpm`/`bunx`/`bun x` are never spawned in any form, so no dependency lifecycle script can ever execute. Registry tarballs arrive via plain `fetch` and are only parsed statically.
4. **Write containment**: every write is realpath-checked into `./data`, `./output`, or a `pkg-audit-*` temp dir — including anything a failure leaves behind, so nothing ever lands outside those roots. Clones are shallow, hardened (`--template=`, no submodules, prompt-disabled), and short-lived: a scanned unit's clone dir is reclaimed as soon as its scan finishes (success or failure), and a *failed* clone's dir and the per-process git-credential config are reclaimed by the next full audit run's startup sweep (`--plan` neither creates nor sweeps temp files). Reclamation is **best-effort**: a per-unit cleanup or a startup sweep that can't remove a dir emits a `warning` (`clone-cleanup-failed` / `temp-sweep-failed`) instead of failing silently — but containment is not best-effort. Everything written stays inside the roots above, so a stranded temp dir is at worst disk to reclaim on a later run, never an escape.
5. **Registry hygiene**: tarball URLs must match the configured registry origin; redirects are followed manually with per-hop origin re-verification (auth headers can't leak cross-origin); tarballs are integrity-verified (SRI/shasum) *before* extraction; archive entries are validated (no symlinks/hardlinks/absolute paths/`..`/bombs) and the extracted tree is re-swept.
6. **See for yourself**: `bun run audit --plan` exercises auth, discovery, and scoping while writing nothing at all.

The full engineering spec — every guarantee above in normative detail — is [PROMPT.md](PROMPT.md).

## FAQ

### Why not Sourcegraph?

If you already run Sourcegraph, its code search genuinely can measure org-wide usage; it is excellent at query-time exploration — ad-hoc "who uses this?" questions are its home turf — and Code Insights can chart usage over time on persistent dashboards. The difference is the shape of the answer: this is a run-to-completion operator instrument that produces a deterministic, permalinked evidence document plus portable data exports, with no server to operate and no licensing footprint. You run it, you keep a document and a dataset; nothing has to stay up for the answer to stay useful.

### Isn't this what Snyk or Dependabot does?

Different question. Security scanners alert on vulnerable or outdated dependencies — whether you should upgrade, and how urgently. This measures how deeply you're coupled to a package's API surface: which of its exports your repos actually import and use, and where. That's the question you're left holding after the alert fires, when someone asks what the migration actually costs.

### How is this different from knip or depcheck?

Those are single-repo hygiene tools: they find unused dependencies and dead exports so you can clean up one project's `package.json`, and they're good at it. This is org-wide and evidence-producing — it scans every repo and branch in scope (your configured cutoff and caps define that scope; archived repos and forks are excluded by default) and attributes usage sites to specific exports where the import syntax names one, each with a commit-pinned permalink you can hand to someone else.

### How is this different from cdxgen or other SBOM tools?

SBOMs are machine-oriented inventory: they answer "is it in the dependency tree" for compliance and vulnerability pipelines, and that's the right shape for those consumers — cdxgen can even attach occurrence evidence to components. This produces a leadership-readable coupling document with per-export usage evidence — closer to the report you'd bring to a migration or vendor decision than to a manifest you'd feed a scanner.

### What about reachability-analysis platforms (Endor Labs, Snyk reachability)?

They validate the same premise — that usage-level truth matters more than manifest-level truth — and they go deeper in their lane: function-level reachability with visible call paths. But that analysis lives inside enterprise vulnerability-prioritization platforms, in service of ranking CVEs. This is a standalone, operator-run, document-producing instrument: no platform to adopt, and the output is the coupling evidence itself rather than a vulnerability-prioritization signal.

### Does it trace function calls?

No. It records import/require/re-export/CLI usage sites — import-level granularity, attributed to a specific export when the syntax names one (namespace, side-effect, re-export, and whole-module usage are recorded at package level). It does not build a call graph, so it can't tell you whether an imported function is invoked on a hot path or merely imported. Call-graph analysis is on the roadmap.

## Contributing

Issues and discussion welcome. PRs by invitation while the 1.x surface stabilizes — open an issue first. Bug reports, holes in the read-only reasoning, and wrong claims in this README are the most valuable things you can file.

## License

Apache-2.0 — see [LICENSE](LICENSE). Copyright 2026 Sondrate Consulting.

## Data, upgrades & privacy

Everything runs locally. Findings live in a local SQLite database (`data/audit.db`) and reports in `output/`; nothing is uploaded anywhere — the only network traffic is read-only GitHub access (through `gh`, plus hardened shallow `git clone` fallbacks for oversized trees) and registry fetches for the packages you track.

- **`data/audit.db` is the durable source of truth.** Weekly re-runs are cheap: unchanged branches are skipped outright; commit-pinned file reads are served from cache with zero network.
- **Know what the database retains:** the API cache stores response bodies — *including the commit-pinned file contents fetched from scanned repos* (manifests, lockfiles, source files). Treat `audit.db` with the same sensitivity as the source it scanned.
- `--fresh` drops runs/findings/queue for a clean rescan but **preserves** the two expensive caches (`api_cache`, `package_api_surface`). `--fresh --purge-cache` is the real full wipe of the live tables — a *logical* wipe, not forensic erasure: prior `output/run-*.json` files stay until you delete them, and SQLite reclaims pages without scrubbing.
- Changing a package's `registryUrl`? Use `--fresh --purge-cache` (or a separate data directory) — the introspection cache is keyed by name+version, not registry origin.
- `--rescan-branch <org>/<repo>@<branch>` (repeatable) overrides skip-current for that branch on the next (otherwise normal) audit — other eligible work still runs.
- **Upgrades are safe:** pulling a new version migrates the database automatically inside a transaction (`PRAGMA user_version`), preserving all reportable data and caches. No manual migration steps, ever.
