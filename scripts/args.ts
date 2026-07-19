// args.ts — pure CLI-argument parsing for the two entrypoints (§8). No I/O: turns an argv array
// into a validated options object, failing fast with actionable messages on any malformed/unknown
// input. Entrypoint grammars (§8):
//   bun run scripts/orchestrate.ts [--config <path>] [--plan] [--fresh [--purge-cache]] \
//                                  [--rescan-branch <org>/<repo>@<branch>]...   # repeatable
//   bun run scripts/report.ts      [--config <path>] [--run-id <id>] [--html]
// `--help`/`-h` on either entrypoint wins over every other argument (even invalid ones), so a
// confused operator can always reach the help text.

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgsError";
  }
}
function fail(msg: string): never {
  throw new ArgsError(msg);
}

// Run ids are generated internally (randomUUID → hex + hyphens). A user-supplied run id (report's
// `--run-id`, export's `--run-id`, compare's two positionals) feeds a `run-<id>.json` path template
// in report.ts (export and compare instead bind it into DB lookups), so validate it against a
// conservative grammar with no path separators BEFORE it can reach a path or a query. This is defense in depth over
// writeFileAtomic's §0 containment: a value like `../../xray/manifest` is rejected here outright.
const RUN_ID_GRAMMAR = /^[A-Za-z0-9._-]+$/;
export function assertRunId(value: string): string {
  // The grammar already excludes path separators, so no traversal is possible; the `.`/`..` reject
  // is belt-and-suspenders against a run id that IS a path component.
  if (!RUN_ID_GRAMMAR.test(value) || value === "." || value === "..")
    throw new ArgsError(`invalid run id ${JSON.stringify(value)} — allowed characters are letters, digits, '.', '_', '-'`);
  return value;
}

// ---- usage / help text ------------------------------------------------------------------------
const CONFIG_PRECEDENCE = "Config path precedence: --config <path> > CONFIG_PATH env > ./config.json";

export const ORCHESTRATE_USAGE =
  "Usage: bun run scripts/orchestrate.ts [--config <path>] [--plan] [--fresh [--purge-cache]] [--rescan-branch <org>/<repo>@<branch>]... [--verbose-units] [--help]";

export const ORCHESTRATE_HELP = `package-audit — READ-ONLY npm-package-usage audit over GitHub orgs (gh CLI + Bun + SQLite)

${ORCHESTRATE_USAGE}

Flags:
  --config <path>     Config file to load. ${CONFIG_PRECEDENCE}
  --plan              Preview the scan scope and exit: validates config, runs preflight,
                      resolves the effective owner list, discovers repos + branches, and
                      prints what WOULD be scanned. Opens no database, writes nothing,
                      fetches no repo content, and fetches no registry packument/tarball.
  --fresh             Drop and recreate the run-scoped tables (runs, findings, errors,
                      work queue). PRESERVES the api_cache and package_api_surface caches.
  --purge-cache       Only valid with --fresh: ALSO drop the caches (the real full wipe).
  --rescan-branch <org>/<repo>@<branch>
                      Force one branch unit back to pending (repeatable).
  --verbose-units     Emit a per-unit skip-current/skip-cutoff line for every reused or
                      cutoff branch. Off by default (a per-repo repo-done rollup summarizes
                      them instead), so a resume of a large estate stays readable.
  --help, -h          Show this help and exit.

The audit writes <outputDir>/run-<run_id>.json and <outputDir>/latest.json when it completes;
a separate \`bun run report\` is only needed to re-emit a historical run (--run-id).`;

export const REPORT_USAGE = "Usage: bun run scripts/report.ts [--config <path>] [--run-id <id>] [--html] [--help]";

export const REPORT_HELP = `package-audit report — re-emit the consolidated §7 report from SQLite alone

${REPORT_USAGE}

Flags:
  --config <path>     Config file to load (for sqlitePath/outputDir). ${CONFIG_PRECEDENCE}
  --run-id <id>       Emit run-<id>.json for that historical run (never touches latest.json).
                      Default (no --run-id): the latest completed reportable run; also
                      overwrites latest.json.
  --html              ALSO render one self-contained HTML dossier per tracked package plus an
                      index.html into <outputDir>/xray/ (manifest-managed; stale dossiers from
                      removed packages are swept).
  --help, -h          Show this help and exit.

Note: \`bun run audit\` already emits the report when a run completes — this entrypoint exists
for re-emitting, especially historical runs.`;

// ---- orchestrate arguments ----------------------------------------------------------------
// A --rescan-branch target: a branch-scope work unit to force back to `pending` (§3).
export interface RescanTarget {
  organization: string;
  repository: string;
  branch: string;
}

export interface OrchestrateArgs {
  readonly configPath: string | null; // explicit --config; null → resolve via env/default in config.ts
  readonly plan: boolean; // preview scope, no DB / no writes (§8 --plan)
  readonly fresh: boolean;
  readonly purgeCache: boolean;
  readonly rescanBranches: readonly RescanTarget[]; // de-duplicated, order-stable
  readonly verboseUnits: boolean; // T8: emit per-unit skip-current/skip-cutoff lines (default: repo-done rollup)
  readonly help: boolean; // --help/-h seen anywhere: print help, do nothing else
}

// Parse a `<org>/<repo>@<branch>` rescan target (§3). Split at the FIRST '@' so a branch name
// containing '@' is preserved; the left side must be exactly `org/repo` (one '/', both non-empty)
// and the branch (everything after the first '@') must be non-empty. A bare branch name (no
// `org/repo@`) is rejected as ambiguous.
export function parseRescanTarget(spec: string): RescanTarget {
  const at = spec.indexOf("@");
  if (at <= 0 || at === spec.length - 1)
    fail(`--rescan-branch must be <org>/<repo>@<branch> (got '${spec}')`);
  const repoSpec = spec.slice(0, at);
  const branch = spec.slice(at + 1);
  const slash = repoSpec.indexOf("/");
  if (slash <= 0 || slash !== repoSpec.lastIndexOf("/") || slash === repoSpec.length - 1)
    fail(`--rescan-branch owner/repo must have exactly one '/' (got '${repoSpec}')`);
  return { organization: repoSpec.slice(0, slash), repository: repoSpec.slice(slash + 1), branch };
}

// `--help`/`-h` anywhere wins — checked BEFORE validation so a malformed command line can still
// reach the help text.
const isHelpFlag = (a: string): boolean => a === "--help" || a === "-h";

// A flag that consumes the following token as its value (or the `--flag=value` attached form).
const VALUE_FLAGS = new Set(["--config", "--rescan-branch"]);
const BOOL_FLAGS = new Set(["--fresh", "--purge-cache", "--plan", "--verbose-units"]);

// Normalize `--flag=value` into flag + attached value (shared by both parsers).
function splitFlag(arg: string): { flag: string; attached: string | null } {
  if (!arg.startsWith("--") || !arg.includes("=")) return { flag: arg, attached: null };
  return { flag: arg.slice(0, arg.indexOf("=")), attached: arg.slice(arg.indexOf("=") + 1) };
}

// A DETACHED value that looks like a flag is a missing value, not a value — `--config --fresh`
// must not silently swallow `--fresh` as the path. The attached `--flag=-x` form stays available
// for values that genuinely start with '-'.
function requireValue(flag: string, attached: string | null, next: string | undefined): string {
  const value = attached !== null ? attached : next;
  if (value === undefined || value === "" || (attached === null && value.startsWith("-")))
    fail(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv: string[]): OrchestrateArgs {
  if (argv.some(isHelpFlag)) return { configPath: null, plan: false, fresh: false, purgeCache: false, rescanBranches: [], verboseUnits: false, help: true };

  let configPath: string | null = null;
  let plan = false;
  let fresh = false;
  let purgeCache = false;
  let verboseUnits = false;
  const rescanBranches: RescanTarget[] = [];
  const seen = new Set<string>(); // dedup rescan targets by org\0repo\0branch

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const { flag, attached } = splitFlag(arg);

    if (BOOL_FLAGS.has(flag)) {
      if (attached !== null) fail(`${flag} takes no value`);
      if (flag === "--fresh") fresh = true;
      else if (flag === "--plan") plan = true;
      else if (flag === "--verbose-units") verboseUnits = true;
      else purgeCache = true;
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      const value = requireValue(flag, attached, argv[i + 1]);
      if (attached === null) i++;
      if (flag === "--config") {
        if (configPath !== null) fail("--config given more than once");
        configPath = value;
      } else {
        const target = parseRescanTarget(value);
        const key = `${target.organization}\0${target.repository}\0${target.branch}`;
        if (!seen.has(key)) {
          seen.add(key);
          rescanBranches.push(target);
        }
      }
      continue;
    }
    fail(`unknown argument '${arg}'`);
  }

  // --plan opens no database, so the DB/cache mutation flags are meaningless with it; reject the
  // combination rather than silently ignoring a requested mutation. Checked FIRST so
  // `--plan --purge-cache` names the actual conflict rather than the purge/fresh coupling.
  if (plan && (fresh || purgeCache || rescanBranches.length > 0))
    fail("--plan cannot be combined with --fresh, --purge-cache, or --rescan-branch (plan mode opens no database)");
  // --purge-cache only takes effect alongside --fresh (db.ts purges the caches only when fresh);
  // reject the misleading combination rather than silently ignoring it (§3 CLI flags).
  if (purgeCache && !fresh) fail("--purge-cache requires --fresh (it only purges caches during a --fresh rebuild)");

  return { configPath, plan, fresh, purgeCache, rescanBranches, verboseUnits, help: false };
}

// ---- report arguments -----------------------------------------------------------------------
export interface ReportArgs {
  readonly configPath: string | null; // explicit --config; null → resolve via env/default in config.ts
  readonly runId: string | null; // --run-id <id>; null → latest completed reportable run
  readonly html: boolean; // --html: ALSO render the per-package HTML dossiers + index into <outputDir>/xray/
  readonly help: boolean;
}

// Strict parser for report.ts (§7). Unknown flags are REJECTED — a silently-ignored typo (e.g.
// `--runid`) would fall through to the DEFAULT report and overwrite latest.json.
export function parseReportArgs(argv: string[]): ReportArgs {
  if (argv.some(isHelpFlag)) return { configPath: null, runId: null, html: false, help: true };

  let configPath: string | null = null;
  let runId: string | null = null;
  let html = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--html") {
      if (html) fail("--html given more than once");
      html = true;
      continue;
    }
    const { flag, attached } = splitFlag(arg);
    if (flag === "--html") fail("--html takes no value"); // --html=x arrives here via splitFlag
    if (flag !== "--config" && flag !== "--run-id") fail(`unknown argument '${arg}'`);
    const value = requireValue(flag, attached, argv[i + 1]);
    if (attached === null) i++;
    if (flag === "--config") {
      if (configPath !== null) fail("--config given more than once");
      configPath = value;
    } else {
      if (runId !== null) fail("--run-id given more than once");
      runId = assertRunId(value);
    }
  }
  return { configPath, runId, html, help: false };
}
