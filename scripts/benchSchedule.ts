// benchSchedule.ts — the preregistered traversal generator + validators (resolution plan §4.5).
// The full (unit × driver × repetition) sequence is a LITERAL table in bench-config.json,
// written once at corpus pinning; this module generates it deterministically and validates the
// committed table's properties in CI so the preregistration cannot drift from its own rules:
//   • within each unit, driver orders across repetitions 1–4 follow a Williams design (a
//     digram-balanced Latin square: each driver once in each position, each ordered predecessor
//     pair exactly once) plus the declared fifth order minimising repeated digrams;
//   • across units, repositories are interleaved so no two C1 branch units (same repository)
//     are adjacent — server-side pack-cache warmth from one branch's acquisition must not
//     systematically precede its sibling's;
//   • checkout-config probe repetitions (core.autocrlf=true — plan §4.5) are appended AFTER the
//     whole main traversal as their own block, never interleaved into it.

export type DriverId = "T0" | "T1" | "T2a" | "T2c";
export const DRIVERS: readonly DriverId[] = ["T0", "T1", "T2a", "T2c"];

export interface ScheduleUnit {
  unitId: string; // e.g. "C1:fastify/fastify@main"
  repoKey: string; // owner/repo — the adjacency-constraint key (C1 siblings share it)
  slot: string; // C1..C5 (the performance corpus; C6's fidelity battery is untimed and unscheduled here)
}

export interface ScheduleRow {
  pos: number; // 1-based position in the full preregistered traversal
  unit: string;
  driver: DriverId;
  rep: number; // 1..reps for matrix rows; reps+1 for the checkout-config probe rep
  probe: boolean; // true = the additional core.autocrlf=true repetition (unscored)
}

export interface Schedule {
  unitOrder: string[];
  rows: ScheduleRow[];
}

export class BenchScheduleError extends Error {
  constructor(message: string) {
    super(`BENCH SCHEDULE: ${message}`);
    this.name = "BenchScheduleError";
  }
}

// ---- Williams-design validation --------------------------------------------------------------
// Returns a list of violations (empty = compliant). Rows 1..4 must be the digram-balanced
// Latin square; row 5 is the declared extra order whose digrams may each repeat at most once.
export function validateWilliamsRows(rows: readonly (readonly DriverId[])[], drivers: readonly DriverId[]): string[] {
  const out: string[] = [];
  const n = drivers.length;
  if (rows.length !== 5) out.push(`expected 5 rows (4 square rows + the declared fifth), got ${rows.length}`);
  const isPerm = (row: readonly DriverId[]): boolean =>
    row.length === n && new Set(row).size === n && row.every((d) => drivers.includes(d));
  rows.forEach((row, i) => {
    if (!isPerm(row)) out.push(`row ${i + 1} is not a permutation of the drivers`);
  });
  if (out.length > 0) return out; // structural failures make the property checks meaningless
  // Latin square over rows 1..4: each driver exactly once in each position
  for (let pos = 0; pos < n; pos++) {
    const column = new Set(rows.slice(0, 4).map((r) => r[pos]!));
    if (column.size !== 4) out.push(`position ${pos + 1} does not carry each driver exactly once across rows 1-4`);
  }
  // digram balance over rows 1..4: every ordered predecessor pair exactly once
  const digrams = new Map<string, number>();
  for (const row of rows.slice(0, 4)) {
    for (let i = 0; i + 1 < row.length; i++) {
      const key = `${row[i]}→${row[i + 1]}`;
      digrams.set(key, (digrams.get(key) ?? 0) + 1);
    }
  }
  if (digrams.size !== n * (n - 1)) out.push(`rows 1-4 carry ${digrams.size} distinct ordered pairs, expected ${n * (n - 1)}`);
  for (const [key, count] of digrams) {
    if (count !== 1) out.push(`ordered pair ${key} occurs ${count} times across rows 1-4 (digram balance requires exactly once)`);
  }
  // the declared fifth row: each of its digrams may appear at most once in rows 1..4 (so no
  // ordered pair reaches three occurrences overall — the minimum any fifth row can achieve)
  const fifth = rows[4]!;
  for (let i = 0; i + 1 < fifth.length; i++) {
    const key = `${fifth[i]}→${fifth[i + 1]}`;
    if ((digrams.get(key) ?? 0) > 1) out.push(`fifth-row pair ${key} already repeats in rows 1-4`);
  }
  return out;
}

// ---- unit interleaving -----------------------------------------------------------------------
// Deterministic greedy rearrangement: always take a unit from the repo with the most remaining
// units whose key differs from the last placed (lexicographic tie-break) — the classic
// no-two-adjacent construction, feasible iff max group ≤ ceil(total/2). Throws when infeasible
// rather than silently emitting an adjacent C1 pair.
export function interleaveUnits(units: readonly ScheduleUnit[]): ScheduleUnit[] {
  const groups = new Map<string, ScheduleUnit[]>();
  for (const u of [...units].sort((a, b) => (a.unitId < b.unitId ? -1 : 1))) {
    const list = groups.get(u.repoKey) ?? [];
    list.push(u);
    groups.set(u.repoKey, list);
  }
  const order: ScheduleUnit[] = [];
  let lastKey: string | null = null;
  for (let placed = 0; placed < units.length; placed++) {
    let bestKey: string | null = null;
    let bestRemaining = -1;
    for (const [key, list] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (list.length === 0 || key === lastKey) continue;
      if (list.length > bestRemaining) {
        bestRemaining = list.length;
        bestKey = key;
      }
    }
    if (bestKey === null)
      throw new BenchScheduleError("interleaving infeasible: only same-repository units remain (adjacency constraint unsatisfiable)");
    order.push(groups.get(bestKey)!.shift()!);
    lastKey = bestKey;
  }
  return order;
}

// ---- schedule construction -------------------------------------------------------------------
// probeDriversFor: which drivers of this unit get the checkout-config probe rep — T2a on every
// unit (checkout is its primary route); T0/T1 only where they materialise a checkout (the C4
// truncated-tree fallback). Plan §4.5.
export function probeDriversFor(unit: ScheduleUnit): DriverId[] {
  return unit.slot === "C4" ? ["T0", "T1", "T2a"] : ["T2a"];
}

export function buildSchedule(
  units: readonly ScheduleUnit[],
  williamsRows: readonly (readonly DriverId[])[],
  reps: number,
): Schedule {
  const williamsViolations = validateWilliamsRows(williamsRows, DRIVERS);
  if (williamsViolations.length > 0)
    throw new BenchScheduleError(`williams rows invalid: ${williamsViolations.join("; ")}`);
  if (reps !== williamsRows.length)
    throw new BenchScheduleError(`reps (${reps}) must equal the number of declared driver orders (${williamsRows.length})`);
  const ordered = interleaveUnits(units);
  const rows: ScheduleRow[] = [];
  let pos = 1;
  for (const unit of ordered) {
    for (let rep = 1; rep <= reps; rep++) {
      for (const driver of williamsRows[rep - 1]!) {
        rows.push({ pos: pos++, unit: unit.unitId, driver, rep, probe: false });
      }
    }
  }
  // the probe epilogue: appended after the WHOLE main traversal, in the same unit order
  for (const unit of ordered) {
    for (const driver of probeDriversFor(unit)) {
      rows.push({ pos: pos++, unit: unit.unitId, driver, rep: reps + 1, probe: true });
    }
  }
  return { unitOrder: ordered.map((u) => u.unitId), rows };
}

// ---- committed-table validation --------------------------------------------------------------
// Validates a (possibly hand-edited) committed schedule against the preregistration rules.
// Returns violations (empty = compliant) so CI can report every defect at once.
export function validateSchedule(
  schedule: Schedule,
  units: readonly ScheduleUnit[],
  williamsRows: readonly (readonly DriverId[])[],
  reps: number,
): string[] {
  const out: string[] = [...validateWilliamsRows(williamsRows, DRIVERS)];
  const byId = new Map(units.map((u) => [u.unitId, u]));
  if (new Set(schedule.unitOrder).size !== schedule.unitOrder.length) out.push("unitOrder contains duplicates");
  if (schedule.unitOrder.length !== units.length) out.push(`unitOrder names ${schedule.unitOrder.length} units, corpus has ${units.length}`);
  for (const id of schedule.unitOrder) if (!byId.has(id)) out.push(`unitOrder names unknown unit ${id}`);
  // adjacency: consecutive units never share a repository
  for (let i = 0; i + 1 < schedule.unitOrder.length; i++) {
    const a = byId.get(schedule.unitOrder[i]!);
    const b = byId.get(schedule.unitOrder[i + 1]!);
    if (a !== undefined && b !== undefined && a.repoKey === b.repoKey)
      out.push(`adjacent same-repository units at order positions ${i + 1}/${i + 2}: ${a.unitId}, ${b.unitId}`);
  }
  // positions are 1..N contiguous in row order
  schedule.rows.forEach((row, i) => {
    if (row.pos !== i + 1) out.push(`row ${i} carries pos ${row.pos}, expected ${i + 1}`);
  });
  const main = schedule.rows.filter((r) => !r.probe);
  const probe = schedule.rows.filter((r) => r.probe);
  // probe rows strictly after every main row
  const lastMain = main.length > 0 ? main[main.length - 1]!.pos : 0;
  for (const p of probe) if (p.pos <= lastMain) out.push(`probe row at pos ${p.pos} precedes the end of the main traversal (${lastMain})`);
  // main traversal: per unit, a contiguous block whose (rep, driver) expansion equals the rows
  const expectedPerUnit: Array<{ driver: DriverId; rep: number }> = [];
  for (let rep = 1; rep <= reps; rep++) for (const d of williamsRows[rep - 1] ?? []) expectedPerUnit.push({ driver: d, rep });
  const seenUnits: string[] = [];
  for (let i = 0; i < main.length; ) {
    const unitId = main[i]!.unit;
    seenUnits.push(unitId);
    const block = main.slice(i, i + expectedPerUnit.length);
    if (block.length < expectedPerUnit.length || block.some((r) => r.unit !== unitId)) {
      out.push(`unit ${unitId}'s main block is not contiguous or is short`);
      break;
    }
    block.forEach((row, j) => {
      const exp = expectedPerUnit[j]!;
      if (row.driver !== exp.driver || row.rep !== exp.rep)
        out.push(`unit ${unitId} main block slot ${j}: got ${row.driver} rep ${row.rep}, expected ${exp.driver} rep ${exp.rep}`);
    });
    i += expectedPerUnit.length;
  }
  if (out.length === 0 && seenUnits.join(" ") !== schedule.unitOrder.join(" "))
    out.push("unitOrder does not match the main traversal's block order");
  // probe epilogue: per unit, exactly probeDriversFor(unit), once each, in unit order, rep = reps+1
  const expectedProbe: Array<{ unit: string; driver: DriverId }> = [];
  for (const id of schedule.unitOrder) {
    const u = byId.get(id);
    if (u === undefined) continue;
    for (const d of probeDriversFor(u)) expectedProbe.push({ unit: id, driver: d });
  }
  if (probe.length !== expectedProbe.length) {
    out.push(`probe epilogue has ${probe.length} rows, expected ${expectedProbe.length}`);
  } else {
    probe.forEach((row, i) => {
      const exp = expectedProbe[i]!;
      if (row.unit !== exp.unit || row.driver !== exp.driver || row.rep !== reps + 1)
        out.push(`probe row ${i}: got ${row.unit}/${row.driver}/rep${row.rep}, expected ${exp.unit}/${exp.driver}/rep${reps + 1}`);
    });
  }
  return out;
}
