# package-audit

READ-ONLY npm-package-usage auditor over GitHub organizations, built on the `gh` CLI, Bun, and SQLite.

It answers one question with evidence: **where, how, and at which versions are the npm packages you track actually used across every org your account can see?** For each tracked package it finds manifest declarations (including npm aliases, overrides, and resolutions), lockfile-resolved versions, import/require usage attributed to specific exports, CLI invocations in scripts/workflows/Dockerfiles, and the package's own published API surface — every finding pinned to a commit SHA with a clickable permalink.

What sets it apart from `gh search code` or the GitHub dependency graph: it scans **branches with commits since your cutoff date (newest N per repo), not just the default branch**, resolves declared ranges to concrete versions through the actual lockfile (npm, yarn, pnpm, bun), detects aliased installs, and is fully resumable — re-runs skip every branch whose head hasn't moved.

## Prerequisites

Checked at startup with actionable errors (nothing here is silently assumed):

| Requirement | Why |
|---|---|
| [Bun](https://bun.sh) ≥ 1.1 | runtime (`bun:sqlite`, shell, glob) |
| `gh` CLI, authenticated | all GitHub access (`gh auth status` must pass) |
| git ≥ 2.45.1 | fallback shallow clones; older releases carry the May-2024 clone CVEs |
| `tar` (GNU or bsdtar) | registry tarball extraction |

## Install

```sh
git clone git@github.com:sondrateconsulting/package-audit.git
cd package-audit
bun install   # required: `typescript` powers the .d.ts/source scanners at runtime; `zod` backs the report schema
```

## Quickstart

1. **Edit [config.json](config.json)** — set the packages you track and, for engagements, an explicit `organizations` allowlist (see [Scoping your scan](#scoping-your-scan)). Your editor validates it against [config.schema.json](config.schema.json) via the `$schema` key.

2. **Preview the scope** — resolves owners and discovers repos/branches, prints what *would* be scanned, and exits. Opens no database, writes nothing, fetches no file content:

```sh
bun run audit --plan
```

3. **Run the audit:**

```sh
bun run audit
```

The finished run writes `output/run-<run_id>.json` and `output/latest.json`. A long first run is normal for large orgs — interrupt it any time; the next invocation resumes where it left off and re-runs skip unchanged branches. `bun run report` exists only to re-emit reports (notably historical ones via `--run-id <id>`); the audit already emits the report itself.

Both entrypoints take `--help`.

## Scoping your scan

**`"organizations": null` (the default) is discovery mode: the tool enumerates *every* organization your gh token is a member of and scans all of them.** That is the right default for "audit everything I can see" — and the wrong one for a client engagement run under a token with memberships outside the engagement.

- Set an explicit allowlist: `"organizations": ["client-org"]`
- Subtract noise: `"excludeOrganizations": [...]` (applies in both modes)
- Personal repos are **off** by default: `"includePersonalNamespace": true` opts in
- Forks and archived repos are **off** by default (`includeForks`, `includeArchived`)
- `bun run audit --plan` shows the exact owner list and branch counts before anything is scanned

Branch coverage, precisely: branches whose latest commit is on/after `cutoffDate`, newest-first, capped at `maxBranchesPerRepo` per repo. Pre-cutoff branches are recorded as skipped; branches past the cap are not surfaced in that run. It is deliberately *not* "all branches ever".

## Configuration

Every field is documented in [config.schema.json](config.schema.json) (your editor shows the descriptions inline). Unknown keys are **rejected at startup** with a did-you-mean hint — a typo can never silently widen or narrow the scan. Config file precedence: `--config <path>` > `CONFIG_PATH` env var > `./config.json`.

### Authentication

- Discovery mode needs the `read:org` scope. A stock `gh auth login` grants it; if missing: `gh auth refresh -h <githubHost> -s read:org`.
- **SAML/SSO orgs:** until the token is SSO-authorized (`gh auth refresh`), an org may 403 on content — or be silently *omitted from enumeration entirely*, under-reporting discovery. SSO failures are classified distinctly in the report's `errors` array with the remediation named.
- **Private registries:** per-package `registryAuthEnvVar` names an env var holding a bearer token. The token is sent only to that registry's origin, never logged, never cached, and never read from any scanned repo's `.npmrc`.
- GitHub Enterprise: set `githubHost`; every call runs through `GH_HOST` (API paths are never hand-built).

## Reading a run

**stdout is pure JSONL** — one structured event per line, safe to pipe. Vocabulary: `config`, `preflight`, `owners`, `run`, `rescan-branch`, `cli-terms`, `plan`, `plan-summary`, `unit` (actions `scanned`, `skip-current`, `skip-cutoff`, `error`), `discovery`, `done`.

**Mid-run `"action":"error"` and `"event":"discovery"` lines are fail-soft**: the failure (a branch scan, or a repo/branch listing for one owner) is recorded in the report's `errors` array and the run continues — one unreachable repo never kills an org-wide audit. Org-scoped `discovery` lines (a whole owner's repo listing failed) carry no `repo` field; branch-scoped ones do. The human-readable end-of-run summary prints to **stderr**.

## Report anatomy

`output/latest.json` / `output/run-<id>.json` — the shape's authoritative, field-by-field reference is the Zod schema in [scripts/reportSchema.ts](scripts/reportSchema.ts) (every field carries a description; tests validate every emitted report against it). The semantics people trip on:

- `versionsSeen` lists only valid-semver resolved versions; non-registry specs (`git+`, `file:`, `workspace:`…) are excluded and logged as package-scoped skips in `errors`.
- `apiSurface` keys are a **subset** of `versionsSeen`: only versions introspected to completion appear. A version missing from `apiSurface` is a recorded introspection *failure* (see `errors`), never silently absent data.
- `usageByRepo` is the **union** of dependency-declaration and usage units — a CLI-only package with no manifest declaration still appears.
- `report --run-id <id>` reconstructs the world exactly as of that run (findings join through an immutable per-run snapshot), even after later runs advance branch heads.
- Reports are deterministic and byte-reproducible: same database, same run, same bytes.

## Data & upgrades

- **`data/audit.db` is the durable source of truth.** Weekly re-runs are cheap: unchanged branches are skipped outright; commit-pinned file reads are served from cache with zero network.
- **Know what the database retains:** the API cache stores response bodies — *including the commit-pinned file contents fetched from scanned repos* (manifests, lockfiles, source files). Treat `audit.db` with the same sensitivity as the source it scanned.
- `--fresh` drops runs/findings/queue for a clean rescan but **preserves** the two expensive caches (`api_cache`, `package_api_surface`). `--fresh --purge-cache` is the real full wipe.
- `--rescan-branch <org>/<repo>@<branch>` (repeatable) forces one branch to rescan without touching anything else.
- **Upgrades are safe:** pulling a new version migrates the database automatically inside a transaction (`PRAGMA user_version`), preserving all reportable data and caches. No manual migration steps, ever.

## Trust: why it cannot write to your org

This tool is built to be pointed at organizations you don't own. The guarantees, and where to verify each one:

1. **Argv-array allowlist on every shell-out** ([scripts/readOnlyGuard.ts](scripts/readOnlyGuard.ts)): every `gh`/`git`/`tar` invocation is checked as an argv *array* (no substring tricks). `gh api` with a non-GET method throws; body flags throw on REST endpoints. GraphQL is the one deliberate body exception: the guard requires an inline `query=` string it can statically verify is a read — mutations/subscriptions are rejected, and `--input` / `query=@file` bodies it cannot inspect are refused. (GraphQL *variable* values are not inspected; variables cannot change the operation type, which comes only from the verified `query=` text.) git mutations and config/exec injection options, and tar's create/append/command-execution options, all throw before anything spawns.
2. **Single chokepoint, grep-enforced**: a test asserts no file other than the wrapper spawns those binaries — no code path can route around the guard ([scripts/github.test.ts](scripts/github.test.ts), "single chokepoint").
3. **Blanket package-manager ban**: `npm`/`npx`/`yarn`/`pnpm`/`bunx`/`bun x` are never spawned in any form, so no dependency lifecycle script can ever execute. Registry tarballs arrive via plain `fetch` and are only parsed statically.
4. **Write containment**: every write is realpath-checked into `./data`, `./output`, or a `pkg-audit-*` temp dir — including anything a failure leaves behind, so nothing ever lands outside those roots. Clones are shallow, hardened (`--template=`, no submodules, prompt-disabled), and short-lived: a scanned unit's clone dir is removed as soon as its scan finishes (success or failure); a *failed* clone's dir and the per-process git-credential config persist only until the next full audit run's startup sweep (`--plan` neither creates nor sweeps temp files).
5. **Registry hygiene**: tarball URLs must match the configured registry origin; redirects are followed manually with per-hop origin re-verification (auth headers can't leak cross-origin); tarballs are integrity-verified (SRI/shasum) *before* extraction; archive entries are validated (no symlinks/hardlinks/absolute paths/`..`/bombs) and the extracted tree is re-swept.
6. **See for yourself**: `bun run audit --plan` exercises auth, discovery, and scoping while writing nothing at all.

The full engineering spec — every guarantee above in normative detail — is [PROMPT.md](PROMPT.md).
