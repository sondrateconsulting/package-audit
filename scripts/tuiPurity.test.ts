// tuiPurity.test.ts — the display-layer purity scan (PROMPT-TUI §U8.14). The TUI is
// observability, never a participant: across scripts/progress.ts + scripts/tui/** (non-test),
// no process.stdout (stdout JSONL purity — display code must be UNABLE to reach the machine
// stream), no logLine import (display never writes the durable record), no spawn surface (the
// sole-spawner scan in github.test.ts already walks these files; this pins the import route
// too), no filesystem write APIs (the ONE permitted fs user is lifecycle.ts's injected divertIo
// default — the §0-contained divert log), and no db.ts/github.ts imports (core never imports
// display; display never reaches core's spawn/DB machinery).
//
// Best-effort textual tripwires, same posture as the github.test.ts chokepoint scan: they catch
// the direct routes; deliberately-evasive forms are code review's job.
import { expect, test, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS_DIR = import.meta.dir;

// the write-capable fs surface + Bun.write; read-only fs (readFileSync etc.) is not banned
const FS_WRITE_RE = /\b(?:writeFileSync|writeSync|appendFileSync|openSync|mkdirSync|rmSync|rmdirSync|unlinkSync|renameSync|copyFileSync|createWriteStream|writeFile|appendFile|mkdir|rm\s*\(|unlink|rename\s*\()\b|Bun\s*\.\s*write/;

// Every import form of the fs builtin — static, side-effect, re-export, dynamic import(),
// require() — with string OR template-literal specifiers (fs, node:fs, fs/promises,
// node:fs/promises). An fs API cannot be called without importing the module, so this is the
// chokepoint a per-API regex cannot be: unlisted write APIs (truncateSync, cpSync, promises
// variants) are unreachable without tripping it. BQ is the backtick (template specifiers).
const BQ = "`";
const Q = `["'${BQ}]`; // any specifier quote
const NOTQ = `[^"'${BQ};]`; // from-clause filler: stops at any quote or statement end
const FS_SPEC = "(?:node:)?fs(?:\\/promises)?";
// Statement forms (static/side-effect/re-export) are LINE-ANCHORED (m flag): a prose "import"
// inside a comment must not bridge across quote-free comment lines into a real from-clause.
// Expression forms (dynamic import(), require()) stay unanchored — they appear mid-line, and
// the specifier-quote adjacency keeps them precise.
const FS_IMPORT_RE = new RegExp(
  `^\\s*(?:import|export)\\b${NOTQ}*?\\bfrom\\s*${Q}${FS_SPEC}${Q}` +
    `|^\\s*import\\s*${Q}${FS_SPEC}${Q}` +
    `|\\bimport\\s*\\(\\s*${Q}${FS_SPEC}${Q}\\s*\\)` +
    `|\\brequire\\s*\\(\\s*${Q}${FS_SPEC}${Q}\\s*\\)`,
  "m",
);

function tuiSources(): Array<{ file: string; src: string }> {
  const files: string[] = ["progress.ts"];
  for (const f of readdirSync(join(SCRIPTS_DIR, "tui"), { recursive: true }) as string[]) {
    if ((f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes(".test.")) files.push(join("tui", f));
  }
  return files.map((file) => ({ file, src: readFileSync(join(SCRIPTS_DIR, file), "utf8") }));
}

describe("tui purity (grep-enforced, §U8.14)", () => {
  test("the scan sees the display layer (progress.ts + scripts/tui/**)", () => {
    const names = tuiSources().map((s) => s.file);
    expect(names).toContain("progress.ts");
    expect(names.some((n) => n.startsWith("tui/"))).toBe(true);
    expect(names.length).toBeGreaterThanOrEqual(7); // progress + activation/lifecycle/store/format/mount/App/panels
  });

  test("no display file can reach process.stdout — the machine stream is structurally out of reach", () => {
    for (const { file, src } of tuiSources()) {
      expect({ file, hits: (src.match(/process\.stdout/g) ?? []).length }).toEqual({ file, hits: 0 });
    }
  });

  test("no display file imports logLine — the durable record has ONE writer and it is not the display", () => {
    // import-shaped: a named import binding of logLine from any specifier
    const re = /import\s*(?:type\s*)?\{[^}]*\blogLine\b[^}]*\}/;
    for (const { file, src } of tuiSources()) {
      expect({ file, importsLogLine: re.test(src) }).toEqual({ file, importsLogLine: false });
    }
  });

  test("no display file reaches a spawn surface", () => {
    const SPAWN_RE = /Bun\s*\??\s*\.\s*(spawn|spawnSync|\$)/;
    const CHILD_RE = /(?:node:)?child_process/;
    for (const { file, src } of tuiSources()) {
      expect({ file, spawn: SPAWN_RE.test(src), childProcess: CHILD_RE.test(src) }).toEqual({ file, spawn: false, childProcess: false });
    }
  });

  test("no filesystem write APIs outside lifecycle.ts (the injected divertIo default is the ONE permitted fs user)", () => {
    for (const { file, src } of tuiSources()) {
      if (file === join("tui", "lifecycle.ts")) continue; // covered by the REGION-scoped test below
      expect({ file, fsWrite: FS_WRITE_RE.test(src) }).toEqual({ file, fsWrite: false });
    }
  });

  test("lifecycle.ts's fs use is exactly the divert quartet, guarded by containment", () => {
    const src = readFileSync(join(SCRIPTS_DIR, "tui", "lifecycle.ts"), "utf8");
    // the ONLY fs import line names exactly the four divert primitives
    expect(src).toMatch(/import \{ openSync, writeSync, closeSync, mkdirSync \} from "node:fs";/);
    expect(src).toContain('openSync(path, "wx", 0o644)'); // exclusive create, never clobber
    expect(src).toContain("assertContained"); // §0 write containment on the candidate path
  });

  test("lifecycle.ts's fs-write identifiers live ONLY inside the audited divert-io region (no whole-file exemption)", () => {
    const src = readFileSync(join(SCRIPTS_DIR, "tui", "lifecycle.ts"), "utf8");
    const START = "// ---- divert io";
    const END = "// ---- the sealable stderr proxy";
    // the banners must be UNIQUE and ORDERED, or a moved/duplicated banner could silently
    // widen the exemption region
    expect(src.indexOf(START)).toBeGreaterThan(-1);
    expect(src.indexOf(START)).toBe(src.lastIndexOf(START));
    expect(src.indexOf(END)).toBe(src.lastIndexOf(END));
    expect(src.indexOf(END)).toBeGreaterThan(src.indexOf(START));
    const outside = src.slice(0, src.indexOf(START)) + src.slice(src.indexOf(END));
    const withoutImport = outside.replace('import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";', "");
    // comments count too, deliberately — same discipline the chokepoint scan imposes: prose
    // elsewhere in the file must not name write APIs the region audit cannot see
    expect(withoutImport.match(FS_WRITE_RE)).toBeNull();
  });

  test("no display file imports the fs module in ANY form — lifecycle.ts's single quartet import is the ONE allowance", () => {
    let allowedTotal = 0;
    for (const { file, src } of tuiSources()) {
      const matches = src.match(new RegExp(FS_IMPORT_RE.source, "gm")) ?? [];
      if (file === join("tui", "lifecycle.ts")) {
        allowedTotal += matches.length;
        // EXACTLY ONE fs-module import across the whole display layer, and it is the quartet —
        // an fs API cannot be called without importing the module OR reaching a dynamic
        // builtin escape hatch, and the companion test below bans those outright — so
        // import-level enforcement closes the unlisted-API hole (truncateSync, cpSync,
        // fs/promises, …) at the chokepoint
        expect({ file, matches }).toEqual({ file, matches: ['import { openSync, writeSync, closeSync, mkdirSync } from "node:fs"'] });
      } else {
        expect({ file, matches }).toEqual({ file, matches: [] });
      }
    }
    expect(allowedTotal).toBe(1);
  });

  test("no display file reaches a dynamic builtin-module escape hatch (getBuiltinModule / createRequire)", () => {
    // process.getBuiltinModule("node:fs") and module.createRequire(...)("fs") acquire builtin
    // modules WITHOUT any import statement — they would bypass the import chokepoint above.
    // The display layer has no legitimate use for either; banned outright, comments included.
    const ESCAPE_RE = /\bgetBuiltinModule\b|\bcreateRequire\b/;
    for (const { file, src } of tuiSources()) {
      expect({ file, escapeHatch: ESCAPE_RE.test(src) }).toEqual({ file, escapeHatch: false });
    }
  });

  test("the fs-import scanner recognizes every promised form and rejects near-misses (meta)", () => {
    const hits = [
      'import { openSync } from "node:fs"',
      "import * as fs from 'fs'",
      'import "node:fs"',
      'import fsp from "fs/promises"',
      'export { writeFileSync } from "node:fs"',
      'export * from "fs"',
      'await import("node:fs/promises")',
      "const fs = require('fs')",
      "import(`node:fs`)",
      "require(`fs/promises`)",
    ];
    const misses = [
      'import extra from "fs-extra"',
      'import local from "./fs.ts"',
      'import x from "myfs"',
      'import y from "node:fstab"',
      'const notAnImport = "just the letters fs in a string"',
    ];
    for (const s of hits) expect({ s, hit: FS_IMPORT_RE.test(s) }).toEqual({ s, hit: true });
    for (const s of misses) expect({ s, hit: FS_IMPORT_RE.test(s) }).toEqual({ s, hit: false });
  });

  test("no display file imports db.ts or github.ts (ownership boundary: core never imports display, display never reaches core machinery)", () => {
    const re = /from\s+["'](?:\.\.?\/)+(?:db|github)\.ts["']/;
    for (const { file, src } of tuiSources()) {
      expect({ file, importsCore: re.test(src) }).toEqual({ file, importsCore: false });
    }
  });

  test("core modules never import from scripts/tui/ except the two orchestrate entry seams", () => {
    // the ownership boundary's other direction (§U4): orchestrate.ts wires activation+lifecycle
    // in; nothing else in core may reach into the display layer.
    for (const file of readdirSync(SCRIPTS_DIR) as string[]) {
      if (!file.endsWith(".ts") || file.includes(".test.")) continue;
      const src = readFileSync(join(SCRIPTS_DIR, file), "utf8");
      const hits = (src.match(/from\s+["']\.\/tui\//g) ?? []).length;
      if (file === "orchestrate.ts") expect({ file, hits }).toEqual({ file, hits: 2 }); // activation + lifecycle
      else expect({ file, hits }).toEqual({ file, hits: 0 });
    }
  });
});
