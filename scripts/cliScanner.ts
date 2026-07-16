// cliScanner.ts — CLI usage detection (§5.G). PURE: given ONE file's content + path + the tracked
// packages' CLI term sets, find command-line invocations of the package. TWO term sets: (1)
// SPECIFIER terms — always, no metadata: exactly {name}; runner invocations (npx/bunx/dlx/bun x)
// for any name, plus pnpm/yarn exec + BARE tokens for an UNSCOPED name only (a scoped package's
// unscoped tail is NEVER a specifier). (2) BIN terms — only when introspection yielded bin names:
// each bin as any runner form + exec + bare token. Bare matching uses punctuation-aware token
// boundaries (expo must NOT match export/expokit/./expo). Searches package.json#scripts, *.sh,
// .github/workflows/**, Makefiles, Dockerfiles. No network, no fs.

import { buildPermalink } from "./permalink.ts";
import { parseJsoncObject, escapePointer } from "./jsonc.ts";

export interface CliTermSet {
  packageName: string;
  name: string; // the config package specifier (scoped or not)
  binNames: string[]; // from introspection (§5.E); empty if none
}

export interface CliScanContext {
  githubHost: string;
  organization: string;
  repository: string;
  branch: string;
  commitSha: string;
  filePath: string;
}

export interface CliRow {
  packageName: string;
  context: string; // scripts.<name> | shell | stage:<name> | workflow | makefile
  filePath: string;
  lineNumber: number; // 1-based
  snippet: string;
  permalink: string;
}

// ---- term-set derivation (pure) -------------------------------------------------------------
interface DerivedTerms {
  packageName: string;
  scoped: boolean;
  runnerTerms: Set<string>; // dlx-family (npx/bunx/pnpm dlx/yarn dlx/bun x): {name} + bins
  execAndBareTerms: Set<string>; // pnpm/yarn exec + bare: unscoped {name} + bins
  bareMatchers: RegExp[]; // §5.G/§7: bareTokenRegex compiled ONCE per exec/bare term (see below)
}

export function deriveTerms(t: CliTermSet): DerivedTerms {
  const scoped = t.name.startsWith("@");
  const bins = t.binNames.filter((b) => b !== ""); // an empty bin name would make bareTokenRegex match everywhere
  const runnerTerms = new Set<string>([t.name, ...bins]);
  const execAndBareTerms = new Set<string>([...(scoped ? [] : [t.name]), ...bins]);
  // §7: PRECOMPILE the bare-token matchers once here instead of constructing a fresh RegExp per
  // bin per command-unit inside commandInvokes. Behaviour-identical — bareTokenRegex has no `/g`,
  // so `.test` is stateless and reusing the compiled RegExp cannot leak lastIndex across commands.
  // The hostile bin COUNT is bounded upstream by MAX_BIN_NAMES (apiSurface §7).
  const bareMatchers = [...execAndBareTerms].map(bareTokenRegex);
  return { packageName: t.packageName, scoped, runnerTerms, execAndBareTerms, bareMatchers };
}

// §7: derive each unit's term sets ONCE, not per scanned file. scanCli is called per FILE with the
// SAME termSets array reference for every file in a unit (unitPipeline.scanUnit), so caching on that
// reference hoists derivation to once-per-unit without changing the caller. A WeakMap keeps it
// GC-safe (no retained references once the unit's array is dropped).
const derivedCache = new WeakMap<CliTermSet[], DerivedTerms[]>();
function deriveAll(termSets: CliTermSet[]): DerivedTerms[] {
  let derived = derivedCache.get(termSets);
  if (derived === undefined) {
    derived = termSets.map(deriveTerms);
    derivedCache.set(termSets, derived);
  }
  return derived;
}

// A punctuation-aware BARE-token boundary (consult §5.G): a bare term must not substring-match
// export/expokit/./expo/expo-cli/scoped tails/paths. Both sides forbid identifier/path chars and
// '=' (so a flag/assignment VALUE like `--flag=expo` or `VAR=expo` is not an invocation).
function bareTokenRegex(term: string): RegExp {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$@./:=-])${esc}(?![A-Za-z0-9_$@/:.=-])`);
}

// Runner invocation prefixes. dlx-family accepts the full runner term set; exec-family accepts
// only the exec/bare term set (unscoped specifier + bins).
const DLX_RUNNERS = ["npx", "bunx", "pnpm dlx", "yarn dlx", "bun x"];
const EXEC_RUNNERS = ["pnpm exec", "yarn exec"];

// Strip a trailing `@version` from a runner package spec (`expo@latest`, `@scope/pkg@1.2` →
// `@scope/pkg`), scoped-safe (the leading @ of a scoped name is not a version separator).
function stripRunnerVersion(spec: string): string {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : spec;
}

// EVERY non-flag target token after a runner prefix in a command string — a compound command
// (`npx a && npx @scope/pkg build`) legitimately invokes the same runner twice, and a scoped
// specifier has NO bare-token fallback, so missing a later occurrence would silently drop it.
// The runner may follow any whitespace/separator DELIBERATELY: wrapper invocations (`sudo npx x`,
// `time npx x`, `xargs npx x`, `concurrently "npx x"`) must match; the cost is that a runner
// word quoted/echoed mid-command also matches — an accepted over-approximation for an auditor
// (the line still evidences a runner+package mention). The target and flag tokens STOP at shell
// operators `&|;` (not just whitespace): `npx a&&npx @scope/pkg` — with no spaces around `&&` —
// must still capture `@scope/pkg` from the SECOND runner, not swallow `a&&npx` into the first.
function runnerTargets(cmd: string, runner: string): string[] {
  const re = new RegExp(`(?:^|[\\s&|;])${runner.replace(/ /g, "\\s+")}\\s+((?:-[^\\s&|;]+\\s+)*)([^\\s&|;]+)`, "g");
  const targets: string[] = [];
  for (let m = re.exec(cmd); m !== null; m = re.exec(cmd)) targets.push(stripRunnerVersion(m[2]!));
  return targets;
}

// Does one command string invoke the package per §5.G's rules?
function commandInvokes(cmd: string, terms: DerivedTerms): boolean {
  for (const runner of DLX_RUNNERS) {
    if (runnerTargets(cmd, runner).some((t) => terms.runnerTerms.has(t))) return true;
  }
  for (const runner of EXEC_RUNNERS) {
    if (runnerTargets(cmd, runner).some((t) => terms.execAndBareTerms.has(t))) return true;
  }
  for (const re of terms.bareMatchers) if (re.test(cmd)) return true; // precompiled (§7)
  return false;
}

// ---- file-kind dispatch ---------------------------------------------------------------------
type FileKind = "package-json" | "shell" | "workflow" | "dockerfile" | "makefile" | "other";

export function classifyFile(path: string): FileKind {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === "package.json") return "package-json";
  if (base.endsWith(".sh") || base.endsWith(".bash")) return "shell";
  // `.github/workflows/**` per §5.G — recursive, even though github.com itself only honors
  // top-level workflow files (a nested yaml mentioning the package is still audit evidence).
  if (/(^|\/)\.github\/workflows\/.+\.(ya?ml)$/.test(path)) return "workflow";
  if (base === "Dockerfile" || base.endsWith(".Dockerfile") || base === "Containerfile") return "dockerfile";
  if (base === "Makefile" || base === "makefile" || base.endsWith(".mk")) return "makefile";
  return "other";
}

// A (command, line, context) unit to scan.
interface Unit {
  cmd: string;
  line: number; // 1-based
  context: string;
}

export function scanCli(content: string, ctx: CliScanContext, termSets: CliTermSet[]): CliRow[] {
  if (termSets.length === 0) return [];
  const kind = classifyFile(ctx.filePath);
  if (kind === "other") return [];
  const derived = deriveAll(termSets); // §7: once per unit (cached on the termSets reference)
  const lines = content.split("\n");

  let units: Unit[];
  switch (kind) {
    case "package-json": units = packageJsonUnits(content); break;
    case "shell": units = lineUnits(lines, "shell"); break;
    case "makefile": units = lineUnits(lines, "makefile"); break;
    case "dockerfile": units = dockerfileUnits(lines); break;
    case "workflow": units = lineUnits(lines, "workflow"); break;
  }

  const rows: CliRow[] = [];
  const seen = new Set<string>(); // dedup by (package, line, context)
  for (const unit of units) {
    for (const terms of derived) {
      if (!commandInvokes(unit.cmd, terms)) continue;
      const key = `${terms.packageName}\0${unit.line}\0${unit.context}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        packageName: terms.packageName,
        context: unit.context,
        filePath: ctx.filePath,
        lineNumber: unit.line,
        snippet: (lines[unit.line - 1] ?? "").trim().slice(0, 300),
        permalink: buildPermalink({
          githubHost: ctx.githubHost, org: ctx.organization, repo: ctx.repository,
          commitSha: ctx.commitSha, path: ctx.filePath, line: unit.line,
        }),
      });
    }
  }
  return rows.sort((a, b) => a.lineNumber - b.lineNumber || cmp(a.packageName, b.packageName) || cmp(a.context, b.context));
}

// package.json#scripts: each script value is a command; context scripts.<name>, line = key line.
function packageJsonUnits(content: string): Unit[] {
  let parsed: ReturnType<typeof parseJsoncObject>;
  try {
    parsed = parseJsoncObject(content);
  } catch {
    return [];
  }
  const scripts = parsed.value["scripts"];
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  const units: Unit[] = [];
  for (const [name, cmd] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof cmd !== "string") continue;
    const line = parsed.keyLines.get(`/scripts/${escapePointer(name)}`) ?? 0;
    if (line > 0) units.push({ cmd, line, context: `scripts.${name}` });
  }
  return units;
}

// Line-oriented files (shell, Makefile, workflow): one unit per line, context = the file kind
// (§5.G). Workflow scanning is line-based without YAML parsing — deterministic; a non-`run:`
// line that mentions a term still matches (accepted over-approximation, the line number pins it).
function lineUnits(lines: string[], contextKind: "shell" | "makefile" | "workflow"): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < lines.length; i++) {
    units.push({ cmd: lines[i]!, line: i + 1, context: contextKind });
  }
  return units;
}

// A stage name is a leading run of these chars WITHIN a single token — one char class, no
// overlapping quantifiers, so it stays linear even on a hostile token.
const STAGE_NAME_PREFIX = /^[A-Za-z0-9_.-]+/;
// ASCII-case-insensitive keyword tests. Deliberately regex (not `.toUpperCase() === "AS"`): JS's
// non-Unicode `/i` folds only ASCII, so `/^as$/i` rejects e.g. `aſ` (U+017F, whose toUpperCase is
// "S") — matching exactly what the old `…\s+AS\s+…/i` regex did.
const FROM_KEYWORD = /^from$/i;
const AS_KEYWORD = /^as$/i;

// The stage name of a `FROM <image> AS <name>` line, or null when the line is not a FROM…AS.
//
// Linear replacement for the old `/^\s*FROM\s+.*?\s+AS\s+([A-Za-z0-9_.-]+)/i`, whose overlapping
// `\s+ .*? \s+` quantifiers explored O(N³) partitions of a space run before failing (CWE-1333
// ReDoS — a single space-padded line hung the whole audit). Splitting on whitespace bounds the work
// to O(line length) and reproduces the old regex term for term:
//   • Search AS from index 2 — the old `\s+.*?\s+` forces ≥1 token between FROM and AS, so AS is
//     never token 0 (FROM) or token 1 (the image, or a leading flag like `--platform=…`). We do NOT
//     parse out flags; like the old regex we just take the first standalone case-insensitive
//     `as`/`AS` token from index 2 on. If the image is literally named `as`, BOTH old and new treat
//     it as the keyword (e.g. `FROM --platform=x as AS build` → `stage:AS`) — this is equivalence
//     with the old parser, not Docker-correctness.
//   • `/^as$/i` mirrors the old literal `AS` under `/i` (ASCII-only case folding, so e.g. `aſ` is
//     not `AS` — matching the old regex, unlike `.toUpperCase() === "AS"`).
//   • First AS with a valid following name wins → the old lazy `.*?`; an AS whose next token starts
//     with an invalid char is skipped → the old capture backtracking to a later AS.
//   • STAGE_NAME_PREFIX = the leading valid-char run of the next token → the old capture group.
// Differential-tested over 40k random inputs: the ONLY divergence is a malformed FROM with no image
// (the token right after FROM is itself `AS`), which never appears in a real Dockerfile.
function dockerfileStageName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const toks = trimmed.split(/\s+/);
  if (!FROM_KEYWORD.test(toks[0]!)) return null;
  for (let i = 2; i < toks.length - 1; i++) {
    if (!AS_KEYWORD.test(toks[i]!)) continue;
    const name = STAGE_NAME_PREFIX.exec(toks[i + 1]!);
    if (name) return name[0];
  }
  return null;
}

// Dockerfile: track `FROM … AS <stage>`; RUN/other lines carry `stage:<name>` (or stage:<index>).
function dockerfileUnits(lines: string[]): Unit[] {
  const units: Unit[] = [];
  let stage = "stage:0";
  let stageIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const stageName = dockerfileStageName(raw);
    if (stageName !== null) {
      stage = `stage:${stageName}`;
      stageIndex++;
    } else if (/^\s*FROM\s+/i.test(raw)) {
      // a bare `FROM <image>` (no `AS <name>`) — carry an index-based stage. This test is linear:
      // one `\s*` and one `\s+` with nothing overlapping after them.
      stage = `stage:${stageIndex}`;
      stageIndex++;
    }
    units.push({ cmd: raw, line: i + 1, context: stage });
  }
  return units;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
