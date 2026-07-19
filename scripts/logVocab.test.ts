import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The stdout JSONL is a CONTRACT: every `event`/`action` token the tool writes with logLine is
// part of the machine-readable output a consumer switches on. PINNED_VOCAB below IS that
// contract, frozen — the source scan must equal it in BOTH directions:
//   • an emitted literal absent from the pin (a new or renamed token) fails: add it to
//     PINNED_VOCAB and document it (backticked) in the README;
//   • a pinned token no longer emitted (a removed or renamed token) fails: delete it from
//     PINNED_VOCAB and record it in RETIRED_VOCAB with a rationale — leaving the contract is
//     as deliberate and visible an act as joining it.
// The earlier subset-only design (emitted ⊆ README) let removals and renames pass silently;
// the README requirement itself was the tripwire that caught `owner-discovery-throttled` /
// `requeue-throttle` / `retry-next-run` going undocumented, and it is retained here over the
// pin (house precedent for frozen ledgers: EXPORTS.md↔registry, config.schema.json↔config.ts,
// reportSchema↔db.ts). Scope note: the scan matches `event:`/`action:` object-literal keys in
// the non-test sources; every such literal is an emitted stdout token today, and any future one
// belongs in the contract too.

const SCRIPTS_DIR = import.meta.dir;
const README = readFileSync(join(SCRIPTS_DIR, "..", "README.md"), "utf8");

type VocabKey = "event" | "action";

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
  /** Why the token left the contract — the permanent retirement record consumers can consult. */
  readonly rationale: string;
}

// Tokens deliberately removed from the contract. Moving an entry here (instead of just deleting
// it from PINNED_VOCAB) is the required paper trail for a removal or rename; the tests below
// hold each entry to being genuinely gone from the sources and carrying a non-empty rationale.
const RETIRED_VOCAB: Record<VocabKey, readonly RetiredToken[]> = {
  event: [],
  action: [],
};

function emittedLiterals(key: VocabKey): string[] {
  const found = new Set<string>();
  const re = new RegExp(`${key}:\\s*"([^"]+)"`, "g");
  // RECURSIVE and .tsx-inclusive (PROMPT-TUI §U8.14): scripts/tui/ can never emit an
  // undocumented stdout token either. (The TUI's own hub deliberately uses a different
  // discriminant key — `type:` — so display plumbing never collides with this scan.)
  for (const file of readdirSync(SCRIPTS_DIR, { recursive: true }) as string[]) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
    if (file.includes(".test.")) continue;
    const src = readFileSync(join(SCRIPTS_DIR, file), "utf8");
    for (const m of src.matchAll(re)) found.add(m[1]!);
  }
  return [...found].sort();
}

for (const key of ["event", "action"] as const) {
  const emitted = emittedLiterals(key);
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
    expect(gone, `${key} tokens no longer emitted must move from PINNED_VOCAB to RETIRED_VOCAB with a rationale`).toEqual([]);
  });

  test(`every pinned ${key} token is documented in the README vocabulary`, () => {
    for (const token of pinned) {
      expect(README, `README must document the \`${token}\` ${key} (stdout JSONL is a contract)`).toContain(`\`${token}\``);
    }
  });

  test(`retired ${key} tokens carry a rationale and are gone from the pin and the sources`, () => {
    const tokens = retired.map((entry) => entry.token);
    expect(new Set(tokens).size, `RETIRED_VOCAB.${key} must not contain duplicates`).toBe(tokens.length);
    for (const { token, rationale } of retired) {
      expect(rationale.trim().length, `retired ${key} \`${token}\` needs a non-empty rationale`).toBeGreaterThan(0);
      expect(pinnedSet.has(token), `\`${token}\` cannot be both pinned and retired`).toBe(false);
      expect(emittedSet.has(token), `retired ${key} \`${token}\` is still emitted — restore its pin or finish removing it`).toBe(false);
    }
  });
}
