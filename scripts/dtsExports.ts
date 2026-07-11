// dtsExports.ts — STATIC enumeration of a package's public export names from its .d.ts type
// surface (§5.E), using the TypeScript compiler API SYNTACTICALLY (createSourceFile + walk;
// never a full program, never execution). Relative `export * from './x'` re-exports are followed
// within the extracted package (BOUNDED, fail-closed) so a barrel .d.ts does not undercount. A
// resolver callback supplies file text AND the CANONICAL path of the file it opened for followed
// specifiers; external specifiers are never chased.
//
// §7 resource bounds (hostile-metadata amplification): parse work is MULTI-DIMENSIONALLY bounded —
// a per-file byte cap checked BEFORE createSourceFile (never allocate a giant AST), a global
// parse-COUNT cap, and a global cumulative parsed-BYTES budget, all charged BEFORE the parse. A
// CANONICAL-path memo guarantees a file reached via any subpath OR any re-export barrel is parsed
// at most once. A per-file export cap and a re-export FOLLOW cap round out the fail-closed set.
// Every overflow THROWS (DtsLimitError → introspectVersion's catch → errors row, no marker) — none
// silently truncates.

import ts from "typescript";

export type ExportKind = "named" | "default" | "type";

export interface DtsExport {
  name: string; // '' for a default export (export_name='' with kind 'default')
  kind: ExportKind;
}

// A followed re-export resolves to BOTH the .d.ts source text AND the CANONICAL package-relative
// path of the file actually OPENED (segment-collapsed / realpath) — the caller resolves subsequent
// relative specifiers against THIS path, not the requested specifier, closing the wrong-directory
// bug (`./dir → dir/index.d.ts → ./secret` must resolve `dir/secret.d.ts`, not root `./secret`).
export interface DtsResolved {
  text: string;
  canonicalPath: string;
}

// Resolve a RELATIVE module specifier (from `fromFile`) to its opened .d.ts, or null when it
// cannot be resolved / is external / exceeds the caller's caps. Pure — the caller owns fs.
export type DtsResolver = (specifier: string, fromFile: string) => DtsResolved | null;

// Fail-closed cap breach for the .d.ts surface (parse budgets, per-file export cap, follow cap).
// Propagates uncaught into introspectVersion's catch → version-keyed errors row, NO marker. Kept
// MODULE-PRIVATE by design: it is an internal signal always caught within the introspection
// subsystem (never rendered at the CLI), so it is deliberately NOT one of cliErrors' exported
// operator-facing error classes. Tests assert the fail-closed MESSAGE, not the class.
class DtsLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DtsLimitError";
  }
}

// Default bounds (all INJECTABLE via a ParseBudget so tests set tiny caps deterministically without
// building 256MiB inputs). Generous relative to real packages; any breach fails closed.
export const MAX_FOLLOW_FILES = 200; // distinct re-export edges followed across the whole surface
export const MAX_EXPORTS_PER_FILE = 65_536; // named/type/default entries a single .d.ts may declare
export const MAX_PARSE_FILE_BYTES = 8 * 1024 * 1024; // per-file cap checked BEFORE createSourceFile
export const MAX_PARSE_FILES = 4096; // global parse COUNT across all subpaths + followed barrels
export const MAX_TOTAL_PARSE_BYTES = 256 * 1024 * 1024; // global cumulative parsed-bytes budget

// The three parse budgets + follow/per-file caps + the canonical memo, threaded as ONE shared
// object through inspectExtracted AND the re-export follower so barrels charge against the same
// counters. Counters mutate in place; the memo caches each file's FULL surface (incl. its default)
// keyed on canonical path — a re-parse is never charged and never re-runs createSourceFile.
export interface ParseBudget {
  maxParseFileBytes: number;
  maxParseFiles: number;
  maxTotalParseBytes: number;
  maxFollowFiles: number;
  maxExportsPerFile: number;
  filesParsed: number;
  totalBytes: number;
  filesFollowed: number;
  memo: Map<string, Map<string, ExportKind>>; // canonicalPath → full surface (name → kind)
}

export interface ParseBudgetOptions {
  maxParseFileBytes?: number;
  maxParseFiles?: number;
  maxTotalParseBytes?: number;
  maxFollowFiles?: number;
  maxExportsPerFile?: number;
}

export function createParseBudget(o: ParseBudgetOptions = {}): ParseBudget {
  return {
    maxParseFileBytes: o.maxParseFileBytes ?? MAX_PARSE_FILE_BYTES,
    maxParseFiles: o.maxParseFiles ?? MAX_PARSE_FILES,
    maxTotalParseBytes: o.maxTotalParseBytes ?? MAX_TOTAL_PARSE_BYTES,
    maxFollowFiles: o.maxFollowFiles ?? MAX_FOLLOW_FILES,
    maxExportsPerFile: o.maxExportsPerFile ?? MAX_EXPORTS_PER_FILE,
    filesParsed: 0,
    totalBytes: 0,
    filesFollowed: 0,
    memo: new Map(),
  };
}

// Enumerate exports from a root .d.ts source. `rootPath` MUST be the CANONICAL package-relative
// path (segment-collapsed) — it is the memo key that dedupes this file against any subpath alias or
// re-export barrel. An optional shared `budget` threads the parse counters/memo across many roots
// (all of a package's subpaths); when omitted a fresh default-capped budget is used.
export function enumerateDtsExports(
  rootSource: string,
  rootPath: string,
  resolver: DtsResolver,
  budget: ParseBudget = createParseBudget(),
): DtsExport[] {
  const surface = parseAndWalk(rootPath, rootSource, resolver, budget);
  return [...surface.entries()]
    .map(([name, kind]) => ({ name, kind }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Parse (once, memoized on canonical path) and walk a single .d.ts, returning its FULL surface
// (name → kind, INCLUDING the default at name=''). All three parse budgets are enforced BEFORE
// createSourceFile allocates the AST. The (empty) result map is inserted into the memo BEFORE the
// walk so a re-export cycle sees the in-progress map and terminates.
function parseAndWalk(canonicalPath: string, source: string, resolver: DtsResolver, budget: ParseBudget): Map<string, ExportKind> {
  const cached = budget.memo.get(canonicalPath);
  if (cached !== undefined) return cached;

  // (1) per-file byte cap — checked BEFORE createSourceFile so an oversized file never allocates.
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > budget.maxParseFileBytes)
    throw new DtsLimitError(`.d.ts file exceeds ${budget.maxParseFileBytes} bytes (${canonicalPath})`);
  // (2) global parse-COUNT cap — charged once per actual parse (millions of tiny parses fail here).
  if (budget.filesParsed + 1 > budget.maxParseFiles)
    throw new DtsLimitError(`parsed .d.ts files exceed ${budget.maxParseFiles}`);
  // (3) global cumulative parsed-BYTES budget — the aliasing/barrel backstop the memo can't dedupe.
  if (budget.totalBytes + bytes > budget.maxTotalParseBytes)
    throw new DtsLimitError(`total parsed .d.ts bytes exceed ${budget.maxTotalParseBytes}`);
  budget.filesParsed += 1;
  budget.totalBytes += bytes;

  const exportsMap = new Map<string, ExportKind>();
  budget.memo.set(canonicalPath, exportsMap); // memoize BEFORE walking (cycle-safe)
  const sf = ts.createSourceFile(canonicalPath, source, ts.ScriptTarget.Latest, /*setParentNodes*/ false, ts.ScriptKind.TS);
  for (const stmt of sf.statements) walkStatement(stmt, canonicalPath, exportsMap, resolver, budget);
  return exportsMap;
}

function record(exportsMap: Map<string, ExportKind>, name: string, kind: ExportKind, budget: ParseBudget): void {
  const existing = exportsMap.get(name);
  if (existing === undefined) {
    // per-file export cap (§C): a hostile .d.ts must not amplify into unbounded rows.
    if (exportsMap.size >= budget.maxExportsPerFile)
      throw new DtsLimitError(`.d.ts exports exceed ${budget.maxExportsPerFile} in one file`);
    exportsMap.set(name, kind);
  } else if (existing === "type" && kind !== "type") {
    // a value ('named'/'default') outranks a bare 'type' for the same name
    exportsMap.set(name, kind);
  }
}

function isTypeOnlyDecl(stmt: ts.Node): boolean {
  return ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt);
}

function hasExportModifier(stmt: ts.Node): boolean {
  return ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}
function hasDefaultModifier(stmt: ts.Node): boolean {
  return ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function walkStatement(stmt: ts.Statement, path: string, exportsMap: Map<string, ExportKind>, resolver: DtsResolver, budget: ParseBudget): void {
  // `export { a, b as c }` / `export { t } from './m'` / `export * from './m'` / `export * as ns from './m'`
  if (ts.isExportDeclaration(stmt)) {
    const isTypeOnly = stmt.isTypeOnly;
    const moduleSpec = stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
    if (stmt.exportClause === undefined) {
      // `export * from './m'` — follow a RELATIVE specifier and hoist its named exports
      if (moduleSpec !== null && isRelative(moduleSpec)) followReexport(moduleSpec, path, exportsMap, resolver, budget);
      return;
    }
    if (ts.isNamespaceExport(stmt.exportClause)) {
      // `export * as ns from './m'` — binds one name `ns`
      record(exportsMap, stmt.exportClause.name.text, isTypeOnly ? "type" : "named", budget);
      return;
    }
    // NamedExports: `export { a, b as c }`. The EXPORTED name is el.name; `export { X as default }`
    // and `export { default } from './m'` both export the name "default" → a default surface.
    for (const el of stmt.exportClause.elements) {
      const name = el.name.text;
      if (name === "default") record(exportsMap, "", "default", budget);
      else record(exportsMap, name, isTypeOnly || el.isTypeOnly ? "type" : "named", budget);
    }
    return;
  }

  // `export = X` (CommonJS) and `export default X`
  if (ts.isExportAssignment(stmt)) {
    // export= has no distinct schema kind — record as the default surface (source notes it)
    record(exportsMap, "", "default", budget);
    return;
  }

  // exported declarations: function/class/const/interface/type/enum with an `export` modifier
  if (hasExportModifier(stmt)) {
    if (hasDefaultModifier(stmt)) {
      record(exportsMap, "", "default", budget);
      return;
    }
    const kind: ExportKind = isTypeOnlyDecl(stmt) ? "type" : "named";
    for (const name of declaredNames(stmt)) record(exportsMap, name, kind, budget);
  }
}

function declaredNames(stmt: ts.Statement): string[] {
  if (ts.isVariableStatement(stmt)) {
    const out: string[] = [];
    for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push(d.name.text);
    return out;
  }
  if (
    (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt) || ts.isModuleDeclaration(stmt)) &&
    stmt.name !== undefined && ts.isIdentifier(stmt.name)
  ) {
    return [stmt.name.text];
  }
  return [];
}

function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

function followReexport(spec: string, fromFile: string, parentExports: Map<string, ExportKind>, resolver: DtsResolver, budget: ParseBudget): void {
  // §D1: hitting the follow limit THROWS (fail-closed) — the old code silently stopped, so a
  // 201-file barrel chain still earned a marker on a truncated surface. Checked BEFORE resolving so
  // an unresolvable specifier (external / missing) does not consume the budget.
  if (budget.filesFollowed >= budget.maxFollowFiles)
    throw new DtsLimitError(`re-export follow limit ${budget.maxFollowFiles} exceeded`);
  const resolved = resolver(spec, fromFile);
  if (resolved === null) return;
  budget.filesFollowed += 1;
  // §D2: walk the resolved child keyed on the CANONICAL path of the file OPENED, so its own nested
  // relative re-exports resolve against THAT directory (not the requested specifier's).
  const childSurface = parseAndWalk(resolved.canonicalPath, resolved.text, resolver, budget);
  // `export * from './m'` re-exports m's NAMED and TYPE exports but NOT its default.
  for (const [name, kind] of childSurface) {
    if (name === "") continue; // export-star does not carry the default
    record(parentExports, name, kind, budget);
  }
}

// Join a relative module specifier against the importing file's path, collapsing '.'/'..'.
export function joinRelative(fromFile: string, spec: string): string {
  const baseDir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const parts = (baseDir === "" ? [] : baseDir.split("/")).concat(spec.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}
