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
    // the write-capable fs surface + Bun.write; read-only fs (readFileSync etc.) is not banned
    const FS_WRITE_RE = /\b(?:writeFileSync|writeSync|appendFileSync|openSync|mkdirSync|rmSync|rmdirSync|unlinkSync|renameSync|copyFileSync|createWriteStream|writeFile|appendFile|mkdir|rm\s*\(|unlink|rename\s*\()\b|Bun\s*\.\s*write/;
    for (const { file, src } of tuiSources()) {
      if (file === join("tui", "lifecycle.ts")) continue; // scoped exemption: realDivertIo (assertContained-guarded)
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
