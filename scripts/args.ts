// args.ts — pure CLI-argument parsing for orchestrate.ts (§8). No I/O: turns an argv array into
// a validated options object, failing fast with actionable messages on any malformed/unknown
// input. Entrypoint grammar (§8):
//   bun run scripts/orchestrate.ts [--config <path>] [--fresh] [--purge-cache] \
//                                  [--rescan-branch <org>/<repo>@<branch>]...   # repeatable

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgsError";
  }
}
function fail(msg: string): never {
  throw new ArgsError(msg);
}

// A --rescan-branch target: a branch-scope work unit to force back to `pending` (§3).
export interface RescanTarget {
  organization: string;
  repository: string;
  branch: string;
}

export interface OrchestrateArgs {
  configPath: string | null; // explicit --config; null → resolve via env/default in config.ts
  fresh: boolean;
  purgeCache: boolean;
  rescanBranches: RescanTarget[]; // de-duplicated, order-stable
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

// A flag that consumes the following token as its value (or the `--flag=value` attached form).
const VALUE_FLAGS = new Set(["--config", "--rescan-branch"]);
const BOOL_FLAGS = new Set(["--fresh", "--purge-cache"]);

export function parseArgs(argv: string[]): OrchestrateArgs {
  let configPath: string | null = null;
  let fresh = false;
  let purgeCache = false;
  const rescanBranches: RescanTarget[] = [];
  const seen = new Set<string>(); // dedup rescan targets by org\0repo\0branch

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // normalize `--flag=value` into flag + value
    let flag = arg;
    let attached: string | null = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      flag = arg.slice(0, arg.indexOf("="));
      attached = arg.slice(arg.indexOf("=") + 1);
    }

    if (BOOL_FLAGS.has(flag)) {
      if (attached !== null) fail(`${flag} takes no value`);
      if (flag === "--fresh") fresh = true;
      else purgeCache = true;
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      const value = attached !== null ? attached : argv[++i];
      if (value === undefined || value === "") fail(`${flag} requires a value`);
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

  // --purge-cache only takes effect alongside --fresh (db.ts purges the caches only when fresh);
  // reject the misleading combination rather than silently ignoring it (§3 CLI flags).
  if (purgeCache && !fresh) fail("--purge-cache requires --fresh (it only purges caches during a --fresh rebuild)");

  return { configPath, fresh, purgeCache, rescanBranches };
}
