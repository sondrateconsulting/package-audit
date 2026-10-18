// tsCompilerApi.ts — the ONE import site of the TypeScript compiler API, with a load-time surface
// check. Both scanners use `typescript` as an IN-PROCESS SYNTACTIC parser (never a Program, never
// a typecheck, never execution): §5.F usageScanner parses with createSourceFile and walks with
// forEachChild; §5.E dtsExports parses with createSourceFile and iterates a source file's
// statements. Both read the SyntaxKind / ScriptKind / ScriptTarget enums. That makes the compiler
// API a RUNTIME dependency of the analysis path, not build tooling — the distinction this file
// exists to defend.
//
// Why the check exists. TypeScript 7 is the native (Go) port: its npm package's root entry exports
// only { version, versionMajorMinor }, and the JS compiler API is gone — the parser moved behind a
// native binary. Nothing it ships replaces the call this code makes: `typescript/unstable/ast` has
// the enums, the `is*` guards, a node factory and a scanner but NO parser (no createSourceFile, no
// forEachChild), and `typescript/unstable/sync` is a Project/Program API that proxies to the binary
// over IPC with remote node handles — not a string→AST call. Under such an install those two
// version strings are all that resolves and every COMPILER-API reference is `undefined`, so
// scanUsage's deliberate per-file fail-OPEN catch (one odd file must never fail a whole branch
// scan) would swallow the TypeError into "this file uses nothing" — a SILENT false negative in a
// tool whose entire job is finding usage. dtsExports would degrade the same way, into per-version
// errors rows.
//
// So the check runs at MODULE LOAD: upstream of that catch, upstream of any scan, and — since
// orchestrate.ts, the audit entrypoint, reaches both scanners through static imports
// (orchestrate → unitPipeline → usageScanner, orchestrate → apiSurface → dtsExports) — before
// main() does any work. A structurally absent parser kills the process immediately with an
// actionable message instead of producing a confident, empty audit. (report.ts, export.ts and
// compare.ts import neither scanner: the report path touches no npm package at all, so it is
// unaffected either way.)
//
// The throw happens during module evaluation, so it can NEVER reach cliErrors.renderFatal and
// keeps its stack; that is deliberate and the reason TsCompilerApiError is module-private rather
// than a registered operator-facing class (same posture as dtsExports' DtsLimitError — tests
// assert the fail-closed MESSAGE and the error NAME, never the class identity). A missing compiler
// API is a broken install, not an expected operator condition, and the message leads either way.
//
// Scope of the check: the load-bearing PRIMITIVES below. The FULL surface the scanners call (46
// `is*`/helper functions today) is pinned by tsCompilerApi.test.ts, which derives it from their
// source so it cannot drift — CI is where an incompatible `typescript` actually gets caught, and
// paying for a 46-member walk on every process start buys nothing over that.

import ts from "typescript";

// Module-private by design (see header): it is thrown before any CLI error rendering can exist.
class TsCompilerApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TsCompilerApiError";
  }
}

// The parse + traversal entry points. Absent these there is no syntactic scanning at all.
export const REQUIRED_COMPILER_FUNCTIONS = ["createSourceFile", "forEachChild"] as const;

// The enum objects both scanners branch on. Enums are runtime OBJECTS; the many `ts.Node`-style
// names the scanners also mention are types, erased at runtime, and are checked by tsc, not here.
export const REQUIRED_COMPILER_ENUMS = ["ScriptKind", "ScriptTarget", "SyntaxKind"] as const;

// Which required members `api` does not provide, in a stable order. Pure — takes the API object so
// tests can drive it with synthetic shapes (notably TypeScript 7's real `{ version,
// versionMajorMinor }`) without installing another TypeScript.
export function missingCompilerApi(api: unknown): string[] {
  if (typeof api !== "object" || api === null) return [...REQUIRED_COMPILER_FUNCTIONS, ...REQUIRED_COMPILER_ENUMS];
  const bag = api as Record<string, unknown>;
  const missing: string[] = [];
  for (const name of REQUIRED_COMPILER_FUNCTIONS) {
    if (typeof bag[name] !== "function") missing.push(name);
  }
  for (const name of REQUIRED_COMPILER_ENUMS) {
    const value = bag[name];
    if (typeof value !== "object" || value === null) missing.push(name);
  }
  return missing;
}

// Fail closed when the installed `typescript` is not the JS compiler API this repo parses with.
// The message carries the whole remediation: it is the only thing the operator sees.
export function assertCompilerApi(api: unknown): void {
  const missing = missingCompilerApi(api);
  if (missing.length === 0) return;
  const observed = typeof api === "object" && api !== null && typeof (api as { version?: unknown }).version === "string" ? ` ${(api as { version: string }).version}` : "";
  throw new TsCompilerApiError(
    `the installed typescript${observed} does not expose the compiler API this auditor parses with (missing: ${missing.join(", ")}). ` +
      `package-audit uses TypeScript IN-PROCESS as a syntactic parser (§5.E/§5.F); TypeScript 7 moved the parser into a native binary and its npm root entry exports only { version, versionMajorMinor }. ` +
      `Pin typescript to the 6.x line — package.json pins an exact version, bun.lock locks it, and CI installs with --frozen-lockfile.`,
  );
}

assertCompilerApi(ts);

export default ts;
