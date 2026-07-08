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
}

export function deriveTerms(t: CliTermSet): DerivedTerms {
  const scoped = t.name.startsWith("@");
  const bins = t.binNames.filter((b) => b !== ""); // an empty bin name would make bareTokenRegex match everywhere
  const runnerTerms = new Set<string>([t.name, ...bins]);
  const execAndBareTerms = new Set<string>([...(scoped ? [] : [t.name]), ...bins]);
  return { packageName: t.packageName, scoped, runnerTerms, execAndBareTerms };
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
  for (const bare of terms.execAndBareTerms) if (bareTokenRegex(bare).test(cmd)) return true;
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
  const derived = termSets.map(deriveTerms);
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

// Dockerfile: track `FROM … AS <stage>`; RUN/other lines carry `stage:<name>` (or stage:<index>).
function dockerfileUnits(lines: string[]): Unit[] {
  const units: Unit[] = [];
  let stage = "stage:0";
  let stageIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const fromMatch = /^\s*FROM\s+.*?\s+AS\s+([A-Za-z0-9_.-]+)/i.exec(raw);
    const bareFrom = /^\s*FROM\s+/i.test(raw);
    if (fromMatch) {
      stage = `stage:${fromMatch[1]}`;
      stageIndex++;
    } else if (bareFrom) {
      stage = `stage:${stageIndex}`;
      stageIndex++;
    }
    units.push({ cmd: raw, line: i + 1, context: stage });
  }
  return units;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
