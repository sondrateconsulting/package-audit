// tsCompilerApi.test.ts — the compiler-API contract, in four layers.
//
// (1) The pure surface check, driven with synthetic shapes — including TypeScript 7's REAL root
//     export, `{ version, versionMajorMinor }`, the shape that turned 72 tests into opaque
//     assertion diffs on PR #26 instead of one legible failure.
// (2) The WIRING: the module must call the check as a top-level statement, after the import and
//     before the export. Delete `assertCompilerApi(ts)` from tsCompilerApi.ts and THIS is what
//     fails — without it every pure test above stays green while the module quietly degrades into
//     a plain re-export.
// (3) The CHOKEPOINT: no other module reaches the typescript package by any of the module-loading
//     forms enumerated below, so the load-time check is not trivially bypassed.
// (4) DRIFT: every compiler-API member the scanners actually use, derived from their source and
//     asserted against the installed API. tsCompilerApi.ts's own load-time check covers only the
//     load-bearing primitives; this is where the full 46-member surface is pinned, so adding a
//     `ts.isFoo(…)` call that a future TypeScript does not ship fails HERE, in CI, with the
//     member named.
//
// Layers 3 and 4 read the AST, not the text. A textual tripwire (the posture tuiPurity.test.ts and
// the sole-spawner scan use, and the posture this file used first) cannot tell an import from
// prose that merely spells one — which matters acutely here, because the fixture table below is a
// list of import statements as DATA. It also cannot see through comments or formatting between
// tokens. Parsing removes both classes at once.
//
// WHAT LAYER 3 DOES NOT PROVE. It is a syntactic scan, so it decides membership from the shape of
// the call, never from what a value holds at runtime. A loader obtained through DATAFLOW —
// `createRequire(…)`'s return value, `const load = require`, a function that forwards its argument
// — is invisible to it, and no static scan short of whole-program analysis would see it. Two
// things narrow that gap rather than paper over it: `createRequire` is banned outright below (a
// blunt rule, but the dataflow it starts cannot be followed), and every remaining form is a
// deliberate act that code review is expected to catch — the same division of labour the
// sole-spawner scan and tuiPurity.test.ts already declare for their own tripwires. Where the scan
// must guess it guesses TOWARD flagging: any `.require` member call counts, shadowed or not, so a
// harmless `loader.require("typescript")` is a false positive by design. False positives are
// noise; false negatives would be a hole.
import { expect, test, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts, { missingCompilerApi, assertCompilerApi, REQUIRED_COMPILER_FUNCTIONS, REQUIRED_COMPILER_ENUMS } from "./tsCompilerApi.ts";

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const GATEWAY = "scripts/tsCompilerApi.ts";
const GATEWAY_BASENAME = "tsCompilerApi";

// Every extension Bun will execute, not just the two the repo happens to use today: a future
// `.mjs` or `.cts` helper must not become a blind spot. An EXTENSIONLESS executable file would be
// outside this set; the repo has none (no `bin` entry, nothing executable outside scripts/), and
// the claim below is scoped to "every file carrying one of these extensions" for that reason.
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
// Only dependencies and git metadata are pruned. Dot-directories are NOT skipped wholesale —
// `.github/` can hold executable JavaScript (composite actions), and the scan is meant to cover
// the repository, not just scripts/.
const PRUNED_DIRS = new Set(["node_modules", ".git"]);

function parseSource(fileName: string, src: string): ts.SourceFile {
  const kind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : fileName.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.(?:m|c)?ts$/.test(fileName)
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  return ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, kind);
}

// Peel the wrappers that change a node's type but not the value it evaluates to, so
// `(require)("typescript")` and `import("typescript" as string)` are still recognized. Same idea
// as usageScanner's transparent-wrapper handling on the scanned side.
function unwrap(node: ts.Node): ts.Node {
  let n = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)) {
      n = n.expression;
      continue;
    }
    return n;
  }
}

// The member name of `x.name` or `x["name"]`, or null for a computed access we cannot read.
function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

// A callee that loads a module: the dynamic-import OPERATOR, an identifier `require`, or any
// `.require` / `["require"]` member call. The member form is deliberately RECEIVER-BLIND —
// `module.require` and `import.meta.require` are the real ones, but matching every receiver costs
// only false positives, while enumerating receivers would miss one. See the header.
function isModuleLoadCallee(calleeRaw: ts.Expression): boolean {
  const callee = unwrap(calleeRaw);
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === "require";
  return memberName(callee) === "require";
}

// Every module specifier a file references, through each loading form: static import, re-export,
// TS import-equals, a type-position import — JSDoc ones too, which `forEachChild` does not reach
// on its own — the dynamic-import operator, and the require forms above.
function moduleSpecifiers(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const push = (node: ts.Node | undefined): void => {
    if (node === undefined) return;
    const inner = unwrap(node);
    if (ts.isStringLiteralLike(inner)) out.push(inner.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) push(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) push(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) push(node.argument.literal);
    else if (ts.isCallExpression(node) && isModuleLoadCallee(node.expression)) push(node.arguments[0]);
    for (const doc of (node as { jsDoc?: readonly ts.Node[] }).jsDoc ?? []) visit(doc);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// Identifiers with a given name, anywhere in the file — the blunt instrument used for the
// createRequire ban, where any mention is disqualifying precisely because its dataflow cannot be
// followed.
function mentionsIdentifier(sf: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// The typescript PACKAGE — the bare name or any subpath (`typescript/unstable/ast` is not a back
// door). `typescript-eslint` and `@typescript/…` are different packages that merely share a prefix.
const isTypescriptPackage = (spec: string): boolean => spec === "typescript" || spec.startsWith("typescript/");

// Repo-relative paths of every file carrying an executable extension, walked from the ROOT so a
// file added outside scripts/ cannot escape. Symlinks are skipped entirely — directory OR file —
// so the scan cannot be redirected outside the repo and cannot cycle.
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!PRUNED_DIRS.has(entry.name)) walk(child);
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(child);
    }
  };
  walk("");
  return out.sort();
}

const sourceOf = (relPath: string): ts.SourceFile => parseSource(relPath, readFileSync(join(REPO_ROOT, relPath), "utf8"));

describe("missingCompilerApi — the load-bearing surface", () => {
  test("the installed typescript satisfies it (this is what the module-load check asserts)", () => {
    expect(missingCompilerApi(ts)).toEqual([]);
    expect(() => assertCompilerApi(ts)).not.toThrow();
  });

  test("TypeScript 7's real root export is reported as missing EVERYTHING", () => {
    // `exports["."]` in typescript@7 resolves to lib/version.cjs — this object, verbatim.
    const ts7Root = { version: "7.0.2", versionMajorMinor: "7.0" };
    expect(missingCompilerApi(ts7Root)).toEqual([...REQUIRED_COMPILER_FUNCTIONS, ...REQUIRED_COMPILER_ENUMS]);
  });

  test("non-objects (undefined/null/a bare function) are missing everything, not a crash", () => {
    const everything = [...REQUIRED_COMPILER_FUNCTIONS, ...REQUIRED_COMPILER_ENUMS];
    expect(missingCompilerApi(undefined)).toEqual(everything);
    expect(missingCompilerApi(null)).toEqual(everything);
    expect(missingCompilerApi(() => {})).toEqual(everything);
  });

  test("a PARTIAL API names only what is absent — the enums and the functions are checked by TYPE", () => {
    const partial = {
      createSourceFile: () => {},
      forEachChild: "not a function", // present but wrong type → still missing
      ScriptKind: {},
      ScriptTarget: null, // present but not an object → still missing
    };
    expect(missingCompilerApi(partial)).toEqual(["forEachChild", "ScriptTarget", "SyntaxKind"]);
  });

  test("assertCompilerApi fails closed: it names the missing members, the observed version, and the remediation", () => {
    let thrown: unknown;
    try {
      assertCompilerApi({ version: "7.0.2", versionMajorMinor: "7.0" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("typescript 7.0.2"); // the observed version, so the operator knows WHAT is installed
    expect(message).toContain("missing: createSourceFile, forEachChild, ScriptKind, ScriptTarget, SyntaxKind");
    expect(message).toContain("{ version, versionMajorMinor }"); // the real TS7 root shape, not a paraphrase
    expect(message).toContain("Pin typescript to the 6.x line");
    expect((thrown as Error).name).toBe("TsCompilerApiError");
  });

  test("an API with no readable version still throws, just without the version clause", () => {
    expect(() => assertCompilerApi({})).toThrow(/^the installed typescript does not expose/);
  });
});

describe("the check is WIRED IN at module scope (AST-verified)", () => {
  // The load-time guarantee has two halves. The half above is behavioral: assertCompilerApi throws
  // for every degraded shape. This half is structural: tsCompilerApi.ts must actually CALL it as a
  // top-level statement, before its export.
  //
  // Checked IN-PROCESS rather than by launching a child process against a stubbed install, because
  // two repo invariants forbid the alternative: github.test.ts holds github.ts as the SOLE
  // process-launch site in the tree (a launch here would be the first breach), and the same scan
  // rejects non-literal dynamic imports — exactly what loading a stubbed copy of this module from
  // a temp directory would require. Module-scope execution order is a language guarantee, so an
  // ExpressionStatement sitting in sf.statements ahead of the export IS the "runs during
  // evaluation, before any importer" claim. What this does NOT prove is the process-level exit
  // behavior; that follows from the throw, which the pure tests above cover directly.
  const statements = [...sourceOf(GATEWAY).statements];

  const guardIndex = statements.findIndex(
    (s) =>
      ts.isExpressionStatement(s) &&
      ts.isCallExpression(s.expression) &&
      ts.isIdentifier(s.expression.expression) &&
      s.expression.expression.text === "assertCompilerApi" &&
      s.expression.arguments.length === 1 &&
      ts.isIdentifier(s.expression.arguments[0]!) &&
      (s.expression.arguments[0] as ts.Identifier).text === "ts",
  );
  const importIndex = statements.findIndex((s) => ts.isImportDeclaration(s) && ts.isStringLiteralLike(s.moduleSpecifier) && s.moduleSpecifier.text === "typescript");
  const exportIndex = statements.findIndex((s) => ts.isExportAssignment(s));

  test("the parse itself works (the file really is a module with an import and a default export)", () => {
    expect(statements.length).toBeGreaterThan(3);
    expect(importIndex).toBeGreaterThanOrEqual(0);
    expect(exportIndex).toBeGreaterThanOrEqual(0);
  });

  test("assertCompilerApi(ts) is a TOP-LEVEL statement — not nested in a function that nobody calls", () => {
    expect(guardIndex).toBeGreaterThanOrEqual(0);
  });

  test("it runs AFTER the typescript import and BEFORE the default export", () => {
    expect(guardIndex).toBeGreaterThan(importIndex);
    expect(guardIndex).toBeLessThan(exportIndex);
  });

  test("the module exports ts DIRECTLY — routing it through a call would erase the ts namespace type", () => {
    // `export default assertedApi(ts)` reads better but breaks every `ts.Node` in the scanners
    // (TS2503: cannot find namespace). The identifier export is load-bearing, so it is pinned.
    const exported = statements[exportIndex];
    expect(exported !== undefined && ts.isExportAssignment(exported) && ts.isIdentifier(exported.expression) && exported.expression.text === "ts").toBe(true);
  });
});

describe("tsCompilerApi is the sole route to the typescript package (AST chokepoint)", () => {
  // The fixture table is the contract for what counts as a module reference. It lives here as
  // plain source strings; because detection is AST-based these strings are DATA, so this file
  // needs no exemption from the repo-wide scan below — the earlier grep needed one, which was
  // itself the tell that a grep cannot separate code from a string containing code.
  const REFERENCES: ReadonlyArray<string> = [
    `import ts from "typescript";`,
    `import ts from 'typescript';`,
    `import type { Node } from "typescript";`,
    `import ts, { type Node } from "typescript";`,
    `import * as ts from "typescript";`,
    `import { "some name" as alias } from "typescript";`, // arbitrary module-namespace name
    `import "typescript";`,
    `export { ScriptTarget } from "typescript/unstable/ast";`,
    `export * from "typescript";`,
    `export * as ts from "typescript";`,
    `import ts = require("typescript");`,
    `const ts = await import("typescript");`,
    `const ts = await import("typescript", { with: { foo: "bar" } });`, // an options arg is still an import
    `const ts = await import("typescript" as string);`, // a cast does not hide the specifier
    `const ts = require("typescript");`,
    `const ts = (require)("typescript");`, // …nor do parentheses around the callee
    `const ts = module.require("typescript");`, // a real CommonJS loader
    `const ts = module["require"]("typescript");`, // …and its computed spelling
    `const ts = import.meta.require("typescript");`, // Bun's loader
    `const ts = import.meta["require"]("typescript");`,
    `const ts = loader.require("typescript");`, // receiver-blind BY DESIGN: a false positive beats a hole
    `type I = import("typescript").Identifier;`, // a TYPE-position import is still a reference
    `import/*c*/ts/*c*/from/*c*/"typescript";`, // comments between tokens hide nothing
    `import a from "./a.ts"; import ts from "typescript";`, // a second import on the same line
    `\n\n   import ts from "typescript";`, // leading whitespace is irrelevant to a parser
  ];
  const NON_REFERENCES: ReadonlyArray<string> = [
    `import ts from "./tsCompilerApi.ts";`,
    `import { rule } from "typescript-eslint";`, // a DIFFERENT package sharing a prefix
    `import { x } from "@typescript/foo";`,
    `import { x } from "not-typescript";`,
    `// import ts from "typescript";`, // commented-out code is not code
    `/* the require("typescript") route is closed */`,
    `/**\n * import ts from "typescript" — how it used to work\n */`,
    `const s = "import ts from \\"typescript\\";";`, // an import spelled inside a STRING is data
    `const forms = [\`require("typescript")\`, \`import("typescript")\`];`, // …including in templates
    `loader.import("typescript");`, // a method named `import` is not the import operator
    `loader . import ("typescript");`, // …spacing does not change that
    `const name = "typescript";`,
  ];

  test("every enumerated loading form is detected", () => {
    expect(REFERENCES.filter((src) => !moduleSpecifiers(parseSource("f.ts", src)).some(isTypescriptPackage))).toEqual([]);
  });

  test("a JSDoc type import in a .js file is detected (forEachChild alone would miss it)", () => {
    const js = `/** @type {import("typescript").Node} */\nlet node;\n`;
    expect(moduleSpecifiers(parseSource("f.js", js)).some(isTypescriptPackage)).toBe(true);
  });

  test("prose, strings, comments and lookalike packages are NOT detected", () => {
    expect(NON_REFERENCES.filter((src) => moduleSpecifiers(parseSource("f.ts", src)).some(isTypescriptPackage))).toEqual([]);
  });

  test("only tsCompilerApi.ts reaches the typescript package — this file included, no carve-out", () => {
    expect(sourceFiles().filter((f) => moduleSpecifiers(sourceOf(f)).some(isTypescriptPackage))).toEqual([GATEWAY]);
  });

  test("createRequire is banned outright — its loader escapes a syntactic scan", () => {
    // The one route the scan above cannot follow: createRequire returns a loader under any name.
    // Banning the mention is blunt (the repo has no use for it) and keeps the claim honest.
    expect(sourceFiles().filter((f) => mentionsIdentifier(sourceOf(f), "createRequire"))).toEqual([]);
  });

  test("the walk itself works: repo-root, nested sources, tests, and no dependencies", () => {
    const files = sourceFiles();
    expect(files).toContain(GATEWAY);
    expect(files).toContain("scripts/tsCompilerApi.test.ts"); // tests are scanned too — they could bypass the gateway
    expect(files.some((f) => f.startsWith("scripts/tui/"))).toBe(true);
    expect(files.every((f) => !f.includes("node_modules"))).toBe(true);
    expect(files.every((f) => SOURCE_EXTENSIONS.some((ext) => f.endsWith(ext)))).toBe(true);
  });
});

describe("compiler-API drift: every member the scanners use exists on the installed API", () => {
  // Classification is by node kind, and the residual bucket is what makes that safe. A value use
  // of the namespace is a PropertyAccess/ElementAccess on `ts`; a type use is a QualifiedName.
  // That split is not a universal law of TypeScript — `typeof ts.foo` is a QualifiedName over a
  // runtime value, and an erased heritage clause is written with a PropertyAccess — so nothing
  // here relies on it holding in general. Anything that does not land squarely in "called" or
  // "enum read" lands in `other`, and `other` must be empty; the two aliasing routes that would
  // sidestep the walk entirely (a bare `const api = ts`, or `import pred = ts.isFoo`) are pinned
  // by their own assertions below.
  function valueRefs(sf: ts.SourceFile): { called: Set<string>; enumRead: Set<string>; other: Set<string> } {
    const called = new Set<string>();
    const enumRead = new Set<string>();
    const other = new Set<string>();
    const visit = (node: ts.Node): void => {
      const onTs = (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === "ts";
      if (onTs) {
        const member = memberName(node);
        const parent: ts.Node | undefined = node.parent;
        if (member === null) other.add("<computed>"); // a non-literal ts[expr] is unverifiable — fail loudly
        else if (parent !== undefined && ts.isCallExpression(parent) && parent.expression === node) called.add(member);
        else if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === node) enumRead.add(member);
        else other.add(member); // referenced without calling, e.g. passed as a callback
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return { called, enumRead, other };
  }

  // Every place the `ts` binding is NAMED, so an alias cannot smuggle the namespace past the walk
  // above. Legitimate positions: the import clause that binds it, the object of a property or
  // element access, and the left of a QualifiedName (a type reference).
  function looseTsReferences(sf: ts.SourceFile): number {
    let loose = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "ts") {
        const p: ts.Node | undefined = node.parent;
        const ok =
          p !== undefined &&
          ((ts.isImportClause(p) && p.name === node) ||
            ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === node) ||
            (ts.isQualifiedName(p) && p.left === node));
        if (!ok) loose++;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return loose;
  }

  // The consumers are DERIVED, not hardcoded: whatever production module imports the gateway is
  // what this scan must cover, under any spelling of the specifier (`./tsCompilerApi`, `.ts`,
  // `.js`). A third scanner added tomorrow joins automatically.
  const importsGateway = (sf: ts.SourceFile): boolean =>
    moduleSpecifiers(sf).some((s) => {
      const base = s.split("/").pop() ?? "";
      return base === GATEWAY_BASENAME || base.startsWith(`${GATEWAY_BASENAME}.`);
    });
  const consumers = sourceFiles().filter((f) => !f.includes(".test.") && f !== GATEWAY && importsGateway(sourceOf(f)));
  const refs = consumers.map((f) => valueRefs(sourceOf(f)));
  const union = (pick: (r: (typeof refs)[number]) => Set<string>): string[] => [...new Set(refs.flatMap((r) => [...pick(r)]))].sort();

  test("the consumers are exactly the two scanners (the drift scan covers the whole gateway surface)", () => {
    expect(consumers).toEqual(["scripts/dtsExports.ts", "scripts/usageScanner.ts"]);
  });

  test("the extraction itself works (it must never silently find nothing)", () => {
    const called = union((r) => r.called);
    expect(called.length).toBeGreaterThan(40);
    expect(called).toContain("createSourceFile");
    expect(called).toContain("forEachChild");
    expect(called).toContain("isIdentifier");
  });

  test("every CALLED member resolves to a function on the installed API", () => {
    const bag = ts as unknown as Record<string, unknown>;
    expect(union((r) => r.called).filter((n) => typeof bag[n] !== "function")).toEqual([]);
  });

  test("every enum the scanners read is a runtime object AND is declared required", () => {
    const bag = ts as unknown as Record<string, unknown>;
    const accessed = union((r) => r.enumRead);
    expect(accessed).toEqual([...REQUIRED_COMPILER_ENUMS].sort());
    expect(accessed.filter((n) => typeof bag[n] !== "object" || bag[n] === null)).toEqual([]);
  });

  test("no member is reached in an unverifiable way (bare reference or computed access)", () => {
    // Everything the scanners touch must be a call or an enum read, so the two checks above are
    // exhaustive. A callback reference (`.filter(ts.isIdentifier)`) or a `ts[expr]` would slip
    // past them — this is the assertion that says neither exists.
    expect(union((r) => r.other)).toEqual([]);
  });

  test("the ts binding is never aliased — no bare reference and no import-equals off the namespace", () => {
    expect(consumers.filter((f) => looseTsReferences(sourceOf(f)) > 0)).toEqual([]);
    const aliased = consumers.filter((f) => {
      let hit = false;
      const visit = (node: ts.Node): void => {
        if (ts.isImportEqualsDeclaration(node) && !ts.isExternalModuleReference(node.moduleReference)) {
          let root: ts.Node = node.moduleReference;
          while (ts.isQualifiedName(root)) root = root.left;
          if (ts.isIdentifier(root) && root.text === "ts") hit = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceOf(f));
      return hit;
    });
    expect(aliased).toEqual([]);
  });

  test("every declared required member is actually still used (no stale declarations)", () => {
    const used = new Set([...union((r) => r.called), ...union((r) => r.enumRead)]);
    expect([...REQUIRED_COMPILER_FUNCTIONS, ...REQUIRED_COMPILER_ENUMS].filter((n) => !used.has(n))).toEqual([]);
  });
});
