// benchArtifacts.test.ts — CI guardianship of the COMMITTED benchmark artifacts (resolution
// plan §8 freeze): corpus.json parses strictly, every pinned unit's selected/*.json parses —
// which re-derives its route matrix from its committed facts, so ground-truth drift is a CI
// failure — the workload's identity fields match the corpus pin, and the literal schedule
// table in bench-config.json validates against the §4.5 rules over the pinned units.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBenchConfig } from "./benchConfig.ts";
import { loadCorpus, scheduleUnitsFrom } from "./benchCorpus.ts";
import { validateSchedule } from "./benchSchedule.ts";
import { parseUnitWorkload } from "./benchWorkload.ts";

const ARTIFACTS = join(import.meta.dir, "..", "docs", "adrs", "0001-benchmark");
const CFG = loadBenchConfig(join(ARTIFACTS, "bench-config.json"));
const CORPUS_PATH = join(ARTIFACTS, "corpus.json");

describe("committed benchmark artifacts (frozen after §8 ratification)", () => {
  test("corpus.json and bench-config.json are pinned TOGETHER (schedule ⇔ corpus)", () => {
    expect(existsSync(CORPUS_PATH)).toBe(CFG.schedule !== null);
  });
  if (!existsSync(CORPUS_PATH)) return; // pre-pinning tree: nothing further to guard yet

  const corpus = loadCorpus(readFileSync(CORPUS_PATH, "utf8"));
  test("every pinned unit's workload parses (route matrix re-derives) and matches its pin", () => {
    for (const slot of corpus.performance) {
      for (const unit of slot.units) {
        const file = join(ARTIFACTS, "selected", `${unit.unitId.replace(/[^A-Za-z0-9._@-]/g, "_")}.json`);
        expect(existsSync(file)).toBe(true);
        const w = parseUnitWorkload(readFileSync(file, "utf8"));
        expect(w.unit).toBe(unit.unitId);
        expect(w.sha).toBe(unit.sha);
        expect(w.treeOid).toBe(unit.treeOid);
        expect(w.objectFormat).toBe(slot.objectFormat);
        expect(w.batchContentBytesCap).toBe(CFG.t1.batchContentBytesCap);
        expect(w.entries.length).toBeGreaterThan(0);
      }
    }
  });
  test("the literal traversal table satisfies the §4.5 preregistration over the pinned units", () => {
    expect(CFG.schedule).not.toBeNull();
    const violations = validateSchedule(CFG.schedule!, scheduleUnitsFrom(corpus), CFG.williamsRows, CFG.reps);
    expect(violations).toEqual([]);
  });
  test("C6 carries all three fixture kinds with driver applicability", () => {
    const kinds = corpus.fidelity.map((f) => f.kind).sort();
    expect(kinds).toEqual(["api-only-symlink", "clone-symlink", "non-utf8-content"]);
    const m9 = corpus.fidelity.find((f) => f.kind === "api-only-symlink")!;
    expect(m9.appliesTo).toEqual(["T0", "T1"]); // no one clones nodejs/node for it (§4.2)
  });
});
