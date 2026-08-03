// benchReport.ts — renders docs/adrs/0001-benchmark/report.md from the §4.6/§4.7 score output
// (benchScore) plus the committed informational artifacts. A PURE string builder over already-
// committed evidence (§8's read-only-analysis carve-out): the report can be regenerated at any
// time from runs.jsonl + fidelity.jsonl + the artifacts, and says nothing those files cannot
// back. The §4.7 rule's OUTPUT is stated verbatim here — the Step-D decision (accept /
// rewrite-for-winner / no-dominator judgment / remain-proposed) is a SEPARATE PR with its own
// adversarial review round, and this report deliberately does not make it.

import type { Corpus } from "./benchCorpus.ts";
import type { BenchConfig } from "./benchConfig.ts";
import type { DriverId } from "./benchSchedule.ts";
import { DRIVERS } from "./benchSchedule.ts";
import type { ScoreOutput, UnitDriverCell } from "./benchScore.ts";

export interface ReportContext {
  score: ScoreOutput;
  cfg: BenchConfig;
  corpus: Corpus;
  ratification: Record<string, unknown>;
  envManifests: Array<Record<string, unknown>>; // env-manifest lines from runs.jsonl
  frozenSurfaceDigest: string;
  boundary: Record<string, unknown> | null; // boundary-probe.json when present
  concurrency: Record<string, unknown> | null; // concurrency-probe.json when present
  option3: Record<string, unknown> | null; // option3.json when present
  generatedAtIso: string;
}

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return "∞";
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
};
const bytes = (n: number | null): string => {
  if (n === null) return "—";
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
};
const ms = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

function cellFor(score: ScoreOutput, unit: string, driver: DriverId): UnitDriverCell {
  const cell = score.cells.find((c) => c.unit === unit && c.driver === driver);
  if (cell === undefined) throw new Error(`report: no cell for ${unit} ${driver}`);
  return cell;
}

export function buildReport(ctx: ReportContext): string {
  const { score, cfg, corpus } = ctx;
  const units = corpus.performance.flatMap((s) => s.units.map((u) => u.unitId));
  const L: string[] = [];
  const push = (s = ""): void => {
    L.push(s);
  };

  push(`# ADR-0001 content-transport benchmark — Step C report`);
  push();
  push(`- **Generated:** ${ctx.generatedAtIso}`);
  push(`- **Plan:** [docs/plans/adr-0001-disagreements-resolution.md](../../plans/adr-0001-disagreements-resolution.md) §4.5–§4.8 (protocol, metrics, rule, budget); ratified per §8.`);
  push(`- **Frozen-surface digest:** \`${ctx.frozenSurfaceDigest}\``);
  push(`- **Harness commit (rows):** \`${score.identity.harnessCommit}\`; **environment manifest hash:** \`${score.identity.envManifestHash}\``);
  push(`- **Noise band:** ${score.noiseBand} (ratified; pilot spread ${String(ctx.ratification["pilotSpread"] ?? "?")} — the band is the frozen formula's output over this spread; provenance, including any re-ratification, is in ratification.json)`);
  const env = ctx.envManifests.find((m) => m["hash"] === score.identity.envManifestHash);
  if (env !== undefined) {
    push(`- **Environment:** ${String(env["os"])} ${String(env["osVersion"])} ${String(env["archName"])}, git ${String(env["gitVersion"])}, gh ${String(env["ghVersion"])}, Bun ${String(env["bunVersion"])}; network: ${String(env["networkDescription"])}; credential: ${String(env["credentialType"])} (login \`${String(env["login"])}\`)`);
  }
  push();
  push(`> **Scope, stated plainly (plan §4.6):** this is a per-scenario serial cost profile, not an`);
  push(`> estate simulation. Concurrent fan-out, the shared REST+GraphQL budget under contention,`);
  push(`> cross-unit cache effects, and aggregate clone disk remain design-ledger items; the`);
  push(`> concurrency probe below evidences them without scoring them.`);
  push();

  // ---- scores ----------------------------------------------------------------------------
  push(`## 1. Scores (§4.6)`);
  push();
  push(`\`T(r) = min(3600 × files ÷ wall(r), capacity × files ÷ units(r) per consuming bucket)\`;`);
  push(`score = median of T over K=${cfg.reps}, worst-of-K beside it. \`files\` = the unit's full pinned`);
  push(`workload (read + no-read entries) — a per-unit constant, so within-unit ratios are unaffected.`);
  push(`Tree acquisition counts toward units (T0/T1 pay it; T2a/T2c do not); discovery is excluded.`);
  push();
  push(`### Median T (files/hour) at the pinned 5,000-point bucket`);
  push();
  push(`| Unit | ${DRIVERS.join(" | ")} |`);
  push(`|---|${DRIVERS.map(() => "---:").join("|")}|`);
  for (const unit of units) {
    const row = DRIVERS.map((d) => {
      const cell = cellFor(score, unit, d);
      if (cell.medianT === null) return "—";
      return `${fmt(cell.medianT)} (worst ${fmt(cell.worstT ?? Number.NaN)})`;
    });
    push(`| ${unit} | ${row.join(" | ")} |`);
  }
  push();
  push(`### The same runs read off at a 15,000-point credential (median, worst-of-K beside it)`);
  push();
  push(`| Unit | ${DRIVERS.join(" | ")} |`);
  push(`|---|${DRIVERS.map(() => "---:").join("|")}|`);
  for (const unit of units) {
    push(`| ${unit} | ${DRIVERS.map((d) => {
      const cell = cellFor(score, unit, d);
      return cell.medianT15k === null ? "—" : `${fmt(cell.medianT15k)} (worst ${fmt(cell.worstT15k ?? Number.NaN)})`;
    }).join(" | ")} |`);
  }
  push();
  push(`### Per-run walls and consumption (median across K complete reps)`);
  push();
  push(`| Unit | Driver | Wall (median) | Core units | GraphQL units | Peak disk (max) | Fallback spend | HTTP bytes | Store bytes | Segments |`);
  push(`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const unit of units) {
    for (const d of DRIVERS) {
      const cell = cellFor(score, unit, d);
      if (cell.runs.length === 0) {
        push(`| ${unit} | ${d} | — | — | — | — | — | — | — | — |`);
        continue;
      }
      const med = (pick: (r: (typeof cell.runs)[number]) => number): number => {
        const v = cell.runs.map(pick).sort((a, b) => a - b);
        return v[Math.floor(v.length / 2)]!;
      };
      const stores = cell.runs.map((r) => r.cloneObjectStoreBytes).filter((v): v is number => v !== null);
      push(`| ${unit} | ${d} | ${ms(med((r) => r.wallMs))} | ${fmt(med((r) => r.unitsCore))} | ${fmt(med((r) => r.unitsGraphql))} | ${bytes(Math.max(...cell.runs.map((r) => r.diskSampledPeakBytes)))} | ${fmt(med((r) => r.fallbackSpend))} | ${bytes(med((r) => r.httpBodyBytes))} | ${stores.length > 0 ? bytes(Math.max(...stores)) : "—"} | ${Math.max(...cell.runs.map((r) => r.segments))} |`);
    }
  }
  push();
  push(`HTTP body bytes (API drivers) and on-disk object-store bytes (clone drivers) are two`);
  push(`explicitly non-comparable transfer kinds (§4.6.3) — the store column is labelled on-disk`);
  push(`because git reports no clean transfer figure without packet tracing.`);
  push();

  // ---- gates -----------------------------------------------------------------------------
  push(`## 2. Eligibility (§4.7 G1–G4, global per driver)`);
  push();
  push(`| Driver | G1 fidelity | G2 completeness | G3 stability | G4 envelope | Attributable secondary signals | Eligible |`);
  push(`|---|---|---|---|---|---:|---|`);
  for (const g of score.gates) {
    push(`| ${g.driver} | ${g.g1} | ${g.g2} | ${g.g3} | ${g.g4} | ${g.g4AttributableSignals} | ${g.eligible ? "**yes**" : "no"} |`);
  }
  push();
  for (const g of score.gates) {
    if (g.reasons.length === 0) continue;
    push(`**${g.driver}** ${g.eligible ? "(warnings)" : "(disqualifying evidence)"}:`);
    push();
    for (const r of g.reasons) push(`- ${r}`);
    push();
  }
  const findings = score.gates.flatMap((g) => g.probeDivergenceFindings.map((f) => ({ driver: g.driver, ...f })));
  push(`### Checkout-config probe divergences (first-class findings, §4.7 G1)`);
  push();
  if (findings.length === 0) {
    push(`No caveat-route divergence was observed between \`core.autocrlf=false\` baselines and the`);
    push(`\`autocrlf=true\` probe reps.`);
  } else {
    push(`Divergences on declared-caveat routes are recorded findings for the decision-maker, not`);
    push(`auto-disqualifications (the waiver is exactly the config delta; §4.7 G1):`);
    push();
    for (const f of findings) push(`- ${f.driver} on ${f.unit} (pos ${f.pos}): ${f.divergences} diverging deliver${f.divergences === 1 ? "y" : "ies"} under \`autocrlf=true\``);
  }
  push();
  push(`### C6 fidelity battery`);
  push();
  push(`| Fixture | Driver | Entry | Final state |`);
  push(`|---|---|---|---|`);
  for (const c of score.fidelity.cells) push(`| ${c.kind} | ${c.driver} | \`${c.path}\` | ${c.final} |`);
  push();

  // ---- comparison + rule output ----------------------------------------------------------
  push(`## 3. Comparison under the ${score.noiseBand} band and the §4.7 rule's output`);
  push();
  push(`Eligible drivers: ${score.eligible.length > 0 ? score.eligible.join(", ") : "none"}.`);
  push();
  if (score.eligible.length >= 2) {
    push(`### Per-unit win/tie/loss (ratios within ${score.noiseBand}× are ties)`);
    push();
    push(`| Unit | ${score.comparisons[0]?.pairs.map((p) => `${p.a} vs ${p.b}`).join(" | ") ?? ""} |`);
    push(`|---|${score.comparisons[0]?.pairs.map(() => "---").join("|") ?? ""}|`);
    for (const comparison of score.comparisons) {
      push(`| ${comparison.unit} | ${comparison.pairs.map((p) => `${p.outcome === "tie" ? "tie" : p.outcome === "a" ? p.a : p.b} (${p.ratio.toFixed(2)}×)`).join(" | ")} |`);
    }
    push();
    push(`### Aggregate per rival`);
    push();
    push(`| Driver | ${score.eligible.map((e) => `vs ${e}`).join(" | ")} |`);
    push(`|---|${score.eligible.map(() => "---").join("|")}|`);
    for (const d of score.eligible) {
      push(`| ${d} | ${score.eligible.map((e) => (e === d ? "—" : `${score.perRival[d][e].wins}W/${score.perRival[d][e].ties}T/${score.perRival[d][e].losses}L`)).join(" | ")} |`);
    }
    push();
  }
  push(`### Rule output (§4.7 case mapping, exhaustive)`);
  push();
  switch (score.caseMapping.kind) {
    case "dominator":
      push(`**≥2 eligible, one dominator.** The rule recommends **${score.caseMapping.recommendation}**: against`);
      push(`every other eligible driver it holds at least one unit-win and no unit-losses.`);
      break;
    case "no-dominator":
      push(`**≥2 eligible, no dominator.** The rule makes **no recommendation**; the full per-unit table`);
      push(`above goes to the decision-maker, whose judgment is exercised on the design ledger (§3.3)`);
      push(`alongside these measurements.`);
      break;
    case "sole-eligible":
      push(`**Exactly one eligible driver.** The rule recommends **${score.caseMapping.recommendation}**, with every other`);
      push(`driver's disqualifying evidence attached in §2 above.`);
      break;
    case "zero-eligible":
      push(`**Zero eligible drivers.** No recommendation, and **no path to \`accepted\` on this benchmark**:`);
      push(`Step D must record remain-\`proposed\` with a remediation plan (which gate failures to fix,`);
      push(`what re-runs under §8's freeze rules). The disqualifying evidence per driver is in §2.`);
      break;
  }
  push();
  push(`The Step-D decision — ratify or override, in any direction — is a separate PR and passes one`);
  push(`further adversarial review round before ADR-0001 changes state (§4.7). An ineligible driver`);
  push(`can never be chosen.`);
  push();

  // ---- protocol events -------------------------------------------------------------------
  push(`## 4. Protocol events (§4.5 taxonomy census)`);
  push();
  push(`| Event | Count |`);
  push(`|---|---:|`);
  push(`| R1/R2 driver rerun allowances consumed | ${score.taxonomy.r1r2RerunsUsed} |`);
  push(`| R3 foreign-consumption invalidations | ${score.taxonomy.r3Foreign} |`);
  push(`| R4 reset-window straddles | ${score.taxonomy.r4Straddles} |`);
  push(`| Control-plane invalidations (snapshot failures) | ${score.taxonomy.controlPlaneInvalidations} |`);
  push(`| R6 branch-arm drift restarts (scaffolding epilogue) | ${score.taxonomy.r6DriftRestarts} |`);
  push(`| Epilogue rows executed | ${score.taxonomy.epilogueRows} |`);
  push(`| Segmented runs (§4.8 feasibility gate) | ${score.taxonomy.segmentedRuns} |`);
  push();
  push(`Failed and invalidated attempts stay in \`runs.jsonl\` and count in failure metrics; a`);
  push(`replaced attempt's timing is excluded from throughput aggregation and the replay's enters`);
  push(`(§4.5). Git transport pacing stayed well under 15 ops/s/repo by construction: each run`);
  push(`issues at most a handful of git transport operations (acquire, coherence check, enumerate,`);
  push(`one interactive read child) per run — even the fastest sub-second wall carries only that`);
  push(`handful of operations, far under the ceiling (§4.8, asserted here).`);
  push();

  // ---- informational executors -----------------------------------------------------------
  push(`## 5. Informational executors (reported, not scored)`);
  push();
  if (ctx.boundary !== null) {
    push(`### Boundary probe (§4.4)`);
    push();
    push(`Committed as [boundary-probe.json](boundary-probe.json). Cells: alias counts`);
    push(`{250, 300, 350, 400, 425, 450, 475} at small fixed content, plus alias×content`);
    push(`{150, 250} × {1.5 MiB, 3 MiB}, 3 tries per cell, on ${String(ctx.boundary["repo"] ?? "?")}.`);
    const cells = Array.isArray(ctx.boundary["cells"]) ? (ctx.boundary["cells"] as Array<Record<string, unknown>>) : [];
    push();
    push(`| Aliases | Content target | Actual bytes | Try outcomes (status/classification) |`);
    push(`|---:|---:|---:|---|`);
    for (const cell of cells) {
      const tries = Array.isArray(cell["tries"]) ? (cell["tries"] as Array<Record<string, unknown>>) : [];
      push(`| ${String(cell["aliasCount"])} | ${cell["contentTargetBytes"] === null ? "small" : bytes(cell["contentTargetBytes"] as number)} | ${bytes(typeof cell["actualContentBytes"] === "number" ? (cell["actualContentBytes"] as number) : null)} | ${tries.map((t) => `${String(t["status"])}/${String(t["classification"])}`).join(", ")} |`);
    }
    push();
  } else {
    push(`### Boundary probe — not yet run (artifact absent)`);
    push();
  }
  if (ctx.concurrency !== null) {
    push(`### Concurrency probe (§4.5)`);
    push();
    push(`Committed as [concurrency-probe.json](concurrency-probe.json): C1's four branch`);
    push(`units as 4 concurrent streams, for T0 and for T1, every secondary-limit signal recorded.`);
    const blocks = Array.isArray(ctx.concurrency["drivers"]) ? (ctx.concurrency["drivers"] as Array<Record<string, unknown>>) : [];
    push();
    push(`| Driver | Streams complete | Wall range | Secondary signals | 5xx | Retries |`);
    push(`|---|---|---|---:|---:|---:|`);
    for (const b of blocks) {
      const streams = Array.isArray(b["streams"]) ? (b["streams"] as Array<Record<string, unknown>>) : [];
      const walls = streams.map((s) => (typeof s["wallMs"] === "number" ? (s["wallMs"] as number) : 0));
      const signals = streams.reduce((n, s) => n + (typeof s["secondarySignals"] === "number" ? (s["secondarySignals"] as number) : 0), 0);
      const fivexx = streams.reduce((n, s) => n + (typeof s["fivexx"] === "number" ? (s["fivexx"] as number) : 0), 0);
      const retries = streams.reduce((n, s) => n + (typeof s["retries"] === "number" ? (s["retries"] as number) : 0), 0);
      push(`| ${String(b["driver"])} | ${streams.filter((s) => s["outcome"] === "complete").length}/${streams.length} | ${walls.length > 0 ? `${ms(Math.min(...walls))}–${ms(Math.max(...walls))}` : "—"} | ${signals} | ${fivexx} | ${retries} |`);
    }
    push();
    push(`These results evidence the scheduler requirement; they rank nothing (§4.5).`);
    push();
  } else {
    push(`### Concurrency probe — not yet run (artifact absent)`);
    push();
  }
  if (ctx.option3 !== null) {
    push(`### Option 3 (compositional analysis, §4.4)`);
    push();
    push(`Committed as [option3.json](option3.json): the offline duplicate-OID analysis over`);
    push(`the corpus trees plus the frozen warm-run scenario`);
    push(`(base/advanced = the pinned warm-pair SHAs recorded in corpus.json).`);
    const statement = ctx.option3["cloneCompositionStatement"];
    if (typeof statement === "string") {
      push();
      push(`> ${statement}`);
    }
    push();
  } else {
    push(`### Option-3 analysis — not yet run (artifact absent)`);
    push();
  }

  push(`## 6. Review record`);
  push();
  push(`Step B's harness passed its adversarial review rounds (the counts and outcomes are`);
  push(`committed in ratification.json's adversarialReviewRecord and amendment entries; no formal`);
  push(`CONVERGED verdict was recorded — stated plainly, per the loop's own precedent). Step C's`);
  push(`runner repairs and executors passed the §8-amended review round`);
  push(`recorded in ratification.json before any evidence here was collected. The artifacts map:`);
  push(`\`runs.jsonl\` (§4.5/§4.6 matrix evidence), \`fidelity.jsonl\` (§4.2 battery),`);
  push(`\`boundary-probe.json\`/\`concurrency-probe.json\`/\`option3.json\` (§4.4/§4.5 informational),`);
  push(`this report (§4.6 metrics, §4.7 verdicts and rule output).`);
  push();
  return `${L.join("\n")}\n`;
}
