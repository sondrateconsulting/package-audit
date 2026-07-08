// usageScanner.ts — in-repo API usage detection (§5.F). PURE: given ONE source file's content +
// the tracked packages' install-name sets resolved from the file's OWNING manifest (§5.F, the
// orchestrator computes this via manifest.resolveOwningManifest), enumerate import/require/usage
// occurrences and attribute each to the resolving dependency_key. Uses the TypeScript compiler
// SYNTACTICALLY (createSourceFile + walk; never a Program/typecheck/execution) — Bun.Transpiler
// is too coarse (no binding names / line numbers / form). No network, no fs.

import ts from "typescript";
import { buildPermalink } from "./permalink.ts";
import type { UsageType } from "./db.ts";

export interface TrackedPackage {
  packageName: string; // the canonical registry name
  installNames: Set<string>; // the dependency KEYS in the OWNING manifest that resolve to it (§5.F)
}

export interface UsageScanContext {
  githubHost: string;
  organization: string;
  repository: string;
  branch: string;
  commitSha: string;
  filePath: string;
}

export interface UsageRow {
  packageName: string;
  dependencyKey: string; // the matched install name (§5.F: never '' for an import)
  usageType: UsageType;
  exportName: string; // 'default' | a named binding | '' (namespace/side-effect/reexport/dynamic/whole-require)
  filePath: string;
  lineNumber: number; // 1-based
  snippet: string;
  permalink: string;
}

const scriptKindFor = (path: string): ts.ScriptKind => {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".mts") || path.endsWith(".cts") || path.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS; // .js/.mjs/.cjs and anything else
};

// Match a module specifier to a tracked package via its install-name set: an EXACT install name
// (root import) or a `<installName>/…` subpath. Prefer the LONGEST matching install name so
// `foo` does not shadow `foo-bar`. Returns the attribution or null.
export function matchSpecifier(specifier: string, packages: TrackedPackage[]): { packageName: string; dependencyKey: string } | null {
  let best: { packageName: string; dependencyKey: string; len: number } | null = null;
  for (const pkg of packages) {
    for (const name of pkg.installNames) {
      if (specifier === name || specifier.startsWith(`${name}/`)) {
        if (best === null || name.length > best.len) best = { packageName: pkg.packageName, dependencyKey: name, len: name.length };
      }
    }
  }
  return best === null ? null : { packageName: best.packageName, dependencyKey: best.dependencyKey };
}

// Enumerate §5.F usage findings for one source file. Fails OPEN — never throws: a file the
// scanner cannot process (unbuildable permalink path, parser blow-up) yields NO rows, so one odd
// file never fails the branch scan. (TS itself is error-TOLERANT: a file with syntax errors
// still parses to a best-effort AST and its recognizable imports are still reported.)
export function scanUsage(content: string, ctx: UsageScanContext, packages: TrackedPackage[]): UsageRow[] {
  if (packages.length === 0 || packages.every((p) => p.installNames.size === 0)) return [];
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(ctx.filePath, content, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKindFor(ctx.filePath));
  } catch {
    return [];
  }
  // Snippets are sliced via the SAME line map TS reports positions in (getLineStarts), so exotic
  // terminators (lone \r, U+2028/U+2029) cannot desync line_number from snippet.
  const lineStarts = sf.getLineStarts();
  const rows: UsageRow[] = [];

  const emit = (node: ts.Node, usageType: UsageType, packageName: string, dependencyKey: string, exportName: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1; // 1-based
    const start = lineStarts[line - 1] ?? 0;
    const end = line < lineStarts.length ? lineStarts[line]! : content.length;
    const snippet = content.slice(start, end).trim();
    rows.push({
      packageName, dependencyKey, usageType, exportName,
      filePath: ctx.filePath, lineNumber: line, snippet,
      permalink: buildPermalink({
        githubHost: ctx.githubHost, org: ctx.organization, repo: ctx.repository,
        commitSha: ctx.commitSha, path: ctx.filePath, line,
      }),
    });
  };

  const stringLiteralText = (node: ts.Expression | undefined): string | null =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

  const walk = (node: ts.Node): void => {
    // static `import ... from 'spec'`
    if (ts.isImportDeclaration(node)) {
      const spec = stringLiteralText(node.moduleSpecifier);
      const m = spec === null ? null : matchSpecifier(spec, packages);
      if (m !== null) emitImport(node, m);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      // `export … from 'spec'` — a reexport (no single named export per §5.F → export_name='')
      const spec = stringLiteralText(node.moduleSpecifier);
      const m = spec === null ? null : matchSpecifier(spec, packages);
      if (m !== null) emit(node.moduleSpecifier, "reexport", m.packageName, m.dependencyKey, "");
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      // TS `import x = require('spec')` — a require form binding the whole module
      const spec = stringLiteralText(node.moduleReference.expression);
      const m = spec === null ? null : matchSpecifier(spec, packages);
      if (m !== null) emit(node.name, "require", m.packageName, m.dependencyKey, "");
    } else if (ts.isCallExpression(node)) {
      handleCall(node);
    }
    ts.forEachChild(node, walk);
  };

  const emitImport = (node: ts.ImportDeclaration, m: { packageName: string; dependencyKey: string }): void => {
    const clause = node.importClause;
    if (clause === undefined) {
      emit(node.moduleSpecifier, "side-effect-import", m.packageName, m.dependencyKey, "");
      return;
    }
    if (clause.name !== undefined) emit(clause.name, "default-import", m.packageName, m.dependencyKey, "default");
    const nb = clause.namedBindings;
    if (nb !== undefined) {
      if (ts.isNamespaceImport(nb)) {
        emit(nb.name, "namespace-import", m.packageName, m.dependencyKey, "");
      } else {
        // NamedImports: the SOURCE export name is propertyName (for `a as b`) else name
        for (const el of nb.elements) {
          const exportName = (el.propertyName ?? el.name).text;
          emit(el.name, "named-import", m.packageName, m.dependencyKey, exportName);
        }
      }
    }
  };

  const handleCall = (call: ts.CallExpression): void => {
    // dynamic `import('spec')` — a BINDABLE form (§5.F): `const { x } = await import('spec')`
    // and `(await import('spec')).x` map back to export names; `.then(...)` dataflow does not.
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = stringLiteralText(call.arguments[0]);
      const m = spec === null ? null : matchSpecifier(spec, packages);
      if (m === null) return;
      for (const exportName of boundNames(call, /*bindingNeedsAwait*/ true)) emit(call, "dynamic-import", m.packageName, m.dependencyKey, exportName);
      return;
    }
    // `require('spec')` — skipped when `require` is lexically shadowed (a local that HAPPENS to
    // be named require is not CommonJS require)
    if (ts.isIdentifier(call.expression) && call.expression.text === "require" && !isRequireShadowed(call)) {
      const spec = stringLiteralText(call.arguments[0]);
      const m = spec === null ? null : matchSpecifier(spec, packages);
      if (m === null) return;
      for (const exportName of boundNames(call, /*bindingNeedsAwait*/ false)) emit(call, "require", m.packageName, m.dependencyKey, exportName);
    }
  };

  // Determine the bound export names for a require(...)/import(...) expression from its
  // surrounding syntax (no execution): destructured `const { x, y: z } = <expr>` → x, y; member
  // access `<expr>.x` → x; a whole-module binding / bare call → '' (one row). An interposed
  // `await` / parenthesization is climbed through first. `bindingNeedsAwait` is set for
  // dynamic-import: WITHOUT an await the expression is a Promise, so a member access is a
  // Promise method (`import('x').then` — NOT a module export) and a destructure is not module
  // bindings — both degrade to '' (whole-module).
  const boundNames = (expr: ts.Expression, bindingNeedsAwait: boolean): string[] => {
    let subject: ts.Node = expr;
    let sawAwait = false;
    // Climb through TRANSPARENT wrappers that don't change the bound value: `await`,
    // parentheses, and the TS type-only wrappers (`x as T`, `<T>x`, `x!`, `x satisfies T`) —
    // otherwise `const { y } = require("p") as any` would hide the destructure and mis-emit ''.
    for (;;) {
      const p: ts.Node | undefined = subject.parent;
      if (p === undefined) break;
      if (ts.isAwaitExpression(p)) { sawAwait = true; subject = p; continue; }
      if (
        ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) ||
        ts.isSatisfiesExpression(p) || p.kind === ts.SyntaxKind.TypeAssertionExpression
      ) { subject = p; continue; }
      break;
    }
    if (bindingNeedsAwait && !sawAwait) return [""];
    const parent = subject.parent;
    if (parent === undefined) return [""];
    // `const { x, "y": z, ...rest } = <expr>` — object BINDING pattern (a declaration)
    if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
      return objectBindingExports(parent.name);
    }
    // `({ x, "y": z } = <expr>)` — object destructuring ASSIGNMENT (target is an object literal)
    if (
      ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === subject && ts.isObjectLiteralExpression(parent.left)
    ) {
      return objectAssignmentExports(parent.left);
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === subject) {
      return [parent.name.text];
    }
    // `<expr>['name']` — a string-literal element access binds one export just like `.name`.
    // A NUMERIC access (`<expr>[0]`) deliberately degrades to '' (whole-module): a `.d.ts`
    // surface (§5.E) never has a numeric-named export, so "0" could never resolve against it,
    // and `require("pkg")[0]` most often means array/index access on the whole module.
    if (
      ts.isElementAccessExpression(parent) && parent.expression === subject &&
      (ts.isStringLiteral(parent.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(parent.argumentExpression))
    ) {
      return [parent.argumentExpression.text];
    }
    return [""];
  };

  try {
    walk(sf);
  } catch {
    return []; // fail OPEN at file level (e.g. a path buildPermalink rejects)
  }
  return dedupeSorted(rows);
}

// The static export KEY a PropertyName resolves to, or null when it is not statically knowable
// (a computed `[k]`, numeric, or private key).
// A numeric/computed/private key returns null → the occurrence degrades to whole-module '' (a
// numeric-named export can never appear in a §5.E .d.ts surface, so mapping it would be spurious).
function propertyKeyText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

// Export names bound by an object BINDING pattern `const { a, "b": c, ...rest } = <expr>`. The
// SOURCE key is the propertyName when present (handles `"b": c` and `b: c`), else the binding
// name; a `...rest` element captures the remaining namespace (no single export) and is skipped.
function objectBindingExports(pattern: ts.ObjectBindingPattern): string[] {
  const names: string[] = [];
  for (const el of pattern.elements) {
    if (el.dotDotDotToken !== undefined) continue; // rest binding is not one export
    const key = el.propertyName !== undefined
      ? propertyKeyText(el.propertyName)
      : (ts.isIdentifier(el.name) ? el.name.text : null);
    if (key !== null) names.push(key);
  }
  return names.length > 0 ? names : [""];
}

// Export names bound by an object destructuring ASSIGNMENT target `({ a, "b": c } = <expr>)`.
// SpreadAssignment (`...rest`) captures the remaining namespace and is skipped.
function objectAssignmentExports(obj: ts.ObjectLiteralExpression): string[] {
  const names: string[] = [];
  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) names.push(prop.name.text);
    else if (ts.isPropertyAssignment(prop)) {
      const key = propertyKeyText(prop.name);
      if (key !== null) names.push(key);
    }
  }
  return names.length > 0 ? names : [""];
}

// Is this `require(...)` call's identifier lexically shadowed by an enclosing declaration
// (parameter, variable/binding element, or function declaration named `require`)? Syntactic
// best-effort: covers the realistic shadow shapes without a binder.
function isRequireShadowed(call: ts.CallExpression): boolean {
  const declaresRequire = (name: ts.BindingName): boolean => {
    if (ts.isIdentifier(name)) return name.text === "require";
    return name.elements.some((el) => !ts.isOmittedExpression(el) && declaresRequire(el.name));
  };
  const listDeclaresRequire = (init: ts.ForInitializer | undefined): boolean =>
    init !== undefined && ts.isVariableDeclarationList(init) && init.declarations.some((d) => declaresRequire(d.name));
  for (let node: ts.Node | undefined = call.parent; node !== undefined; node = node.parent) {
    if (ts.isFunctionLike(node) && node.parameters.some((p) => declaresRequire(p.name))) return true;
    if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name?.text === "require") return true;
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined && declaresRequire(node.variableDeclaration.name)) return true;
    // loop-scoped bindings: `for (const require of …)`, `for…in`, `for (let require = …; …)`
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      if (listDeclaresRequire(node.initializer)) return true;
    } else if (ts.isForStatement(node) && listDeclaresRequire(node.initializer)) {
      return true;
    }
    const statements = ts.isBlock(node) || ts.isSourceFile(node) ? node.statements : ts.isCaseOrDefaultClause(node) ? node.statements : null;
    if (statements === null) continue;
    for (const stmt of statements) {
      if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.some((d) => declaresRequire(d.name))) return true;
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === "require") return true;
    }
  }
  return false;
}

// Deterministic, deduped rows (the DB UNIQUE key collapses identical tuples anyway, but emitting
// a stable sorted set keeps re-scans byte-identical).
function dedupeSorted(rows: UsageRow[]): UsageRow[] {
  const seen = new Map<string, UsageRow>();
  for (const r of rows) {
    const key = `${r.packageName}\0${r.dependencyKey}\0${r.usageType}\0${r.exportName}\0${r.lineNumber}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.lineNumber - b.lineNumber ||
      cmp(a.packageName, b.packageName) ||
      cmp(a.dependencyKey, b.dependencyKey) ||
      cmp(a.usageType, b.usageType) ||
      cmp(a.exportName, b.exportName),
  );
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
