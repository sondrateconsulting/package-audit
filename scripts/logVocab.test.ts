import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The stdout JSONL is a CONTRACT: every `event`/`action` token the tool writes with logLine is
// part of the machine-readable output a consumer switches on. This source scan requires every
// emitted literal to appear (backticked) somewhere in the README — the missing
// tripwire that let `owner-discovery-throttled` / `requeue-throttle` / `retry-next-run` go
// undocumented (house precedent: EXPORTS.md↔registry, config.schema.json↔config.ts,
// reportSchema↔db.ts). Scope note: this matches `event:`/`action:` object-literal keys in the
// non-test sources; every such literal is an emitted stdout token today, and any future one belongs in the
// contract too, so demanding it be documented is the intended invariant.

const SCRIPTS_DIR = import.meta.dir;
const README = readFileSync(join(SCRIPTS_DIR, "..", "README.md"), "utf8");

function emittedLiterals(key: "event" | "action"): string[] {
  const found = new Set<string>();
  const re = new RegExp(`${key}:\\s*"([^"]+)"`, "g");
  for (const file of readdirSync(SCRIPTS_DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(join(SCRIPTS_DIR, file), "utf8");
    for (const m of src.matchAll(re)) found.add(m[1]!);
  }
  return [...found].sort();
}

for (const key of ["event", "action"] as const) {
  test(`every emitted ${key}: literal is documented in the README vocabulary`, () => {
    const literals = emittedLiterals(key);
    expect(literals.length).toBeGreaterThan(0); // the scan must actually find tokens
    for (const token of literals) {
      expect(README, `README must document the \`${token}\` ${key} (stdout JSONL is a contract)`).toContain(`\`${token}\``);
    }
  });
}
