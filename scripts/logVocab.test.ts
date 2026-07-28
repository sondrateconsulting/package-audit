import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// The stdout JSONL is a CONTRACT: every `event`/`action` token the tool writes to stdout is
// part of the machine-readable output a consumer switches on. (Most go through `logLine`, but
// not all — `export-summary` is hand-serialized and written by export.ts's main().) PINNED_VOCAB
// below IS that contract, frozen — the source scan must equal it in BOTH directions:
//   • an emitted token absent from the pin (a new or renamed token) fails: add it to
//     PINNED_VOCAB and EVER_PINNED_VOCAB, and document it (backticked) in the README;
//   • a pinned token no longer emitted (a removed or renamed token) fails: delete it from
//     PINNED_VOCAB and record it in RETIRED_VOCAB with a rationale — leaving the contract is
//     as deliberate and visible an act as joining it.
// The earlier subset-only design (emitted ⊆ README) let removals and renames pass silently;
// the README requirement itself was the tripwire that caught `owner-discovery-throttled` /
// `requeue-throttle` / `retry-next-run` going undocumented, and it is retained here over the
// pin (house precedent for frozen ledgers: EXPORTS.md↔registry, config.schema.json↔config.ts,
// reportSchema↔db.ts).
//
// Scope note: the scan is SYNTACTIC, not textual. It parses each non-test source and collects
// `event:`/`action:` object-literal properties whose value is a string literal, or an
// identifier bound to one by an unambiguous same-file `const`. That matters in both
// directions: token-shaped text in a comment or string must not count as an emission (a stale
// comment mentioning a removed token would otherwise keep it looking alive), and hoisting a
// literal into a const must not read as a removal. What the scan still cannot resolve inside a
// `logLine()` call is reported as blindness and fails its own test, so a token the scanner
// merely stopped seeing is never mistaken for one the tool stopped emitting.

const SCRIPTS_DIR = import.meta.dir;
const README = readFileSync(join(SCRIPTS_DIR, "..", "README.md"), "utf8");

const VOCAB_SECTION_HEADING = "## Reading a run";

// The vocabulary is documented in one README section, and the check reads only that section.
// Searching the whole file would let unrelated prose satisfy it: `export` is also a CLI
// subcommand, headed "### Data exports (`export`)", so the export EVENT could disappear from
// the documented vocabulary while the test stayed green on the subcommand's heading.
function vocabularySection(readme: string): string {
  const start = readme.search(new RegExp(`^${VOCAB_SECTION_HEADING}$`, "m"));
  if (start === -1) return "";
  const body = readme.slice(start + VOCAB_SECTION_HEADING.length);
  const end = body.search(/^## /m);
  return end === -1 ? body : body.slice(0, end);
}

test("the README vocabulary section excludes prose from the rest of the file", () => {
  const section = vocabularySection(
    ["# Title", "### Data exports (`export`)", "", `${VOCAB_SECTION_HEADING}`, "Vocabulary: `done`.", "", "## Report anatomy", "`not-vocabulary`"].join("\n"),
  );
  expect(section, "the documented vocabulary must come from the vocabulary section").toContain("`done`");
  expect(section, "a backticked token elsewhere in the README does not document it").not.toContain("Data exports");
  expect(section).not.toContain("not-vocabulary");
});

test("a renamed README vocabulary section yields nothing rather than silently matching", () => {
  expect(vocabularySection("# Title\n\n## Something else\n\n`done`\n")).toBe("");
});

const README_VOCAB = vocabularySection(README);

test(`the README keeps its "${VOCAB_SECTION_HEADING}" section`, () => {
  expect(
    README_VOCAB.trim().length,
    `the vocabulary check reads the "${VOCAB_SECTION_HEADING}" section — renaming it would silently document nothing`,
  ).toBeGreaterThan(0);
});

// The loop below iterates VOCAB_KEYS and VocabKey is derived from it, so the two can never
// drift: adding a third discriminant grows the type, the Records, AND the test loop together.
const VOCAB_KEYS = ["event", "action"] as const;
type VocabKey = (typeof VOCAB_KEYS)[number];

interface ScanResult {
  readonly tokens: Record<VocabKey, string[]>;
  /**
   * `logLine()` discriminants the scanner could not statically resolve. These are scanner
   * BLINDNESS, not absence — reported separately so a token the scan merely stopped seeing
   * is never mistaken for a token the tool stopped emitting.
   */
  readonly unresolved: readonly string[];
}

// Pure and fixture-testable: the vocabulary a single source emits. Split out from the tree
// walk so the matching rules are covered by hand-written sources (below) rather than only by
// whatever the repo happens to contain today.
function staticString(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function vocabKeyOf(name: ts.Node): VocabKey | undefined {
  const text = ts.isIdentifier(name) ? name.text : staticString(name);
  return VOCAB_KEYS.find((key) => key === text);
}

function scanSourceVocabulary(source: string, fileName = "scan.ts"): ScanResult {
  const found: Record<VocabKey, Set<string>> = { event: new Set(), action: new Set() };
  const unresolved: string[] = [];
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // Same-file `const NAME = "literal"` bindings, so hoisting a literal out of its call site is
  // a refactor the scan FOLLOWS rather than a token it loses.
  //
  // Only `const` counts: a `let`/`var` can be reassigned, so its initializer is not evidence of
  // what gets emitted. Resolution is by name, not by lexical scope (a full binding resolver
  // would need a TypeChecker over the whole program), so every OTHER binding of the same name —
  // a parameter, a destructured element, a function/class/import — poisons the entry to null.
  // That keeps name-based lookup from reaching across an unrelated binding: the cost of a
  // collision is an unresolved token (reported as blindness), never a wrong one.
  const consts = new Map<string, string | null>();
  const bind = (name: string, value: string | null): void => {
    consts.set(name, consts.has(name) ? null : value);
  };
  const collectConsts = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const declaredConst =
        node.parent !== undefined &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0;
      const value =
        declaredConst && node.initializer !== undefined ? staticString(node.initializer) : undefined;
      bind(node.name.text, value ?? null);
    } else if (
      (ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name)
    ) {
      bind(node.name.text, null);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isImportSpecifier(node) ||
        ts.isImportClause(node) || ts.isNamespaceImport(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      bind(node.name.text, null);
    }
    ts.forEachChild(node, collectConsts);
  };
  collectConsts(sourceFile);

  const resolve = (node: ts.Node): string | undefined => {
    const direct = staticString(node);
    if (direct !== undefined) return direct;
    if (!ts.isIdentifier(node)) return undefined;
    const bound = consts.get(node.text);
    return typeof bound === "string" ? bound : undefined;
  };

  const collectTokens = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = vocabKeyOf(node.name);
      const value = key === undefined ? undefined : resolve(node.initializer);
      if (key !== undefined && value !== undefined) found[key].add(value);
    }
    ts.forEachChild(node, collectTokens);
  };
  collectTokens(sourceFile);

  // Blindness is only reported for `logLine()` itself. Elsewhere a non-literal `event:` is
  // ordinary display plumbing (scripts/tui/lifecycle.ts passes `event: ev` to emitProgress),
  // and failing on those would make the guard cry wolf on code that emits no stdout token.
  const collectBlindSpots = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "logLine"
    ) {
      for (const arg of node.arguments) {
        if (!ts.isObjectLiteralExpression(arg)) continue;
        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
          const key = vocabKeyOf(prop.name);
          if (key === undefined) continue;
          if (resolve(ts.isPropertyAssignment(prop) ? prop.initializer : prop.name) !== undefined) continue;
          const { line } = sourceFile.getLineAndCharacterOfPosition(prop.getStart());
          unresolved.push(`${fileName}:${line + 1} ${key}`);
        }
      }
    }
    ts.forEachChild(node, collectBlindSpots);
  };
  collectBlindSpots(sourceFile);

  return {
    tokens: { event: [...found.event].sort(), action: [...found.action].sort() },
    unresolved,
  };
}

// The scanner's own rules, pinned against hand-written sources. Without these the scanner is
// only ever exercised by today's tree, so a blind spot in it looks exactly like a clean run.
test("the scan counts syntactic vocabulary properties only, not token-shaped prose", () => {
  const source = [
    '// action:"comment-line"',
    '/* action: "comment-block" */',
    "const prose = `action:\"string-prose\"`;",
    'logLine({ url: "https://example.test/a//b", action: "after-url" });',
    'logLine({ left: "/*", action: "between-markers", right: "*/" });',
  ].join("\n");
  expect(
    scanSourceVocabulary(source).tokens.action,
    "a token mentioned in a comment or a string is not an emitted token",
  ).toEqual(["after-url", "between-markers"]);
});

test("the scan resolves a vocabulary value held in a same-file const", () => {
  const source = 'const EVENT_UNIT = "unit";\nlogLine({ event: EVENT_UNIT });';
  expect(
    scanSourceVocabulary(source).tokens.event,
    "hoisting a literal to a const must not read as a removed token",
  ).toEqual(["unit"]);
});

test("an unresolvable logLine discriminant is reported as blindness, not absence", () => {
  const scanned = scanSourceVocabulary("logLine({ event: pickEvent() });", "blind.ts");
  expect(scanned.tokens.event).toEqual([]);
  expect(
    scanned.unresolved.join(""),
    "an event the scanner cannot read must be surfaced, not silently dropped",
  ).toContain("blind.ts");
});

test("a reassignable let is not treated as a stable token", () => {
  const scanned = scanSourceVocabulary('let EVENT = "unit";\nEVENT = pick();\nlogLine({ event: EVENT });', "let.ts");
  expect(scanned.tokens.event, "only a const binding is stable enough to read as an emitted token").toEqual([]);
  expect(scanned.unresolved.join(""), "an unstable binding is blindness, not absence").toContain("let.ts");
});

test("a const shadowed by another binding of the same name does not resolve", () => {
  const source = 'const X = "foo";\nfunction f(X: string) { logLine({ event: X }); }';
  const scanned = scanSourceVocabulary(source, "shadow.ts");
  expect(scanned.tokens.event, "resolution must not cross an unrelated binding of the same name").toEqual([]);
  expect(scanned.unresolved.join("")).toContain("shadow.ts");
});

test("a non-literal event outside logLine is display plumbing, not a blind spot", () => {
  // scripts/tui/lifecycle.ts does exactly this: `emitProgress({ type: "jsonl", event: ev })`.
  const scanned = scanSourceVocabulary('emitProgress({ type: "jsonl", event: ev });');
  expect(scanned.tokens.event).toEqual([]);
  expect(scanned.unresolved).toEqual([]);
});

// The frozen stdout JSONL vocabulary. Sorted (default string sort), duplicate-free, and
// backtick-documented in the README — all three are asserted below.
const PINNED_VOCAB: Record<VocabKey, readonly string[]> = {
  event: [
    "cli-terms",
    "concurrency",
    "config",
    "discovery",
    "done",
    "dossier",
    "dossier-summary",
    "export",
    "export-summary",
    "introspection",
    "owner-discovery-throttled",
    "owners",
    "plan",
    "plan-excluded",
    "plan-summary",
    "policy-warning",
    "preflight",
    "reconciliation",
    "rescan-branch",
    "run",
    "unit",
    "warning",
  ],
  action: [
    "error",
    "past-cap",
    "prune-excluded-owner",
    "prune-stale",
    "requeue-throttle",
    "retry-next-run",
    "scanned",
    "skip-current",
    "skip-cutoff",
    "skip-policy",
  ],
};

interface RetiredToken {
  readonly token: string;
  /** Why the token left the contract — the retirement record kept for reviewers and maintainers. */
  readonly rationale: string;
}

// Tokens deliberately removed from the contract. Moving an entry here (instead of just deleting
// it from PINNED_VOCAB) is the required paper trail for a removal or rename; the tests below
// hold each entry to being genuinely gone from the sources and carrying a non-empty rationale.
const RETIRED_VOCAB: Record<VocabKey, readonly RetiredToken[]> = {
  event: [],
  action: [],
};

// Every token that has EVER been part of the contract, retired or not. PINNED_VOCAB and
// RETIRED_VOCAB must together partition it exactly, which is what makes a retirement checkable:
// without it, "retire `don`" (a typo for `done`) satisfies every other rule, since a name that
// never existed is trivially not pinned and not emitted.
//
// Honest limit: this is a mutable file, so it is a REVIEW AID, not proof. Nothing stops the same
// commit that invents a retirement from also adding the invented token here — it just cannot
// happen by accident, and the diff makes it obvious to a reviewer. Real proof of prior
// membership needs immutable history (git, a released manifest), which is out of scope for a
// test that must stay fast and offline.
const EVER_PINNED_VOCAB: Record<VocabKey, readonly string[]> = {
  event: [
    "cli-terms",
    "concurrency",
    "config",
    "discovery",
    "done",
    "dossier",
    "dossier-summary",
    "export",
    "export-summary",
    "introspection",
    "owner-discovery-throttled",
    "owners",
    "plan",
    "plan-excluded",
    "plan-summary",
    "policy-warning",
    "preflight",
    "reconciliation",
    "rescan-branch",
    "run",
    "unit",
    "warning",
  ],
  action: [
    "error",
    "past-cap",
    "prune-excluded-owner",
    "prune-stale",
    "requeue-throttle",
    "retry-next-run",
    "scanned",
    "skip-current",
    "skip-cutoff",
    "skip-policy",
  ],
};

interface RetirementInput {
  readonly key: VocabKey;
  readonly retired: readonly RetiredToken[];
  readonly pinned: ReadonlySet<string>;
  readonly emitted: ReadonlySet<string>;
  readonly everPinned: ReadonlySet<string>;
}

// Pure, so the ledger's rules are covered by the fixtures below even while the real ledger is
// empty. Returns every problem rather than throwing on the first, so one run lists them all.
function retirementProblems({ key, retired, pinned, emitted, everPinned }: RetirementInput): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { token, rationale } of retired) {
    if (seen.has(token)) problems.push(`retired ${key} \`${token}\` is listed twice`);
    seen.add(token);
    if (rationale.trim().length === 0) problems.push(`retired ${key} \`${token}\` needs a non-empty rationale`);
    if (pinned.has(token)) problems.push(`\`${token}\` cannot be both pinned and retired`);
    if (emitted.has(token)) problems.push(`retired ${key} \`${token}\` is still emitted — restore its pin or finish removing it`);
    if (!everPinned.has(token))
      problems.push(
        `retired ${key} \`${token}\` was never pinned — EVER_PINNED_VOCAB.${key} has no record of it (typo, or a token that never shipped)`,
      );
  }
  return problems;
}

interface HistoryInput {
  readonly key: VocabKey;
  readonly pinned: readonly string[];
  readonly retired: readonly RetiredToken[];
  readonly everPinned: readonly string[];
}

// PINNED_VOCAB and RETIRED_VOCAB must exactly partition EVER_PINNED_VOCAB. The "unaccounted"
// half is what turns a typo into two failures instead of none: retiring `don` leaves the real
// `done` in the catalog but in neither list, so the mistake surfaces from both directions.
function contractHistoryProblems({ key, pinned, retired, everPinned }: HistoryInput): string[] {
  const problems: string[] = [];
  const history = new Set(everPinned);
  const accounted = new Set([...pinned, ...retired.map((entry) => entry.token)]);
  for (const token of pinned)
    if (!history.has(token))
      problems.push(`pinned ${key} \`${token}\` is missing from EVER_PINNED_VOCAB.${key} — add it there too`);
  for (const token of everPinned)
    if (!accounted.has(token))
      problems.push(`${key} \`${token}\` is in EVER_PINNED_VOCAB but neither pinned nor retired — it left the contract with no paper trail`);
  return problems;
}

test("a token dropped from the pin without a retirement is unaccounted for", () => {
  const problems = contractHistoryProblems({
    key: "event",
    pinned: [],
    retired: [{ token: "don", rationale: "typo of done" }],
    everPinned: ["done"],
  }).join("\n");
  expect(problems, "a typo'd retirement must also surface as the real token going missing").toContain(
    "`done` is in EVER_PINNED_VOCAB but neither pinned nor retired",
  );
});

const NO_TOKENS: ReadonlySet<string> = new Set();

test("a completed retirement raises no problems", () => {
  expect(
    retirementProblems({
      key: "event",
      retired: [{ token: "gone", rationale: "renamed to `done`" }],
      pinned: NO_TOKENS,
      emitted: NO_TOKENS,
      everPinned: new Set(["gone"]),
    }),
  ).toEqual([]);
});

test("the ledger rejects duplicates, blank rationales, and half-finished removals", () => {
  const problems = retirementProblems({
    key: "action",
    retired: [
      { token: "dup", rationale: "ok" },
      { token: "dup", rationale: "ok" },
      { token: "blank", rationale: "   " },
      { token: "still-pinned", rationale: "ok" },
      { token: "still-emitted", rationale: "ok" },
    ],
    pinned: new Set(["still-pinned"]),
    emitted: new Set(["still-emitted"]),
    everPinned: new Set(["dup", "blank", "still-pinned", "still-emitted"]),
  }).join("\n");
  expect(problems).toContain("`dup` is listed twice");
  expect(problems).toContain("`blank` needs a non-empty rationale");
  expect(problems).toContain("`still-pinned` cannot be both pinned and retired");
  expect(problems).toContain("`still-emitted` is still emitted");
});

test("retiring a token that was never in the contract is rejected", () => {
  const problems = retirementProblems({
    key: "event",
    retired: [{ token: "totally-fabricated-token-xyz", rationale: "made up" }],
    pinned: NO_TOKENS,
    emitted: NO_TOKENS,
    everPinned: new Set(["done"]),
  }).join("\n");
  expect(problems, "an invented or typo'd retirement must not pass silently").toContain(
    "retired event `totally-fabricated-token-xyz` was never pinned",
  );
});

// One walk for both keys: parsing each source is the expensive part, so it happens once.
function scanTree(): ScanResult {
  const found: Record<VocabKey, Set<string>> = { event: new Set(), action: new Set() };
  const unresolved: string[] = [];
  // RECURSIVE and .tsx-inclusive (PROMPT-TUI §U8.14): scripts/tui/ can never emit an
  // undocumented stdout token either. (The TUI's own hub deliberately uses a different
  // discriminant key — `type:` — so display plumbing never collides with this scan.)
  for (const file of readdirSync(SCRIPTS_DIR, { recursive: true }) as string[]) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
    if (/\.test\.tsx?$/.test(file)) continue;
    const scanned = scanSourceVocabulary(readFileSync(join(SCRIPTS_DIR, file), "utf8"), file);
    for (const key of VOCAB_KEYS) for (const token of scanned.tokens[key]) found[key]!.add(token);
    unresolved.push(...scanned.unresolved);
  }
  return {
    tokens: { event: [...found.event].sort(), action: [...found.action].sort() },
    unresolved,
  };
}

const TREE = scanTree();

// Blindness must never masquerade as absence. If the scan cannot read a logLine discriminant,
// that token silently leaves the emitted set and every pinned-but-gone check starts lying.
test("every logLine discriminant in the sources is statically readable", () => {
  expect(
    TREE.unresolved,
    "a logLine event/action the scan cannot resolve reads exactly like a removed token — give it a string literal or a same-file const",
  ).toEqual([]);
});

for (const key of VOCAB_KEYS) {
  const emitted = TREE.tokens[key];
  const emittedSet = new Set(emitted);
  const pinned = PINNED_VOCAB[key];
  const pinnedSet = new Set(pinned);
  const retired = RETIRED_VOCAB[key];

  test(`the pinned ${key} vocabulary is sorted and duplicate-free`, () => {
    expect([...pinned], `keep PINNED_VOCAB.${key} sorted so contract diffs stay reviewable`).toEqual([...pinned].sort());
    expect(new Set(pinned).size, `PINNED_VOCAB.${key} must not contain duplicates`).toBe(pinned.length);
  });

  test(`every emitted ${key}: literal is pinned (a new token is a contract change)`, () => {
    expect(emitted.length).toBeGreaterThan(0); // the scan must actually find tokens
    const unpinned = emitted.filter((token) => !pinnedSet.has(token));
    expect(unpinned, `new ${key} tokens must be added to PINNED_VOCAB and documented in the README`).toEqual([]);
  });

  test(`every pinned ${key} token is still emitted (a removal or rename is a contract change)`, () => {
    const gone = pinned.filter((token) => !emittedSet.has(token));
    expect(
      gone,
      `${key} tokens missing from the source scan. If the emitter really dropped them, move them from PINNED_VOCAB to RETIRED_VOCAB with a rationale — but check the emitter first: a token whose value stopped being statically readable looks identical here, and retiring one that is still live would put a false record in the ledger`,
    ).toEqual([]);
  });

  test(`every pinned ${key} token is documented in the README vocabulary`, () => {
    const undocumented = pinned.filter((token) => !README_VOCAB.includes(`\`${token}\``));
    expect(
      undocumented,
      `these ${key} tokens are missing from the README's "${VOCAB_SECTION_HEADING}" vocabulary (stdout JSONL is a contract)`,
    ).toEqual([]);
  });

  test(`retired ${key} tokens carry a rationale and are gone from the pin and the sources`, () => {
    const problems = retirementProblems({
      key,
      retired,
      pinned: pinnedSet,
      emitted: emittedSet,
      everPinned: new Set(EVER_PINNED_VOCAB[key]),
    });
    expect(problems, `RETIRED_VOCAB.${key} entries must each be a completed, documented retirement`).toEqual([]);
  });

  test(`the pinned and retired ${key} vocabularies account for every token ever pinned`, () => {
    const problems = contractHistoryProblems({
      key,
      pinned,
      retired,
      everPinned: EVER_PINNED_VOCAB[key],
    });
    expect(problems, `PINNED_VOCAB.${key} + RETIRED_VOCAB.${key} must partition EVER_PINNED_VOCAB.${key}`).toEqual([]);
  });
}
