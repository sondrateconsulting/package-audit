// dtsExports.ts — STATIC enumeration of a package's public export names from its .d.ts type
// surface (§5.E), using the TypeScript compiler API SYNTACTICALLY (createSourceFile + walk;
// never a full program, never execution). Relative `export * from './x'` re-exports are followed
// within the extracted package (capped) so a barrel .d.ts does not undercount. A resolver
// callback supplies file text for followed specifiers; external specifiers are never chased.

import ts from "typescript";

export type ExportKind = "named" | "default" | "type";

export interface DtsExport {
  name: string; // '' for a default export (export_name='' with kind 'default')
  kind: ExportKind;
}

// Resolve a RELATIVE module specifier (from `fromFile`) to its .d.ts source text, or null when
// it cannot be resolved / is external / exceeds the caller's caps. Pure — the caller owns fs.
export type DtsResolver = (specifier: string, fromFile: string) => string | null;

const MAX_FOLLOW_FILES = 200; // barrel-chain safety cap

interface WalkState {
  exports: Map<string, ExportKind>; // name → kind (dedup; a later 'type' does not downgrade 'named')
  resolver: DtsResolver;
  visited: Set<string>;
  filesFollowed: { n: number };
}

// Enumerate exports from a root .d.ts source. `rootPath` is the package-relative path used for
// re-export resolution and cycle detection.
export function enumerateDtsExports(rootSource: string, rootPath: string, resolver: DtsResolver): DtsExport[] {
  const state: WalkState = { exports: new Map(), resolver, visited: new Set(), filesFollowed: { n: 0 } };
  walkFile(rootSource, rootPath, state);
  return [...state.exports.entries()]
    .map(([name, kind]) => ({ name, kind }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function record(state: WalkState, name: string, kind: ExportKind): void {
  const existing = state.exports.get(name);
  // a value ('named'/'default') outranks a bare 'type' for the same name
  if (existing === undefined || (existing === "type" && kind !== "type")) state.exports.set(name, kind);
}

function walkFile(source: string, path: string, state: WalkState): void {
  if (state.visited.has(path)) return;
  state.visited.add(path);
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, /*setParentNodes*/ false, ts.ScriptKind.TS);
  for (const stmt of sf.statements) walkStatement(stmt, path, state);
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

function walkStatement(stmt: ts.Statement, path: string, state: WalkState): void {
  // `export { a, b as c }` / `export { t } from './m'` / `export * from './m'` / `export * as ns from './m'`
  if (ts.isExportDeclaration(stmt)) {
    const isTypeOnly = stmt.isTypeOnly;
    const moduleSpec = stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
    if (stmt.exportClause === undefined) {
      // `export * from './m'` — follow a RELATIVE specifier and hoist its named exports
      if (moduleSpec !== null && isRelative(moduleSpec)) followReexport(moduleSpec, path, state);
      return;
    }
    if (ts.isNamespaceExport(stmt.exportClause)) {
      // `export * as ns from './m'` — binds one name `ns`
      record(state, stmt.exportClause.name.text, isTypeOnly ? "type" : "named");
      return;
    }
    // NamedExports: `export { a, b as c }`. The EXPORTED name is el.name; `export { X as default }`
    // and `export { default } from './m'` both export the name "default" → a default surface.
    for (const el of stmt.exportClause.elements) {
      const name = el.name.text;
      if (name === "default") record(state, "", "default");
      else record(state, name, isTypeOnly || el.isTypeOnly ? "type" : "named");
    }
    return;
  }

  // `export = X` (CommonJS) and `export default X`
  if (ts.isExportAssignment(stmt)) {
    // export= has no distinct schema kind — record as the default surface (source notes it)
    record(state, "", "default");
    return;
  }

  // exported declarations: function/class/const/interface/type/enum with an `export` modifier
  if (hasExportModifier(stmt)) {
    if (hasDefaultModifier(stmt)) {
      record(state, "", "default");
      return;
    }
    const kind: ExportKind = isTypeOnlyDecl(stmt) ? "type" : "named";
    for (const name of declaredNames(stmt)) record(state, name, kind);
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

function followReexport(spec: string, fromFile: string, state: WalkState): void {
  if (state.filesFollowed.n >= MAX_FOLLOW_FILES) return;
  const resolved = state.resolver(spec, fromFile);
  if (resolved === null) return;
  state.filesFollowed.n++;
  const childPath = joinRelative(fromFile, spec);
  // `export * from './m'` re-exports m's NAMED and TYPE exports but NOT its default. Collect the
  // child's surface in an isolated exports map (sharing visited/resolver/counter for cycle and
  // cap tracking), then merge everything EXCEPT the default into the parent.
  const childState: WalkState = { exports: new Map(), resolver: state.resolver, visited: state.visited, filesFollowed: state.filesFollowed };
  walkFile(resolved, childPath, childState);
  for (const [name, kind] of childState.exports) {
    if (name === "") continue; // export-star does not carry the default
    record(state, name, kind);
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
